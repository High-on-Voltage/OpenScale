#include "serial_console.hpp"

#include <cstdio>
#include <cstring>

#include "config_store.hpp"
#include "esp_check.h"
#include "esp_console.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "security.hpp"

namespace app {
namespace {
constexpr char kTag[] = "serial";
Settings* s_settings = nullptr;

int command_status(int, char**) {
    if (s_settings == nullptr) return 1;
    std::printf("Hostname: %s\n", s_settings->hostname);
    std::printf("Wi-Fi SSID: %s\n", s_settings->wifi_ssid[0] != '\0' ? s_settings->wifi_ssid : "<not configured>");
    std::printf("HTTP enabled: %s\n", s_settings->http_enabled ? "yes" : "no");
    std::printf("Admin password: %s\n", s_settings->admin_hash_hex[0] != '\0' ? "configured" : "not configured");
    return 0;
}

int command_set_password(int argc, char** argv) {
    if (s_settings == nullptr || argc != 2) {
        std::printf("Usage: set-password <new-password-at-least-8-characters>\n");
        return 1;
    }
    const esp_err_t err = security::set_admin_password(*s_settings, argv[1]);
    if (err != ESP_OK) {
        std::printf("Password rejected. Use 8-128 characters.\n");
        return 1;
    }
    if (!config_store::save_settings_struct(*s_settings)) {
        std::printf("Could not save settings.\n");
        return 1;
    }
    std::printf("Admin password updated. Restarting...\n");
    vTaskDelay(pdMS_TO_TICKS(300));
    esp_restart();
    return 0;
}

int command_clear_password(int argc, char**) {
    if (s_settings == nullptr || argc != 1) {
        std::printf("Usage: clear-password\n");
        return 1;
    }
    s_settings->admin_salt_hex[0] = '\0';
    s_settings->admin_hash_hex[0] = '\0';
    if (!config_store::save_settings_struct(*s_settings)) {
        std::printf("Could not save settings.\n");
        return 1;
    }
    std::printf("Admin password cleared. Restarting...\n");
    vTaskDelay(pdMS_TO_TICKS(300));
    esp_restart();
    return 0;
}

int command_set_http(int argc, char** argv) {
    if (s_settings == nullptr || argc != 2 || (std::strcmp(argv[1], "on") != 0 && std::strcmp(argv[1], "off") != 0)) {
        std::printf("Usage: set-http on|off\n");
        return 1;
    }
    s_settings->http_enabled = std::strcmp(argv[1], "on") == 0;
    if (!config_store::save_settings_struct(*s_settings)) {
        std::printf("Could not save settings.\n");
        return 1;
    }
    std::printf("HTTP %s. Restarting...\n", s_settings->http_enabled ? "enabled" : "disabled");
    vTaskDelay(pdMS_TO_TICKS(300));
    esp_restart();
    return 0;
}

int command_set_wifi(int argc, char** argv) {
    if (s_settings == nullptr || argc != 3) {
        std::printf("Usage: set-wifi <ssid> <password-or-dash-for-open-network>\n");
        return 1;
    }
    if (std::strlen(argv[1]) > kMaxSsid || std::strlen(argv[2]) > kMaxWifiPassword) {
        std::printf("SSID or password is too long.\n");
        return 1;
    }
    std::snprintf(s_settings->wifi_ssid, sizeof(s_settings->wifi_ssid), "%s", argv[1]);
    std::snprintf(s_settings->wifi_password, sizeof(s_settings->wifi_password), "%s", std::strcmp(argv[2], "-") == 0 ? "" : argv[2]);
    if (s_settings->wifi_password[0] != '\0' && std::strlen(s_settings->wifi_password) < 8U) {
        std::printf("Wi-Fi password must be empty or at least 8 characters.\n");
        return 1;
    }
    if (!config_store::save_settings_struct(*s_settings)) {
        std::printf("Could not save settings.\n");
        return 1;
    }
    std::printf("Wi-Fi settings saved. Restarting...\n");
    vTaskDelay(pdMS_TO_TICKS(300));
    esp_restart();
    return 0;
}

esp_err_t register_command(const char* command, const char* help, esp_console_cmd_func_t function) {
    esp_console_cmd_t config{};
    config.command = command;
    config.help = help;
    config.func = function;
    return esp_console_cmd_register(&config);
}
}  // namespace

esp_err_t start_serial_console(Settings* settings) {
    if (settings == nullptr) return ESP_ERR_INVALID_ARG;
    s_settings = settings;

    esp_console_config_t console_config = ESP_CONSOLE_CONFIG_DEFAULT();
    console_config.max_cmdline_length = 256;
    esp_err_t err = esp_console_init(&console_config);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;

    ESP_RETURN_ON_ERROR(esp_console_register_help_command(), kTag, "register help command");
    ESP_RETURN_ON_ERROR(register_command("status", "Show non-secret configuration status", command_status), kTag, "register status");
    ESP_RETURN_ON_ERROR(register_command("set-password", "Set the HTTP admin password", command_set_password), kTag, "register set-password");
    ESP_RETURN_ON_ERROR(register_command("clear-password", "Remove the HTTP admin password", command_clear_password), kTag, "register clear-password");
    ESP_RETURN_ON_ERROR(register_command("set-http", "Enable or disable plain HTTP", command_set_http), kTag, "register set-http");
    ESP_RETURN_ON_ERROR(register_command("set-wifi", "Set station SSID and password", command_set_wifi), kTag, "register set-wifi");

    esp_console_repl_t* repl = nullptr;
    esp_console_repl_config_t repl_config = ESP_CONSOLE_REPL_CONFIG_DEFAULT();
    repl_config.prompt = "sensor-node> ";
    repl_config.max_cmdline_length = 256;
    esp_console_dev_uart_config_t uart_config = ESP_CONSOLE_DEV_UART_CONFIG_DEFAULT();
    ESP_RETURN_ON_ERROR(esp_console_new_repl_uart(&uart_config, &repl_config, &repl), kTag, "create UART console");
    ESP_RETURN_ON_ERROR(esp_console_start_repl(repl), kTag, "start UART console");
    ESP_LOGI(kTag, "Serial console ready (115200 baud)");
    return ESP_OK;
}

}  // namespace app
