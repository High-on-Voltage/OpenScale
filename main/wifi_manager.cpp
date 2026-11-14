#include "wifi_manager.hpp"

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

esp_err_t WifiManager::start(const Settings& settings) {
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

    if (settings.wifi_ssid[0] == '\0') {
        ESP_LOGW(kTag, "No station SSID configured; starting fallback access point");
        return start_access_point(settings);
    }

    esp_netif_set_hostname(sta_netif_, settings.hostname);
    wifi_config_t station_config{};
    std::memcpy(station_config.sta.ssid, settings.wifi_ssid, std::strlen(settings.wifi_ssid));
    std::memcpy(station_config.sta.password, settings.wifi_password, std::strlen(settings.wifi_password));
    station_config.sta.threshold.authmode = settings.wifi_password[0] == '\0' ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA2_PSK;
    station_config.sta.pmf_cfg.capable = true;
    station_config.sta.pmf_cfg.required = false;

    ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_STA), kTag, "set station mode");
    ESP_RETURN_ON_ERROR(esp_wifi_set_config(WIFI_IF_STA, &station_config), kTag, "configure station");
    ESP_RETURN_ON_ERROR(esp_wifi_start(), kTag, "start Wi-Fi");

    const EventBits_t bits = xEventGroupWaitBits(event_group_, kConnectedBit | kFailedBit,
                                                  pdTRUE, pdFALSE,
                                                  pdMS_TO_TICKS(settings.sta_timeout_ms));
    if ((bits & kConnectedBit) != 0) return ESP_OK;

    ESP_LOGW(kTag, "Could not connect to configured Wi-Fi; switching to fallback AP");
    esp_wifi_stop();
    return start_access_point(settings);
}

esp_err_t WifiManager::start_access_point(const Settings& settings) {
    std::uint8_t mac[6]{};
    ESP_RETURN_ON_ERROR(esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP), kTag, "read SoftAP MAC");

    char ssid[33]{};
    char password[16]{};
    std::snprintf(ssid, sizeof(ssid), "%s-%02X%02X", settings.ap_ssid_prefix, mac[4], mac[5]);
    std::snprintf(password, sizeof(password), "s%02X%02X%02X%02X", mac[2], mac[3], mac[4], mac[5]);

    wifi_config_t ap_config{};
    std::snprintf(reinterpret_cast<char*>(ap_config.ap.ssid), sizeof(ap_config.ap.ssid), "%s", ssid);
    std::snprintf(reinterpret_cast<char*>(ap_config.ap.password), sizeof(ap_config.ap.password), "%s", password);
    ap_config.ap.ssid_len = std::strlen(ssid);
    ap_config.ap.channel = 1;
    ap_config.ap.max_connection = 4;
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
