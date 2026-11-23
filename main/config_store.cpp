#include "config_store.hpp"

extern "C" {
extern const unsigned char web_assets_start[];
extern const unsigned char web_assets_end[];
}

#include <cerrno>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <cmath>
#include <climits>
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
constexpr char kWifiPath[] = "/data/settings/wifi.json";
constexpr char kSensorsPath[] = "/data/settings/sensors.json";
constexpr char kUnitsPath[] = "/data/settings/units.json";
constexpr char kWebUiSettingsPath[] = "/data/settings/webui-settings.json";
constexpr char kStoragePartition[] = "storage";
wl_handle_t s_wl_handle = WL_INVALID_HANDLE;

constexpr char kDefaultSettings[] = R"json({
  "schemaVersion": 1,
  "hostname": "",
  "redirectToHostname": true,
  "http_indexpath": "/default.html",
  "buffer": {
    "ringbuffer_max_total_size_bytes": 262144,
    "queue_capacity": 64
  },
  "https": { "enabled": false },
  "security": {}
})json";

constexpr char kDefaultWifi[] = R"json({
  "schemaVersion": 1,
  "networks": [],
  "ap": {
    "enabled": true,
    "ssidPrefix": "OpenScale",
    "channel": 1,
    "maxStations": 4,
    "keepApWhenConnected": false
  }
})json";

constexpr char kDefaultSensors[] = R"json({
  "schemaVersion": 1,
  "sensors": []
})json";

constexpr char kDefaultUnits[] = R"json({
  "schemaVersion": 1,
  "baseUnit": "mg",
  "defaultUnit": "g",
  "units": [
    {"id":"ug","name":"Micrograms","symbol":"µg","factor":0.001,"decimals":0,"group":"Metric"},
    {"id":"mg","name":"Milligrams","symbol":"mg","factor":1,"decimals":1,"group":"Metric"},
    {"id":"g","name":"Grams","symbol":"g","factor":1000,"decimals":3,"group":"Metric"},
    {"id":"kg","name":"Kilograms","symbol":"kg","factor":1000000,"decimals":3,"group":"Metric"},
    {"id":"oz_av","name":"Ounces (avoirdupois)","symbol":"oz","factor":28349.523125,"decimals":4,"group":"Imperial / US customary"},
    {"id":"lb_av","name":"Pounds (avoirdupois)","symbol":"lb","factor":453592.37,"decimals":5,"group":"Imperial / US customary"},
    {"id":"oz_troy","name":"Troy ounces","symbol":"oz t","factor":31103.4768,"decimals":4,"group":"Imperial / US customary"},
    {"id":"st","name":"Stone","symbol":"st","factor":6350293.18,"decimals":4,"group":"Imperial / US customary"},
    {"id":"raw","name":"Raw sensor counts (diagnostic)","symbol":"counts","factor":null,"decimals":0,"group":"Diagnostic"}
  ]
})json";

constexpr char kDefaultWebUiSettings[] = R"json({ "schemaVersion": 1 })json";

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
    if (web_path == nullptr || web_path[0] == '\0' || web_path[0] == '/' ||
        std::strlen(web_path) > 120U || std::strchr(web_path, '\\') != nullptr ||
        std::strchr(web_path, '%') != nullptr || std::strstr(web_path, "//") != nullptr ||
        std::strcmp(web_path, "api") == 0 || std::strcmp(web_path, "data") == 0 ||
        std::strcmp(web_path, "stream") == 0 || std::strncmp(web_path, "api/", 4U) == 0 ||
        std::strncmp(web_path, "data/", 5U) == 0) return false;

    // Preserve arbitrary static filenames and nested paths while rejecting
    // hidden segments, empty segments, and path traversal components.
    const char* segment = web_path;
    for (const char* p = web_path; ; ++p) {
        const unsigned char ch = static_cast<unsigned char>(*p);
        if (*p != '\0' && ch != '/') {
            if (!(std::isalnum(ch) || ch == '.' || ch == '_' || ch == '-')) return false;
            continue;
        }
        const std::size_t segment_length = static_cast<std::size_t>(p - segment);
        if (segment_length == 0U || segment[0] == '.' ||
            (segment_length == 1U && segment[0] == '.') ||
            (segment_length == 2U && segment[0] == '.' && segment[1] == '.')) return false;
        if (*p == '\0') break;
        segment = p + 1;
    }
    return true;
}

bool ensure_directory(const char* path) {
    if (mkdir(path, 0755) == 0 || errno == EEXIST) return true;
    ESP_LOGE(kTag, "mkdir(%s) failed: %s", path, std::strerror(errno));
    return false;
}

