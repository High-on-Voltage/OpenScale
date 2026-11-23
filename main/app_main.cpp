#include <cstdio>

#include "esp_err.h"
#include "esp_log.h"
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

void install_recovery_sensor_config() {
    g_sensor_config = {};
    g_sensor_config.count = 1;
    g_sensor_config.queue_capacity = 128;
    g_sensor_config.items[0].id = 0;
    std::snprintf(g_sensor_config.items[0].name, sizeof(g_sensor_config.items[0].name), "Unconfigured sensor");
    std::snprintf(g_sensor_config.items[0].type, sizeof(g_sensor_config.items[0].type), "hx711");
    g_sensor_config.items[0].enabled = false;
    g_sensor_config.items[0].ring_buffer_samples = 1;
}
}  // namespace

extern "C" void app_main(void) {
    ESP_LOGI(kTag, "Starting OpenScale firmware v%s (WebUI v%s)", app::version::firmware, app::version::webui);
    initialize_nvs();

    // Keep UART available even when storage cannot be mounted.
    const esp_err_t console_error = app::start_serial_console(&g_settings);
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
        ESP_LOGE(kTag, "Settings could not be loaded: %s. Network services will remain disabled until repaired over serial.", error);
        g_settings = app::Settings{};
        g_settings.http_enabled = false;
    }
    if (!app::config_store::load_sensors(g_sensor_config, error, sizeof(error))) {
        ESP_LOGE(kTag, "Sensor configuration could not be loaded: %s. Sensor acquisition disabled until repaired.", error);
        install_recovery_sensor_config();
    }

    if (g_sensors.initialize(g_sensor_config, g_settings.max_ring_buffer_bytes)) {
        if (!g_sensors.start()) ESP_LOGE(kTag, "Sensor manager could not start");
    } else {
        ESP_LOGE(kTag, "Sensor manager initialization failed; check ring buffer memory budget and sensors.json");
    }

    if (settings_valid) {
        const esp_err_t wifi_error = g_wifi.start(g_settings);
        if (wifi_error != ESP_OK) ESP_LOGE(kTag, "Wi-Fi initialization failed: %s", esp_err_to_name(wifi_error));
    } else {
        ESP_LOGW(kTag, "Wi-Fi startup skipped because settings.json is invalid");
    }

    if (g_settings.http_enabled && settings_valid) {
        const esp_err_t http_error = app::start_http_server(g_settings, &g_sensors);
        if (http_error != ESP_OK) ESP_LOGE(kTag, "HTTP server could not start: %s", esp_err_to_name(http_error));
    } else {
        ESP_LOGW(kTag, "Plain HTTP disabled in settings.json. No HTTPS server is included in this milestone.");
    }

    ESP_LOGI(kTag, "Initialization complete");
    while (true) vTaskDelay(pdMS_TO_TICKS(1000));
}
