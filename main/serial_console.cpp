#include "serial_console.hpp"
#include "security.hpp"
#include "factory_defaults.hpp"
#include "storage.hpp"
#include "esp_console.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "cJSON.h"
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace openscale {
namespace {
constexpr char TAG[] = "serial";

cJSON *read_json_or_default(const char *path, const char *factory_filename) {
    std::vector<uint8_t> bytes;
    if (storage::read_file(path, bytes, 64 * 1024) == ESP_OK) {
        cJSON *parsed = cJSON_ParseWithLength(reinterpret_cast<const char *>(bytes.data()), bytes.size());
        if (parsed) return parsed;
    }
    const char *defaults = factory_defaults::get(factory_filename);
    return defaults ? cJSON_Parse(defaults) : nullptr;
}

bool save_json(const char *path, cJSON *root) {
    char *printed = cJSON_Print(root);
    if (!printed) return false;
    const bool ok = storage::write_file_atomic(path, reinterpret_cast<const uint8_t *>(printed), std::strlen(printed)) == ESP_OK;
    cJSON_free(printed);
    return ok;
}

int cmd_wifi_clear(int, char **) {
    const char *defaults = factory_defaults::get("wifi.json");
    cJSON *root = defaults ? cJSON_Parse(defaults) : nullptr;
    const bool ok = root && save_json("/data/settings/wifi.json", root);
    cJSON_Delete(root);
    std::printf(ok ? "Wi-Fi station list cleared. Reboot to apply.\n" : "Could not save wifi.json.\n");
    return ok ? 0 : 1;
}

int cmd_wifi_set(int argc, char **argv) {
    if (argc < 3 || argc > 4) {
        std::printf("Usage: wifi_set <ssid> <password> [priority]\n");
        return 1;
    }
    const char *ssid = argv[1];
    const char *password = argv[2];
    if (!*ssid || std::strlen(ssid) > 32 || (std::strlen(password) != 0 && std::strlen(password) < 8) || std::strlen(password) > 63) {
        std::printf("SSID must be 1-32 bytes; password must be empty or 8-63 bytes.\n");
        return 1;
    }
    const int priority = argc == 4 ? std::atoi(argv[3]) : 100;
    cJSON *root = read_json_or_default("/data/settings/wifi.json", "wifi.json");
    if (!root) {
        std::printf("Could not load or create wifi.json.\n");
        return 1;
    }
    cJSON *networks = cJSON_GetObjectItemCaseSensitive(root, "networks");
    if (!cJSON_IsArray(networks)) {
        cJSON_DeleteItemFromObjectCaseSensitive(root, "networks");
        networks = cJSON_AddArrayToObject(root, "networks");
    }
    int next_id = 1;
    for (int i = 0; i < cJSON_GetArraySize(networks); ++i) {
        const cJSON *id = cJSON_GetObjectItemCaseSensitive(cJSON_GetArrayItem(networks, i), "id");
        if (cJSON_IsNumber(id)) next_id = std::max(next_id, id->valueint + 1);
    }
    cJSON *entry = cJSON_CreateObject();
    cJSON_AddNumberToObject(entry, "id", next_id);
    cJSON_AddStringToObject(entry, "ssid", ssid);
    if (*password) cJSON_AddStringToObject(entry, "password", password);
    else cJSON_AddNullToObject(entry, "password");
    cJSON_AddNumberToObject(entry, "priority", priority);
    cJSON_AddItemToArray(networks, entry);
    const bool ok = save_json("/data/settings/wifi.json", root);
    cJSON_Delete(root);
    std::printf(ok ? "Wi-Fi network saved with id %d. Reboot to apply.\n" : "Could not save wifi.json.\n", next_id);
    return ok ? 0 : 1;
}

int cmd_password_set(int argc, char **argv) {
    if (argc != 2) { std::printf("Usage: password_set <password>\n"); return 1; }
    cJSON *root = read_json_or_default("/data/settings/settings.json", "settings.json");
    if (!root || !security::set_password_verifier(root, argv[1]) || !save_json("/data/settings/settings.json", root)) {
        cJSON_Delete(root);
        std::printf("Password update failed (password must be 8-128 bytes; check storage).\n");
        return 1;
    }
    cJSON_Delete(root);
    std::printf("Administrator password updated.\n");
    return 0;
}

int cmd_password_clear(int, char **) {
    cJSON *root = read_json_or_default("/data/settings/settings.json", "settings.json");
    if (!root || !security::set_password_verifier(root, nullptr) || !save_json("/data/settings/settings.json", root)) {
        cJSON_Delete(root);
        std::printf("Password clear failed.\n");
        return 1;
    }
    cJSON_Delete(root);
    std::printf("Administrator password cleared.\n");
    return 0;
}

int cmd_hostname_set(int argc, char **argv) {
    if (argc != 2 || !*argv[1] || std::strlen(argv[1]) > 63 || std::strchr(argv[1], '.')) {
        std::printf("Usage: hostname_set <hostname-without-.local>\n");
        return 1;
    }
    cJSON *root = read_json_or_default("/data/settings/settings.json", "settings.json");
    if (!root) { std::printf("Could not load settings.json.\n"); return 1; }
    cJSON *network = cJSON_GetObjectItemCaseSensitive(root, "network");
    if (!cJSON_IsObject(network)) network = cJSON_AddObjectToObject(root, "network");
    cJSON_DeleteItemFromObjectCaseSensitive(network, "hostname");
    cJSON_AddStringToObject(network, "hostname", argv[1]);
    const bool ok = save_json("/data/settings/settings.json", root);
    cJSON_Delete(root);
    std::printf(ok ? "Hostname saved. mDNS and hostname redirects are not implemented yet.\n" : "Could not save settings.json.\n");
    return ok ? 0 : 1;
}

int cmd_debug_set(int argc, char **argv) {
    if (argc != 2 || (std::strcmp(argv[1], "0") && std::strcmp(argv[1], "1"))) {
        std::printf("Usage: debug_set <0|1>\n"); return 1;
    }
    esp_log_level_set("*", std::strcmp(argv[1], "1") == 0 ? ESP_LOG_DEBUG : ESP_LOG_INFO);
    std::printf("Debug logging %s.\n", std::strcmp(argv[1], "1") == 0 ? "enabled" : "disabled");
    return 0;
}

int cmd_help(int, char **) {
    std::printf("OpenScale serial commands:\n"
                "  wifi_set <ssid> <password> [priority]\n"
                "  wifi_clear\n  password_set <password>\n  password_clear\n"
                "  hostname_set <hostname>\n  debug_set <0|1>\n  help\n");
    return 0;
}

void register_command(const char *command, const char *help, esp_console_cmd_func_t func) {
    esp_console_cmd_t cmd{};
    cmd.command = command;
    cmd.help = help;
    cmd.func = func;
    const esp_err_t err = esp_console_cmd_register(&cmd);
    if (err != ESP_OK) ESP_LOGW(TAG, "Register command %s: %s", command, esp_err_to_name(err));
}
}

esp_err_t serial_console_start() {
    esp_console_repl_t *repl = nullptr;
    esp_console_dev_uart_config_t uart_config = ESP_CONSOLE_DEV_UART_CONFIG_DEFAULT();
    esp_console_repl_config_t repl_config = ESP_CONSOLE_REPL_CONFIG_DEFAULT();
    repl_config.prompt = "openscale>";
    repl_config.max_cmdline_length = 256;
    esp_err_t err = esp_console_new_repl_uart(&uart_config, &repl_config, &repl);
    if (err != ESP_OK) return err;
    register_command("wifi_set", "Add a Wi-Fi station network", cmd_wifi_set);
    register_command("wifi_clear", "Clear all saved station networks", cmd_wifi_clear);
    register_command("password_set", "Set the administrator password", cmd_password_set);
    register_command("password_clear", "Clear the administrator password", cmd_password_clear);
    register_command("hostname_set", "Set the mDNS hostname", cmd_hostname_set);
    register_command("debug_set", "Toggle debug logging", cmd_debug_set);
    register_command("help", "List serial commands", cmd_help);
    err = esp_console_start_repl(repl);
    if (err != ESP_OK) ESP_LOGE(TAG, "Console start failed: %s", esp_err_to_name(err));
    return err;
}
}
