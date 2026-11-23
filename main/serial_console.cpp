#include "serial_console.hpp"

#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <cstdint>

#include "config_store.hpp"
#include "esp_check.h"
#include "esp_console.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "security.hpp"
#include "version.hpp"

namespace app {
namespace {
constexpr char kTag[] = "serial";
Settings* s_settings = nullptr;
WifiConfig* s_wifi = nullptr;

int command_status(int, char**) {
    if (s_settings == nullptr || s_wifi == nullptr) return 1;
    std::printf("Firmware: v%s\nWebUI: v%s\n", version::firmware, version::webui);
    std::printf("Hostname: %s\n", s_settings->hostname[0] ? s_settings->hostname : "<generated at startup>");
    std::printf("Wi-Fi networks: %u\n", static_cast<unsigned>(s_wifi->network_count));
    std::printf("Fallback AP: %s\n", s_wifi->ap_enabled ? "enabled" : "disabled");
    std::printf("Admin password: %s\n", s_settings->admin_hash_hex[0] ? "configured" : "not configured");
    return 0;
}

int command_password_set(int argc, char** argv) {
    if (s_settings == nullptr || argc != 2) {
        std::printf("Usage: password_set <new-password-at-least-8-characters>\n");
        return 1;
    }
    const esp_err_t err = security::set_admin_password(*s_settings, argv[1]);
    if (err != ESP_OK || !config_store::save_settings_struct(*s_settings)) {
        std::printf("Password rejected or could not be saved.\n");
        return 1;
    }
    std::printf("Administrator password updated. Restarting...\n");
    vTaskDelay(pdMS_TO_TICKS(300));
    esp_restart();
    return 0;
}

int command_password_clear(int argc, char**) {
    if (s_settings == nullptr || argc != 1) {
        std::printf("Usage: password_clear\n");
        return 1;
    }
    s_settings->admin_salt_hex[0] = '\0';
    s_settings->admin_hash_hex[0] = '\0';
    if (!config_store::save_settings_struct(*s_settings)) {
        std::printf("Could not save settings.\n");
        return 1;
    }
    std::printf("Administrator password cleared. Restarting...\n");
    vTaskDelay(pdMS_TO_TICKS(300));
    esp_restart();
    return 0;
}

int command_wifi_set(int argc, char** argv) {
    if (s_wifi == nullptr || argc != 4) {
        std::printf("Usage: wifi_set <ssid> <password-or-dash> <priority>\n");
        return 1;
    }
    if (std::strlen(argv[1]) == 0U || std::strlen(argv[1]) > kMaxSsid || std::strlen(argv[2]) > kMaxWifiPassword) {
        std::printf("SSID or password length is invalid.\n");
        return 1;
    }
    char* end = nullptr;
    const long priority = std::strtol(argv[3], &end, 10);
    if (end == argv[3] || *end != '\0' || priority < INT32_MIN || priority > INT32_MAX) {
        std::printf("Priority must be a signed 32-bit integer.\n");
        return 1;
    }
    std::size_t index = 0;
    while (index < s_wifi->network_count && std::strcmp(s_wifi->networks[index].ssid, argv[1]) != 0) ++index;
    if (index == s_wifi->network_count) {
        if (s_wifi->network_count >= kMaxWifiNetworks) {
            std::printf("Maximum saved network count reached.\n");
            return 1;
        }
        ++s_wifi->network_count;
    }
    WifiNetwork network = s_wifi->networks[index];
    if (network.id == 0) {
        std::uint16_t candidate = 1;
        bool used = true;
        while (used && candidate != 0) {
            used = false;
            for (std::size_t i = 0; i < s_wifi->network_count; ++i)
                if (i != index && s_wifi->networks[i].id == candidate) used = true;
            if (used) ++candidate;
        }
        if (candidate == 0) { std::printf("No free network IDs remain.\n"); return 1; }
        network.id = candidate;
    }
    std::snprintf(network.ssid, sizeof(network.ssid), "%s", argv[1]);
    if (std::strcmp(argv[2], "-") != 0) {
        if (argv[2][0] != '\0' && std::strlen(argv[2]) < 8U) {
            std::printf("Wi-Fi password must be empty or at least 8 characters.\n");
            return 1;
        }
        std::snprintf(network.password, sizeof(network.password), "%s", argv[2]);
    }
    network.priority = static_cast<std::int32_t>(priority);
    s_wifi->networks[index] = network;
    if (!config_store::save_wifi_struct(*s_wifi)) {
        std::printf("Could not save wifi.json.\n");
        return 1;
    }
    std::printf("Wi-Fi network saved. Restarting...\n");
    vTaskDelay(pdMS_TO_TICKS(300));
    esp_restart();
    return 0;
}

int command_wifi_clear(int argc, char**) {
    if (s_wifi == nullptr || argc != 1) {
        std::printf("Usage: wifi_clear\n");
        return 1;
    }
    s_wifi->network_count = 0;
    if (!config_store::save_wifi_struct(*s_wifi)) {
        std::printf("Could not save wifi.json.\n");
        return 1;
    }
    std::printf("Station networks cleared. Restarting...\n");
    vTaskDelay(pdMS_TO_TICKS(300));
    esp_restart();
    return 0;
}

int command_hostname_set(int argc, char** argv) {
    if (s_settings == nullptr || argc != 2 || std::strlen(argv[1]) >= sizeof(s_settings->hostname)) {
        std::printf("Usage: hostname_set <hostname-without-.local>\n");
        return 1;
    }
    std::snprintf(s_settings->hostname, sizeof(s_settings->hostname), "%s", argv[1]);
    if (!config_store::save_settings_struct(*s_settings)) {
        std::printf("Could not save settings.json.\n");
        return 1;
    }
    std::printf("Hostname saved. Restarting...\n");
    vTaskDelay(pdMS_TO_TICKS(300));
    esp_restart();
    return 0;
}

int command_debug_set(int argc, char** argv) {
    if (argc != 2) {
        std::printf("Usage: debug_set <none|error|warn|info|debug|verbose>\n");
        return 1;
    }
    esp_log_level_t level;
    if (!std::strcmp(argv[1], "none")) level = ESP_LOG_NONE;
    else if (!std::strcmp(argv[1], "error")) level = ESP_LOG_ERROR;
    else if (!std::strcmp(argv[1], "warn")) level = ESP_LOG_WARN;
    else if (!std::strcmp(argv[1], "info")) level = ESP_LOG_INFO;
    else if (!std::strcmp(argv[1], "debug")) level = ESP_LOG_DEBUG;
    else if (!std::strcmp(argv[1], "verbose")) level = ESP_LOG_VERBOSE;
    else { std::printf("Unknown log level.\n"); return 1; }
    esp_log_level_set("*", level);
    std::printf("Log level updated for this boot.\n");
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

esp_err_t start_serial_console(Settings* settings, WifiConfig* wifi) {
    if (settings == nullptr || wifi == nullptr) return ESP_ERR_INVALID_ARG;
    s_settings = settings;
    s_wifi = wifi;

    esp_console_config_t console_config = ESP_CONSOLE_CONFIG_DEFAULT();
    console_config.max_cmdline_length = 256;
    esp_err_t err = esp_console_init(&console_config);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;

    ESP_RETURN_ON_ERROR(esp_console_register_help_command(), kTag, "register help command");
    ESP_RETURN_ON_ERROR(register_command("status", "Show non-secret configuration status", command_status), kTag, "register status");
    ESP_RETURN_ON_ERROR(register_command("password_set", "Set the HTTP administrator password", command_password_set), kTag, "register password_set");
    ESP_RETURN_ON_ERROR(register_command("password_clear", "Clear the HTTP administrator password", command_password_clear), kTag, "register password_clear");
    ESP_RETURN_ON_ERROR(register_command("wifi_set", "Set a station network", command_wifi_set), kTag, "register wifi_set");
    ESP_RETURN_ON_ERROR(register_command("wifi_clear", "Clear station networks", command_wifi_clear), kTag, "register wifi_clear");
    ESP_RETURN_ON_ERROR(register_command("hostname_set", "Set the device hostname", command_hostname_set), kTag, "register hostname_set");
    ESP_RETURN_ON_ERROR(register_command("debug_set", "Set the runtime log level", command_debug_set), kTag, "register debug_set");

    esp_console_repl_t* repl = nullptr;
    esp_console_repl_config_t repl_config = ESP_CONSOLE_REPL_CONFIG_DEFAULT();
    repl_config.prompt = "openscale> ";
    repl_config.max_cmdline_length = 256;
    esp_console_dev_uart_config_t uart_config = ESP_CONSOLE_DEV_UART_CONFIG_DEFAULT();
    ESP_RETURN_ON_ERROR(esp_console_new_repl_uart(&uart_config, &repl_config, &repl), kTag, "create UART console");
    ESP_RETURN_ON_ERROR(esp_console_start_repl(repl), kTag, "start UART console");
    ESP_LOGI(kTag, "Serial console ready (115200 baud)");
    return ESP_OK;
}

}  // namespace app
