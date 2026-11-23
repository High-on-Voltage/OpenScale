#include <cstdio>
#include <cstring>

#include "esp_err.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "esp_system.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "app_types.hpp"
#include "config_store.hpp"
#include "http_server.hpp"
#include "sensor_manager.hpp"
#include "serial_console.hpp"
#include "wifi_manager.hpp"
#include "version.hpp"

namespace {
constexpr char kTag[] = "app";
app::Settings g_settings{};
app::WifiConfig g_wifi_config{};
app::SensorConfigList g_sensor_config{};
app::SensorManager g_sensors;
app::WifiManager g_wifi;

void initialize_nvs() {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);
}

void generate_hostname() {
    if (g_settings.hostname[0] != '\0') return;
    std::uint8_t mac[6]{};
    if (esp_read_mac(mac, ESP_MAC_WIFI_STA) == ESP_OK) {
        std::snprintf(g_settings.hostname, sizeof(g_settings.hostname),
                      "openscale_%02x%02x%02x", mac[3], mac[4], mac[5]);
    }
}

void generate_ap_password_if_needed(bool wifi_config_valid) {
    if (!g_wifi_config.ap_enabled || g_wifi_config.ap_password[0] != '\0') return;
    static constexpr char alphabet[] = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    std::uint8_t random[16]{};
    esp_fill_random(random, sizeof(random));
    for (std::size_t i = 0; i < sizeof(random); ++i)
        g_wifi_config.ap_password[i] = alphabet[random[i] % (sizeof(alphabet) - 1U)];
    g_wifi_config.ap_password[sizeof(random)] = '\0';
    if (wifi_config_valid && !app::config_store::save_wifi_struct(g_wifi_config))
        ESP_LOGW(kTag, "Generated AP password could not be saved; it remains active for this boot");
}

void install_empty_sensor_config() {
    g_sensor_config = {};
    g_sensor_config.queue_capacity = g_settings.queue_capacity;
}
}  // namespace

extern "C" void app_main(void) {
    ESP_LOGI(kTag, "Starting OpenScale firmware v%s (WebUI v%s)", app::version::firmware, app::version::webui);
    initialize_nvs();

    // Keep UART available even when storage or configuration is unavailable.
    const esp_err_t console_error = app::start_serial_console(&g_settings, &g_wifi_config);
    if (console_error != ESP_OK) ESP_LOGE(kTag, "Serial console could not start: %s", esp_err_to_name(console_error));

    const esp_err_t filesystem_error = app::config_store::init_filesystem();
    if (filesystem_error != ESP_OK) {
        ESP_LOGE(kTag, "Storage initialization failed: %s. Network services remain disabled; UART stays available.",
                 esp_err_to_name(filesystem_error));
        while (true) vTaskDelay(pdMS_TO_TICKS(1000));
    }

    char error[192]{};
    const bool settings_valid = app::config_store::load_settings(g_settings, error, sizeof(error));
    if (!settings_valid) {
        ESP_LOGE(kTag, "config_fallback: settings.json unavailable/invalid (%s); in-memory defaults active; saved file untouched", error);
        app::record_device_log("config_fallback", "Could not load settings.json; in-memory defaults are active", "settings.json", error);
        g_settings = app::Settings{};
    }
    const bool wifi_valid = app::config_store::load_wifi(g_wifi_config, error, sizeof(error));
    if (!wifi_valid) {
        ESP_LOGE(kTag, "config_fallback: wifi.json unavailable/invalid (%s); in-memory factory AP defaults active; saved file untouched", error);
        app::record_device_log("config_fallback", "Could not load wifi.json; factory Wi-Fi defaults are active", "wifi.json", error);
        g_wifi_config = app::WifiConfig{};
    }
    generate_ap_password_if_needed(wifi_valid);

    if (settings_valid && g_settings.hostname[0] == '\0') {
        generate_hostname();
        if (!app::config_store::save_settings_struct(g_settings))
            ESP_LOGW(kTag, "Generated hostname could not be saved; it remains active for this boot");
    } else if (!settings_valid) {
        generate_hostname();  // Do not repair or overwrite a corrupt saved settings file.
    }

    if (!app::config_store::load_sensors(g_sensor_config, error, sizeof(error))) {
        ESP_LOGE(kTag, "config_fallback: sensors.json unavailable/invalid (%s); no sensors active; saved file untouched", error);
        install_empty_sensor_config();
    }
    g_sensor_config.queue_capacity = g_settings.queue_capacity;

    if (g_sensors.initialize(g_sensor_config, g_settings.ringbuffer_max_total_size_bytes)) {
        if (!g_sensors.start()) ESP_LOGE(kTag, "Sensor manager could not start");
    } else {
        ESP_LOGE(kTag, "Sensor manager initialization failed; check buffer budget and sensors.json");
    }

    // Network services remain available with factory defaults after config fallback.
    const esp_err_t wifi_error = g_wifi.start(g_settings, g_wifi_config);
    if (wifi_error != ESP_OK) ESP_LOGE(kTag, "Wi-Fi initialization failed: %s", esp_err_to_name(wifi_error));

    const esp_err_t http_error = app::start_http_server(g_settings, &g_sensors);
    if (http_error != ESP_OK) ESP_LOGE(kTag, "HTTP server could not start: %s", esp_err_to_name(http_error));

    ESP_LOGI(kTag, "Initialization complete");
    while (true) vTaskDelay(pdMS_TO_TICKS(1000));
}