bool ensure_asset_parent_directories(const char* web_path) {
    char absolute_path[256]{};
    if (!make_asset_storage_path(web_path, absolute_path, sizeof(absolute_path))) return false;
    constexpr char kAssetRoot[] = "/data/www/";
    char* cursor = absolute_path + sizeof(kAssetRoot) - 1U;
    for (; *cursor != '\0'; ++cursor) {
        if (*cursor != '/') continue;
        *cursor = '\0';
        const bool ok = ensure_directory(absolute_path);
        *cursor = '/';
        if (!ok) return false;
    }
    return true;
}

std::uint16_t read_le16(const unsigned char* p) {
    return static_cast<std::uint16_t>(p[0]) |
           static_cast<std::uint16_t>(static_cast<std::uint16_t>(p[1]) << 8U);
}

std::uint32_t read_le32(const unsigned char* p) {
    return static_cast<std::uint32_t>(p[0]) |
           (static_cast<std::uint32_t>(p[1]) << 8U) |
           (static_cast<std::uint32_t>(p[2]) << 16U) |
           (static_cast<std::uint32_t>(p[3]) << 24U);
}

bool seed_embedded_assets() {
    const std::size_t pack_size = static_cast<std::size_t>(web_assets_end - web_assets_start);
    constexpr std::size_t kHeaderSize = 12U;
    constexpr std::size_t kEntryHeaderSize = 8U;
    if (pack_size < kHeaderSize || std::memcmp(web_assets_start, "OSWA", 4U) != 0 ||
        read_le16(web_assets_start + 4U) != 1U || read_le32(web_assets_start + 8U) != pack_size) {
        ESP_LOGE(kTag, "Embedded web asset pack has an invalid header");
        return false;
    }

    const std::uint16_t count = read_le16(web_assets_start + 6U);
    const unsigned char* cursor = web_assets_start + kHeaderSize;
    const unsigned char* end = web_assets_end;
    for (std::uint16_t i = 0; i < count; ++i) {
        if (static_cast<std::size_t>(end - cursor) < kEntryHeaderSize) return false;
        const std::uint16_t path_length = read_le16(cursor);
        const std::uint16_t flags = read_le16(cursor + 2U);
        const std::uint32_t gzip_length = read_le32(cursor + 4U);
        cursor += kEntryHeaderSize;
        if (flags != 0U || path_length == 0U || path_length > 120U || gzip_length < 18U ||
            static_cast<std::size_t>(end - cursor) < static_cast<std::size_t>(path_length) + gzip_length) {
            ESP_LOGE(kTag, "Embedded web asset pack entry %u is malformed", static_cast<unsigned>(i));
            return false;
        }

        char web_path[121]{};
        std::memcpy(web_path, cursor, path_length);
        cursor += path_length;
        const unsigned char* gzip_data = cursor;
        cursor += gzip_length;
        if (!valid_web_path(web_path) || gzip_data[0] != 0x1fU || gzip_data[1] != 0x8bU ||
            !ensure_asset_parent_directories(web_path)) {
            ESP_LOGE(kTag, "Embedded web asset path or gzip stream is invalid: %s", web_path);
            return false;
        }

        char destination[256]{};
        if (!make_asset_storage_path(web_path, destination, sizeof(destination))) return false;
        struct stat st {};
        if (stat(destination, &st) == 0 && st.st_size > 0) continue;  // Preserve user-managed overrides.
        if (!write_file_atomic(destination, gzip_data, gzip_length)) {
            ESP_LOGE(kTag, "Could not seed embedded web asset %s", web_path);
            return false;
        }
    }
    if (cursor != end) {
        ESP_LOGE(kTag, "Embedded web asset pack contains trailing bytes");
        return false;
    }
    ESP_LOGI(kTag, "Seeded %u embedded web asset(s)", static_cast<unsigned>(count));
    return true;
}

