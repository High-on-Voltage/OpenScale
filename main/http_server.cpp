#include "http_server.hpp"

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <dirent.h>
#include <initializer_list>
#include <limits>
#include <sys/statvfs.h>
#include <sys/stat.h>
#include <unistd.h>
#include <strings.h>

#include "cJSON.h"
#include "config_store.hpp"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "lwip/ip4_addr.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_random.h"
#include "esp_chip_info.h"
#include "esp_timer.h"
#include "esp_flash.h"
#include "mbedtls/base64.h"
#include "security.hpp"
#include "sensor_manager.hpp"
#include "version.hpp"
#include "freertos/task.h"
#include "freertos/FreeRTOS.h"

namespace app {
namespace {
constexpr char kTag[] = "http";
constexpr std::size_t kMaxJsonBody = 65536;
constexpr std::size_t kMaxSseBatch = 64;
constexpr std::size_t kMaxHistoryChunk = 512;
constexpr int kMaxSseClients = 3;

struct ServerContext {
    Settings settings{};
    SensorManager* sensors = nullptr;
    httpd_handle_t handle = nullptr;
    char boot_id[9]{};
    char csrf_token[33]{};
    bool settings_pending = false;
    bool wifi_pending = false;
    bool sensors_pending = false;
};
ServerContext s_server{};
std::atomic<int> s_sse_clients{0};
std::uint64_t s_sse_event_counter = 0;
portMUX_TYPE s_sse_event_mux = portMUX_INITIALIZER_UNLOCKED;

constexpr std::size_t kDeviceLogCapacity = 128;
struct DeviceLogEntry {
    std::uint64_t log_entry_id = 0;
    std::uint64_t timestamp_us = 0;
    char type[24]{};
    char message[112]{};
    char file[32]{};
    char reason[48]{};
};
DeviceLogEntry s_device_log[kDeviceLogCapacity]{};
std::size_t s_device_log_write = 0;
std::size_t s_device_log_count = 0;
std::uint64_t s_device_log_latest_id = 0;
portMUX_TYPE s_device_log_mux = portMUX_INITIALIZER_UNLOCKED;

constexpr std::size_t kEventIdCacheCapacity = 512;
struct EventIdCacheEntry {
    std::uint8_t kind = 0;
    std::uint16_t sensor_id = 0;
    std::uint64_t payload_id = 0;
    std::uint64_t event_counter = 0;
};
EventIdCacheEntry s_event_id_cache[kEventIdCacheCapacity]{};
std::size_t s_event_id_cache_write = 0;

std::uint64_t next_sse_event_counter() {
    portENTER_CRITICAL(&s_sse_event_mux);
    const std::uint64_t value = ++s_sse_event_counter;
    portEXIT_CRITICAL(&s_sse_event_mux);
    return value;
}

std::uint64_t shared_sse_event_counter(std::uint8_t kind, std::uint16_t sensor_id, std::uint64_t payload_id) {
    portENTER_CRITICAL(&s_sse_event_mux);
    for (const EventIdCacheEntry& entry : s_event_id_cache) {
        if (entry.event_counter != 0U && entry.kind == kind && entry.sensor_id == sensor_id && entry.payload_id == payload_id) {
            const std::uint64_t value = entry.event_counter;
            portEXIT_CRITICAL(&s_sse_event_mux);
            return value;
        }
    }
    const std::uint64_t value = ++s_sse_event_counter;
    s_event_id_cache[s_event_id_cache_write] = {kind, sensor_id, payload_id, value};
    s_event_id_cache_write = (s_event_id_cache_write + 1U) % kEventIdCacheCapacity;
    portEXIT_CRITICAL(&s_sse_event_mux);
    return value;
}

std::size_t copy_device_logs_after(std::uint64_t after_id, DeviceLogEntry* output, std::size_t capacity) {
    if (output == nullptr || capacity == 0U) return 0U;
    portENTER_CRITICAL(&s_device_log_mux);
    const std::size_t count = s_device_log_count;
    const std::size_t oldest = (s_device_log_write + kDeviceLogCapacity - count) % kDeviceLogCapacity;
    std::size_t copied = 0;
    for (std::size_t i = 0; i < count && copied < capacity; ++i) {
        const DeviceLogEntry& entry = s_device_log[(oldest + i) % kDeviceLogCapacity];
        if (entry.log_entry_id > after_id) output[copied++] = entry;
    }
    portEXIT_CRITICAL(&s_device_log_mux);
    return copied;
}

void set_common_headers(httpd_req_t* request) {
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    httpd_resp_set_hdr(request, "X-Content-Type-Options", "nosniff");
    httpd_resp_set_hdr(request, "Referrer-Policy", "no-referrer");
}

esp_err_t send_error(httpd_req_t* request, const char* status, const char* message) {
    httpd_resp_set_status(request, status);
    httpd_resp_set_type(request, "application/json; charset=utf-8");
    set_common_headers(request);
    cJSON* root = cJSON_CreateObject();
    cJSON_AddBoolToObject(root, "ok", false);
    cJSON_AddStringToObject(root, "error", message != nullptr ? message : "Request failed");
    char* body = cJSON_PrintUnformatted(root);
    const esp_err_t err = body != nullptr ? httpd_resp_sendstr(request, body) : httpd_resp_sendstr(request, "{\"ok\":false}");
    cJSON_free(body);
    cJSON_Delete(root);
    return err;
}

esp_err_t send_json(httpd_req_t* request, cJSON* root, const char* status = "200 OK") {
    char* body = cJSON_PrintUnformatted(root);
    if (body == nullptr) return send_error(request, "500 Internal Server Error", "Out of memory");
    httpd_resp_set_status(request, status);
    httpd_resp_set_type(request, "application/json; charset=utf-8");
    set_common_headers(request);
    const esp_err_t err = httpd_resp_sendstr(request, body);
    cJSON_free(body);
    return err;
}

// cJSON numbers are doubles. Protocol uint64 fields must remain exact integer
// tokens, including after uptime/sample IDs grow beyond JavaScript's 2^53 limit.
void add_uint64(cJSON* object, const char* key, std::uint64_t value) {
    char token[32]{};
    std::snprintf(token, sizeof(token), "%llu", static_cast<unsigned long long>(value));
    cJSON_AddItemToObject(object, key, cJSON_CreateRaw(token));
}

bool request_is_admin(httpd_req_t* request) {
    if (s_server.settings.admin_hash_hex[0] == '\0') return true;

    const std::size_t header_length = httpd_req_get_hdr_value_len(request, "Authorization");
    auto unauthorized = [request]() {
        httpd_resp_set_status(request, "401 Unauthorized");
        httpd_resp_set_type(request, "application/json; charset=utf-8");
        set_common_headers(request);
        httpd_resp_sendstr(request, "{\"ok\":false,\"error\":\"Authentication required\"}");
    };
    if (header_length == 0U || header_length > 256U) { unauthorized(); return false; }

    char header[257]{};
    if (httpd_req_get_hdr_value_str(request, "Authorization", header, sizeof(header)) != ESP_OK ||
        std::strncmp(header, "Basic ", 6U) != 0) { unauthorized(); return false; }

    unsigned char decoded[192]{};
    std::size_t decoded_length = 0;
    const int rc = mbedtls_base64_decode(decoded, sizeof(decoded) - 1U, &decoded_length,
                                          reinterpret_cast<const unsigned char*>(header + 6U),
                                          std::strlen(header + 6U));
    if (rc != 0 || decoded_length == 0U) { unauthorized(); return false; }
    decoded[decoded_length] = '\0';
    char* separator = std::strchr(reinterpret_cast<char*>(decoded), ':');
    if (separator == nullptr) { unauthorized(); return false; }
    *separator = '\0';
    const bool username_ok = true;  // v0.5 settings schema defines a password, not a username.
    const bool password_ok = security::verify_admin_password(s_server.settings, separator + 1);
    if (username_ok && password_ok) return true;
    unauthorized();
    return false;
}

bool request_has_csrf(httpd_req_t* request) {
    char supplied[40]{};
    return httpd_req_get_hdr_value_str(request, "X-CSRF-Token", supplied, sizeof(supplied)) == ESP_OK &&
           std::strcmp(supplied, s_server.csrf_token) == 0;
}

bool require_csrf(httpd_req_t* request) {
    if (request_has_csrf(request)) return true;
    send_error(request, "403 Forbidden", "Missing or invalid X-CSRF-Token");
    return false;
}

bool read_request_body(httpd_req_t* request, std::size_t max_size, char** output, std::size_t* length) {
    if (output == nullptr || length == nullptr || request->content_len == 0U || request->content_len > max_size) return false;
    *output = nullptr;
    *length = 0;
    char* body = static_cast<char*>(std::malloc(request->content_len + 1U));
    if (body == nullptr) return false;
    std::size_t received_total = 0;
    while (received_total < request->content_len) {
        const int received = httpd_req_recv(request, body + received_total, request->content_len - received_total);
        if (received == HTTPD_SOCK_ERR_TIMEOUT) continue;
        if (received <= 0) { std::free(body); return false; }
        received_total += static_cast<std::size_t>(received);
    }
    body[received_total] = '\0';
    *output = body;
    *length = received_total;
    return true;
}

bool request_path_equals(const httpd_req_t* request, const char* expected_path) {
    if (request == nullptr || expected_path == nullptr) return false;
    const char* query = std::strchr(request->uri, '?');
    const std::size_t actual_length = query != nullptr
        ? static_cast<std::size_t>(query - request->uri) : std::strlen(request->uri);
    return actual_length == std::strlen(expected_path) &&
           std::memcmp(request->uri, expected_path, actual_length) == 0;
}

bool query_value(httpd_req_t* request, const char* key, char* output, std::size_t output_size) {
    const std::size_t query_length = httpd_req_get_url_query_len(request);
    if (query_length == 0U || query_length > 256U) return false;
    char query[257]{};
    if (httpd_req_get_url_query_str(request, query, sizeof(query)) != ESP_OK) return false;
    return httpd_query_key_value(query, key, output, output_size) == ESP_OK;
}

bool parse_unsigned_query(httpd_req_t* request, const char* key, std::uint32_t* output) {
    char text[24]{};
    if (!query_value(request, key, text, sizeof(text))) return false;
    char* end = nullptr;
    errno = 0;
    const unsigned long value = std::strtoul(text, &end, 10);
    if (text[0] == '-' || errno == ERANGE || end == text || *end != '\0' || value > UINT32_MAX) return false;
    *output = static_cast<std::uint32_t>(value);
    return true;
}

bool parse_unsigned_query64(httpd_req_t* request, const char* key, std::uint64_t* output) {
    char text[32]{};
    if (!query_value(request, key, text, sizeof(text)) || text[0] == '\0' || text[0] == '-') return false;
    char* end = nullptr;
    errno = 0;
    const unsigned long long value = std::strtoull(text, &end, 10);
    if (errno == ERANGE || end == text || *end != '\0') return false;
    *output = static_cast<std::uint64_t>(value);
    return true;
}

long double decode_raw_value(const SensorConfig& config, std::uint64_t raw) {
    if (std::strcmp(config.raw_format, "int24") == 0) {
        std::uint32_t bits = static_cast<std::uint32_t>(raw) & 0x00ffffffU;
        std::int32_t value = (bits & 0x00800000U) != 0U
            ? static_cast<std::int32_t>(bits | 0xff000000U) : static_cast<std::int32_t>(bits);
        return value;
    }
    if (std::strcmp(config.raw_format, "int32") == 0) {
        const std::uint32_t bits = static_cast<std::uint32_t>(raw);
        std::int32_t value = 0;
        std::memcpy(&value, &bits, sizeof(value));
        return value;
    }
    if (std::strcmp(config.raw_format, "int64") == 0) {
        std::int64_t value = 0;
        std::memcpy(&value, &raw, sizeof(value));
        return static_cast<long double>(value);
    }
    if (std::strcmp(config.raw_format, "float32") == 0) {
        const std::uint32_t bits = static_cast<std::uint32_t>(raw);
        float value = 0.0F;
        std::memcpy(&value, &bits, sizeof(value));
        return std::isfinite(value) ? static_cast<long double>(value) : std::numeric_limits<long double>::quiet_NaN();
    }
    if (std::strcmp(config.raw_format, "float64") == 0) {
        double value = 0.0;
        std::memcpy(&value, &raw, sizeof(value));
        return std::isfinite(value) ? static_cast<long double>(value) : std::numeric_limits<long double>::quiet_NaN();
    }
    return static_cast<long double>(raw);
}

std::uint32_t calculate_sample_flags(std::uint16_t sensor_id, std::uint64_t raw) {
    if (s_server.sensors == nullptr) return 0U;
    SensorStats stats[kMaxSensors]{};
    const std::size_t count = s_server.sensors->get_stats(stats, kMaxSensors);
    for (std::size_t i = 0; i < count; ++i) {
        if (stats[i].config.id != sensor_id) continue;
        const long double value = decode_raw_value(stats[i].config, raw);
        if (!std::isfinite(value)) return 0U;
        std::uint32_t flags = 0U;
        if (stats[i].config.overload.enabled && value >= stats[i].config.overload.threshold) flags |= 0x00000001U;
        if (stats[i].config.underload.enabled && value <= stats[i].config.underload.threshold) flags |= 0x00000002U;
        return flags;
    }
    return 0U;
}

void store_le16(std::uint8_t* output, std::uint16_t value) {
    output[0] = static_cast<std::uint8_t>(value & 0xffU);
    output[1] = static_cast<std::uint8_t>((value >> 8U) & 0xffU);
}

void store_le32(std::uint8_t* output, std::uint32_t value) {
    for (unsigned i = 0; i < 4U; ++i) output[i] = static_cast<std::uint8_t>((value >> (i * 8U)) & 0xffU);
}

void store_le64(std::uint8_t* output, std::uint64_t value) {
    for (unsigned i = 0; i < 8U; ++i) output[i] = static_cast<std::uint8_t>((value >> (i * 8U)) & 0xffU);
}

bool ring_bytes_required(const SensorConfigList& sensors, std::size_t* output) {
    if (output == nullptr) return false;
    std::size_t total = 0;
    for (std::size_t i = 0; i < sensors.count; ++i) {
        const std::size_t samples = sensors.items[i].ringbuffer_size_samples;
        if (samples > (SIZE_MAX - total) / sizeof(RingEntry)) return false;
        total += samples * sizeof(RingEntry);
    }
    *output = total;
    return true;
}

const char* mime_type_for(const char* path) {
    const char* ext = std::strrchr(path, '.');
    if (ext == nullptr) return "application/octet-stream";
    if (strcasecmp(ext, ".html") == 0 || strcasecmp(ext, ".htm") == 0) return "text/html; charset=utf-8";
    if (strcasecmp(ext, ".js") == 0 || strcasecmp(ext, ".mjs") == 0) return "text/javascript; charset=utf-8";
    if (strcasecmp(ext, ".css") == 0) return "text/css; charset=utf-8";
    if (strcasecmp(ext, ".json") == 0 || strcasecmp(ext, ".webmanifest") == 0) return "application/json; charset=utf-8";
    if (strcasecmp(ext, ".svg") == 0) return "image/svg+xml";
    if (strcasecmp(ext, ".png") == 0) return "image/png";
    if (strcasecmp(ext, ".jpg") == 0 || strcasecmp(ext, ".jpeg") == 0) return "image/jpeg";
    if (strcasecmp(ext, ".webp") == 0) return "image/webp";
    if (strcasecmp(ext, ".gif") == 0) return "image/gif";
    if (strcasecmp(ext, ".ico") == 0) return "image/x-icon";
    if (strcasecmp(ext, ".wasm") == 0) return "application/wasm";
    if (strcasecmp(ext, ".xml") == 0) return "application/xml";
    if (strcasecmp(ext, ".pdf") == 0) return "application/pdf";
    if (strcasecmp(ext, ".woff2") == 0) return "font/woff2";
    if (strcasecmp(ext, ".woff") == 0) return "font/woff";
    if (strcasecmp(ext, ".ttf") == 0) return "font/ttf";
    if (strcasecmp(ext, ".txt") == 0 || strcasecmp(ext, ".map") == 0 ||
        strcasecmp(ext, ".md") == 0 || strcasecmp(ext, ".ts") == 0) return "text/plain; charset=utf-8";
    return "application/octet-stream";
}

bool safe_web_path_from_uri(const char* uri, const char* prefix, char* output, std::size_t output_size) {
    if (uri == nullptr || prefix == nullptr || output == nullptr) return false;
    const std::size_t prefix_length = std::strlen(prefix);
    if (std::strncmp(uri, prefix, prefix_length) != 0) return false;
    const char* path = uri + prefix_length;
    if (*path == '/') ++path;
    const char* query = std::strchr(path, '?');
    const std::size_t length = query != nullptr ? static_cast<std::size_t>(query - path) : std::strlen(path);
    if (length == 0U || length >= output_size) return false;
    std::memcpy(output, path, length);
    output[length] = '\0';
    if (std::strstr(output, "..") != nullptr || std::strchr(output, '%') != nullptr || std::strchr(output, '\\') != nullptr) return false;
    return true;
}

esp_err_t serve_compressed_asset(httpd_req_t* request, const char* web_path) {
    char absolute_path[256]{};
    if (!config_store::make_asset_storage_path(web_path, absolute_path, sizeof(absolute_path))) {
        return send_error(request, "400 Bad Request", "Invalid web path");
    }
    FILE* file = std::fopen(absolute_path, "rb");
    if (file == nullptr) return send_error(request, "404 Not Found", "File not found");

    httpd_resp_set_type(request, mime_type_for(web_path));
    httpd_resp_set_hdr(request, "Content-Encoding", "gzip");
    httpd_resp_set_hdr(request, "Vary", "Accept-Encoding");
    httpd_resp_set_hdr(request, "Cache-Control", "public, max-age=60");
    char buffer[1024];
    esp_err_t result = ESP_OK;
    while (true) {
        const std::size_t count = std::fread(buffer, 1U, sizeof(buffer), file);
        if (count > 0U && httpd_resp_send_chunk(request, buffer, count) != ESP_OK) {
            result = ESP_FAIL;
            break;
        }
        if (count < sizeof(buffer)) {
            if (std::ferror(file)) result = ESP_FAIL;
            break;
        }
    }
    std::fclose(file);
    if (result == ESP_OK) result = httpd_resp_send_chunk(request, nullptr, 0);
    return result;
}

esp_err_t static_file_handler(httpd_req_t* request) {
    if (std::strncmp(request->uri, "/api/", 5U) == 0 || std::strncmp(request->uri, "/data/", 6U) == 0 ||
        request_path_equals(request, "/stream")) return send_error(request, "404 Not Found", "Unknown endpoint");

    char web_path[160]{};
    if (request_path_equals(request, "/")) {
        if (!config_store::get_index_path(web_path, sizeof(web_path))) std::snprintf(web_path, sizeof(web_path), "/default.html");
        if (web_path[0] == '/') std::memmove(web_path, web_path + 1, std::strlen(web_path));
    } else {
        if (!safe_web_path_from_uri(request->uri, "/", web_path, sizeof(web_path))) {
            return send_error(request, "400 Bad Request", "Invalid path");
        }
    }
    return serve_compressed_asset(request, web_path);
}

void redact_settings_json(cJSON* root) {
    cJSON* security = cJSON_GetObjectItemCaseSensitive(root, "security");
    if (!cJSON_IsObject(security)) return;
    cJSON_DeleteItemFromObjectCaseSensitive(security, "passwordVerifier");
    cJSON_DeleteItemFromObjectCaseSensitive(security, "password");
    cJSON_DeleteItemFromObjectCaseSensitive(security, "passwordSet");
    cJSON_AddBoolToObject(security, "passwordSet", s_server.settings.admin_hash_hex[0] != '\0');
}

void redact_wifi_json(cJSON* root) {
    cJSON* networks = cJSON_GetObjectItemCaseSensitive(root, "networks");
    if (cJSON_IsArray(networks)) {
        for (cJSON* item = networks->child; item != nullptr; item = item->next) {
            cJSON* password = cJSON_GetObjectItemCaseSensitive(item, "password");
            const bool password_set = cJSON_IsString(password) && password->valuestring != nullptr && password->valuestring[0] != '\0';
            cJSON_DeleteItemFromObjectCaseSensitive(item, "password");
            cJSON_DeleteItemFromObjectCaseSensitive(item, "passwordSet");
            cJSON_AddBoolToObject(item, "passwordSet", password_set);
        }
    }
    cJSON* ap = cJSON_GetObjectItemCaseSensitive(root, "ap");
    if (cJSON_IsObject(ap)) {
        cJSON* password = cJSON_GetObjectItemCaseSensitive(ap, "password");
        const bool password_set = cJSON_IsString(password) && password->valuestring != nullptr && password->valuestring[0] != '\0';
        cJSON_DeleteItemFromObjectCaseSensitive(ap, "password");
        cJSON_DeleteItemFromObjectCaseSensitive(ap, "passwordSet");
        cJSON_AddBoolToObject(ap, "passwordSet", password_set);
    }
}

esp_err_t send_write_result(httpd_req_t* request, const char* status, bool saved, const char* pending_file = nullptr) {
    cJSON* response = cJSON_CreateObject();
    cJSON_AddStringToObject(response, "status", status);
    cJSON_AddBoolToObject(response, "saved", saved);
    cJSON_AddArrayToObject(response, "errors");
    cJSON_AddArrayToObject(response, "warnings");
    cJSON* pending = cJSON_AddArrayToObject(response, "pendingChanges");
    if (pending_file != nullptr) cJSON_AddItemToArray(pending, cJSON_CreateString(pending_file));
    const esp_err_t err = send_json(request, response);
    cJSON_Delete(response);
    return err;
}

const char* settings_path_for_request(httpd_req_t* request) {
    if (request_path_equals(request, "/data/settings/settings.json")) return "/data/settings/settings.json";
    if (request_path_equals(request, "/data/settings/wifi.json")) return "/data/settings/wifi.json";
    if (request_path_equals(request, "/data/settings/sensors.json")) return "/data/settings/sensors.json";
    if (request_path_equals(request, "/data/settings/units.json")) return "/data/settings/units.json";
    if (request_path_equals(request, "/data/settings/webui-settings.json")) return "/data/settings/webui-settings.json";
    return nullptr;
}

bool resource_requires_admin(const char* path) {
    return path != nullptr &&
        (std::strcmp(path, "/data/settings/settings.json") == 0 ||
         std::strcmp(path, "/data/settings/wifi.json") == 0);
}

bool apply_settings_put(const char* body, std::size_t length, char* error, std::size_t error_size) {
    Settings parsed{};
    if (!config_store::validate_settings_json(body, length, &parsed, error, error_size)) return false;
    Settings previous{};
    char previous_error[96]{};
    if (!config_store::load_settings(previous, previous_error, sizeof(previous_error))) previous = Settings{};

    cJSON* root = cJSON_ParseWithLength(body, length);
    cJSON* security_object = cJSON_IsObject(root) ? cJSON_GetObjectItemCaseSensitive(root, "security") : nullptr;
    cJSON* password = cJSON_IsObject(security_object) ? cJSON_GetObjectItemCaseSensitive(security_object, "password") : nullptr;
    if (cJSON_IsObject(security_object) && cJSON_GetObjectItemCaseSensitive(security_object, "passwordVerifier") != nullptr) {
        cJSON_Delete(root);
        std::snprintf(error, error_size, "passwordVerifier is firmware-internal; submit security.password instead");
        return false;
    }
    if (password == nullptr) {
        std::snprintf(parsed.admin_salt_hex, sizeof(parsed.admin_salt_hex), "%s", previous.admin_salt_hex);
        std::snprintf(parsed.admin_hash_hex, sizeof(parsed.admin_hash_hex), "%s", previous.admin_hash_hex);
        parsed.pbkdf2_iterations = previous.pbkdf2_iterations;
    } else if (cJSON_IsNull(password)) {
        parsed.admin_salt_hex[0] = '\0';
        parsed.admin_hash_hex[0] = '\0';
    } else if (cJSON_IsString(password) && password->valuestring != nullptr) {
        const esp_err_t password_error = security::set_admin_password(parsed, password->valuestring);
        if (password_error != ESP_OK) {
            cJSON_Delete(root);
            std::snprintf(error, error_size, "security.password must contain 8-128 characters");
            return false;
        }
    } else {
        cJSON_Delete(root);
        std::snprintf(error, error_size, "security.password must be a string or null");
        return false;
    }

    cJSON_DeleteItemFromObjectCaseSensitive(security_object, "password");
    cJSON_DeleteItemFromObjectCaseSensitive(security_object, "passwordSet");
    if (parsed.admin_hash_hex[0] != '\0') {
        cJSON* verifier = cJSON_AddObjectToObject(security_object, "passwordVerifier");
        cJSON_AddStringToObject(verifier, "algorithm", "PBKDF2-HMAC-SHA256");
        cJSON_AddStringToObject(verifier, "salt", parsed.admin_salt_hex);
        cJSON_AddNumberToObject(verifier, "iterations", parsed.pbkdf2_iterations);
        cJSON_AddStringToObject(verifier, "verifier", parsed.admin_hash_hex);
    } else {
        cJSON_DeleteItemFromObjectCaseSensitive(security_object, "passwordVerifier");
    }
    char* persisted = cJSON_PrintUnformatted(root);
    const bool saved = persisted != nullptr &&
        config_store::save_settings_json(persisted, std::strlen(persisted));
    cJSON_free(persisted);
    cJSON_Delete(root);
    if (saved) s_server.settings = parsed;  // Keep auth/password state consistent without waiting for reboot.
    return saved;
}

bool apply_wifi_put(const char* body, std::size_t length, char* error, std::size_t error_size) {
    WifiConfig parsed{};
    if (!config_store::validate_wifi_json(body, length, &parsed, error, error_size)) return false;
    WifiConfig previous{};
    char previous_error[96]{};
    if (!config_store::load_wifi(previous, previous_error, sizeof(previous_error))) previous = WifiConfig{};

    cJSON* root = cJSON_ParseWithLength(body, length);
    cJSON* networks = cJSON_IsObject(root) ? cJSON_GetObjectItemCaseSensitive(root, "networks") : nullptr;
    std::size_t index = 0;
    for (cJSON* item = cJSON_IsArray(networks) ? networks->child : nullptr; item != nullptr; item = item->next, ++index) {
        if (index >= parsed.network_count) break;
        const std::uint16_t id = parsed.networks[index].id;
        cJSON* supplied_id = cJSON_GetObjectItemCaseSensitive(item, "id");
        if (supplied_id == nullptr) cJSON_AddNumberToObject(item, "id", id);
        cJSON* password = cJSON_GetObjectItemCaseSensitive(item, "password");
        if (password == nullptr) {
            for (std::size_t old = 0; old < previous.network_count; ++old) {
                if (previous.networks[old].id == id && previous.networks[old].password[0] != '\0') {
                    cJSON_AddStringToObject(item, "password", previous.networks[old].password);
                    break;
                }
            }
        }
    }
    cJSON* ap = cJSON_GetObjectItemCaseSensitive(root, "ap");
    if (cJSON_IsObject(ap) && cJSON_GetObjectItemCaseSensitive(ap, "password") == nullptr && previous.ap_password[0] != '\0') {
        cJSON_AddStringToObject(ap, "password", previous.ap_password);
    }
    char* persisted = cJSON_PrintUnformatted(root);
    const bool saved = persisted != nullptr && config_store::save_wifi_json(persisted, std::strlen(persisted));
    cJSON_free(persisted);
    cJSON_Delete(root);
    if (!saved) std::snprintf(error, error_size, "Could not save wifi.json");
    return saved;
}

esp_err_t settings_resource_handler(httpd_req_t* request) {
    const char* path = settings_path_for_request(request);
    if (path == nullptr) return send_error(request, "404 Not Found", "Unknown settings file");
    const bool admin_resource = resource_requires_admin(path);

    if (request->method == HTTP_GET) {
        if (admin_resource && !request_is_admin(request)) return ESP_OK;
        char* data = nullptr;
        std::size_t length = 0;
        if (!config_store::read_file(path, &data, &length)) return send_error(request, "404 Not Found", "Settings file unavailable");
        cJSON* root = cJSON_ParseWithLength(data, length);
        std::free(data);
        if (!cJSON_IsObject(root)) { cJSON_Delete(root); return send_error(request, "500 Internal Server Error", "Stored settings JSON is invalid"); }
        if (std::strcmp(path, "/data/settings/settings.json") == 0) redact_settings_json(root);
        if (std::strcmp(path, "/data/settings/wifi.json") == 0) redact_wifi_json(root);
        const esp_err_t err = send_json(request, root);
        cJSON_Delete(root);
        return err;
    }

    if (request->method == HTTP_PUT) {
        if (!require_csrf(request)) return ESP_OK;
        if (!request_is_admin(request)) return ESP_OK;
        char* body = nullptr;
        std::size_t length = 0;
        if (!read_request_body(request, kMaxJsonBody, &body, &length)) return send_error(request, "413 Payload Too Large", "Missing or oversized JSON body");
        bool saved = false;
        const char* status = "needs-restart";
        char error[192]{};
        const char* pending = nullptr;
        if (std::strcmp(path, "/data/settings/settings.json") == 0) {
            saved = apply_settings_put(body, length, error, sizeof(error));
            pending = "settings.json";
        } else if (std::strcmp(path, "/data/settings/wifi.json") == 0) {
            saved = apply_wifi_put(body, length, error, sizeof(error));
            pending = "wifi.json";
        } else if (std::strcmp(path, "/data/settings/sensors.json") == 0) {
            SensorConfigList parsed{};
            std::size_t required_bytes = 0;
            saved = config_store::validate_sensors_json(body, length, &parsed, error, sizeof(error)) &&
                    ring_bytes_required(parsed, &required_bytes) && required_bytes <= s_server.settings.ringbuffer_max_total_size_bytes &&
                    config_store::save_sensors_json(body, length);
            if (saved) pending = "sensors.json";
            else if (error[0] == '\0') std::snprintf(error, sizeof(error), "Sensor buffers exceed the configured aggregate memory budget");
        } else if (std::strcmp(path, "/data/settings/units.json") == 0) {
            saved = config_store::save_units_json(body, length);
            status = "applied";
            if (!saved) std::snprintf(error, sizeof(error), "Invalid units.json structure");
        } else if (std::strcmp(path, "/data/settings/webui-settings.json") == 0) {
            saved = config_store::save_webui_settings_json(body, length);
            status = "applied";
            if (!saved) std::snprintf(error, sizeof(error), "Expected a schemaVersion: 1 JSON object");
        }
        std::free(body);
        if (!saved) return send_error(request, "400 Bad Request", error[0] ? error : "Configuration update rejected");
        if (std::strcmp(path, "/data/settings/settings.json") == 0) s_server.settings_pending = true;
        else if (std::strcmp(path, "/data/settings/wifi.json") == 0) s_server.wifi_pending = true;
        else if (std::strcmp(path, "/data/settings/sensors.json") == 0) s_server.sensors_pending = true;
        return send_write_result(request, status, true, pending);
    }

    if (request->method == HTTP_DELETE) {
        if (!require_csrf(request)) return ESP_OK;
        if (!request_is_admin(request)) return ESP_OK;
        const char* defaults = nullptr;
        const char* pending = nullptr;
        const char* status = "needs-restart";
        if (std::strcmp(path, "/data/settings/settings.json") == 0) {
            defaults = R"json({"schemaVersion":1,"hostname":"","redirectToHostname":true,"http_indexpath":"/default.html","buffer":{"ringbuffer_max_total_size_bytes":262144,"queue_capacity":64},"https":{"enabled":false},"security":{}})json";
            pending = "settings.json";
        } else if (std::strcmp(path, "/data/settings/wifi.json") == 0) {
            defaults = R"json({"schemaVersion":1,"networks":[],"ap":{"enabled":true,"ssidPrefix":"OpenScale","channel":1,"maxStations":4,"keepApWhenConnected":false}})json";
            pending = "wifi.json";
        } else if (std::strcmp(path, "/data/settings/sensors.json") == 0) {
            defaults = R"json({"schemaVersion":1,"sensors":[]})json";
            pending = "sensors.json";
        } else if (std::strcmp(path, "/data/settings/units.json") == 0) {
            defaults = R"json({"schemaVersion":1,"baseUnit":"mg","defaultUnit":"g","units":[{"id":"ug","name":"Micrograms","symbol":"µg","factor":0.001,"decimals":0,"group":"Metric"},{"id":"mg","name":"Milligrams","symbol":"mg","factor":1,"decimals":1,"group":"Metric"},{"id":"g","name":"Grams","symbol":"g","factor":1000,"decimals":3,"group":"Metric"},{"id":"kg","name":"Kilograms","symbol":"kg","factor":1000000,"decimals":3,"group":"Metric"},{"id":"oz_av","name":"Ounces (avoirdupois)","symbol":"oz","factor":28349.523125,"decimals":4,"group":"Imperial / US customary"},{"id":"lb_av","name":"Pounds (avoirdupois)","symbol":"lb","factor":453592.37,"decimals":5,"group":"Imperial / US customary"},{"id":"oz_troy","name":"Troy ounces","symbol":"oz t","factor":31103.4768,"decimals":4,"group":"Imperial / US customary"},{"id":"st","name":"Stone","symbol":"st","factor":6350293.18,"decimals":4,"group":"Imperial / US customary"},{"id":"raw","name":"Raw sensor counts (diagnostic)","symbol":"counts","factor":null,"decimals":0,"group":"Diagnostic"}]})json";
            status = "applied";
        } else {
            defaults = R"json({"schemaVersion":1})json";
            status = "applied";
        }
        const bool saved = config_store::write_file_atomic(path, defaults, std::strlen(defaults));
        if (!saved) return send_error(request, "507 Insufficient Storage", "Could not restore factory default");
        if (std::strcmp(path, "/data/settings/settings.json") == 0) {
            s_server.settings = Settings{};
            s_server.settings_pending = true;
        } else if (std::strcmp(path, "/data/settings/wifi.json") == 0) {
            s_server.wifi_pending = true;
        } else if (std::strcmp(path, "/data/settings/sensors.json") == 0) {
            s_server.sensors_pending = true;
        }
        return send_write_result(request, status, true, pending);
    }
    return send_error(request, "405 Method Not Allowed", "Method not supported for this settings resource");
}

esp_err_t calibration_file_handler(httpd_req_t* request) {
    char filename[80]{};
    if (!safe_web_path_from_uri(request->uri, "/data/calibration/", filename, sizeof(filename))) {
        return send_error(request, "400 Bad Request", "Invalid calibration path");
    }
    char path[128]{};
    if (!config_store::make_calibration_storage_path(filename, path, sizeof(path))) {
        return send_error(request, "400 Bad Request", "Invalid calibration filename");
    }
    char* data = nullptr;
    std::size_t length = 0;
    if (!config_store::read_file(path, &data, &length)) return send_error(request, "404 Not Found", "Calibration file not found");
    httpd_resp_set_type(request, "application/json; charset=utf-8");
    httpd_resp_set_hdr(request, "Content-Encoding", "gzip");
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    const esp_err_t err = httpd_resp_send(request, data, length);
    std::free(data);
    return err;
}

esp_err_t device_log_handler(httpd_req_t* request) {
    std::uint64_t after_id = 0;
    char after_text[32]{};
    bool after_supplied = false;
    if (query_value(request, "after_id", after_text, sizeof(after_text))) {
        char* end = nullptr;
        errno = 0;
        const unsigned long long parsed = std::strtoull(after_text, &end, 10);
        if (after_text[0] < '0' || after_text[0] > '9' || errno == ERANGE || end == after_text || *end != '\0')
            return send_error(request, "400 Bad Request", "after_id must be an unsigned integer");
        after_id = static_cast<std::uint64_t>(parsed);
        after_supplied = true;
    }

    std::uint32_t limit = 128;
    char limit_text[24]{};
    if (query_value(request, "limit", limit_text, sizeof(limit_text))) {
        if (!parse_unsigned_query(request, "limit", &limit) || limit == 0U || limit > 128U)
            return send_error(request, "400 Bad Request", "limit must be between 1 and 128");
    }

    auto* snapshot = static_cast<DeviceLogEntry*>(std::calloc(kDeviceLogCapacity, sizeof(DeviceLogEntry)));
    if (snapshot == nullptr) return send_error(request, "500 Internal Server Error", "Out of memory");
    const std::size_t count = copy_device_logs_after(0, snapshot, kDeviceLogCapacity);
    std::uint64_t oldest_id = 0;
    std::uint64_t latest_id = 0;
    if (count > 0U) {
        oldest_id = snapshot[0].log_entry_id;
        latest_id = snapshot[count - 1U].log_entry_id;
    }
    std::size_t filtered_count = 0;
    for (std::size_t i = 0; i < count; ++i)
        if (snapshot[i].log_entry_id > after_id) ++filtered_count;
    bool truncated = false;
    if (after_supplied && oldest_id != 0U && after_id < oldest_id - 1U) truncated = true;
    const std::size_t skip = filtered_count > limit ? filtered_count - limit : 0U;
    if (skip > 0U) truncated = true;

    cJSON* root = cJSON_CreateObject();
    cJSON* entries = cJSON_AddArrayToObject(root, "entries");
    std::size_t matching_index = 0;
    for (std::size_t i = 0; i < count; ++i) {
        const DeviceLogEntry& entry = snapshot[i];
        if (entry.log_entry_id <= after_id) continue;
        if (matching_index++ < skip) continue;
        cJSON* item = cJSON_CreateObject();
        add_uint64(item, "logEntryId", entry.log_entry_id);
        add_uint64(item, "t", entry.timestamp_us);
        cJSON_AddStringToObject(item, "type", entry.type);
        cJSON_AddStringToObject(item, "message", entry.message);
        if (entry.file[0] != '\0' || entry.reason[0] != '\0') {
            cJSON* details = cJSON_AddObjectToObject(item, "details");
            if (entry.file[0] != '\0') cJSON_AddStringToObject(details, "file", entry.file);
            if (entry.reason[0] != '\0') cJSON_AddStringToObject(details, "reason", entry.reason);
            if (std::strcmp(entry.type, "config_fallback") == 0)
                cJSON_AddBoolToObject(details, "savedFileModified", false);
        }
        cJSON_AddItemToArray(entries, item);
    }
    cJSON_AddNumberToObject(root, "returned", filtered_count - skip);
    add_uint64(root, "oldestLogEntryId", oldest_id);
    add_uint64(root, "latestLogEntryId", latest_id);
    cJSON_AddBoolToObject(root, "truncated", truncated);
    const esp_err_t err = send_json(request, root);
    cJSON_Delete(root);
    std::free(snapshot);
    return err;
}

esp_err_t device_handler(httpd_req_t* request) {
    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "productName", "OpenScale");
    cJSON_AddStringToObject(root, "firmwareVersion", version::firmware);
    cJSON_AddStringToObject(root, "webuiVersion", version::webui);
    cJSON_AddStringToObject(root, "buildId", version::build_id);
    cJSON_AddStringToObject(root, "gitCommit", version::git_commit);
    cJSON_AddStringToObject(root, "espIdfVersion", esp_get_idf_version());
    cJSON_AddNumberToObject(root, "protocolVersion", 1);
    cJSON* formats = cJSON_AddObjectToObject(root, "fileFormatVersions");
    cJSON_AddNumberToObject(formats, "settings", 1);
    cJSON_AddNumberToObject(formats, "wifi", 1);
    cJSON_AddNumberToObject(formats, "sensors", 1);
    cJSON_AddNumberToObject(formats, "units", 1);
    cJSON_AddNumberToObject(formats, "webuiSettings", 1);
    cJSON_AddNumberToObject(formats, "calibration", 1);
    cJSON_AddNumberToObject(formats, "historyBinary", 1);
    cJSON_AddNumberToObject(root, "maxUploadBytes", kDefaultMaxUploadBytes);
    cJSON_AddNumberToObject(root, "maxHistoryChunk", kMaxHistoryChunk);

