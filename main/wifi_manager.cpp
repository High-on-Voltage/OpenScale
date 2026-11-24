#include "wifi_manager.hpp"
#include "lwip/ip4_addr.h"
#include "lwip/inet.h"
#include "lwip/sockets.h"
#include "device_log.hpp"
#include "factory_defaults.hpp"
#include "storage.hpp"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "cJSON.h"
#include <sys/time.h>
#include <unistd.h>
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

enum class WifiLogKind : uint8_t { StationConnected, ApClientConnected };
struct WifiLogEvent {
    WifiLogKind kind{};
    uint8_t aid{};
    char ip[16]{};
};
QueueHandle_t s_wifi_log_queue = nullptr;
std::atomic<uint32_t> s_ap_ip_addr{0};
char s_captive_portal_uri[64]{};

uint16_t read_be16(const uint8_t *data) {
    return static_cast<uint16_t>((static_cast<uint16_t>(data[0]) << 8) | data[1]);
}

void write_be16(uint8_t *data, uint16_t value) {
    data[0] = static_cast<uint8_t>(value >> 8);
    data[1] = static_cast<uint8_t>(value & 0xff);
}

size_t dns_question_end(const uint8_t *packet, size_t length) {
    if (!packet || length < 17) return 0;
    size_t pos = 12;
    while (pos < length) {
        const uint8_t label_length = packet[pos++];
        if (label_length == 0) break;
        if ((label_length & 0xc0U) != 0 || label_length > 63 ||
            pos + label_length > length) return 0;
        pos += label_length;
    }
    if (pos + 4 > length) return 0;
    return pos + 4;
}

bool make_captive_dns_response(const uint8_t *query, size_t query_length,
                               uint8_t *response, size_t &response_length,
                               uint32_t ap_ip_network_order) {
    if (!query || !response || query_length < 17 ||
        (query[2] & 0x80U) || read_be16(query + 4) != 1) return false;

    const size_t question_end = dns_question_end(query, query_length);
    if (!question_end || question_end > 512) return false;

    std::memcpy(response, query, question_end);
    response[2] = static_cast<uint8_t>((query[2] & 0x79U) | 0x84U);
    response[3] = 0x80U;
    write_be16(response + 4, 1);
    write_be16(response + 6, 0);
    write_be16(response + 8, 0);
    write_be16(response + 10, 0);

    const size_t type_offset = question_end - 4;
    const bool wants_ipv4 = read_be16(query + type_offset) == 1 &&
                            read_be16(query + type_offset + 2) == 1;
    response_length = question_end;
    if (!wants_ipv4) return true;

    write_be16(response + 6, 1);
    static constexpr uint8_t answer_prefix[] = {
        0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01,
        0x00, 0x00, 0x00, 0x1e, 0x00, 0x04
    };
    std::memcpy(response + response_length, answer_prefix, sizeof(answer_prefix));
    response_length += sizeof(answer_prefix);
    std::memcpy(response + response_length, &ap_ip_network_order, sizeof(ap_ip_network_order));
    response_length += sizeof(ap_ip_network_order);
    return true;
}

void captive_dns_worker(void *) {
    uint8_t query[512]{};
    uint8_t response[528]{};

    while (true) {
        if (!s_ap_running.load()) {
            vTaskDelay(pdMS_TO_TICKS(500));
            continue;
        }

        const uint32_t ap_ip = s_ap_ip_addr.load();
        if (!ap_ip) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }

        const int socket_fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
        if (socket_fd < 0) {
            ESP_LOGW(TAG, "Captive DNS socket creation failed; retrying");
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }

        sockaddr_in local{};
        local.sin_family = AF_INET;
        local.sin_port = htons(53);
        local.sin_addr.s_addr = ap_ip;
        if (bind(socket_fd, reinterpret_cast<const sockaddr *>(&local), sizeof(local)) != 0) {
            ESP_LOGW(TAG, "Captive DNS bind failed; retrying");
            close(socket_fd);
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }

        timeval timeout{1, 0};
        (void)setsockopt(socket_fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
        ip4_addr_t ap_address{};
        ap_address.addr = ap_ip;
        ESP_LOGI(TAG, "Captive DNS active on " IPSTR, IP2STR(&ap_address));

        while (s_ap_running.load()) {
            sockaddr_in client{};
            socklen_t client_length = sizeof(client);
            const int received = recvfrom(socket_fd, query, sizeof(query), 0,
                reinterpret_cast<sockaddr *>(&client), &client_length);
            if (received <= 0) continue;

            size_t response_length = 0;
            if (!make_captive_dns_response(query, static_cast<size_t>(received),
                                            response, response_length, ap_ip)) continue;
            (void)sendto(socket_fd, response, response_length, 0,
                reinterpret_cast<const sockaddr *>(&client), client_length);
        }
        close(socket_fd);
    }
}

