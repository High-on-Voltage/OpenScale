#include "config_store.hpp"

extern "C" {
extern const unsigned char _binary_www_default_html_gz_start[];
extern const unsigned char _binary_www_default_html_gz_end[];
extern const unsigned char _binary_www_default_js_gz_start[];
extern const unsigned char _binary_www_default_js_gz_end[];
}

#include <cerrno>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <sys/stat.h>
#include <unistd.h>
#include <strings.h>

#include "cJSON.h"
#include "esp_log.h"
#include "driver/gpio.h"
#include "esp_vfs_fat.h"
#include "wear_levelling.h"

namespace app::config_store {
namespace {
constexpr char kTag[] = "config_store";
constexpr char kMountPath[] = "/data";
constexpr char kSettingsPath[] = "/data/settings/settings.json";
constexpr char kSensorsPath[] = "/data/settings/sensors.json";
constexpr char kWebUiSettingsPath[] = "/data/settings/webui-settings.json";
constexpr char kStoragePartition[] = "storage";
wl_handle_t s_wl_handle = WL_INVALID_HANDLE;

constexpr char kDefaultSettings[] = R"json({
  "schema_version": 1,
  "device": { "hostname": "esp32-sensor" },
  "wifi": {
    "ssid": "",
    "password": "",
    "connect_timeout_ms": 12000,
    "ap_ssid_prefix": "ESP32-Sensor"
  },
  "http": { "enabled": true, "port": 80 },
  "https": { "enabled": false },
  "security": {
    "admin": {
      "username": "admin",
      "password_salt": "",
      "password_hash": "",
      "pbkdf2_iterations": 100000
    }
  },
  "storage": {
    "max_ring_buffer_bytes": 262144,
    "max_upload_bytes": 524288
  }
})json";

constexpr char kDefaultSensors[] = R"json({
  "schema_version": 1,
  "queue_capacity": 1024,
  "sensors": [
    {
      "id": 0,
      "name": "Scale 1",
      "type": "hx711",
      "enabled": true,
      "rate_hz": 80,
      "ring_buffer_samples": 1600,
      "hx711": { "dout_gpio": 16, "sck_gpio": 4, "rate_gpio": null, "gain": "A128" }
    },
    {
      "id": 1,
      "name": "Scale 2",
      "type": "hx711",
      "enabled": false,
      "rate_hz": 80,
      "ring_buffer_samples": 1600,
      "hx711": { "dout_gpio": null, "sck_gpio": null, "rate_gpio": null, "gain": "A128" }
    },
    {
      "id": 2,
      "name": "Scale 3 (10 Hz)",
      "type": "hx711",
      "enabled": false,
      "rate_hz": 10,
      "ring_buffer_samples": 600,
      "hx711": { "dout_gpio": null, "sck_gpio": null, "rate_gpio": null, "gain": "A128" },
      "details": { "note": "Further sensor details can be added here." }
    }
  ]
})json";

constexpr char kDefaultWebUiSettings[] = R"json({
  "schema_version": 1,
  "index": "/default.html"
})json";

void set_error(char* output, std::size_t size, const char* message) {
    if (output != nullptr && size > 0) std::snprintf(output, size, "%s", message != nullptr ? message : "Unknown error");
}

bool copy_json_string(cJSON* parent, const char* key, char* destination,
                      std::size_t destination_size, bool required = false) {
    cJSON* item = cJSON_GetObjectItemCaseSensitive(parent, key);
    if (item == nullptr || cJSON_IsNull(item)) return !required;
    if (!cJSON_IsString(item) || item->valuestring == nullptr) return false;
    const std::size_t length = std::strlen(item->valuestring);
    if (length >= destination_size) return false;
    std::memcpy(destination, item->valuestring, length + 1U);
    return true;
}

bool get_bool(cJSON* parent, const char* key, bool* value, bool required = false) {
    cJSON* item = cJSON_GetObjectItemCaseSensitive(parent, key);
    if (item == nullptr) return !required;
    if (!cJSON_IsBool(item)) return false;
    *value = cJSON_IsTrue(item);
    return true;
}