bool get_number(cJSON* parent, const char* key, double* value, bool required = false) {
    cJSON* item = cJSON_GetObjectItemCaseSensitive(parent, key);
    if (item == nullptr) return !required;
    if (!cJSON_IsNumber(item) || !std::isfinite(item->valuedouble)) return false;
    *value = item->valuedouble;
    return true;
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
    cJSON* buffer = cJSON_GetObjectItemCaseSensitive(root, "buffer");
    cJSON* https = cJSON_GetObjectItemCaseSensitive(root, "https");
    cJSON* security = cJSON_GetObjectItemCaseSensitive(root, "security");
    std::uint32_t schema_version = 0;
    std::uint32_t number = 0;
    bool ok = get_uint(root, "schemaVersion", &schema_version, 1U, 1U, true) &&
              cJSON_IsObject(buffer) && cJSON_IsObject(https) && cJSON_IsObject(security);

    if (ok) ok = copy_json_string(root, "hostname", value.hostname, sizeof(value.hostname));
    if (ok) ok = get_bool(root, "redirectToHostname", &value.redirect_to_hostname, true);
    if (ok) ok = copy_json_string(root, "http_indexpath", value.http_indexpath, sizeof(value.http_indexpath), true);
    if (ok) {
        number = static_cast<std::uint32_t>(value.ringbuffer_max_total_size_bytes);
        ok = get_uint(buffer, "ringbuffer_max_total_size_bytes", &number, 4096U, 2097152U, true);
        value.ringbuffer_max_total_size_bytes = number;
    }
    if (ok) {
        number = static_cast<std::uint32_t>(value.queue_capacity);
        ok = get_uint(buffer, "queue_capacity", &number, 1U, 8192U, true);
        value.queue_capacity = number;
    }
    if (ok) ok = get_bool(https, "enabled", &value.https_enabled, true);

    // The public API uses security.password (write-only) / passwordSet (read-only).
    // The on-device file stores only a verifier object and never plaintext password material.
    if (ok) {
        cJSON* verifier = cJSON_GetObjectItemCaseSensitive(security, "passwordVerifier");
        cJSON* password = cJSON_GetObjectItemCaseSensitive(security, "password");
        if (verifier != nullptr) {
            char algorithm[40]{};
            ok = cJSON_IsObject(verifier) &&
                 copy_json_string(verifier, "algorithm", algorithm, sizeof(algorithm), true) &&
                 std::strcmp(algorithm, "PBKDF2-HMAC-SHA256") == 0 &&
                 copy_json_string(verifier, "salt", value.admin_salt_hex, sizeof(value.admin_salt_hex), true) &&
                 copy_json_string(verifier, "verifier", value.admin_hash_hex, sizeof(value.admin_hash_hex), true);
            if (ok) {
                number = value.pbkdf2_iterations;
                ok = get_uint(verifier, "iterations", &number, 10000U, 2000000U, true);
                value.pbkdf2_iterations = number;
            }
            if (ok) ok = is_hex_string(value.admin_salt_hex, 32U) && is_hex_string(value.admin_hash_hex, 64U);
        } else if (password != nullptr && !cJSON_IsNull(password)) {
            ok = cJSON_IsString(password) && password->valuestring != nullptr &&
                 std::strlen(password->valuestring) >= 8U && std::strlen(password->valuestring) <= 128U;
        }
        // passwordSet is informational only and is deliberately ignored on input.
    }

    if (ok && (value.http_indexpath[0] != '/' || !valid_web_path(value.http_indexpath + 1))) ok = false;
    if (ok && value.https_enabled) {
        set_error(error, error_size, "https.enabled cannot be true until HTTPS/TLS is operational");
        ok = false;
    }

    cJSON_Delete(root);
    if (!ok) {
        if (error != nullptr && error_size > 0 && error[0] == '\0')
            set_error(error, error_size, "Invalid settings field, value, or password verifier");
        return false;
    }
    if (parsed != nullptr) *parsed = value;
    return true;
}