    esp_chip_info_t chip{};
    esp_chip_info(&chip);
    cJSON_AddNumberToObject(root, "chipRevision", chip.revision);
    cJSON_AddNumberToObject(root, "cpuCores", chip.cores);
    std::uint32_t flash_size = 0;
    if (esp_flash_get_size(nullptr, &flash_size) == ESP_OK)
        cJSON_AddNumberToObject(root, "flashPhysicalBytes", flash_size);
    const esp_err_t err = send_json(request, root);
    cJSON_Delete(root);
    return err;
}

esp_err_t status_handler(httpd_req_t* request) {
    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "bootId", s_server.boot_id);
    add_uint64(root, "uptimeUs", static_cast<std::uint64_t>(esp_timer_get_time()));
    cJSON_AddStringToObject(root, "csrfToken", s_server.csrf_token);
    cJSON* pending = cJSON_AddArrayToObject(root, "pendingChanges");
    if (s_server.settings_pending) cJSON_AddItemToArray(pending, cJSON_CreateString("settings.json"));
    if (s_server.wifi_pending) cJSON_AddItemToArray(pending, cJSON_CreateString("wifi.json"));
    if (s_server.sensors_pending) cJSON_AddItemToArray(pending, cJSON_CreateString("sensors.json"));
    cJSON_AddNullToObject(root, "unixtimestamp");
    cJSON_AddNumberToObject(root, "openSseConnections", s_sse_clients.load(std::memory_order_relaxed));