bool get_uint(cJSON* parent, const char* key, std::uint32_t* value, std::uint32_t min_value,
              std::uint32_t max_value, bool required = false) {
    cJSON* item = cJSON_GetObjectItemCaseSensitive(parent, key);
    if (item == nullptr) return !required;
    if (!cJSON_IsNumber(item) || item->valuedouble < min_value || item->valuedouble > max_value ||
        item->valuedouble != static_cast<double>(item->valueint)) return false;
    *value = static_cast<std::uint32_t>(item->valueint);
    return true;
}

bool is_hex_string(const char* value, std::size_t expected_length) {
    if (value == nullptr || std::strlen(value) != expected_length) return false;
    for (std::size_t i = 0; i < expected_length; ++i) {
        if (!std::isxdigit(static_cast<unsigned char>(value[i]))) return false;
    }
    return true;
}

bool get_gpio(cJSON* parent, const char* key, int* value, bool allow_null) {
    cJSON* item = cJSON_GetObjectItemCaseSensitive(parent, key);
    if (item == nullptr || cJSON_IsNull(item)) {
        if (allow_null) {
            *value = -1;
            return true;
        }
        return false;
    }
    if (!cJSON_IsNumber(item) || item->valueint < 0 || item->valueint >= GPIO_NUM_MAX ||
        item->valuedouble != static_cast<double>(item->valueint)) return false;
    *value = item->valueint;
    return true;
}

bool valid_web_path(const char* web_path) {
    if (web_path == nullptr || web_path[0] == '\0' || web_path[0] == '/') return false;
    if (std::strlen(web_path) > 120U || std::strstr(web_path, "..") != nullptr ||
        std::strchr(web_path, '\\') != nullptr || std::strchr(web_path, '%') != nullptr) return false;
    if (web_path[0] == '.' || std::strchr(web_path, '/') != nullptr) return false;
    for (const char* p = web_path; *p != '\0'; ++p) {
        const unsigned char ch = static_cast<unsigned char>(*p);
        if (!(std::isalnum(ch) || ch == '/' || ch == '.' || ch == '_' || ch == '-')) return false;
    }
    const char* extension = std::strrchr(web_path, '.');
    if (extension == nullptr) return false;
    static constexpr const char* kAllowed[] = {
        ".html", ".htm", ".js", ".css", ".svg", ".png", ".jpg", ".jpeg", ".webp",
        ".ico", ".woff", ".woff2", ".ttf", ".txt", ".map"
    };
    for (const char* allowed : kAllowed) if (strcasecmp(extension, allowed) == 0) return true;
    return false;
}

bool ensure_directory(const char* path) {
    if (mkdir(path, 0755) == 0 || errno == EEXIST) return true;
    ESP_LOGE(kTag, "mkdir(%s) failed: %s", path, std::strerror(errno));
    return false;
}

bool ensure_embedded_file(const char* path, const unsigned char* begin, const unsigned char* end) {
    struct stat st {};
    if (stat(path, &st) == 0 && st.st_size > 0) return true;
    const std::size_t length = static_cast<std::size_t>(end - begin);
    return write_file_atomic(path, begin, length);
}