void wifi_log_worker(void *) {
    while (true) {
        WifiLogEvent event{};
        if (xQueueReceive(s_wifi_log_queue, &event, portMAX_DELAY) != pdTRUE) continue;

        if (event.kind == WifiLogKind::StationConnected) {
            ESP_LOGI(TAG, "STA got IP: %s", event.ip);
            device_log_add("wifi_state", "Wi-Fi station connected", "{\"state\":\"connected\"}");
        } else {
            char details[96]{};
            std::snprintf(details, sizeof(details),
                "{\"state\":\"ap_client_connected\",\"aid\":%u}", event.aid);
            ESP_LOGI(TAG, "Fallback AP client connected (aid=%u)", event.aid);
            device_log_add("wifi_state", "Fallback AP client connected", details);
        }
    }
}

void event_handler(void *, esp_event_base_t base, int32_t id, void *data) {
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        portENTER_CRITICAL(&s_wifi_mux); s_connected = false; s_station_ip[0] = '\0'; portEXIT_CRITICAL(&s_wifi_mux);
        if (s_events) {
            xEventGroupClearBits(s_events, STA_CONNECTED_BIT);
            xEventGroupSetBits(s_events, STA_FAILED_BIT);
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        const auto *event = static_cast<ip_event_got_ip_t *>(data);
        portENTER_CRITICAL(&s_wifi_mux);
        s_connected = true;
        std::snprintf(s_station_ip, sizeof(s_station_ip), IPSTR, IP2STR(&event->ip_info.ip));
        portEXIT_CRITICAL(&s_wifi_mux);
        if (s_events) xEventGroupSetBits(s_events, STA_CONNECTED_BIT);

        WifiLogEvent log_event{};
        log_event.kind = WifiLogKind::StationConnected;
        std::snprintf(log_event.ip, sizeof(log_event.ip), IPSTR, IP2STR(&event->ip_info.ip));
        if (s_wifi_log_queue) (void)xQueueSend(s_wifi_log_queue, &log_event, 0);
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_AP_STACONNECTED) {
        const auto *event = static_cast<wifi_event_ap_staconnected_t *>(data);
        WifiLogEvent log_event{};
        log_event.kind = WifiLogKind::ApClientConnected;
        log_event.aid = event->aid;
        if (s_wifi_log_queue) (void)xQueueSend(s_wifi_log_queue, &log_event, 0);
    }
}