    cJSON* memory = cJSON_AddObjectToObject(root, "memory");
    cJSON_AddNumberToObject(memory, "heapFree", static_cast<double>(esp_get_free_heap_size()));
    cJSON_AddNumberToObject(memory, "heapMinFree", static_cast<double>(esp_get_minimum_free_heap_size()));
    cJSON_AddNumberToObject(memory, "heapLargestBlock", static_cast<double>(heap_caps_get_largest_free_block(MALLOC_CAP_DEFAULT)));
    cJSON_AddNumberToObject(memory, "psramTotal", static_cast<double>(heap_caps_get_total_size(MALLOC_CAP_SPIRAM)));
    cJSON_AddNumberToObject(memory, "psramFree", static_cast<double>(heap_caps_get_free_size(MALLOC_CAP_SPIRAM)));
    cJSON_AddNumberToObject(memory, "psramLargestBlock", static_cast<double>(heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM)));

    cJSON* flash = cJSON_AddObjectToObject(root, "flash");
    std::uint32_t flash_size = 0;
    if (esp_flash_get_size(nullptr, &flash_size) == ESP_OK) cJSON_AddNumberToObject(flash, "physicalTotal", flash_size);
    struct statvfs fs_stats {};
    if (statvfs("/data", &fs_stats) == 0) {
        const std::uint64_t total = static_cast<std::uint64_t>(fs_stats.f_blocks) * fs_stats.f_frsize;
        const std::uint64_t free = static_cast<std::uint64_t>(fs_stats.f_bavail) * fs_stats.f_frsize;
        cJSON_AddNumberToObject(flash, "filesystemTotal", static_cast<double>(total));
        cJSON_AddNumberToObject(flash, "filesystemFree", static_cast<double>(free));
        cJSON_AddNumberToObject(flash, "filesystemUsed", static_cast<double>(total - free));
    }

    cJSON* wifi = cJSON_AddObjectToObject(root, "wifi");
    wifi_ap_record_t ap_info{};
    const bool wifi_connected = esp_wifi_sta_get_ap_info(&ap_info) == ESP_OK;
    cJSON_AddBoolToObject(wifi, "connected", wifi_connected);
    if (wifi_connected) cJSON_AddNumberToObject(wifi, "rssi", ap_info.rssi);
    esp_netif_t* sta_netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (sta_netif != nullptr) {
        esp_netif_ip_info_t ip_info{};
        if (esp_netif_get_ip_info(sta_netif, &ip_info) == ESP_OK && ip_info.ip.addr != 0U) {
            char ip[16]{};
            std::snprintf(ip, sizeof(ip), IPSTR, IP2STR(&ip_info.ip));
            cJSON_AddStringToObject(wifi, "ip", ip);
        }
    }
    wifi_sta_list_t ap_stations{};
    if (esp_wifi_ap_get_sta_list(&ap_stations) == ESP_OK)
        cJSON_AddNumberToObject(wifi, "clientsConnected", ap_stations.num);

    SensorStats stats[kMaxSensors]{};
    const std::size_t count = s_server.sensors->get_stats(stats, kMaxSensors);
    cJSON* sensors = cJSON_AddArrayToObject(root, "sensors");
    for (std::size_t i = 0; i < count; ++i) {
        cJSON* item = cJSON_CreateObject();
        cJSON_AddNumberToObject(item, "sensorId", stats[i].config.id);
        cJSON_AddStringToObject(item, "state", stats[i].task_active ? "ok" : (stats[i].config.enabled ? "error" : "disabled"));
        cJSON_AddNumberToObject(item, "rate_hz", stats[i].config.rate_hz);
        add_uint64(item, "sensorUptimeUs", stats[i].sensor_uptime_us);
        cJSON_AddNumberToObject(item, "configRevision", 1);
        cJSON_AddNumberToObject(item, "warningRevision", 1);
        cJSON_AddNumberToObject(item, "ringBufferCapacity", static_cast<double>(stats[i].capacity));
        cJSON_AddNumberToObject(item, "ringBufferUsed", static_cast<double>(stats[i].buffered_samples));
        add_uint64(item, "oldestId", stats[i].oldest_sequence);
        add_uint64(item, "latestId", stats[i].newest_sequence);
        cJSON_AddNumberToObject(item, "queueDrops", stats[i].queue_drops);
        cJSON_AddNumberToObject(item, "readErrors", stats[i].read_errors);
        cJSON_AddItemToArray(sensors, item);
    }
    const esp_err_t err = send_json(request, root);
    cJSON_Delete(root);
    return err;
}