bool parse_settings_internal(const char* json, std::size_t length, Settings* parsed,
                             char* error, std::size_t error_size) {
    set_error(error, error_size, "");
    if (json == nullptr || length == 0U || length > 65536U) {
        set_error(error, error_size, "Settings JSON is empty or too large");
        return false;
    }
    cJSON* root = cJSON_ParseWithLength(json, length);
    if (!cJSON_IsObject(root)) {
        cJSON_Delete(root);
        set_error(error, error_size, "Settings must be a JSON object");
        return false;
    }

    Settings value{};
    cJSON* device = cJSON_GetObjectItemCaseSensitive(root, "device");
    cJSON* wifi = cJSON_GetObjectItemCaseSensitive(root, "wifi");
    cJSON* http = cJSON_GetObjectItemCaseSensitive(root, "http");
    cJSON* https = cJSON_GetObjectItemCaseSensitive(root, "https");
    cJSON* security = cJSON_GetObjectItemCaseSensitive(root, "security");
    cJSON* admin = cJSON_IsObject(security) ? cJSON_GetObjectItemCaseSensitive(security, "admin") : nullptr;
    cJSON* storage = cJSON_GetObjectItemCaseSensitive(root, "storage");
    std::uint32_t number = 0;
    std::uint32_t schema_version = 0;
    bool ok = get_uint(root, "schema_version", &schema_version, 1U, 1U, true) &&
              cJSON_IsObject(device) && cJSON_IsObject(wifi) && cJSON_IsObject(http) &&
              cJSON_IsObject(https) && cJSON_IsObject(admin) && cJSON_IsObject(storage);

    if (ok) ok = copy_json_string(device, "hostname", value.hostname, sizeof(value.hostname));
    if (ok) ok = copy_json_string(wifi, "ssid", value.wifi_ssid, sizeof(value.wifi_ssid));
    if (ok) ok = copy_json_string(wifi, "password", value.wifi_password, sizeof(value.wifi_password));
    if (ok) ok = copy_json_string(wifi, "ap_ssid_prefix", value.ap_ssid_prefix, sizeof(value.ap_ssid_prefix));
    if (ok) {
        number = value.sta_timeout_ms;
        ok = get_uint(wifi, "connect_timeout_ms", &number, 1000U, 120000U);
        value.sta_timeout_ms = number;
    }
    if (ok) ok = get_bool(http, "enabled", &value.http_enabled, true);
    if (ok) {
        number = value.http_port;
        ok = get_uint(http, "port", &number, 1U, 65534U);
        value.http_port = static_cast<std::uint16_t>(number);
    }
    if (ok) ok = get_bool(https, "enabled", &value.https_enabled, true);
    if (ok) ok = copy_json_string(admin, "username", value.admin_username, sizeof(value.admin_username));
    if (ok) ok = copy_json_string(admin, "password_salt", value.admin_salt_hex, sizeof(value.admin_salt_hex));
    if (ok) ok = copy_json_string(admin, "password_hash", value.admin_hash_hex, sizeof(value.admin_hash_hex));
    if (ok) {
        number = value.pbkdf2_iterations;
        ok = get_uint(admin, "pbkdf2_iterations", &number, 10000U, 2000000U);
        value.pbkdf2_iterations = number;
    }
    if (ok) {
        number = static_cast<std::uint32_t>(value.max_ring_buffer_bytes);
        ok = get_uint(storage, "max_ring_buffer_bytes", &number, 4096U, 2097152U);
        value.max_ring_buffer_bytes = number;
    }
    if (ok) {
        number = static_cast<std::uint32_t>(value.max_upload_bytes);
        ok = get_uint(storage, "max_upload_bytes", &number, 1024U, 2097152U);
        value.max_upload_bytes = number;
    }

    if (ok && value.wifi_ssid[0] != '\0' && value.wifi_password[0] != '\0' &&
        std::strlen(value.wifi_password) < 8U) ok = false;
    if (ok && value.wifi_ssid[0] == '\0' && value.wifi_password[0] != '\0') ok = false;
    if (ok && ((value.admin_hash_hex[0] == '\0') != (value.admin_salt_hex[0] == '\0'))) ok = false;
    if (ok && value.admin_hash_hex[0] != '\0' &&
        (value.admin_username[0] == '\0' || !is_hex_string(value.admin_salt_hex, 32U) ||
         !is_hex_string(value.admin_hash_hex, 64U))) ok = false;
    if (ok && value.https_enabled) {
        set_error(error, error_size, "https.enabled cannot be true yet; HTTPS is reserved for a later milestone");
        ok = false;
    }

    cJSON_Delete(root);
    if (!ok) {
        if (error != nullptr && error_size > 0 && error[0] == '\0') {
            set_error(error, error_size, "Invalid settings field, value, or password verifier");
        }
        return false;
    }
    if (parsed != nullptr) *parsed = value;
    set_error(error, error_size, "");
    return true;
}