bool parse_wifi_internal(const char* json, std::size_t length, WifiConfig* parsed,
                         char* error, std::size_t error_size) {
    set_error(error, error_size, "");
    if (json == nullptr || length == 0U || length > 65536U) {
        set_error(error, error_size, "Wi-Fi JSON is empty or too large");
        return false;
    }
    cJSON* root = cJSON_ParseWithLength(json, length);
    cJSON* networks = cJSON_IsObject(root) ? cJSON_GetObjectItemCaseSensitive(root, "networks") : nullptr;
    cJSON* ap = cJSON_IsObject(root) ? cJSON_GetObjectItemCaseSensitive(root, "ap") : nullptr;
    std::uint32_t schema_version = 0;
    WifiConfig value{};
    bool ok = get_uint(root, "schemaVersion", &schema_version, 1U, 1U, true) &&
              cJSON_IsArray(networks) && cJSON_IsObject(ap);
    std::uint16_t next_id = 1;
    for (cJSON* item = ok ? networks->child : nullptr; item != nullptr; item = item->next) {
        if (!cJSON_IsObject(item) || value.network_count >= kMaxWifiNetworks) { ok = false; break; }
        WifiNetwork& network = value.networks[value.network_count];
        std::uint32_t id = 0;
        cJSON* id_item = cJSON_GetObjectItemCaseSensitive(item, "id");
        if (id_item == nullptr) {
            // Assign the lowest free ID while reserving all explicit IDs in the
            // complete submitted list, including entries that appear later.
            bool used = true;
            while (used && next_id <= 65535U) {
                used = false;
                for (std::size_t i = 0; i < value.network_count; ++i)
                    if (value.networks[i].id == next_id) used = true;
                for (cJSON* scan = networks->child; !used && scan != nullptr; scan = scan->next) {
                    cJSON* candidate_item = cJSON_GetObjectItemCaseSensitive(scan, "id");
                    if (candidate_item == nullptr) continue;
                    std::uint32_t candidate_id = 0;
                    if (get_uint(scan, "id", &candidate_id, 1U, 65535U, true) && candidate_id == next_id)
                        used = true;
                }
                if (used) ++next_id;
            }
            if (next_id > 65535U) { ok = false; break; }
            id = next_id++;
        } else if (!get_uint(item, "id", &id, 1U, 65535U, true)) {
            ok = false; break;
        }
        cJSON* priority_item = cJSON_GetObjectItemCaseSensitive(item, "priority");
        if (!cJSON_IsNumber(priority_item) || priority_item->valuedouble < INT32_MIN ||
            priority_item->valuedouble > INT32_MAX || priority_item->valuedouble != static_cast<double>(priority_item->valueint)) {
            ok = false; break;
        }
        const std::int32_t priority = static_cast<std::int32_t>(priority_item->valueint);
        if (!copy_json_string(item, "ssid", network.ssid, sizeof(network.ssid), true) || network.ssid[0] == '\0') {
            ok = false; break;
        }
        cJSON* password = cJSON_GetObjectItemCaseSensitive(item, "password");
        if (password != nullptr && !cJSON_IsNull(password) &&
            (!cJSON_IsString(password) || password->valuestring == nullptr ||
             std::strlen(password->valuestring) > kMaxWifiPassword)) { ok = false; break; }
        if (cJSON_IsString(password)) std::snprintf(network.password, sizeof(network.password), "%s", password->valuestring);
        network.id = static_cast<std::uint16_t>(id);
        network.priority = static_cast<std::int32_t>(priority);
        for (std::size_t i = 0; i < value.network_count; ++i) {
            if (value.networks[i].id == network.id) ok = false;
        }
        if (!ok) break;
        if (network.password[0] != '\0' && std::strlen(network.password) < 8U) { ok = false; break; }
        ++value.network_count;
    }
    std::uint32_t number = 0;
    if (ok) ok = get_bool(ap, "enabled", &value.ap_enabled, true) &&
                 copy_json_string(ap, "ssidPrefix", value.ap_ssid_prefix, sizeof(value.ap_ssid_prefix), true);
    if (ok) {
        number = value.ap_channel;
        ok = get_uint(ap, "channel", &number, 1U, 13U, true);
        value.ap_channel = static_cast<std::uint8_t>(number);
    }
    if (ok) {
        number = value.ap_max_stations;
        ok = get_uint(ap, "maxStations", &number, 1U, 10U, true);
        value.ap_max_stations = static_cast<std::uint8_t>(number);
    }
    if (ok) ok = get_bool(ap, "keepApWhenConnected", &value.keep_ap_when_connected, true);
    cJSON* ap_password = cJSON_IsObject(ap) ? cJSON_GetObjectItemCaseSensitive(ap, "password") : nullptr;
    if (ok && ap_password != nullptr && !cJSON_IsNull(ap_password)) {
        ok = cJSON_IsString(ap_password) && ap_password->valuestring != nullptr &&
             std::strlen(ap_password->valuestring) >= 8U && std::strlen(ap_password->valuestring) <= kMaxWifiPassword;
        if (ok) std::snprintf(value.ap_password, sizeof(value.ap_password), "%s", ap_password->valuestring);
    }
    if (ok && value.ap_enabled && value.ap_password[0] != '\0' && std::strlen(value.ap_password) < 8U) ok = false;
    cJSON_Delete(root);
    if (!ok) {
        set_error(error, error_size, "Invalid Wi-Fi network list or access-point settings");
        return false;
    }
    if (parsed != nullptr) *parsed = value;
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
    std::uint32_t schema_version = 0;
    if (!cJSON_IsArray(sensors) || !get_uint(root, "schemaVersion", &schema_version, 1U, 1U, true)) {
        cJSON_Delete(root);
        set_error(error, error_size, "Expected schemaVersion: 1 and a sensors array");
        return false;
    }

    SensorConfigList list{};
    bool ok = true;
    for (cJSON* item = sensors->child; item != nullptr; item = item->next) {
        if (!cJSON_IsObject(item) || list.count >= kMaxSensors) { ok = false; break; }
        SensorConfig cfg{};
        std::uint32_t id = 0, rate = 0, ring_samples = 0;
        if (!get_uint(item, "id", &id, 0U, 65535U, true) ||
            !copy_json_string(item, "name", cfg.name, sizeof(cfg.name), true) ||
            !copy_json_string(item, "type", cfg.type, sizeof(cfg.type), true) ||
            !copy_json_string(item, "unit", cfg.unit, sizeof(cfg.unit), true) ||
            !copy_json_string(item, "rawFormat", cfg.raw_format, sizeof(cfg.raw_format), true) ||
            !get_bool(item, "enabled", &cfg.enabled, true) ||
            !get_uint(item, "rate_hz", &rate, 1U, 1000U, true) ||
            !get_uint(item, "ringbuffer_size_samples", &ring_samples, 1U, 100000U, true)) {
            ok = false; break;
        }
        static constexpr const char* formats[] = {"uint32", "uint64", "int24", "int32", "int64", "float32", "float64"};
        bool known_format = false;
        for (const char* format : formats) if (std::strcmp(cfg.raw_format, format) == 0) known_format = true;
        if (!known_format) { ok = false; break; }
        cfg.id = static_cast<std::uint16_t>(id);
        cfg.rate_hz = rate;
        cfg.ringbuffer_size_samples = ring_samples;
        for (std::size_t i = 0; i < list.count; ++i) if (list.items[i].id == cfg.id) ok = false;
        if (!ok) break;

        cJSON* warnings = cJSON_GetObjectItemCaseSensitive(item, "warnings");
        if (warnings != nullptr) {
            if (!cJSON_IsObject(warnings)) { ok = false; break; }
            auto parse_warning = [&](const char* key, WarningThreshold* warning) {
                cJSON* node = cJSON_GetObjectItemCaseSensitive(warnings, key);
                if (node == nullptr) return true;
                if (!cJSON_IsObject(node) || !get_bool(node, "enabled", &warning->enabled, true)) return false;
                if (!warning->enabled) return true;
                return get_number(node, "threshold", &warning->threshold, true) &&
                       get_number(node, "hysteresis", &warning->hysteresis, true) && warning->hysteresis >= 0.0;
            };
            if (!parse_warning("overload", &cfg.overload) || !parse_warning("underload", &cfg.underload)) {
                ok = false; break;
            }
        }

        if (strcasecmp(cfg.type, "hx711") == 0) {
            if (std::strcmp(cfg.raw_format, "int24") != 0) { ok = false; break; }
            cJSON* hx = cJSON_GetObjectItemCaseSensitive(item, "hx711");
            if (!cJSON_IsObject(hx) || !copy_json_string(hx, "gain", cfg.gain, sizeof(cfg.gain))) {
                ok = false; break;
            }
            // The documented null gain means the driver/default selection (A128).
            if (strcasecmp(cfg.gain, "A128") != 0 && strcasecmp(cfg.gain, "A64") != 0 &&
                strcasecmp(cfg.gain, "B32") != 0) {
                ok = false; break;
            }
            if (cfg.enabled && (!get_gpio(hx, "dout_gpio", &cfg.dout_gpio, false) ||
                    !get_gpio(hx, "sck_gpio", &cfg.sck_gpio, false) ||
                    !get_gpio(hx, "rate_gpio", &cfg.rate_gpio, true) ||
                    (cfg.rate_hz != 10U && cfg.rate_hz != 80U) ||
                    (strcasecmp(cfg.gain, "A128") != 0 && strcasecmp(cfg.gain, "A64") != 0 &&
                     strcasecmp(cfg.gain, "B32") != 0) || cfg.dout_gpio == cfg.sck_gpio ||
                    (cfg.rate_gpio >= 0 && (cfg.rate_gpio == cfg.dout_gpio || cfg.rate_gpio == cfg.sck_gpio)))) {
                ok = false; break;
            }
        }
        list.items[list.count++] = cfg;
    }

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
    if (!ok) {
        set_error(error, error_size, "Invalid sensor entry, duplicate ID/GPIO, or too many sensors");
        return false;
    }
    if (parsed != nullptr) *parsed = list;
    return true;
}