esp_err_t history_handler(httpd_req_t* request) {
    std::uint32_t sensor_id = 0;
    if (!parse_unsigned_query(request, "sensor_id", &sensor_id) || sensor_id > 65535U)
        return send_error(request, "400 Bad Request", "Provide sensor_id as a numeric sensor ID");

    std::uint64_t from_id = 0;
    std::uint64_t to_id = 0;
    char from_text[32]{}, to_text[32]{};
    const bool has_from = query_value(request, "from_id", from_text, sizeof(from_text));
    const bool has_to = query_value(request, "to_id", to_text, sizeof(to_text));
    if (has_from != has_to) return send_error(request, "400 Bad Request", "from_id and to_id must be supplied together");
    if (has_from && (!parse_unsigned_query64(request, "from_id", &from_id) ||
                     !parse_unsigned_query64(request, "to_id", &to_id) || to_id < from_id))
        return send_error(request, "400 Bad Request", "Invalid inclusive sample ID range");

    std::uint32_t requested_limit = 5000U;
    char limit_text[24]{};
    if (query_value(request, "limit", limit_text, sizeof(limit_text))) {
        if (!parse_unsigned_query(request, "limit", &requested_limit) || requested_limit == 0U)
            return send_error(request, "400 Bad Request", "limit must be a positive integer");
    }
    const std::size_t limit = std::min<std::size_t>(requested_limit, kMaxHistoryChunk);

    char format[12] = "json";
    char format_text[12]{};
    if (query_value(request, "format", format_text, sizeof(format_text))) {
        if (std::strcmp(format_text, "json") != 0 && std::strcmp(format_text, "bin") != 0)
            return send_error(request, "400 Bad Request", "format must be json or bin");
        std::snprintf(format, sizeof(format), "%s", format_text);
    }

    auto* samples = static_cast<Sample*>(std::calloc(limit, sizeof(Sample)));
    if (samples == nullptr) return send_error(request, "500 Internal Server Error", "Out of memory");
    bool limit_truncated = false;
    HistoryInfo history_info{};
    const std::size_t count = s_server.sensors->copy_history(static_cast<std::uint16_t>(sensor_id), has_from,
        from_id, to_id, limit, samples, limit, &limit_truncated, &history_info);

    SensorStats sensor_stats{};
    bool sensor_found = false;
    SensorStats all_stats[kMaxSensors]{};
    const std::size_t stats_count = s_server.sensors->get_stats(all_stats, kMaxSensors);
    for (std::size_t i = 0; i < stats_count; ++i) {
        if (all_stats[i].config.id == sensor_id) {
            sensor_stats = all_stats[i];
            sensor_found = true;
            break;
        }
    }

    bool truncated = limit_truncated;
    if (has_from && history_info.retained > 0U) {
        if (from_id < history_info.oldest_id || to_id > history_info.latest_id ||
            to_id < history_info.oldest_id || from_id > history_info.latest_id) truncated = true;
    }
    for (std::size_t i = 0; i < count; ++i)
        samples[i].flags = calculate_sample_flags(samples[i].sensor_id, samples[i].raw_value);

    const std::uint64_t first_id = count > 0U ? samples[0].sequence : 0U;
    const std::uint64_t last_id = count > 0U ? samples[count - 1U].sequence : 0U;
    const std::uint64_t oldest_id = history_info.retained > 0U ? history_info.oldest_id : 0U;
    const std::uint64_t latest_id = history_info.retained > 0U ? history_info.latest_id : 0U;

    char numeric[32]{};
    std::snprintf(numeric, sizeof(numeric), "%u", static_cast<unsigned>(count));
    httpd_resp_set_hdr(request, "X-History-Returned", numeric);
    if (count > 0U) {
        std::snprintf(numeric, sizeof(numeric), "%llu", static_cast<unsigned long long>(first_id));
        httpd_resp_set_hdr(request, "X-History-First-Id", numeric);
        std::snprintf(numeric, sizeof(numeric), "%llu", static_cast<unsigned long long>(last_id));
        httpd_resp_set_hdr(request, "X-History-Last-Id", numeric);
    }
    if (oldest_id != 0U) {
        std::snprintf(numeric, sizeof(numeric), "%llu", static_cast<unsigned long long>(latest_id));
        httpd_resp_set_hdr(request, "X-History-Latest-Id", numeric);
        std::snprintf(numeric, sizeof(numeric), "%llu", static_cast<unsigned long long>(oldest_id));
        httpd_resp_set_hdr(request, "X-History-Oldest-Id", numeric);
    }
    httpd_resp_set_hdr(request, "X-History-Truncated", truncated ? "true" : "false");
    std::snprintf(numeric, sizeof(numeric), "%u", static_cast<unsigned>(kMaxHistoryChunk));
    httpd_resp_set_hdr(request, "X-History-Max-Chunk", numeric);
    set_common_headers(request);

    esp_err_t response_error = ESP_OK;
    if (std::strcmp(format, "bin") == 0) {
        constexpr std::size_t header_size = 12U;
        constexpr std::size_t record_size = 28U;
        const std::size_t payload_size = header_size + count * record_size;
        auto* payload = static_cast<std::uint8_t*>(std::calloc(payload_size, 1U));
        if (payload == nullptr) {
            std::free(samples);
            return send_error(request, "500 Internal Server Error", "Out of memory");
        }
        payload[0] = 'H'; payload[1] = 'I'; payload[2] = 'S'; payload[3] = 'T';
        store_le16(payload + 4U, 1U);
        store_le16(payload + 6U, 0U);
        store_le32(payload + 8U, static_cast<std::uint32_t>(count));
        for (std::size_t i = 0; i < count; ++i) {
            std::uint8_t* record = payload + header_size + i * record_size;
            store_le64(record, samples[i].sequence);
            store_le64(record + 8U, samples[i].timestamp_us);
            store_le64(record + 16U, samples[i].raw_value);
            store_le32(record + 24U, samples[i].flags);
        }
        httpd_resp_set_type(request, "application/octet-stream");
        response_error = httpd_resp_send(request, reinterpret_cast<const char*>(payload), payload_size);
        std::free(payload);
    } else {
        const std::size_t body_capacity = 512U + count * 160U;
        char* body = static_cast<char*>(std::malloc(body_capacity));
        if (body == nullptr) {
            std::free(samples);
            return send_error(request, "500 Internal Server Error", "Out of memory");
        }
        std::size_t offset = 0;
        auto append = [&](const char* fmt, auto... args) {
            if (offset >= body_capacity) return false;
            const int written = std::snprintf(body + offset, body_capacity - offset, fmt, args...);
            if (written < 0 || static_cast<std::size_t>(written) >= body_capacity - offset) return false;
            offset += static_cast<std::size_t>(written);
            return true;
        };
        bool ok = append("{\"sensorId\":%u,\"samples\":[", static_cast<unsigned>(sensor_id));
        for (std::size_t i = 0; ok && i < count; ++i) {
            ok = append("%s{\"n\":%llu,\"t\":%llu,\"raw\":%llu,\"flags\":%u}",
                i == 0U ? "" : ",", static_cast<unsigned long long>(samples[i].sequence),
                static_cast<unsigned long long>(samples[i].timestamp_us),
                static_cast<unsigned long long>(samples[i].raw_value), samples[i].flags);
        }
        ok = ok && append("],\"returned\":%u,\"firstId\":", static_cast<unsigned>(count));
        ok = ok && (count > 0U ? append("%llu", static_cast<unsigned long long>(first_id)) : append("null"));
        ok = ok && append(",\"lastId\":");
        ok = ok && (count > 0U ? append("%llu", static_cast<unsigned long long>(last_id)) : append("null"));
        ok = ok && append(",\"latestId\":");
        ok = ok && (latest_id > 0U ? append("%llu", static_cast<unsigned long long>(latest_id)) : append("null"));
        ok = ok && append(",\"oldestId\":");
        ok = ok && (oldest_id > 0U ? append("%llu", static_cast<unsigned long long>(oldest_id)) : append("null"));
        ok = ok && append(",\"truncated\":%s}", truncated ? "true" : "false");
        if (!ok) response_error = send_error(request, "500 Internal Server Error", "Could not serialize history response");
        else {
            httpd_resp_set_type(request, "application/json; charset=utf-8");
            response_error = httpd_resp_send(request, body, offset);
        }
        std::free(body);
    }
    std::free(samples);
    return response_error;
}