bool parse_sensors_internal(const char* json, std::size_t length, SensorConfigList* parsed,
                            char* error, std::size_t error_size) {
    set_error(error, error_size, "");
    if (json == nullptr || length == 0U || length > 65536U) {
        set_error(error, error_size, "Sensors JSON is empty or too large");
        return false;
    }
    cJSON* root = cJSON_ParseWithLength(json, length);
    cJSON* sensors = cJSON_IsObject(root) ? cJSON_GetObjectItemCaseSensitive(root, "sensors") : nullptr;
    if (!cJSON_IsArray(sensors)) {
        cJSON_Delete(root);
        set_error(error, error_size, "sensors must be an array");
        return false;
    }

    SensorConfigList list{};
    std::uint32_t schema_version = 0;
    std::uint32_t queue_capacity = 1024;
    if (!get_uint(root, "schema_version", &schema_version, 1U, 1U, true) ||
        !get_uint(root, "queue_capacity", &queue_capacity, 64U, 8192U)) {
        cJSON_Delete(root);
        set_error(error, error_size, "queue_capacity must be between 64 and 8192");
        return false;
    }
    list.queue_capacity = queue_capacity;

    bool ok = true;
    for (cJSON* item = sensors->child; item != nullptr; item = item->next) {
        if (!cJSON_IsObject(item) || list.count >= kMaxSensors) { ok = false; break; }
        SensorConfig cfg{};
        std::uint32_t id = 0;
        std::uint32_t rate = 0;
        std::uint32_t ring_samples = 0;
        if (!get_uint(item, "id", &id, 0U, 65535U, true) ||
            !copy_json_string(item, "name", cfg.name, sizeof(cfg.name), true) ||
            !copy_json_string(item, "type", cfg.type, sizeof(cfg.type), true) ||
            !get_bool(item, "enabled", &cfg.enabled, true) ||
            !get_uint(item, "rate_hz", &rate, 1U, 1000U, true) ||
            !get_uint(item, "ring_buffer_samples", &ring_samples, 1U, 100000U, true)) {
            ok = false;
            break;
        }
        cfg.id = static_cast<std::uint16_t>(id);
        cfg.rate_hz = rate;
        cfg.ring_buffer_samples = ring_samples;
        for (std::size_t i = 0; i < list.count; ++i) {
            if (list.items[i].id == cfg.id) ok = false;
        }
        if (!ok) break;

        if (strcasecmp(cfg.type, "hx711") == 0) {
            cJSON* hx = cJSON_GetObjectItemCaseSensitive(item, "hx711");
            if (!cJSON_IsObject(hx) || !copy_json_string(hx, "gain", cfg.gain, sizeof(cfg.gain))) {
                ok = false;
                break;
            }
            if (cfg.enabled) {
                if (!get_gpio(hx, "dout_gpio", &cfg.dout_gpio, false) ||
                    !get_gpio(hx, "sck_gpio", &cfg.sck_gpio, false) ||
                    !get_gpio(hx, "rate_gpio", &cfg.rate_gpio, true) ||
                    (cfg.rate_hz != 10U && cfg.rate_hz != 80U) ||
                    (strcasecmp(cfg.gain, "A128") != 0 && strcasecmp(cfg.gain, "A64") != 0 &&
                     strcasecmp(cfg.gain, "B32") != 0) || cfg.dout_gpio == cfg.sck_gpio ||
                    (cfg.rate_gpio >= 0 && (cfg.rate_gpio == cfg.dout_gpio || cfg.rate_gpio == cfg.sck_gpio))) {
                    ok = false;
                    break;
                }
            }
        }
        list.items[list.count++] = cfg;
    }

    // Refuse duplicate GPIO assignments across enabled HX711 sensors.
    if (ok) {
        for (std::size_t i = 0; i < list.count; ++i) {
            const auto& a = list.items[i];
            if (!a.enabled || strcasecmp(a.type, "hx711") != 0) continue;
            for (std::size_t j = i + 1; j < list.count; ++j) {
                const auto& b = list.items[j];
                if (!b.enabled || strcasecmp(b.type, "hx711") != 0) continue;
                const int a_pins[] = {a.dout_gpio, a.sck_gpio, a.rate_gpio};
                const int b_pins[] = {b.dout_gpio, b.sck_gpio, b.rate_gpio};
                for (int ap : a_pins) for (int bp : b_pins) if (ap >= 0 && ap == bp) ok = false;
            }
        }
    }

    cJSON_Delete(root);
    if (!ok || list.count == 0U) {
        set_error(error, error_size, "Invalid sensor entry, duplicate ID/GPIO, or too many sensors");
        return false;
    }
    if (parsed != nullptr) *parsed = list;
    set_error(error, error_size, "");
    return true;
}

