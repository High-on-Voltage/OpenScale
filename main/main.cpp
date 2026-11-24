#include "build_info.h"
#include "webui_build_info.h"
#include "device_log.hpp"
#include "event_bus.hpp"
#include "sensor_pipeline.hpp"
#include "serial_console.hpp"
#include "storage.hpp"
#include "web_server.hpp"
#include "wifi_manager.hpp"
#include "system_state.hpp"
#include "freertos/FreeRTOS.h"
#include <array>
#include <cstring>
#include <string>
#include "esp_log.h"
#include "esp_random.h"
#include "nvs_flash.h"
#include <cstdio>

namespace openscale {
namespace {
char s_boot_id[9]{};
char s_csrf_token[33]{};
std::array<std::array<char, 40>, 5> s_pending_changes{};
portMUX_TYPE s_state_mux = portMUX_INITIALIZER_UNLOCKED;
void random_hex(char *out, size_t bytes) {
    static constexpr char hex[] = "0123456789abcdef";
    for (size_t i = 0; i < bytes; ++i) {
        const uint8_t value = static_cast<uint8_t>(esp_random());
        out[i * 2] = hex[value >> 4];
        out[i * 2 + 1] = hex[value & 0x0F];
    }
    out[bytes * 2] = '\0';
}
}
const char *boot_id() { return s_boot_id; }
const char *csrf_token() { return s_csrf_token; }
void system_state_init() {
    random_hex(s_boot_id, 4);
    random_hex(s_csrf_token, 16);
    pending_changes_clear();
}
void pending_change_add(const char *resource) {
    if (!resource || !resource[0]) return;
    portENTER_CRITICAL(&s_state_mux);
    size_t free_slot = s_pending_changes.size();
    for (size_t i = 0; i < s_pending_changes.size(); ++i) {
        if (std::strcmp(s_pending_changes[i].data(), resource) == 0) { portEXIT_CRITICAL(&s_state_mux); return; }
        if (!s_pending_changes[i][0] && free_slot == s_pending_changes.size()) free_slot = i;
    }
    if (free_slot < s_pending_changes.size()) std::snprintf(s_pending_changes[free_slot].data(), s_pending_changes[free_slot].size(), "%s", resource);
    portEXIT_CRITICAL(&s_state_mux);
}
void pending_changes_clear() {
    portENTER_CRITICAL(&s_state_mux);
    for (auto &entry : s_pending_changes) entry.fill(0);
    portEXIT_CRITICAL(&s_state_mux);
}
std::string pending_changes_json() {
    std::array<std::array<char, 40>, 5> copy{};
    portENTER_CRITICAL(&s_state_mux);
    copy = s_pending_changes;
    portEXIT_CRITICAL(&s_state_mux);
    std::string result = "[";
    bool first = true;
    for (const auto &entry : copy) if (entry[0]) {
        if (!first) result += ",";
        first = false;
        result += "\"" + std::string(entry.data()) + "\"";
    }
    result += "]";
    return result;
}
}

extern "C" void app_main(void) {
    ESP_LOGI("openscale", "OpenScale firmware %s (build %s, git %s)",
             OPEN_SCALE_FIRMWARE_VERSION, OPEN_SCALE_BUILD_ID, OPEN_SCALE_GIT_COMMIT);
    ESP_LOGI("openscale", "WebUI version %s; protocol v%d", OPEN_SCALE_WEBUI_VERSION, OPEN_SCALE_PROTOCOL_VERSION);

    const esp_err_t nvs_err = nvs_flash_init();
    if (nvs_err == ESP_ERR_NVS_NO_FREE_PAGES || nvs_err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGE("openscale", "NVS initialisation requires recovery; not erasing NVS automatically");
    } else if (nvs_err != ESP_OK) {
        ESP_LOGE("openscale", "NVS init: %s", esp_err_to_name(nvs_err));
    }

    openscale::system_state_init();
    openscale::event_bus_init(openscale::boot_id());
    openscale::device_log_init();
    const esp_err_t fs_err = openscale::storage::init();
    if (fs_err != ESP_OK) {
        openscale::device_log_add("network_error", "Storage unavailable; configuration and persistent assets are unavailable",
                                  "{\"interface\":\"fatfs\",\"code\":\"mount_failed\"}");
    }

    (void)openscale::wifi_manager_start();
    openscale::sensor_pipeline_init();
    (void)openscale::web_server_start();
    (void)openscale::serial_console_start();
}