esp_err_t files_list_handler(httpd_req_t* request) {
    struct stat root_stats {};
    if (stat("/data/www", &root_stats) != 0 || !S_ISDIR(root_stats.st_mode)) {
        return send_error(request, "500 Internal Server Error", "Cannot open web asset directory");
    }
    const bool password_set = s_server.settings.admin_hash_hex[0] != '\0';
    cJSON* root = cJSON_CreateObject();
    cJSON* files = cJSON_AddArrayToObject(root, "files");
    cJSON* api_paths = cJSON_AddArrayToObject(root, "apiPaths");
    append_web_assets_recursive("/data/www", "", files, password_set);

    append_settings_file(files, "/data/settings/settings.json", password_set);
    append_settings_file(files, "/data/settings/wifi.json", password_set);
    append_settings_file(files, "/data/settings/sensors.json", password_set);
    append_settings_file(files, "/data/settings/units.json", password_set);
    append_settings_file(files, "/data/settings/webui-settings.json", password_set);
    append_calibration_files(files, password_set);

    add_api_path(api_paths, "/", {"GET"});
    add_api_path(api_paths, "/api/device", {"GET"});
    add_api_path(api_paths, "/api/status", {"GET"});
    add_api_path(api_paths, "/api/device-log", {"GET"});
    add_api_path(api_paths, "/api/history", {"GET"});
    add_api_path(api_paths, "/stream", {"GET"});
    add_api_path(api_paths, "/api/restart", {"POST"});
    add_api_path(api_paths, "/api/files", {"GET"});
    add_api_path(api_paths, "/data/settings/settings.json", {"GET", "PUT", "DELETE"});
    add_api_path(api_paths, "/data/settings/wifi.json", {"GET", "PUT", "DELETE"});
    add_api_path(api_paths, "/data/settings/sensors.json", {"GET", "PUT", "DELETE"});
    add_api_path(api_paths, "/data/settings/units.json", {"GET", "PUT", "DELETE"});
    add_api_path(api_paths, "/data/settings/webui-settings.json", {"GET", "PUT", "DELETE"});
    add_api_path(api_paths, "/data/calibration/calibration_<sensorId>_<profileId>.json", {"GET", "PUT", "DELETE"});
    add_api_path(api_paths, "/<static-asset-path>", {"GET", "PUT", "DELETE"});

    const esp_err_t err = send_json(request, root);
    cJSON_Delete(root);
    return err;
}