bool write_default_if_missing(const char* path, const char* contents, std::size_t length) {
    struct stat st {};
    if (stat(path, &st) == 0 && st.st_size > 0) return true;
    return write_file_atomic(path, contents, length);
}

bool recover_backup_if_target_missing(const char* path) {
    char backup[192]{};
    if (std::snprintf(backup, sizeof(backup), "%s.bak", path) >= static_cast<int>(sizeof(backup))) return false;
    if (access(path, F_OK) == 0) {
        // A completed replacement may leave a stale backup after sudden power loss.
        unlink(backup);
        return true;
    }
    if (access(backup, F_OK) != 0) return true;
    if (rename(backup, path) != 0) {
        ESP_LOGE(kTag, "Could not recover %s from backup: %s", path, std::strerror(errno));
        return false;
    }
    ESP_LOGW(kTag, "Recovered %s from its atomic-write backup", path);
    return true;
}
}  // namespace

esp_err_t init_filesystem() {
    esp_vfs_fat_mount_config_t mount_config{};
    mount_config.format_if_mount_failed = true;  // Needed for a brand-new storage partition.
    mount_config.max_files = 12;
    mount_config.allocation_unit_size = 4096;

    esp_err_t err = esp_vfs_fat_spiflash_mount_rw_wl(kMountPath, kStoragePartition, &mount_config, &s_wl_handle);
    if (err != ESP_OK) {
        ESP_LOGE(kTag, "Could not mount storage partition: %s", esp_err_to_name(err));
        return err;
    }

    if (!ensure_directory("/data/settings") || !ensure_directory("/data/calibration") ||
        !ensure_directory("/data/www")) return ESP_FAIL;

    if (!recover_backup_if_target_missing(kSettingsPath) ||
        !recover_backup_if_target_missing(kSensorsPath) ||
        !recover_backup_if_target_missing(kWebUiSettingsPath)) return ESP_FAIL;

    if (!write_default_if_missing(kSettingsPath, kDefaultSettings, sizeof(kDefaultSettings) - 1U) ||
        !write_default_if_missing(kSensorsPath, kDefaultSensors, sizeof(kDefaultSensors) - 1U) ||
        !write_default_if_missing(kWebUiSettingsPath, kDefaultWebUiSettings, sizeof(kDefaultWebUiSettings) - 1U) ||
        !ensure_embedded_file("/data/www/default.html.gz", _binary_www_default_html_gz_start, _binary_www_default_html_gz_end) ||
        !ensure_embedded_file("/data/www/default.js.gz", _binary_www_default_js_gz_start, _binary_www_default_js_gz_end)) {
        ESP_LOGE(kTag, "Could not initialize default files");
        return ESP_FAIL;
    }
    ESP_LOGI(kTag, "Mounted FATFS storage with wear levelling at %s", kMountPath);
    return ESP_OK;
}

