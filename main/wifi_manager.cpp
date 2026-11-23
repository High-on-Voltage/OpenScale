#include "wifi_manager.hpp"

#include <algorithm>
#include <cstdio>
#include <cstring>

#include "esp_check.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_wifi.h"
#include "freertos/task.h"

namespace app {
namespace {
constexpr char kTag[] = "wifi";
constexpr EventBits_t kConnectedBit = BIT0;
constexpr EventBits_t kFailedBit = BIT1;
constexpr int kMaxStaRetries = 3;
constexpr std::uint32_t kPerNetworkTimeoutMs = 15000;
}  // namespace

void WifiManager::event_handler(void* argument, esp_event_base_t event_base,
                                std::int32_t event_id, void* event_data) {
    static_cast<WifiManager*>(argument)->on_event(event_base, event_id, event_data);
}

void WifiManager::on_event(esp_event_base_t event_base, std::int32_t event_id, void* event_data) {
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        station_connected_ = false;
        if (retry_count_ < kMaxStaRetries) {
            ++retry_count_;
            ESP_LOGW(kTag, "Station disconnected; retry %d/%d", retry_count_, kMaxStaRetries);
            esp_wifi_connect();
        } else if (event_group_ != nullptr) {
            xEventGroupSetBits(event_group_, kFailedBit);
        }
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        const auto* event = static_cast<ip_event_got_ip_t*>(event_data);
        station_connected_ = true;
        retry_count_ = 0;
        ESP_LOGI(kTag, "Connected; IPv4 address: " IPSTR, IP2STR(&event->ip_info.ip));
        if (event_group_ != nullptr) xEventGroupSetBits(event_group_, kConnectedBit);
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_AP_STACONNECTED) {
        const auto* event = static_cast<wifi_event_ap_staconnected_t*>(event_data);
        ESP_LOGI(kTag, "AP client connected: " MACSTR, MAC2STR(event->mac));
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_AP_STADISCONNECTED) {
        const auto* event = static_cast<wifi_event_ap_stadisconnected_t*>(event_data);
        ESP_LOGI(kTag, "AP client disconnected: " MACSTR, MAC2STR(event->mac));
    }
}