bool validate_structured_json(const char* json, std::size_t length, const char* required_key = nullptr) {
    if (json == nullptr || length == 0U || length > 65536U) return false;
    cJSON* root = cJSON_ParseWithLength(json, length);
    std::uint32_t schema_version = 0;
    bool valid = cJSON_IsObject(root) && get_uint(root, "schemaVersion", &schema_version, 1U, 1U, true);
    if (valid && required_key != nullptr) valid = cJSON_IsArray(cJSON_GetObjectItemCaseSensitive(root, required_key));
    cJSON_Delete(root);
    return valid;
}

bool write_default_if_missing(const char* path, const char* contents, std::size_t length) {
    struct stat st {};
    if (stat(path, &st) == 0 && st.st_size > 0) return true;
    return write_file_atomic(path, contents, length);
}

bool recover_backup_if_target_missing(const char* path) {
    char backup[256]{};
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

// Load an existing structured file before changing firmware-owned fields. This
// keeps keys owned by future firmware/WebUI revisions intact during serial
// maintenance operations such as hostname/password/network updates.
cJSON* load_object_for_update(const char* path) {
    char* bytes = nullptr;
    std::size_t length = 0;
    if (!read_file(path, &bytes, &length)) return nullptr;
    cJSON* root = cJSON_ParseWithLength(bytes, length);
    std::free(bytes);
    if (!cJSON_IsObject(root)) {
        cJSON_Delete(root);
        return nullptr;
    }
    return root;
}

cJSON* ensure_object(cJSON* parent, const char* key) {
    cJSON* value = cJSON_GetObjectItemCaseSensitive(parent, key);
    if (cJSON_IsObject(value)) return value;
    cJSON_DeleteItemFromObjectCaseSensitive(parent, key);
    return cJSON_AddObjectToObject(parent, key);
}

void replace_string(cJSON* parent, const char* key, const char* value) {
    cJSON_DeleteItemFromObjectCaseSensitive(parent, key);
    cJSON_AddStringToObject(parent, key, value != nullptr ? value : "");
}

void replace_number(cJSON* parent, const char* key, double value) {
    cJSON_DeleteItemFromObjectCaseSensitive(parent, key);
    cJSON_AddNumberToObject(parent, key, value);
}

void replace_boolean(cJSON* parent, const char* key, bool value) {
    cJSON_DeleteItemFromObjectCaseSensitive(parent, key);
    cJSON_AddBoolToObject(parent, key, value);
}
}  // namespace