bool write_uploaded_file(httpd_req_t* request, const char* final_path, std::size_t max_length,
                         bool* insufficient_storage) {
    if (insufficient_storage != nullptr) *insufficient_storage = false;
    auto mark_storage_error = [insufficient_storage]() {
        if (insufficient_storage != nullptr && errno == ENOSPC) *insufficient_storage = true;
    };
    // A gzip stream has a fixed two-byte magic prefix and is at least 18 bytes.
    if (request->content_len < 18U || request->content_len > max_length) return false;
    char temporary_path[320]{};
    char backup_path[320]{};
    if (std::snprintf(temporary_path, sizeof(temporary_path), "%s.upload", final_path) >= static_cast<int>(sizeof(temporary_path)) ||
        std::snprintf(backup_path, sizeof(backup_path), "%s.bak", final_path) >= static_cast<int>(sizeof(backup_path))) return false;

    FILE* file = std::fopen(temporary_path, "wb");
    if (file == nullptr) { mark_storage_error(); return false; }
    char buffer[1024];
    std::size_t remaining = request->content_len;
    bool ok = true;
    while (remaining > 0U) {
        const std::size_t wanted = std::min(remaining, sizeof(buffer));
        const int received = httpd_req_recv(request, buffer, wanted);
        if (received == HTTPD_SOCK_ERR_TIMEOUT) continue;
        if (received <= 0 || std::fwrite(buffer, 1U, static_cast<std::size_t>(received), file) != static_cast<std::size_t>(received)) {
            mark_storage_error();
            ok = false;
            break;
        }
        remaining -= static_cast<std::size_t>(received);
    }
    if (ok && std::fflush(file) != 0) { mark_storage_error(); ok = false; }
    if (ok && fsync(fileno(file)) != 0) { mark_storage_error(); ok = false; }
    if (std::fclose(file) != 0) { mark_storage_error(); ok = false; }
    if (!ok) { unlink(temporary_path); return false; }

    FILE* validation_file = std::fopen(temporary_path, "rb");
    unsigned char gzip_magic[2]{};
    const bool is_gzip = validation_file != nullptr &&
        std::fread(gzip_magic, 1U, sizeof(gzip_magic), validation_file) == sizeof(gzip_magic) &&
        gzip_magic[0] == 0x1fU && gzip_magic[1] == 0x8bU;
    if (validation_file != nullptr) std::fclose(validation_file);
    if (!is_gzip) { unlink(temporary_path); return false; }

    unlink(backup_path);
    const bool had_original = access(final_path, F_OK) == 0;
    if (had_original && rename(final_path, backup_path) != 0) {
        mark_storage_error();
        unlink(temporary_path);
        return false;
    }
    if (rename(temporary_path, final_path) != 0) {
        mark_storage_error();
        if (had_original) rename(backup_path, final_path);
        unlink(temporary_path);
        return false;
    }
    unlink(backup_path);
    return true;
}