esp_err_t WifiManager::start(const Settings& settings, const WifiConfig& wifi) {
    esp_err_t err = esp_netif_init();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;
    err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;

    sta_netif_ = esp_netif_create_default_wifi_sta();
    ap_netif_ = esp_netif_create_default_wifi_ap();
    if (sta_netif_ == nullptr || ap_netif_ == nullptr) return ESP_FAIL;

    wifi_init_config_t init_config = WIFI_INIT_CONFIG_DEFAULT();
    err = esp_wifi_init(&init_config);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;
    esp_wifi_set_storage(WIFI_STORAGE_RAM);
    event_group_ = xEventGroupCreate();
    if (event_group_ == nullptr) return ESP_ERR_NO_MEM;

    ESP_RETURN_ON_ERROR(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &WifiManager::event_handler, this), kTag, "register Wi-Fi event handler");
    ESP_RETURN_ON_ERROR(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &WifiManager::event_handler, this), kTag, "register IP event handler");

    if (settings.hostname[0] != '\0') esp_netif_set_hostname(sta_netif_, settings.hostname);

    // The current station connector tries the full configured list in priority order.
    // Stable order is retained for equal priorities, as required by wifi.json.
    std::size_t order[kMaxWifiNetworks]{};
    for (std::size_t i = 0; i < wifi.network_count; ++i) order[i] = i;
    std::stable_sort(order, order + wifi.network_count, [&wifi](std::size_t a, std::size_t b) {
        return wifi.networks[a].priority > wifi.networks[b].priority;
    });

    for (std::size_t attempt = 0; attempt < wifi.network_count; ++attempt) {
        const WifiNetwork& network = wifi.networks[order[attempt]];
        retry_count_ = 0;
        station_connected_ = false;
        xEventGroupClearBits(event_group_, kConnectedBit | kFailedBit);
        wifi_config_t station_config{};
        std::memcpy(station_config.sta.ssid, network.ssid, std::strlen(network.ssid));
        std::memcpy(station_config.sta.password, network.password, std::strlen(network.password));
        station_config.sta.threshold.authmode = network.password[0] == '\0' ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA2_PSK;
        station_config.sta.pmf_cfg.capable = true;
        station_config.sta.pmf_cfg.required = false;

        esp_wifi_stop();  // ESP_ERR_WIFI_NOT_STARTED is expected on the first iteration.
        ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_STA), kTag, "set station mode");
        ESP_RETURN_ON_ERROR(esp_wifi_set_config(WIFI_IF_STA, &station_config), kTag, "configure station");
        err = esp_wifi_start();
        if (err != ESP_OK) return err;
        const EventBits_t bits = xEventGroupWaitBits(event_group_, kConnectedBit | kFailedBit,
                                                      pdTRUE, pdFALSE,
                                                      pdMS_TO_TICKS(kPerNetworkTimeoutMs));
        if ((bits & kConnectedBit) != 0) {
            if (wifi.keep_ap_when_connected && wifi.ap_enabled) {
                // Keep the AP alongside STA only when explicitly requested.
                wifi_config_t ap_config{};
                std::uint8_t mac[6]{};
                ESP_RETURN_ON_ERROR(esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP), kTag, "read SoftAP MAC");
                char ssid[33]{};
                char generated_password[16]{};
                std::snprintf(ssid, sizeof(ssid), "%s-%02X%02X", wifi.ap_ssid_prefix, mac[4], mac[5]);
                if (wifi.ap_password[0] == '\0') {
                    std::snprintf(generated_password, sizeof(generated_password), "s%02X%02X%02X%02X", mac[2], mac[3], mac[4], mac[5]);
                }
                const char* ap_password = wifi.ap_password[0] != '\0' ? wifi.ap_password : generated_password;
                std::snprintf(reinterpret_cast<char*>(ap_config.ap.ssid), sizeof(ap_config.ap.ssid), "%s", ssid);
                std::snprintf(reinterpret_cast<char*>(ap_config.ap.password), sizeof(ap_config.ap.password), "%s", ap_password);
                ap_config.ap.ssid_len = std::strlen(ssid);
                ap_config.ap.channel = wifi.ap_channel;
                ap_config.ap.max_connection = wifi.ap_max_stations;
                ap_config.ap.authmode = WIFI_AUTH_WPA2_PSK;
                ESP_RETURN_ON_ERROR(esp_wifi_set_config(WIFI_IF_AP, &ap_config), kTag, "configure retained AP");
                ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_APSTA), kTag, "enable AP+STA");
                access_point_active_ = true;
                ESP_LOGW(kTag, "Retained AP active. SSID: %s | password: %s", ssid, ap_password);
            }
            ESP_LOGI(kTag, "Connected using configured Wi-Fi network ID %u", network.id);
            return ESP_OK;
        }
        ESP_LOGW(kTag, "Wi-Fi network ID %u did not connect within %u ms", network.id, kPerNetworkTimeoutMs);
        esp_wifi_stop();
    }

    if (wifi.ap_enabled) {
        ESP_LOGW(kTag, "No station network connected; starting configured fallback AP");
        return start_access_point(wifi);
    }
    ESP_LOGE(kTag, "No station network connected and fallback AP is disabled");
    return ESP_FAIL;
}

esp_err_t WifiManager::start_access_point(const WifiConfig& wifi) {
    std::uint8_t mac[6]{};
    ESP_RETURN_ON_ERROR(esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP), kTag, "read SoftAP MAC");

    char ssid[33]{};
    char generated_password[16]{};
    std::snprintf(ssid, sizeof(ssid), "%s-%02X%02X", wifi.ap_ssid_prefix, mac[4], mac[5]);
    if (wifi.ap_password[0] == '\0')
        std::snprintf(generated_password, sizeof(generated_password), "s%02X%02X%02X%02X", mac[2], mac[3], mac[4], mac[5]);
    const char* password = wifi.ap_password[0] != '\0' ? wifi.ap_password : generated_password;

    wifi_config_t ap_config{};
    std::snprintf(reinterpret_cast<char*>(ap_config.ap.ssid), sizeof(ap_config.ap.ssid), "%s", ssid);
    std::snprintf(reinterpret_cast<char*>(ap_config.ap.password), sizeof(ap_config.ap.password), "%s", password);
    ap_config.ap.ssid_len = std::strlen(ssid);
    ap_config.ap.channel = wifi.ap_channel;
    ap_config.ap.max_connection = wifi.ap_max_stations;
    ap_config.ap.authmode = WIFI_AUTH_WPA2_PSK;
    ap_config.ap.pmf_cfg.required = false;

    ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_AP), kTag, "set AP mode");
    ESP_RETURN_ON_ERROR(esp_wifi_set_config(WIFI_IF_AP, &ap_config), kTag, "configure AP");
    ESP_RETURN_ON_ERROR(esp_wifi_start(), kTag, "start AP");
    access_point_active_ = true;
    ESP_LOGW(kTag, "Fallback AP started. SSID: %s | password: %s | gateway: 192.168.4.1", ssid, password);
    return ESP_OK;
}

}  // namespace app