bool read_file(const char* absolute_path, char** data, std::size_t* length) {
    if (absolute_path == nullptr || data == nullptr || length == nullptr) return false;
    *data = nullptr;
    *length = 0;
    FILE* file = std::fopen(absolute_path, "rb");
    if (file == nullptr) return false;
    if (std::fseek(file, 0, SEEK_END) != 0) { std::fclose(file); return false; }
    const long size = std::ftell(file);
    if (size < 0 || std::fseek(file, 0, SEEK_SET) != 0) { std::fclose(file); return false; }
    char* buffer = static_cast<char*>(std::malloc(static_cast<std::size_t>(size) + 1U));
    if (buffer == nullptr) { std::fclose(file); return false; }
    const std::size_t count = std::fread(buffer, 1U, static_cast<std::size_t>(size), file);
    std::fclose(file);
    if (count != static_cast<std::size_t>(size)) { std::free(buffer); return false; }
    buffer[count] = '\0';
    *data = buffer;
    *length = count;
    return true;
}

bool write_file_atomic(const char* absolute_path, const void* data, std::size_t length) {
    if (absolute_path == nullptr || (data == nullptr && length != 0U)) return false;
    char temp_path[192]{};
    char backup_path[192]{};
    if (std::snprintf(temp_path, sizeof(temp_path), "%s.tmp", absolute_path) >= static_cast<int>(sizeof(temp_path)) ||
        std::snprintf(backup_path, sizeof(backup_path), "%s.bak", absolute_path) >= static_cast<int>(sizeof(backup_path))) return false;

    FILE* file = std::fopen(temp_path, "wb");
    if (file == nullptr) return false;
    const std::size_t written = length == 0U ? 0U : std::fwrite(data, 1U, length, file);
    const bool flushed = (written == length) && (std::fflush(file) == 0) && (fsync(fileno(file)) == 0);
    const bool closed = std::fclose(file) == 0;
    if (!flushed || !closed) { unlink(temp_path); return false; }

    unlink(backup_path);
    const bool had_original = (access(absolute_path, F_OK) == 0);
    if (had_original && rename(absolute_path, backup_path) != 0) { unlink(temp_path); return false; }
    if (rename(temp_path, absolute_path) != 0) {
        if (had_original) rename(backup_path, absolute_path);
        unlink(temp_path);
        return false;
    }
    unlink(backup_path);
    return true;
}

bool load_settings(Settings& out, char* error, std::size_t error_size) {
    char* json = nullptr;
    std::size_t length = 0;
    if (!read_file(kSettingsPath, &json, &length)) { set_error(error, error_size, "Cannot read settings.json"); return false; }
    const bool ok = parse_settings_internal(json, length, &out, error, error_size);
    std::free(json);
    return ok;
}

bool load_sensors(SensorConfigList& out, char* error, std::size_t error_size) {
    char* json = nullptr;
    std::size_t length = 0;
    if (!read_file(kSensorsPath, &json, &length)) { set_error(error, error_size, "Cannot read sensors.json"); return false; }
    const bool ok = parse_sensors_internal(json, length, &out, error, error_size);
    std::free(json);
    return ok;
}

bool validate_settings_json(const char* json, std::size_t length, Settings* parsed,
                            char* error, std::size_t error_size) {
    return parse_settings_internal(json, length, parsed, error, error_size);
}

bool validate_sensors_json(const char* json, std::size_t length, SensorConfigList* parsed,
                           char* error, std::size_t error_size) {
    return parse_sensors_internal(json, length, parsed, error, error_size);
}

bool save_settings_json(const char* json, std::size_t length) {
    Settings parsed{};
    char error[160]{};
    if (!parse_settings_internal(json, length, &parsed, error, sizeof(error))) {
        ESP_LOGW(kTag, "Rejected settings upload: %s", error);
        return false;
    }
    return write_file_atomic(kSettingsPath, json, length);
}