esp_err_t init_filesystem() {
    esp_vfs_fat_mount_config_t mount_config{};
    // Never auto-format on mount failure: user settings and assets may be present.
    // Provision a blank or damaged partition through an explicit service action.
    mount_config.format_if_mount_failed = false;
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
        !recover_backup_if_target_missing(kWifiPath) ||
        !recover_backup_if_target_missing(kSensorsPath) ||
        !recover_backup_if_target_missing(kUnitsPath) ||
        !recover_backup_if_target_missing(kWebUiSettingsPath)) return ESP_FAIL;

    if (!write_default_if_missing(kSettingsPath, kDefaultSettings, sizeof(kDefaultSettings) - 1U) ||
        !write_default_if_missing(kWifiPath, kDefaultWifi, sizeof(kDefaultWifi) - 1U) ||
        !write_default_if_missing(kSensorsPath, kDefaultSensors, sizeof(kDefaultSensors) - 1U) ||
        !write_default_if_missing(kUnitsPath, kDefaultUnits, sizeof(kDefaultUnits) - 1U) ||
        !write_default_if_missing(kWebUiSettingsPath, kDefaultWebUiSettings, sizeof(kDefaultWebUiSettings) - 1U) ||
        !seed_embedded_assets()) {
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
    char temp_path[256]{};
    char backup_path[256]{};
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

bool load_wifi(WifiConfig& out, char* error, std::size_t error_size) {
    char* json = nullptr;
    std::size_t length = 0;
    if (!read_file(kWifiPath, &json, &length)) { set_error(error, error_size, "Cannot read wifi.json"); return false; }
    const bool ok = parse_wifi_internal(json, length, &out, error, error_size);
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

bool validate_wifi_json(const char* json, std::size_t length, WifiConfig* parsed,
                         char* error, std::size_t error_size) {
    return parse_wifi_internal(json, length, parsed, error, error_size);
}

bool validate_sensors_json(const char* json, std::size_t length, SensorConfigList* parsed,
                           char* error, std::size_t error_size) {
    return parse_sensors_internal(json, length, parsed, error, error_size);
}

bool validate_units_json(const char* json, std::size_t length) {
    if (json == nullptr || length == 0U || length > 65536U) return false;
    cJSON* root = cJSON_ParseWithLength(json, length);
    std::uint32_t schema = 0;
    cJSON* units = cJSON_IsObject(root) ? cJSON_GetObjectItemCaseSensitive(root, "units") : nullptr;
    bool ok = get_uint(root, "schemaVersion", &schema, 1U, 1U, true);
    // Validate the documented structural contract without interpreting conversion factors.
    char base[32]{}, def[32]{};
    if (ok) ok = copy_json_string(root, "baseUnit", base, sizeof(base), true) &&
                 copy_json_string(root, "defaultUnit", def, sizeof(def), true) && cJSON_IsArray(units);
    if (ok) {
        for (cJSON* item = units->child; item != nullptr; item = item->next) {
            char id[32]{}, name[64]{}, symbol[24]{}, group[48]{};
            cJSON* factor = cJSON_GetObjectItemCaseSensitive(item, "factor");
            std::uint32_t decimals = 0;
            if (!cJSON_IsObject(item) || !copy_json_string(item, "id", id, sizeof(id), true) ||
                !copy_json_string(item, "name", name, sizeof(name), true) ||
                !copy_json_string(item, "symbol", symbol, sizeof(symbol), true) ||
                !copy_json_string(item, "group", group, sizeof(group), true) ||
                !get_uint(item, "decimals", &decimals, 0U, 12U, true) ||
                !(cJSON_IsNull(factor) || (cJSON_IsNumber(factor) && factor->valuedouble > 0.0))) {
                ok = false; break;
            }
        }
    }
    cJSON_Delete(root);
    return ok;
}

bool validate_webui_settings_json(const char* json, std::size_t length) {
    return validate_structured_json(json, length);
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
    cJSON* root = load_object_for_update(kSettingsPath);
    if (root == nullptr) {
        ESP_LOGE(kTag, "Refusing to rewrite invalid/missing settings.json during a serial update");
        return false;
    }
    replace_number(root, "schemaVersion", 1);
    replace_string(root, "hostname", settings.hostname);
    replace_boolean(root, "redirectToHostname", settings.redirect_to_hostname);
    replace_string(root, "http_indexpath", settings.http_indexpath);

    cJSON* buffer = ensure_object(root, "buffer");
    cJSON* https = ensure_object(root, "https");
    cJSON* security = ensure_object(root, "security");
    bool structure_ok = buffer != nullptr && https != nullptr && security != nullptr;
    if (structure_ok) {
        replace_number(buffer, "ringbuffer_max_total_size_bytes", static_cast<double>(settings.ringbuffer_max_total_size_bytes));
        replace_number(buffer, "queue_capacity", static_cast<double>(settings.queue_capacity));
        replace_boolean(https, "enabled", settings.https_enabled);
        cJSON_DeleteItemFromObjectCaseSensitive(security, "password");
        cJSON_DeleteItemFromObjectCaseSensitive(security, "passwordSet");
        cJSON_DeleteItemFromObjectCaseSensitive(security, "passwordVerifier");
        if (settings.admin_hash_hex[0] != '\0') {
            cJSON* verifier = cJSON_AddObjectToObject(security, "passwordVerifier");
            structure_ok = verifier != nullptr;
            if (structure_ok) {
                cJSON_AddStringToObject(verifier, "algorithm", "PBKDF2-HMAC-SHA256");
                cJSON_AddStringToObject(verifier, "salt", settings.admin_salt_hex);
                cJSON_AddNumberToObject(verifier, "iterations", settings.pbkdf2_iterations);
                cJSON_AddStringToObject(verifier, "verifier", settings.admin_hash_hex);
            }
        }
    }
    char* printed = structure_ok ? cJSON_PrintUnformatted(root) : nullptr;
    const bool ok = printed != nullptr && write_file_atomic(kSettingsPath, printed, std::strlen(printed));
    cJSON_free(printed);
    cJSON_Delete(root);
    return ok;
}

bool save_wifi_json(const char* json, std::size_t length) {
    WifiConfig parsed{};
    char error[160]{};
    if (!parse_wifi_internal(json, length, &parsed, error, sizeof(error))) {
        ESP_LOGW(kTag, "Rejected Wi-Fi upload: %s", error);
        return false;
    }
    return write_file_atomic(kWifiPath, json, length);
}

bool save_wifi_struct(const WifiConfig& wifi) {
    if (wifi.network_count > kMaxWifiNetworks) return false;
    cJSON* root = load_object_for_update(kWifiPath);
    if (root == nullptr) {
        ESP_LOGE(kTag, "Refusing to rewrite invalid/missing wifi.json during a serial update");
        return false;
    }
    replace_number(root, "schemaVersion", 1);
    cJSON* previous_networks = cJSON_GetObjectItemCaseSensitive(root, "networks");
    cJSON* networks = cJSON_CreateArray();
    cJSON* ap = ensure_object(root, "ap");
    bool structure_ok = networks != nullptr && ap != nullptr;
    for (std::size_t i = 0; structure_ok && i < wifi.network_count; ++i) {
        const WifiNetwork& network = wifi.networks[i];
        cJSON* item = nullptr;
        // Preserve WebUI/future-owned properties on a network when its stable ID
        // survives a serial-side update.
        for (cJSON* old = cJSON_IsArray(previous_networks) ? previous_networks->child : nullptr;
             old != nullptr; old = old->next) {
            std::uint32_t old_id = 0;
            if (get_uint(old, "id", &old_id, 1U, 65535U, true) && old_id == network.id) {
                item = cJSON_Duplicate(old, 1);
                break;
            }
        }
        if (item == nullptr) item = cJSON_CreateObject();
        structure_ok = item != nullptr;
        if (!structure_ok) break;
        replace_number(item, "id", network.id);
        replace_string(item, "ssid", network.ssid);
        cJSON_DeleteItemFromObjectCaseSensitive(item, "password");
        cJSON_DeleteItemFromObjectCaseSensitive(item, "passwordSet");
        if (network.password[0] != '\0') cJSON_AddStringToObject(item, "password", network.password);
        replace_number(item, "priority", network.priority);
        cJSON_AddItemToArray(networks, item);
    }
    if (structure_ok) {
        cJSON_DeleteItemFromObjectCaseSensitive(root, "networks");
        cJSON_AddItemToObject(root, "networks", networks);
    } else {
        cJSON_Delete(networks);
    }
    if (structure_ok) {
        replace_boolean(ap, "enabled", wifi.ap_enabled);
        replace_string(ap, "ssidPrefix", wifi.ap_ssid_prefix);
        replace_number(ap, "channel", wifi.ap_channel);
        replace_number(ap, "maxStations", wifi.ap_max_stations);
        replace_boolean(ap, "keepApWhenConnected", wifi.keep_ap_when_connected);
        cJSON_DeleteItemFromObjectCaseSensitive(ap, "passwordSet");
        cJSON_DeleteItemFromObjectCaseSensitive(ap, "password");
        if (wifi.ap_password[0] != '\0') cJSON_AddStringToObject(ap, "password", wifi.ap_password);
    }
    char* printed = structure_ok ? cJSON_PrintUnformatted(root) : nullptr;
    const bool ok = printed != nullptr && write_file_atomic(kWifiPath, printed, std::strlen(printed));
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

bool save_units_json(const char* json, std::size_t length) {
    if (!validate_units_json(json, length)) return false;
    return write_file_atomic("/data/settings/units.json", json, length);
}

bool save_webui_settings_json(const char* json, std::size_t length) {
    if (!validate_webui_settings_json(json, length)) return false;
    return write_file_atomic(kWebUiSettingsPath, json, length);
}

bool get_index_path(char* output, std::size_t output_size) {
    if (output == nullptr || output_size == 0U) return false;
    Settings settings{};
    char error[80]{};
    if (!load_settings(settings, error, sizeof(error))) return false;
    if (std::strlen(settings.http_indexpath) >= output_size) return false;
    std::snprintf(output, output_size, "%s", settings.http_indexpath);
    return true;
}

bool set_index_path(const char* web_path) {
    if (web_path == nullptr || web_path[0] != '/' || !valid_web_path(web_path + 1)) return false;
    char asset_path[192]{};
    if (!make_asset_storage_path(web_path + 1, asset_path, sizeof(asset_path)) || access(asset_path, F_OK) != 0) return false;
    Settings settings{};
    char error[80]{};
    if (!load_settings(settings, error, sizeof(error))) return false;
    if (std::strlen(web_path) >= sizeof(settings.http_indexpath)) return false;
    std::snprintf(settings.http_indexpath, sizeof(settings.http_indexpath), "%s", web_path);
    return save_settings_struct(settings);
}

bool make_asset_storage_path(const char* web_path, char* output, std::size_t output_size) {
    if (!valid_web_path(web_path) || output == nullptr) return false;
    const int written = std::snprintf(output, output_size, "/data/www/%s.gz", web_path);
    return written >= 0 && static_cast<std::size_t>(written) < output_size;
}

bool ensure_asset_parent_directory(const char* web_path) {
    return ensure_asset_parent_directories(web_path);
}

bool save_asset_gzip(const char* web_path, const void* data, std::size_t length) {
    char path[256]{};
    return ensure_asset_parent_directories(web_path) && make_asset_storage_path(web_path, path, sizeof(path)) &&
           write_file_atomic(path, data, length);
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
    char path[256]{};
    if (!make_asset_storage_path(web_path, path, sizeof(path))) return false;
    return unlink(path) == 0;
}

bool rename_asset(const char* from_web_path, const char* to_web_path) {
    if (is_protected_default_asset(from_web_path) || is_protected_default_asset(to_web_path)) return false;
    char from[256]{};
    char to[256]{};
    if (!make_asset_storage_path(from_web_path, from, sizeof(from)) ||
        !make_asset_storage_path(to_web_path, to, sizeof(to)) || access(from, F_OK) != 0 || access(to, F_OK) == 0 ||
        !ensure_asset_parent_directories(to_web_path)) return false;
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
    if (filename == nullptr || output == nullptr) return false;
    const std::size_t length = std::strlen(filename);
    constexpr char kPrefix[] = "calibration_";
    constexpr char kExtension[] = ".json";
    if (length <= sizeof(kPrefix) - 1U + 1U + sizeof(kExtension) - 1U || length > 64U ||
        std::strncmp(filename, kPrefix, sizeof(kPrefix) - 1U) != 0 ||
        strcasecmp(filename + length - (sizeof(kExtension) - 1U), kExtension) != 0) return false;

    const char* sensor_id = filename + sizeof(kPrefix) - 1U;
    const char* separator = std::strchr(sensor_id, '_');
    if (separator == nullptr || separator == sensor_id) return false;
    for (const char* p = sensor_id; p < separator; ++p)
        if (!std::isdigit(static_cast<unsigned char>(*p))) return false;

    const char* profile = separator + 1;
    const std::size_t profile_length = static_cast<std::size_t>((filename + length - (sizeof(kExtension) - 1U)) - profile);
    if (profile_length == 0U) return false;
    for (std::size_t i = 0; i < profile_length; ++i) {
        const unsigned char c = static_cast<unsigned char>(profile[i]);
        if (!(std::isalnum(c) || c == '_' || c == '-' || c == '.')) return false;
    }
    const int written = std::snprintf(output, output_size, "/data/calibration/%s", filename);
    return written >= 0 && static_cast<std::size_t>(written) < output_size;
}

}  // namespace app::config_store
