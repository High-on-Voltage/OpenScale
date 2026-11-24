#include "wifi_manager.hpp"
#include "lwip/ip4_addr.h"
#include "device_log.hpp"
#include "storage.hpp"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "cJSON.h"
#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace openscale {
namespace {
constexpr char TAG[] = "wifi";
constexpr EventBits_t STA_CONNECTED_BIT = BIT0;
constexpr EventBits_t STA_FAILED_BIT = BIT1;
struct Network { std::string ssid; std::string password; std::string ip; std::string subnet; int priority{0}; int original_order{0}; };
EventGroupHandle_t s_events = nullptr;
esp_netif_t *s_sta_netif = nullptr;
esp_netif_t *s_ap_netif = nullptr;
portMUX_TYPE s_wifi_mux = portMUX_INITIALIZER_UNLOCKED;
bool s_connected = false;
char s_station_ip[16]{};
bool s_keep_ap = false;
bool s_ap_enabled = true;
std::string s_ap_prefix = "OpenScale";
std::string s_ap_password;
bool s_ap_password_explicit = false;
std::atomic<bool> s_ap_running{false};
uint8_t s_max_stations = 4;
uint8_t s_ap_channel = 1;
std::vector<Network> s_networks;

void event_handler(void *, esp_event_base_t base, int32_t id, void *data) {
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        portENTER_CRITICAL(&s_wifi_mux); s_connected = false; s_station_ip[0] = '\0'; portEXIT_CRITICAL(&s_wifi_mux);
        if (s_events) {
            xEventGroupClearBits(s_events, STA_CONNECTED_BIT);
            xEventGroupSetBits(s_events, STA_FAILED_BIT);
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        const auto *event = static_cast<ip_event_got_ip_t *>(data);
        ESP_LOGI(TAG, "STA got IP: " IPSTR, IP2STR(&event->ip_info.ip));
        portENTER_CRITICAL(&s_wifi_mux);
        s_connected = true;
        std::snprintf(s_station_ip, sizeof(s_station_ip), IPSTR, IP2STR(&event->ip_info.ip));
        portEXIT_CRITICAL(&s_wifi_mux);
        if (s_events) xEventGroupSetBits(s_events, STA_CONNECTED_BIT);
        device_log_add("wifi_state", "Wi-Fi station connected", "{\"state\":\"connected\"}");
        if (!s_keep_ap && s_ap_netif) {
            if (esp_wifi_set_mode(WIFI_MODE_STA) == ESP_OK) s_ap_running.store(false);
        }
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_AP_STACONNECTED) {
        const auto *event = static_cast<wifi_event_ap_staconnected_t *>(data);
        char details[96]{};
        std::snprintf(details, sizeof(details), "{\"state\":\"ap_client_connected\",\"aid\":%u}", event->aid);
        device_log_add("wifi_state", "Fallback AP client connected", details);
    }
}

void load_wifi_config() {
    std::vector<uint8_t> bytes;
    const esp_err_t read_err = storage::read_file("/data/settings/wifi.json", bytes, 64 * 1024);
    cJSON *root = nullptr;
    if (read_err == ESP_ERR_NOT_FOUND) {
        static constexpr char defaults[] = "{\"schemaVersion\":1,\"networks\":[],\"ap\":{\"enabled\":true,\"ssidPrefix\":\"OpenScale\",\"channel\":null,\"maxStations\":4,\"keepApWhenConnected\":false}}";
        std::vector<uint8_t> data(defaults, defaults + sizeof(defaults) - 1);
        if (storage::ready()) (void)storage::write_file_atomic("/data/settings/wifi.json", data.data(), data.size());
        root = cJSON_Parse(defaults);
    } else if (read_err == ESP_OK) {
        root = cJSON_ParseWithLength(reinterpret_cast<const char *>(bytes.data()), bytes.size());
    }
    if (!root) {
        device_log_add("config_fallback", "Could not load wifi.json; in-memory defaults are active",
                       "{\"file\":\"wifi.json\",\"reason\":\"parse_error\",\"savedFileModified\":false}");
        s_networks.clear();
        return;
    }
    const cJSON *networks = cJSON_GetObjectItemCaseSensitive(root, "networks");
    if (cJSON_IsArray(networks)) {
        const int count = cJSON_GetArraySize(networks);
        for (int i = 0; i < count; ++i) {
            const cJSON *entry = cJSON_GetArrayItem(networks, i);
            const cJSON *ssid = cJSON_GetObjectItemCaseSensitive(entry, "ssid");
            const cJSON *password = cJSON_GetObjectItemCaseSensitive(entry, "password");
            const cJSON *priority = cJSON_GetObjectItemCaseSensitive(entry, "priority");
            if (!cJSON_IsString(ssid) || !ssid->valuestring[0]) continue;
            Network network{};
            network.ssid = ssid->valuestring;
            if (cJSON_IsString(password)) network.password = password->valuestring;
            if (cJSON_IsNumber(priority)) network.priority = priority->valueint;
            network.original_order = i;
            const cJSON *ip = cJSON_GetObjectItemCaseSensitive(entry, "ip");
            const cJSON *subnet = cJSON_GetObjectItemCaseSensitive(entry, "subnet");
            if (cJSON_IsString(ip)) network.ip = ip->valuestring;
            if (cJSON_IsString(subnet)) network.subnet = subnet->valuestring;
            s_networks.push_back(std::move(network));
        }
    }
    const cJSON *ap = cJSON_GetObjectItemCaseSensitive(root, "ap");
    const cJSON *enabled = cJSON_GetObjectItemCaseSensitive(ap, "enabled");
    const cJSON *prefix = cJSON_GetObjectItemCaseSensitive(ap, "ssidPrefix");
    const cJSON *max = cJSON_GetObjectItemCaseSensitive(ap, "maxStations");
    const cJSON *channel = cJSON_GetObjectItemCaseSensitive(ap, "channel");
    const cJSON *keep = cJSON_GetObjectItemCaseSensitive(ap, "keepApWhenConnected");
    const cJSON *ap_password = cJSON_GetObjectItemCaseSensitive(ap, "password");
    if (cJSON_IsBool(enabled)) s_ap_enabled = cJSON_IsTrue(enabled);
    if (cJSON_IsString(prefix) && prefix->valuestring[0]) s_ap_prefix = prefix->valuestring;
    if (cJSON_IsNumber(max)) s_max_stations = std::clamp(max->valueint, 1, 10);
    if (cJSON_IsNumber(channel)) s_ap_channel = static_cast<uint8_t>(std::clamp(channel->valueint, 1, 13));
    if (cJSON_IsBool(keep)) s_keep_ap = cJSON_IsTrue(keep);
    s_ap_password_explicit = ap_password != nullptr;
    if (cJSON_IsString(ap_password)) s_ap_password = ap_password->valuestring;
    else s_ap_password.clear();
    cJSON_Delete(root);
    std::stable_sort(s_networks.begin(), s_networks.end(), [](const Network &a, const Network &b) {
        return a.priority > b.priority;
    });
}

void start_fallback_ap() {
    if (s_ap_running.load()) return;
    if (!s_ap_enabled) {
        ESP_LOGW(TAG, "Fallback AP disabled in configuration");
        return;
    }
    uint8_t mac[6]{};
    (void)esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
    char ssid[33]{};
    std::snprintf(ssid, sizeof(ssid), "%s-%02X%02X%02X", s_ap_prefix.c_str(), mac[3], mac[4], mac[5]);
    // Use an explicit configured password, otherwise generate a per-device recovery secret.
    char password[64]{};
    const bool generated_password = !s_ap_password_explicit;
    if (generated_password) std::snprintf(password, sizeof(password), "OS-%02X%02X-%02X%02X", mac[2], mac[3], mac[4], mac[5]);
    else std::snprintf(password, sizeof(password), "%s", s_ap_password.c_str());
    wifi_config_t ap_config{};
    std::snprintf(reinterpret_cast<char *>(ap_config.ap.ssid), sizeof(ap_config.ap.ssid), "%s", ssid);
    std::snprintf(reinterpret_cast<char *>(ap_config.ap.password), sizeof(ap_config.ap.password), "%s", password);
    ap_config.ap.ssid_len = std::strlen(ssid);
    ap_config.ap.channel = s_ap_channel;
    ap_config.ap.max_connection = s_max_stations;
    ap_config.ap.authmode = password[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    if (esp_wifi_set_mode(WIFI_MODE_APSTA) == ESP_OK && esp_wifi_set_config(WIFI_IF_AP, &ap_config) == ESP_OK) {
        if (generated_password) ESP_LOGW(TAG, "Fallback AP: SSID=%s password=%s", ssid, password);
        else if (password[0]) ESP_LOGI(TAG, "Fallback AP started with configured credentials (password not logged)");
        else ESP_LOGW(TAG, "Fallback AP started without a password (explicit configuration)");
        s_ap_running.store(true);
        device_log_add("wifi_state", "Fallback access point started", "{\"state\":\"ap_started\"}");
    }
}

void connect_worker(void *) {
    while (true) {
        bool connected = false;
        for (const auto &network : s_networks) {
            wifi_config_t sta{};
            std::snprintf(reinterpret_cast<char *>(sta.sta.ssid), sizeof(sta.sta.ssid), "%s", network.ssid.c_str());
            std::snprintf(reinterpret_cast<char *>(sta.sta.password), sizeof(sta.sta.password), "%s", network.password.c_str());
            sta.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
            sta.sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;
            (void)esp_wifi_disconnect();
            (void)esp_wifi_set_config(WIFI_IF_STA, &sta);
            xEventGroupClearBits(s_events, STA_CONNECTED_BIT | STA_FAILED_BIT);
            const esp_err_t connect_err = esp_wifi_connect();
            if (connect_err != ESP_OK) continue;
            // A delayed disconnect event from the previous AP can arrive after
            // this attempt begins. Only a successful GOT_IP ends the 15s window.
            const EventBits_t bits = xEventGroupWaitBits(s_events, STA_CONNECTED_BIT,
                pdFALSE, pdFALSE, pdMS_TO_TICKS(15000));
            if (bits & STA_CONNECTED_BIT) { connected = true; break; }
        }
        if (!connected) {
            device_log_add("wifi_state", "No configured Wi-Fi station connected; fallback AP active", "{\"state\":\"disconnected\"}");
            start_fallback_ap();
        }
        // A complete retry pass starts every 30 seconds while disconnected.
        for (int i = 0; i < 30 && !(xEventGroupGetBits(s_events) & STA_CONNECTED_BIT); ++i)
            vTaskDelay(pdMS_TO_TICKS(1000));
        if (xEventGroupGetBits(s_events) & STA_CONNECTED_BIT) {
            if (!s_keep_ap) (void)esp_wifi_set_mode(WIFI_MODE_STA);
            // Stay alive: a later disconnect starts another priority-ordered pass.
            while (xEventGroupGetBits(s_events) & STA_CONNECTED_BIT) vTaskDelay(pdMS_TO_TICKS(1000));
        }
    }
}
}

esp_err_t wifi_manager_start() {
    load_wifi_config();
    esp_err_t err = esp_netif_init();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;
    err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;
    s_sta_netif = esp_netif_create_default_wifi_sta();
    s_ap_netif = esp_netif_create_default_wifi_ap();
    if (!s_sta_netif || !s_ap_netif) return ESP_FAIL;
    wifi_init_config_t config = WIFI_INIT_CONFIG_DEFAULT();
    err = esp_wifi_init(&config);
    if (err != ESP_OK) return err;
    (void)esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &event_handler, nullptr);
    (void)esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &event_handler, nullptr);
    s_events = xEventGroupCreate();
    if (!s_events) return ESP_ERR_NO_MEM;
    err = esp_wifi_set_storage(WIFI_STORAGE_RAM);
    if (err == ESP_OK) err = esp_wifi_set_mode(WIFI_MODE_STA);
    if (err == ESP_OK) err = esp_wifi_start();
    if (err != ESP_OK) return err;
    if (xTaskCreate(connect_worker, "wifi_connect", 4096, nullptr, 4, nullptr) != pdPASS) return ESP_ERR_NO_MEM;
    return ESP_OK;
}

WifiRuntimeStatus wifi_manager_status() {
    WifiRuntimeStatus status{};
    portENTER_CRITICAL(&s_wifi_mux);
    status.connected = s_connected;
    std::snprintf(status.ip, sizeof(status.ip), "%s", s_station_ip);
    portEXIT_CRITICAL(&s_wifi_mux);
    wifi_ap_record_t ap{};
    if (status.connected && esp_wifi_sta_get_ap_info(&ap) == ESP_OK) { status.rssi = ap.rssi; status.rssi_valid = true; }
    wifi_sta_list_t stations{};
    if (esp_wifi_ap_get_sta_list(&stations) == ESP_OK) status.clients_connected = stations.num;
    return status;
}
}