bool save_settings_struct(const Settings& settings) {
    cJSON* root = cJSON_CreateObject();
    cJSON_AddNumberToObject(root, "schema_version", 1);
    cJSON* device = cJSON_AddObjectToObject(root, "device");
    cJSON_AddStringToObject(device, "hostname", settings.hostname);
    cJSON* wifi = cJSON_AddObjectToObject(root, "wifi");
    cJSON_AddStringToObject(wifi, "ssid", settings.wifi_ssid);
    cJSON_AddStringToObject(wifi, "password", settings.wifi_password);
    cJSON_AddNumberToObject(wifi, "connect_timeout_ms", settings.sta_timeout_ms);
    cJSON_AddStringToObject(wifi, "ap_ssid_prefix", settings.ap_ssid_prefix);
    cJSON* http = cJSON_AddObjectToObject(root, "http");
    cJSON_AddBoolToObject(http, "enabled", settings.http_enabled);
    cJSON_AddNumberToObject(http, "port", settings.http_port);
    cJSON* https = cJSON_AddObjectToObject(root, "https");
    cJSON_AddBoolToObject(https, "enabled", settings.https_enabled);
    cJSON* security = cJSON_AddObjectToObject(root, "security");
    cJSON* admin = cJSON_AddObjectToObject(security, "admin");
    cJSON_AddStringToObject(admin, "username", settings.admin_username);
    cJSON_AddStringToObject(admin, "password_salt", settings.admin_salt_hex);
    cJSON_AddStringToObject(admin, "password_hash", settings.admin_hash_hex);
    cJSON_AddNumberToObject(admin, "pbkdf2_iterations", settings.pbkdf2_iterations);
    cJSON* storage = cJSON_AddObjectToObject(root, "storage");
    cJSON_AddNumberToObject(storage, "max_ring_buffer_bytes", static_cast<double>(settings.max_ring_buffer_bytes));
    cJSON_AddNumberToObject(storage, "max_upload_bytes", static_cast<double>(settings.max_upload_bytes));

    char* printed = cJSON_PrintUnformatted(root);
    const bool ok = printed != nullptr && save_settings_json(printed, std::strlen(printed));
    cJSON_free(printed);
    cJSON_Delete(root);
    return ok;
}

bool save_sensors_json(const char* json, std::size_t length) {
    SensorConfigList parsed{};
    char error[160]{};
    if (!parse_sensors_internal(json, length, &parsed, error, sizeof(error))) {
        ESP_LOGW(kTag, "Rejected sensors upload: %s", error);
        return false;
    }
    return write_file_atomic(kSensorsPath, json, length);
}

bool save_webui_settings_json(const char* json, std::size_t length) {
    if (json == nullptr || length == 0U || length > 65536U) return false;
    cJSON* root = cJSON_ParseWithLength(json, length);
    cJSON* index = cJSON_IsObject(root) ? cJSON_GetObjectItemCaseSensitive(root, "index") : nullptr;
    bool valid = cJSON_IsObject(root);
    if (valid && index != nullptr) {
        char asset_path[192]{};
        valid = cJSON_IsString(index) && index->valuestring != nullptr &&
                index->valuestring[0] == '/' && valid_web_path(index->valuestring + 1) &&
                make_asset_storage_path(index->valuestring + 1, asset_path, sizeof(asset_path)) &&
                access(asset_path, F_OK) == 0;
    }
    cJSON_Delete(root);
    if (!valid) return false;
    return write_file_atomic(kWebUiSettingsPath, json, length);
}

bool get_index_path(char* output, std::size_t output_size) {
    if (output == nullptr || output_size == 0U) return false;
    char* json = nullptr;
    std::size_t length = 0;
    if (!read_file(kWebUiSettingsPath, &json, &length)) return false;
    cJSON* root = cJSON_ParseWithLength(json, length);
    cJSON* item = cJSON_IsObject(root) ? cJSON_GetObjectItemCaseSensitive(root, "index") : nullptr;
    bool ok = cJSON_IsString(item) && item->valuestring != nullptr &&
              std::strlen(item->valuestring) < output_size && item->valuestring[0] == '/' &&
              valid_web_path(item->valuestring + 1);
    if (ok) std::snprintf(output, output_size, "%s", item->valuestring);
    cJSON_Delete(root);
    std::free(json);
    return ok;
}