void load_wifi_config() {
    std::vector<uint8_t> bytes;
    const esp_err_t read_err = storage::read_file("/data/settings/wifi.json", bytes, 64 * 1024);
    cJSON *root = nullptr;
    if (read_err == ESP_OK)
        ESP_LOGI(TAG, "Loaded /data/settings/wifi.json (%u bytes)", static_cast<unsigned>(bytes.size()));
    if (read_err == ESP_ERR_NOT_FOUND) {
        ESP_LOGI(TAG, "/data/settings/wifi.json missing; using embedded factory defaults");
        const char *defaults = factory_defaults::get("wifi.json");
        if (defaults) {
            const size_t size = std::strlen(defaults);
            if (storage::ready()) (void)storage::write_file_atomic(
                "/data/settings/wifi.json", reinterpret_cast<const uint8_t *>(defaults), size);
            root = cJSON_Parse(defaults);
        }
    } else if (read_err == ESP_OK) {
        root = cJSON_ParseWithLength(reinterpret_cast<const char *>(bytes.data()), bytes.size());
    }
    if (!root) {
        ESP_LOGW(TAG, "Could not load wifi.json; using embedded defaults and preserving the saved file");
        const char *reason = read_err == ESP_OK ? "parse_error" : "read_error";
        char details[128]{};
        std::snprintf(details, sizeof(details),
                      "{\"file\":\"wifi.json\",\"reason\":\"%s\",\"savedFileModified\":false}",
                      reason);
        device_log_add("config_fallback", "Could not load wifi.json; in-memory factory defaults are active", details);
        // Factory defaults are immutable firmware data. Use them only in memory
        // for a corrupt/unreadable saved file; never repair or overwrite it here.
        const char *defaults = factory_defaults::get("wifi.json");
        root = defaults ? cJSON_Parse(defaults) : nullptr;
        if (!root) {
            s_networks.clear();
            return;
        }
    }
    const cJSON *networks = cJSON_GetObjectItemCaseSensitive(root, "networks");
    if (cJSON_IsArray(networks)) {
        const int count = cJSON_GetArraySize(networks);
        for (int i = 0; i < count; ++i) {
            const cJSON *entry = cJSON_GetArrayItem(networks, i);
            const cJSON *ssid = cJSON_GetObjectItemCaseSensitive(entry, "ssid");
            const cJSON *password = cJSON_GetObjectItemCaseSensitive(entry, "password");
            const cJSON *priority = cJSON_GetObjectItemCaseSensitive(entry, "priority");
            if (!cJSON_IsString(ssid) || !ssid->valuestring[0] || std::strlen(ssid->valuestring) > 32) continue;
            Network network{};
            network.ssid = ssid->valuestring;
            if (cJSON_IsString(password)) network.password = password->valuestring;
            if (network.password.size() > 63) continue;
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
    std::snprintf(ssid, sizeof(ssid), "%.25s-%02X%02X%02X", s_ap_prefix.c_str(), mac[3], mac[4], mac[5]);
    // Use an explicit configured password, otherwise generate a per-device recovery secret.
    char password[64]{};
    const bool generated_password = !s_ap_password_explicit;
    if (generated_password) std::snprintf(password, sizeof(password), "OS-%02X%02X-%02X%02X", mac[2], mac[3], mac[4], mac[5]);
    else std::snprintf(password, sizeof(password), "%s", s_ap_password.c_str());
    wifi_config_t ap_config{};
    const size_t ssid_length = std::min(std::strlen(ssid), sizeof(ap_config.ap.ssid));
    std::memcpy(ap_config.ap.ssid, ssid, ssid_length);
    const size_t password_length = std::min(std::strlen(password), sizeof(ap_config.ap.password) - 1);
    std::memcpy(ap_config.ap.password, password, password_length);
    ap_config.ap.ssid_len = static_cast<uint8_t>(ssid_length);
    ap_config.ap.channel = s_ap_channel;
    ap_config.ap.max_connection = s_max_stations;
    ap_config.ap.authmode = password[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    // Configure DHCP options before APSTA mode brings up the AP DHCP server.
    // ESP-IDF rejects DHCP-server option updates while the server is running.
    esp_netif_ip_info_t ap_info{};
    if (esp_netif_get_ip_info(s_ap_netif, &ap_info) == ESP_OK) {
        s_ap_ip_addr.store(ap_info.ip.addr);
        std::snprintf(s_captive_portal_uri, sizeof(s_captive_portal_uri),
                      "http://" IPSTR "/", IP2STR(&ap_info.ip));
        uint8_t offer_dns = 1;
        const esp_err_t dns_option_err = esp_netif_dhcps_option(
            s_ap_netif, ESP_NETIF_OP_SET, ESP_NETIF_DOMAIN_NAME_SERVER,
            &offer_dns, sizeof(offer_dns));
        if (dns_option_err != ESP_OK)
            ESP_LOGW(TAG, "Could not advertise AP DNS server: %s", esp_err_to_name(dns_option_err));
        const esp_err_t portal_option_err = esp_netif_dhcps_option(
            s_ap_netif, ESP_NETIF_OP_SET, ESP_NETIF_CAPTIVEPORTAL_URI,
            s_captive_portal_uri, std::strlen(s_captive_portal_uri) + 1);
        if (portal_option_err != ESP_OK)
            ESP_LOGW(TAG, "Could not advertise captive portal URI: %s", esp_err_to_name(portal_option_err));
    } else {
        ESP_LOGW(TAG, "Could not read fallback AP IPv4 configuration");
    }

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
            const size_t ssid_length = std::min(network.ssid.size(), sizeof(sta.sta.ssid));
            std::memcpy(sta.sta.ssid, network.ssid.data(), ssid_length);
            const size_t password_length = std::min(network.password.size(), sizeof(sta.sta.password) - 1);
            std::memcpy(sta.sta.password, network.password.data(), password_length);
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
            if (!s_keep_ap && s_ap_netif) {
                if (esp_wifi_set_mode(WIFI_MODE_STA) == ESP_OK) s_ap_running.store(false);
            }
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
    s_wifi_log_queue = xQueueCreate(8, sizeof(WifiLogEvent));
    if (!s_wifi_log_queue) return ESP_ERR_NO_MEM;
    (void)esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &event_handler, nullptr);
    (void)esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &event_handler, nullptr);
    s_events = xEventGroupCreate();
    if (!s_events) return ESP_ERR_NO_MEM;
    err = esp_wifi_set_storage(WIFI_STORAGE_RAM);
    if (err == ESP_OK) err = esp_wifi_set_mode(WIFI_MODE_STA);
    if (err == ESP_OK) err = esp_wifi_start();
    if (err != ESP_OK) return err;
    if (xTaskCreate(wifi_log_worker, "wifi_log", 4096, nullptr, 3, nullptr) != pdPASS)
        return ESP_ERR_NO_MEM;
    if (xTaskCreate(captive_dns_worker, "captive_dns", 4096, nullptr, 3, nullptr) != pdPASS)
        return ESP_ERR_NO_MEM;
    if (xTaskCreate(connect_worker, "wifi_connect", 4096, nullptr, 4, nullptr) != pdPASS)
        return ESP_ERR_NO_MEM;
    return ESP_OK;
}

uint32_t wifi_manager_ap_ip() { return s_ap_ip_addr.load(); }
bool wifi_manager_ap_is_running() { return s_ap_running.load(); }

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