esp_err_t asset_upload_handler(httpd_req_t* request) {
    if (!require_csrf(request)) return ESP_OK;
    if (!request_is_admin(request)) return ESP_OK;
    char web_path[160]{};
    if (!safe_web_path_from_uri(request->uri, "/", web_path, sizeof(web_path)) ||
        config_store::is_protected_default_asset(web_path)) {
        return send_error(request, "400 Bad Request", "Invalid or immutable asset path");
    }
    char encoding[32]{};
    if (httpd_req_get_hdr_value_str(request, "Content-Encoding", encoding, sizeof(encoding)) != ESP_OK ||
        strcasecmp(encoding, "gzip") != 0) {
        return send_error(request, "415 Unsupported Media Type", "Upload assets with Content-Encoding: gzip");
    }
    char final_path[256]{};
    if (!config_store::ensure_asset_parent_directory(web_path) ||
        !config_store::make_asset_storage_path(web_path, final_path, sizeof(final_path))) {
        return send_error(request, "400 Bad Request", "Invalid asset path");
    }
    if (request->content_len > kDefaultMaxUploadBytes)
        return send_error(request, "413 Payload Too Large", "Request body exceeds maxUploadBytes");
    bool insufficient_storage = false;
    if (!write_uploaded_file(request, final_path, kDefaultMaxUploadBytes, &insufficient_storage)) {
        return send_error(request, insufficient_storage ? "507 Insufficient Storage" : "400 Bad Request",
                          insufficient_storage ? "Insufficient flash space" : "Upload failed or body was not a gzip stream");
    }
    return send_write_result(request, "applied", true);
}

esp_err_t asset_delete_handler(httpd_req_t* request) {
    if (!require_csrf(request)) return ESP_OK;
    if (!request_is_admin(request)) return ESP_OK;
    char web_path[160]{};
    if (!safe_web_path_from_uri(request->uri, "/", web_path, sizeof(web_path)) ||
        config_store::is_protected_default_asset(web_path)) return send_error(request, "400 Bad Request", "Invalid or immutable asset path");
    if (!config_store::delete_asset(web_path)) return send_error(request, "404 Not Found", "Asset not found or selected index cannot be deleted");
    return send_write_result(request, "applied", true);
}

esp_err_t calibration_delete_handler(httpd_req_t* request) {
    if (!require_csrf(request)) return ESP_OK;
    if (!request_is_admin(request)) return ESP_OK;
    char filename[80]{};
    if (!safe_web_path_from_uri(request->uri, "/data/calibration/", filename, sizeof(filename)))
        return send_error(request, "400 Bad Request", "Invalid calibration filename");
    char path[128]{};
    if (!config_store::make_calibration_storage_path(filename, path, sizeof(path)))
        return send_error(request, "400 Bad Request", "Invalid calibration filename");
    if (unlink(path) != 0) return send_error(request, "404 Not Found", "Calibration file not found");
    return send_write_result(request, "applied", true);
}

esp_err_t calibration_upload_handler(httpd_req_t* request) {
    if (!require_csrf(request)) return ESP_OK;
    if (!request_is_admin(request)) return ESP_OK;
    char filename[80]{};
    if (!safe_web_path_from_uri(request->uri, "/data/calibration/", filename, sizeof(filename)))
        return send_error(request, "400 Bad Request", "Invalid calibration filename");
    char path[128]{};
    if (!config_store::make_calibration_storage_path(filename, path, sizeof(path)))
        return send_error(request, "400 Bad Request", "Invalid calibration filename");
    char content_type[64]{};
    if (httpd_req_get_hdr_value_str(request, "Content-Type", content_type, sizeof(content_type)) != ESP_OK ||
        strncasecmp(content_type, "application/json", 16U) != 0 ||
        (content_type[16] != '\0' && content_type[16] != ';' && content_type[16] != ' '))
        return send_error(request, "415 Unsupported Media Type", "Upload calibration JSON with Content-Type: application/json");
    char encoding[32]{};
    if (httpd_req_get_hdr_value_str(request, "Content-Encoding", encoding, sizeof(encoding)) != ESP_OK ||
        strcasecmp(encoding, "gzip") != 0)
        return send_error(request, "415 Unsupported Media Type", "Upload calibration JSON with Content-Encoding: gzip");
    if (request->content_len > kDefaultMaxUploadBytes)
        return send_error(request, "413 Payload Too Large", "Request body exceeds maxUploadBytes");
    bool insufficient_storage = false;
    if (!write_uploaded_file(request, path, kDefaultMaxUploadBytes, &insufficient_storage)) {
        return send_error(request, insufficient_storage ? "507 Insufficient Storage" : "400 Bad Request",
                          insufficient_storage ? "Insufficient flash space" : "Calibration upload failed or body was not a gzip stream");
    }
    return send_write_result(request, "applied", true);
}

esp_err_t restart_handler(httpd_req_t* request) {
    if (!require_csrf(request)) return ESP_OK;
    if (!request_is_admin(request)) return ESP_OK;
    cJSON* response = cJSON_CreateObject();
    cJSON_AddBoolToObject(response, "ok", true);
    cJSON_AddStringToObject(response, "message", "Restarting");
    const esp_err_t err = send_json(request, response);
    cJSON_Delete(response);
    if (err == ESP_OK) {
        vTaskDelay(pdMS_TO_TICKS(250));
        esp_restart();
    }
    return err;
}

bool send_sse_device_log(httpd_req_t* request, const DeviceLogEntry& entry, bool snapshot) {
    cJSON* data_object = cJSON_CreateObject();
    add_uint64(data_object, "logEntryId", entry.log_entry_id);
    add_uint64(data_object, "t", entry.timestamp_us);
    cJSON_AddStringToObject(data_object, "type", entry.type);
    cJSON_AddStringToObject(data_object, "message", entry.message);
    if (entry.file[0] != '\0' || entry.reason[0] != '\0') {
        cJSON* details = cJSON_AddObjectToObject(data_object, "details");
        if (entry.file[0] != '\0') cJSON_AddStringToObject(details, "file", entry.file);
        if (entry.reason[0] != '\0') cJSON_AddStringToObject(details, "reason", entry.reason);
        if (std::strcmp(entry.type, "config_fallback") == 0)
            cJSON_AddBoolToObject(details, "savedFileModified", false);
    }
    char* data = cJSON_PrintUnformatted(data_object);
    cJSON_Delete(data_object);
    if (data == nullptr) return false;

    const std::uint64_t counter = snapshot
        ? next_sse_event_counter()
        : shared_sse_event_counter(2, 0, entry.log_entry_id);
    char frame[640]{};
    const int length = std::snprintf(frame, sizeof(frame), "id: %s-%llu\nevent: device_log\ndata: %s\n\n",
                                    s_server.boot_id, static_cast<unsigned long long>(counter), data);
    cJSON_free(data);
    return length > 0 && static_cast<std::size_t>(length) < sizeof(frame) &&
           httpd_resp_send_chunk(request, frame, static_cast<std::size_t>(length)) == ESP_OK;
}

bool send_sse_sample(httpd_req_t* request, const Sample& sample) {
    const std::uint64_t counter = shared_sse_event_counter(1, sample.sensor_id, sample.sequence);
    char frame[384]{};
    const int length = std::snprintf(frame, sizeof(frame),
        "id: %s-%llu\nevent: sample\ndata: {\"sensorId\":%u,\"n\":%llu,\"t\":%llu,\"raw\":%llu,\"flags\":%u}\n\n",
        s_server.boot_id, static_cast<unsigned long long>(counter), sample.sensor_id,
        static_cast<unsigned long long>(sample.sequence),
        static_cast<unsigned long long>(sample.timestamp_us),
        static_cast<unsigned long long>(sample.raw_value), sample.flags);
    return length > 0 && static_cast<std::size_t>(length) < sizeof(frame) &&
           httpd_resp_send_chunk(request, frame, static_cast<std::size_t>(length)) == ESP_OK;
}