bool set_index_path(const char* web_path) {
    if (web_path == nullptr || web_path[0] != '/' || !valid_web_path(web_path + 1)) return false;
    char asset_path[192]{};
    if (!make_asset_storage_path(web_path + 1, asset_path, sizeof(asset_path)) || access(asset_path, F_OK) != 0) return false;
    cJSON* root = cJSON_CreateObject();
    cJSON_AddNumberToObject(root, "schema_version", 1);
    cJSON_AddStringToObject(root, "index", web_path);
    char* printed = cJSON_PrintUnformatted(root);
    const bool ok = printed != nullptr && save_webui_settings_json(printed, std::strlen(printed));
    cJSON_free(printed);
    cJSON_Delete(root);
    return ok;
}

bool make_asset_storage_path(const char* web_path, char* output, std::size_t output_size) {
    if (!valid_web_path(web_path) || output == nullptr) return false;
    return std::snprintf(output, output_size, "/data/www/%s.gz", web_path) < static_cast<int>(output_size);
}

bool save_asset_gzip(const char* web_path, const void* data, std::size_t length) {
    char path[192]{};
    return make_asset_storage_path(web_path, path, sizeof(path)) && write_file_atomic(path, data, length);
}

bool is_protected_default_asset(const char* web_path) {
    // Keep the entire default.* namespace immutable, not just the two files
    // currently embedded by this firmware build.
    return web_path != nullptr && strncasecmp(web_path, "default.", 8U) == 0;
}

bool delete_asset(const char* web_path) {
    if (is_protected_default_asset(web_path)) return false;
    char selected_index[128]{};
    char requested_index[132]{};
    std::snprintf(requested_index, sizeof(requested_index), "/%s", web_path != nullptr ? web_path : "");
    if (get_index_path(selected_index, sizeof(selected_index)) && std::strcmp(selected_index, requested_index) == 0) return false;
    char path[192]{};
    if (!make_asset_storage_path(web_path, path, sizeof(path))) return false;
    return unlink(path) == 0;
}

bool rename_asset(const char* from_web_path, const char* to_web_path) {
    if (is_protected_default_asset(from_web_path) || is_protected_default_asset(to_web_path)) return false;
    char from[192]{};
    char to[192]{};
    if (!make_asset_storage_path(from_web_path, from, sizeof(from)) ||
        !make_asset_storage_path(to_web_path, to, sizeof(to)) || access(from, F_OK) != 0 || access(to, F_OK) == 0) return false;
    char selected_index[128]{};
    char from_index[132]{};
    std::snprintf(from_index, sizeof(from_index), "/%s", from_web_path);
    const bool was_index = get_index_path(selected_index, sizeof(selected_index)) && std::strcmp(selected_index, from_index) == 0;
    if (rename(from, to) != 0) return false;
    if (was_index) {
        char to_index[132]{};
        std::snprintf(to_index, sizeof(to_index), "/%s", to_web_path);
        if (!set_index_path(to_index)) {
            rename(to, from);
            return false;
        }
    }
    return true;
}

bool make_calibration_storage_path(const char* filename, char* output, std::size_t output_size) {
    if (filename == nullptr || output == nullptr || std::strlen(filename) < 6U || std::strlen(filename) > 64U) return false;
    const std::size_t n = std::strlen(filename);
    if (strcasecmp(filename + n - 5U, ".json") != 0) return false;
    for (std::size_t i = 0; i < n; ++i) {
        const unsigned char c = static_cast<unsigned char>(filename[i]);
        if (!(std::isalnum(c) || c == '_' || c == '-' || c == '.')) return false;
    }
    if (std::strstr(filename, "..") != nullptr) return false;
    return std::snprintf(output, output_size, "/data/calibration/%s", filename) < static_cast<int>(output_size);
}

}  // namespace app::config_store