void sse_task(void* argument) {
    auto* request = static_cast<httpd_req_t*>(argument);
    std::uint64_t cursors[kMaxSensors]{};
    // Connections start at the live edge for samples; device-log entries are
    // the only retained snapshot sent to a new stream client.
    s_server.sensors->get_latest_sequences(cursors, kMaxSensors);
    Sample samples[kMaxSseBatch]{};
    constexpr std::size_t kDeviceLogBatch = 16;
    auto* logs = static_cast<DeviceLogEntry*>(std::calloc(kDeviceLogBatch, sizeof(DeviceLogEntry)));
    if (logs == nullptr) {
        httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR, "Out of memory");
        httpd_req_async_handler_complete(request);
        s_sse_clients.fetch_sub(1, std::memory_order_relaxed);
        vTaskDelete(nullptr);
        return;
    }
    std::int64_t last_keepalive_us = esp_timer_get_time();
    std::uint64_t last_log_entry_id = 0;
    bool initial_log_snapshot = true;

    httpd_resp_set_type(request, "text/event-stream; charset=utf-8");
    httpd_resp_set_hdr(request, "Cache-Control", "no-cache, no-transform");
    httpd_resp_set_hdr(request, "Connection", "keep-alive");
    httpd_resp_set_hdr(request, "X-Accel-Buffering", "no");

    bool connected = httpd_resp_send_chunk(request, ": connected\n\n", HTTPD_RESP_USE_STRLEN) == ESP_OK;
    while (connected) {
        // Replay retained device-log entries once on connect, then forward new entries.
        const std::size_t log_count = copy_device_logs_after(last_log_entry_id, logs, kDeviceLogBatch);
        for (std::size_t i = 0; i < log_count; ++i) {
            if (!send_sse_device_log(request, logs[i], initial_log_snapshot)) {
                connected = false;
                break;
            }
            last_log_entry_id = logs[i].log_entry_id;
        }
        if (log_count < kDeviceLogBatch) initial_log_snapshot = false;
        if (!connected) break;

        const std::size_t sample_count = s_server.sensors->copy_new_samples(cursors, samples, kMaxSseBatch);
        for (std::size_t i = 0; i < sample_count; ++i) {
            samples[i].flags = calculate_sample_flags(samples[i].sensor_id, samples[i].raw_value);
            if (!send_sse_sample(request, samples[i])) {
                connected = false;
                break;
            }
        }
        if (!connected) break;

        if (esp_timer_get_time() - last_keepalive_us > 15000000LL) {
            connected = httpd_resp_send_chunk(request, ": keep-alive\n\n", HTTPD_RESP_USE_STRLEN) == ESP_OK;
            last_keepalive_us = esp_timer_get_time();
        }
        if (!connected) break;
        vTaskDelay(pdMS_TO_TICKS(12));
    }

    httpd_resp_send_chunk(request, nullptr, 0);
    std::free(logs);
    httpd_req_async_handler_complete(request);
    s_sse_clients.fetch_sub(1, std::memory_order_relaxed);
    vTaskDelete(nullptr);
}

esp_err_t sse_handler(httpd_req_t* request) {
    const int previous = s_sse_clients.fetch_add(1, std::memory_order_relaxed);
    if (previous >= kMaxSseClients) {
        s_sse_clients.fetch_sub(1, std::memory_order_relaxed);
        return send_error(request, "503 Service Unavailable", "Too many SSE clients");
    }

    httpd_req_t* async_request = nullptr;
    const esp_err_t begin_error = httpd_req_async_handler_begin(request, &async_request);
    if (begin_error != ESP_OK) {
        s_sse_clients.fetch_sub(1, std::memory_order_relaxed);
        return begin_error;
    }
    if (xTaskCreate(sse_task, "sse_stream", 6144, async_request, 4, nullptr) != pdPASS) {
        httpd_req_async_handler_complete(async_request);
        s_sse_clients.fetch_sub(1, std::memory_order_relaxed);
        return ESP_FAIL;
    }
    return ESP_OK;
}

esp_err_t register_uri(httpd_handle_t server, const char* uri, httpd_method_t method,
                       esp_err_t (*handler)(httpd_req_t*)) {
    httpd_uri_t route{};
    route.uri = uri;
    route.method = method;
    route.handler = handler;
    route.user_ctx = nullptr;
    const esp_err_t err = httpd_register_uri_handler(server, &route);
    if (err != ESP_OK) ESP_LOGE(kTag, "Could not register %s: %s", uri, esp_err_to_name(err));
    return err;
}

}  // namespace

void record_device_log(const char* type, const char* message, const char* file, const char* reason) {
    portENTER_CRITICAL(&s_device_log_mux);
    DeviceLogEntry& entry = s_device_log[s_device_log_write];
    entry = DeviceLogEntry{};
    entry.log_entry_id = ++s_device_log_latest_id;
    entry.timestamp_us = static_cast<std::uint64_t>(esp_timer_get_time());
    std::snprintf(entry.type, sizeof(entry.type), "%s", type != nullptr ? type : "device");
    std::snprintf(entry.message, sizeof(entry.message), "%s", message != nullptr ? message : "");
    std::snprintf(entry.file, sizeof(entry.file), "%s", file != nullptr ? file : "");
    std::snprintf(entry.reason, sizeof(entry.reason), "%s", reason != nullptr ? reason : "");
    s_device_log_write = (s_device_log_write + 1U) % kDeviceLogCapacity;
    if (s_device_log_count < kDeviceLogCapacity) ++s_device_log_count;
    portEXIT_CRITICAL(&s_device_log_mux);
}

esp_err_t start_http_server(const Settings& settings, SensorManager* sensors) {
    if (sensors == nullptr) return ESP_ERR_INVALID_ARG;
    s_server.settings = settings;
    s_server.sensors = sensors;
    portENTER_CRITICAL(&s_sse_event_mux);
    s_sse_event_counter = 0;
    s_event_id_cache_write = 0;
    std::memset(s_event_id_cache, 0, sizeof(s_event_id_cache));
    portEXIT_CRITICAL(&s_sse_event_mux);
    std::uint8_t random_id[8]{};
    std::uint8_t random_csrf[16]{};
    esp_fill_random(random_id, sizeof(random_id));
    esp_fill_random(random_csrf, sizeof(random_csrf));
    static constexpr char kHex[] = "0123456789abcdef";
    // Eight lowercase hexadecimal characters identify one boot session.
    for (std::size_t i = 0; i < 4U; ++i) {
        s_server.boot_id[i * 2U] = kHex[(random_id[i] >> 4U) & 0x0fU];
        s_server.boot_id[i * 2U + 1U] = kHex[random_id[i] & 0x0fU];
    }
    s_server.boot_id[8] = '\0';
    for (std::size_t i = 0; i < sizeof(random_csrf); ++i) {
        s_server.csrf_token[i * 2U] = kHex[(random_csrf[i] >> 4U) & 0x0fU];
        s_server.csrf_token[i * 2U + 1U] = kHex[random_csrf[i] & 0x0fU];
    }
    s_server.csrf_token[32] = '\0';

    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port = 80;
    config.ctrl_port = 32768;
    config.max_open_sockets = 8;
    config.max_uri_handlers = 32;
    config.stack_size = 8192;
    config.lru_purge_enable = true;
    config.uri_match_fn = httpd_uri_match_wildcard;

    const esp_err_t err = httpd_start(&s_server.handle, &config);
    if (err != ESP_OK) return err;

    struct UriRoute {
        const char* uri;
        httpd_method_t method;
        esp_err_t (*handler)(httpd_req_t*);
    };
    // Exact API/configuration routes precede catch-all static asset routes.
    static constexpr UriRoute routes[] = {
        {"/stream", HTTP_GET, sse_handler},
        {"/api/device", HTTP_GET, device_handler},
        {"/api/status", HTTP_GET, status_handler},
        {"/api/device-log", HTTP_GET, device_log_handler},
        {"/api/history", HTTP_GET, history_handler},
        {"/api/files", HTTP_GET, files_list_handler},
        {"/api/restart", HTTP_POST, restart_handler},
        {"/data/settings/settings.json", HTTP_GET, settings_resource_handler},
        {"/data/settings/settings.json", HTTP_PUT, settings_resource_handler},
        {"/data/settings/settings.json", HTTP_DELETE, settings_resource_handler},
        {"/data/settings/wifi.json", HTTP_GET, settings_resource_handler},
        {"/data/settings/wifi.json", HTTP_PUT, settings_resource_handler},
        {"/data/settings/wifi.json", HTTP_DELETE, settings_resource_handler},
        {"/data/settings/sensors.json", HTTP_GET, settings_resource_handler},
        {"/data/settings/sensors.json", HTTP_PUT, settings_resource_handler},
        {"/data/settings/sensors.json", HTTP_DELETE, settings_resource_handler},
        {"/data/settings/units.json", HTTP_GET, settings_resource_handler},
        {"/data/settings/units.json", HTTP_PUT, settings_resource_handler},
        {"/data/settings/units.json", HTTP_DELETE, settings_resource_handler},
        {"/data/settings/webui-settings.json", HTTP_GET, settings_resource_handler},
        {"/data/settings/webui-settings.json", HTTP_PUT, settings_resource_handler},
        {"/data/settings/webui-settings.json", HTTP_DELETE, settings_resource_handler},
        {"/data/calibration/*", HTTP_GET, calibration_file_handler},
        {"/data/calibration/*", HTTP_PUT, calibration_upload_handler},
        {"/data/calibration/*", HTTP_DELETE, calibration_delete_handler},
        {"/*", HTTP_GET, static_file_handler},
        {"/*", HTTP_PUT, asset_upload_handler},
        {"/*", HTTP_DELETE, asset_delete_handler},
    };
    for (const UriRoute& route : routes) {
        const esp_err_t register_error = register_uri(s_server.handle, route.uri, route.method, route.handler);
        if (register_error != ESP_OK) {
            httpd_stop(s_server.handle);
            s_server.handle = nullptr;
            return register_error;
        }
    }

    ESP_LOGI(kTag, "HTTP server listening on port 80");
    return ESP_OK;
}

}  // namespace app
