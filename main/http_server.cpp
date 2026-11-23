#include "http_server.hpp"

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <sys/statvfs.h>
#include <sys/stat.h>
#include <unistd.h>
#include <strings.h>

#include "cJSON.h"
#include "config_store.hpp"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_flash.h"
#include "mbedtls/base64.h"
#include "security.hpp"
#include "sensor_manager.hpp"
#include "version.hpp"
#include "freertos/task.h"

namespace app {
namespace {
constexpr char kTag[] = "http";
constexpr std::size_t kMaxJsonBody = 65536;
constexpr std::size_t kMaxSseBatch = 64;
constexpr int kMaxSseClients = 3;

struct ServerContext {
    Settings settings{};
    SensorManager* sensors = nullptr;
    httpd_handle_t handle = nullptr;
};
ServerContext s_server{};
std::atomic<int> s_sse_clients{0};
std::atomic<std::uint32_t> s_sse_event_id{0};

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

bool request_is_admin(httpd_req_t* request) {
    if (s_server.settings.admin_hash_hex[0] == '\0') return true;  // First-boot setup is intentionally open.

    const std::size_t header_length = httpd_req_get_hdr_value_len(request, "Authorization");
    if (header_length == 0U || header_length > 256U) {
        httpd_resp_set_status(request, "401 Unauthorized");
        httpd_resp_set_hdr(request, "WWW-Authenticate", "Basic realm=\"ESP32 Sensor Node\", charset=\"UTF-8\"");
        httpd_resp_set_type(request, "application/json");
        httpd_resp_sendstr(request, "{\"ok\":false,\"error\":\"Authentication required\"}");
        return false;
    }

    char header[257]{};
    if (httpd_req_get_hdr_value_str(request, "Authorization", header, sizeof(header)) != ESP_OK ||
        std::strncmp(header, "Basic ", 6U) != 0) {
        httpd_resp_set_status(request, "401 Unauthorized");
        httpd_resp_set_hdr(request, "WWW-Authenticate", "Basic realm=\"ESP32 Sensor Node\"");
        httpd_resp_sendstr(request, "Authentication required");
        return false;
    }

    unsigned char decoded[192]{};
    std::size_t decoded_length = 0;
    const int rc = mbedtls_base64_decode(decoded, sizeof(decoded) - 1U, &decoded_length,
                                          reinterpret_cast<const unsigned char*>(header + 6U),
                                          std::strlen(header + 6U));
    if (rc != 0 || decoded_length == 0U) {
        httpd_resp_set_status(request, "401 Unauthorized");
        httpd_resp_set_hdr(request, "WWW-Authenticate", "Basic realm=\"ESP32 Sensor Node\"");
        httpd_resp_sendstr(request, "Authentication required");
        return false;
    }
    decoded[decoded_length] = '\0';
    char* separator = std::strchr(reinterpret_cast<char*>(decoded), ':');
    if (separator == nullptr) {
        httpd_resp_set_status(request, "401 Unauthorized");
        httpd_resp_set_hdr(request, "WWW-Authenticate", "Basic realm=\"ESP32 Sensor Node\"");
        httpd_resp_sendstr(request, "Authentication required");
        return false;
    }
    *separator = '\0';
    const bool username_ok = std::strcmp(reinterpret_cast<char*>(decoded), s_server.settings.admin_username) == 0;
    const bool password_ok = security::verify_admin_password(s_server.settings, separator + 1);
    if (username_ok && password_ok) return true;

    httpd_resp_set_status(request, "401 Unauthorized");
    httpd_resp_set_hdr(request, "WWW-Authenticate", "Basic realm=\"ESP32 Sensor Node\"");
    httpd_resp_sendstr(request, "Authentication required");
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
    const unsigned long value = std::strtoul(text, &end, 10);
    if (end == text || *end != '\0' || value > UINT32_MAX) return false;
    *output = static_cast<std::uint32_t>(value);
    return true;
}

bool ring_bytes_required(const SensorConfigList& sensors, std::size_t* output) {
    if (output == nullptr) return false;
    std::size_t total = 0;
    for (std::size_t i = 0; i < sensors.count; ++i) {
        const std::size_t samples = sensors.items[i].ring_buffer_samples;
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

esp_err_t settings_file_handler(httpd_req_t* request) {
    const char* path = nullptr;
    if (request_path_equals(request, "/data/settings/settings.json")) path = "/data/settings/settings.json";
    else if (request_path_equals(request, "/data/settings/sensors.json")) path = "/data/settings/sensors.json";
    else if (request_path_equals(request, "/data/settings/webui-settings.json")) path = "/data/settings/webui-settings.json";
    else return send_error(request, "404 Not Found", "Unknown settings file");

    char* data = nullptr;
    std::size_t length = 0;
    if (!config_store::read_file(path, &data, &length)) return send_error(request, "404 Not Found", "Settings file unavailable");

    if (std::strcmp(path, "/data/settings/settings.json") == 0 && !request_is_admin(request)) {
        std::free(data);
        return ESP_OK;
    }
    if (std::strcmp(path, "/data/settings/settings.json") == 0 && s_server.settings.admin_hash_hex[0] == '\0') {
        cJSON* root = cJSON_ParseWithLength(data, length);
        cJSON* wifi = cJSON_IsObject(root) ? cJSON_GetObjectItemCaseSensitive(root, "wifi") : nullptr;
        cJSON* security = cJSON_IsObject(root) ? cJSON_GetObjectItemCaseSensitive(root, "security") : nullptr;
        cJSON* admin = cJSON_IsObject(security) ? cJSON_GetObjectItemCaseSensitive(security, "admin") : nullptr;
        if (cJSON_IsObject(wifi)) cJSON_ReplaceItemInObject(wifi, "password", cJSON_CreateString(""));
        if (cJSON_IsObject(admin)) {
            cJSON_ReplaceItemInObject(admin, "password_salt", cJSON_CreateString(""));
            cJSON_ReplaceItemInObject(admin, "password_hash", cJSON_CreateString(""));
        }
        char* redacted = cJSON_PrintUnformatted(root);
        cJSON_Delete(root);
        std::free(data);
        data = redacted;
        if (data == nullptr) return send_error(request, "500 Internal Server Error", "Out of memory");
        length = std::strlen(data);
    }

    httpd_resp_set_type(request, "application/json; charset=utf-8");
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    const esp_err_t err = httpd_resp_send(request, data, length);
    std::free(data);
    return err;
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
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    const esp_err_t err = httpd_resp_send(request, data, length);
    std::free(data);
    return err;
}

esp_err_t device_handler(httpd_req_t* request) {
    cJSON* root = cJSON_CreateObject();
    cJSON_AddBoolToObject(root, "ok", true);
    cJSON_AddStringToObject(root, "productName", "OpenScale");
    cJSON_AddStringToObject(root, "firmwareVersion", version::firmware);
    cJSON_AddStringToObject(root, "webuiVersion", version::webui);
    cJSON_AddStringToObject(root, "buildId", version::build_id);
    cJSON_AddStringToObject(root, "gitCommit", version::git_commit);
    cJSON_AddStringToObject(root, "espIdfVersion", esp_get_idf_version());
    cJSON_AddNumberToObject(root, "runtime_ms", static_cast<double>(esp_timer_get_time() / 1000));
    cJSON_AddNumberToObject(root, "heap_total_bytes", static_cast<double>(heap_caps_get_total_size(MALLOC_CAP_DEFAULT)));
    cJSON_AddNumberToObject(root, "heap_free_bytes", static_cast<double>(esp_get_free_heap_size()));
    cJSON_AddNumberToObject(root, "heap_min_free_bytes", static_cast<double>(esp_get_minimum_free_heap_size()));
    cJSON_AddNumberToObject(root, "heap_largest_free_block_bytes", static_cast<double>(heap_caps_get_largest_free_block(MALLOC_CAP_DEFAULT)));
    cJSON_AddNumberToObject(root, "queue_depth", static_cast<double>(s_server.sensors->queue_depth()));
    cJSON_AddNumberToObject(root, "queue_capacity", static_cast<double>(s_server.sensors->queue_capacity()));
    cJSON_AddNumberToObject(root, "queue_allocated_bytes",
                             static_cast<double>(s_server.sensors->queue_capacity() * sizeof(Sample)));
    cJSON_AddNumberToObject(root, "ring_buffer_used_bytes", static_cast<double>(s_server.sensors->ring_bytes_used()));
    cJSON_AddNumberToObject(root, "ring_buffer_limit_bytes", static_cast<double>(s_server.settings.max_ring_buffer_bytes));
    cJSON_AddNumberToObject(root, "target_sse_hz", 80);

    std::uint32_t flash_size = 0;
    if (esp_flash_get_size(nullptr, &flash_size) == ESP_OK) cJSON_AddNumberToObject(root, "flash_total_bytes", flash_size);
    struct statvfs fs_stats {};
    if (statvfs("/data", &fs_stats) == 0) {
        const std::uint64_t total = static_cast<std::uint64_t>(fs_stats.f_blocks) * fs_stats.f_frsize;
        const std::uint64_t free = static_cast<std::uint64_t>(fs_stats.f_bavail) * fs_stats.f_frsize;
        cJSON_AddNumberToObject(root, "filesystem_total_bytes", static_cast<double>(total));
        cJSON_AddNumberToObject(root, "filesystem_free_bytes", static_cast<double>(free));
    }

    SensorStats stats[kMaxSensors]{};
    const std::size_t count = s_server.sensors->get_stats(stats, kMaxSensors);
    cJSON* sensors = cJSON_AddArrayToObject(root, "sensors");
    for (std::size_t i = 0; i < count; ++i) {
        cJSON* item = cJSON_CreateObject();
        cJSON_AddNumberToObject(item, "id", stats[i].config.id);
        cJSON_AddStringToObject(item, "name", stats[i].config.name);
        cJSON_AddStringToObject(item, "type", stats[i].config.type);
        cJSON_AddBoolToObject(item, "enabled", stats[i].config.enabled);
        cJSON_AddBoolToObject(item, "task_active", stats[i].task_active);
        cJSON_AddNumberToObject(item, "rate_hz", stats[i].config.rate_hz);
        cJSON_AddNumberToObject(item, "buffered_samples", static_cast<double>(stats[i].buffered_samples));
        cJSON_AddNumberToObject(item, "capacity", static_cast<double>(stats[i].capacity));
        cJSON_AddNumberToObject(item, "oldest_sequence", static_cast<double>(stats[i].oldest_sequence));
        cJSON_AddNumberToObject(item, "newest_sequence", static_cast<double>(stats[i].newest_sequence));
        cJSON_AddNumberToObject(item, "queue_drops", stats[i].queue_drops);
        cJSON_AddNumberToObject(item, "read_errors", stats[i].read_errors);
        cJSON_AddItemToArray(sensors, item);
    }
    const esp_err_t err = send_json(request, root);
    cJSON_Delete(root);
    return err;
}

esp_err_t history_handler(httpd_req_t* request) {
    std::uint32_t sensor_id = 0;
    std::uint32_t limit = 128;
    if (!parse_unsigned_query(request, "sensor_id", &sensor_id) || sensor_id > 65535U) {
        return send_error(request, "400 Bad Request", "Provide sensor_id as a numeric sensor ID");
    }
    char limit_text[24]{};
    if (query_value(request, "limit", limit_text, sizeof(limit_text))) {
        std::uint32_t parsed_limit = 0;
        if (!parse_unsigned_query(request, "limit", &parsed_limit)) {
            return send_error(request, "400 Bad Request", "limit must be an integer between 1 and 512");
        }
        limit = parsed_limit;
    }
    if (limit == 0U || limit > 512U) return send_error(request, "400 Bad Request", "limit must be between 1 and 512");

    auto* samples = static_cast<Sample*>(std::calloc(limit, sizeof(Sample)));
    if (samples == nullptr) return send_error(request, "500 Internal Server Error", "Out of memory");
    const std::size_t count = s_server.sensors->copy_history(static_cast<std::uint16_t>(sensor_id), limit, samples, limit);
    SensorStats stats[kMaxSensors]{};
    const std::size_t stats_count = s_server.sensors->get_stats(stats, kMaxSensors);

    cJSON* root = cJSON_CreateObject();
    cJSON_AddBoolToObject(root, "ok", true);
    cJSON_AddNumberToObject(root, "sensor_id", sensor_id);
    cJSON_AddNumberToObject(root, "count", count);
    cJSON* meta = cJSON_CreateObject();
    cJSON* items = cJSON_CreateArray();
    for (std::size_t i = 0; i < stats_count; ++i) {
        if (stats[i].config.id == sensor_id) {
            cJSON_AddStringToObject(meta, "name", stats[i].config.name);
            cJSON_AddNumberToObject(meta, "capacity", static_cast<double>(stats[i].capacity));
            cJSON_AddNumberToObject(meta, "buffered_samples", static_cast<double>(stats[i].buffered_samples));
            cJSON_AddNumberToObject(meta, "oldest_sequence", static_cast<double>(stats[i].oldest_sequence));
            cJSON_AddNumberToObject(meta, "newest_sequence", static_cast<double>(stats[i].newest_sequence));
            break;
        }
    }
    for (std::size_t i = 0; i < count; ++i) {
        cJSON* sample = cJSON_CreateObject();
        cJSON_AddNumberToObject(sample, "seq", static_cast<double>(samples[i].sequence));
        cJSON_AddNumberToObject(sample, "timestamp_us", static_cast<double>(samples[i].timestamp_us));
        cJSON_AddNumberToObject(sample, "raw", samples[i].raw_value);
        cJSON_AddItemToArray(items, sample);
    }
    cJSON_AddItemToObject(root, "sensor", meta);
    cJSON_AddItemToObject(root, "samples", items);
    const esp_err_t err = send_json(request, root);
    cJSON_Delete(root);
    std::free(samples);
    return err;
}

void append_web_assets_recursive(const char* absolute_directory, const char* relative_directory,
                                cJSON* files, const char* index_path) {
    DIR* directory = opendir(absolute_directory);
    if (directory == nullptr) return;
    dirent* entry = nullptr;
    while ((entry = readdir(directory)) != nullptr) {
        if (std::strcmp(entry->d_name, ".") == 0 || std::strcmp(entry->d_name, "..") == 0) continue;

        char absolute_path[256]{};
        char relative_path[160]{};
        const int absolute_length = std::snprintf(absolute_path, sizeof(absolute_path), "%s/%s",
                                                  absolute_directory, entry->d_name);
        const int relative_length = relative_directory[0] == '\0'
            ? std::snprintf(relative_path, sizeof(relative_path), "%s", entry->d_name)
            : std::snprintf(relative_path, sizeof(relative_path), "%s/%s", relative_directory, entry->d_name);
        if (absolute_length < 0 || static_cast<std::size_t>(absolute_length) >= sizeof(absolute_path) ||
            relative_length < 0 || static_cast<std::size_t>(relative_length) >= sizeof(relative_path)) continue;

        struct stat stats {};
        if (stat(absolute_path, &stats) != 0) continue;
        if (S_ISDIR(stats.st_mode)) {
            append_web_assets_recursive(absolute_path, relative_path, files, index_path);
            continue;
        }
        const std::size_t name_length = std::strlen(relative_path);
        if (!S_ISREG(stats.st_mode) || name_length <= 3U ||
            std::strcmp(relative_path + name_length - 3U, ".gz") != 0) continue;

        relative_path[name_length - 3U] = '\0';
        cJSON* item = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "path", relative_path);
        cJSON_AddNumberToObject(item, "size_compressed", static_cast<double>(stats.st_size));
        cJSON_AddBoolToObject(item, "immutable", config_store::is_protected_default_asset(relative_path));
        char full_web_path[164]{};
        std::snprintf(full_web_path, sizeof(full_web_path), "/%s", relative_path);
        cJSON_AddBoolToObject(item, "index", std::strcmp(index_path, full_web_path) == 0);
        cJSON_AddItemToArray(files, item);
    }
    closedir(directory);
}

esp_err_t files_list_handler(httpd_req_t* request) {
    struct stat root_stats {};
    if (stat("/data/www", &root_stats) != 0 || !S_ISDIR(root_stats.st_mode)) {
        return send_error(request, "500 Internal Server Error", "Cannot open web asset directory");
    }
    cJSON* root = cJSON_CreateObject();
    cJSON_AddBoolToObject(root, "ok", true);
    cJSON* files = cJSON_AddArrayToObject(root, "files");
    char index_path[160]{};
    config_store::get_index_path(index_path, sizeof(index_path));
    append_web_assets_recursive("/data/www", "", files, index_path);
    const esp_err_t err = send_json(request, root);
    cJSON_Delete(root);
    return err;
}

esp_err_t json_config_handler(httpd_req_t* request) {
    if (!request_is_admin(request)) return ESP_OK;
    char* body = nullptr;
    std::size_t length = 0;
    if (!read_request_body(request, kMaxJsonBody, &body, &length)) return send_error(request, "413 Payload Too Large", "Missing or oversized JSON body");

    bool saved = false;
    bool needs_restart = true;
    char error[192]{};
    if (request_path_equals(request, "/api/config/settings")) {
        Settings parsed{};
        if (!config_store::validate_settings_json(body, length, &parsed, error, sizeof(error))) {
            std::free(body);
            return send_error(request, "400 Bad Request", error);
        }
        if (s_server.settings.admin_hash_hex[0] != '\0' && parsed.admin_hash_hex[0] == '\0') {
            std::free(body);
            return send_error(request, "400 Bad Request", "The administrator password can only be cleared through the serial console");
        }
        SensorConfigList current_sensors{};
        std::size_t required_ring_bytes = 0;
        if (!config_store::load_sensors(current_sensors, error, sizeof(error)) ||
            !ring_bytes_required(current_sensors, &required_ring_bytes)) {
            std::free(body);
            return send_error(request, "500 Internal Server Error", "Could not verify the current sensor memory requirements");
        }
        if (required_ring_bytes > parsed.max_ring_buffer_bytes) {
            std::free(body);
            return send_error(request, "400 Bad Request", "New max_ring_buffer_bytes is smaller than the currently configured ring buffers");
        }
        saved = config_store::save_settings_json(body, length);
    } else if (request_path_equals(request, "/api/config/sensors")) {
        SensorConfigList parsed{};
        if (!config_store::validate_sensors_json(body, length, &parsed, error, sizeof(error))) {
            std::free(body);
            return send_error(request, "400 Bad Request", error);
        }
        std::size_t required_bytes = 0;
        if (!ring_bytes_required(parsed, &required_bytes) || required_bytes > s_server.settings.max_ring_buffer_bytes) {
            std::free(body);
            return send_error(request, "400 Bad Request", "Configured ring buffers exceed max_ring_buffer_bytes");
        }
        saved = config_store::save_sensors_json(body, length);
    } else if (request_path_equals(request, "/api/config/webui")) {
        needs_restart = false;
        saved = config_store::save_webui_settings_json(body, length);
    }
    std::free(body);
    if (!saved) return send_error(request, "500 Internal Server Error", "Could not save configuration");

    cJSON* response = cJSON_CreateObject();
    cJSON_AddBoolToObject(response, "ok", true);
    cJSON_AddBoolToObject(response, "restart_required", needs_restart);
    const esp_err_t err = send_json(request, response, "200 OK");
    cJSON_Delete(response);
    if (err == ESP_OK && needs_restart) {
        vTaskDelay(pdMS_TO_TICKS(250));
        esp_restart();
    }
    return err;
}

bool write_uploaded_file(httpd_req_t* request, const char* final_path, std::size_t max_length) {
    // A gzip stream has a fixed two-byte magic prefix and is at least 18 bytes.
    if (request->content_len < 18U || request->content_len > max_length) return false;
    char temporary_path[320]{};
    char backup_path[320]{};
    if (std::snprintf(temporary_path, sizeof(temporary_path), "%s.upload", final_path) >= static_cast<int>(sizeof(temporary_path)) ||
        std::snprintf(backup_path, sizeof(backup_path), "%s.bak", final_path) >= static_cast<int>(sizeof(backup_path))) return false;

    FILE* file = std::fopen(temporary_path, "wb");
    if (file == nullptr) return false;
    char buffer[1024];
    std::size_t remaining = request->content_len;
    bool ok = true;
    while (remaining > 0U) {
        const std::size_t wanted = std::min(remaining, sizeof(buffer));
        const int received = httpd_req_recv(request, buffer, wanted);
        if (received == HTTPD_SOCK_ERR_TIMEOUT) continue;
        if (received <= 0 || std::fwrite(buffer, 1U, static_cast<std::size_t>(received), file) != static_cast<std::size_t>(received)) {
            ok = false;
            break;
        }
        remaining -= static_cast<std::size_t>(received);
    }
    if (ok) ok = std::fflush(file) == 0 && fsync(fileno(file)) == 0;
    if (std::fclose(file) != 0) ok = false;
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
    if (had_original && rename(final_path, backup_path) != 0) { unlink(temporary_path); return false; }
    if (rename(temporary_path, final_path) != 0) {
        if (had_original) rename(backup_path, final_path);
        unlink(temporary_path);
        return false;
    }
    unlink(backup_path);
    return true;
}

esp_err_t asset_upload_handler(httpd_req_t* request) {
    if (!request_is_admin(request)) return ESP_OK;
    char web_path[160]{};
    if (!safe_web_path_from_uri(request->uri, "/api/files/", web_path, sizeof(web_path)) ||
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
    if (!write_uploaded_file(request, final_path, s_server.settings.max_upload_bytes)) {
        return send_error(request, "400 Bad Request", "Upload failed, exceeded max_upload_bytes, or did not contain a gzip stream");
    }
    cJSON* response = cJSON_CreateObject();
    cJSON_AddBoolToObject(response, "ok", true);
    cJSON_AddStringToObject(response, "path", web_path);
    cJSON_AddBoolToObject(response, "stored_gzip", true);
    const esp_err_t err = send_json(request, response, "201 Created");
    cJSON_Delete(response);
    return err;
}

esp_err_t asset_delete_handler(httpd_req_t* request) {
    if (!request_is_admin(request)) return ESP_OK;
    char web_path[160]{};
    if (!safe_web_path_from_uri(request->uri, "/api/files/", web_path, sizeof(web_path)) ||
        config_store::is_protected_default_asset(web_path)) return send_error(request, "400 Bad Request", "Invalid or immutable asset path");
    if (!config_store::delete_asset(web_path)) return send_error(request, "404 Not Found", "Asset not found");
    cJSON* response = cJSON_CreateObject();
    cJSON_AddBoolToObject(response, "ok", true);
    const esp_err_t err = send_json(request, response);
    cJSON_Delete(response);
    return err;
}

esp_err_t asset_index_handler(httpd_req_t* request) {
    if (!request_is_admin(request)) return ESP_OK;
    char* body = nullptr;
    std::size_t length = 0;
    if (!read_request_body(request, 1024U, &body, &length)) return send_error(request, "400 Bad Request", "Expected small JSON body");
    cJSON* root = cJSON_ParseWithLength(body, length);
    cJSON* path = cJSON_IsObject(root) ? cJSON_GetObjectItemCaseSensitive(root, "path") : nullptr;
    const bool ok = cJSON_IsString(path) && path->valuestring != nullptr && config_store::set_index_path(path->valuestring);
    cJSON_Delete(root);
    std::free(body);
    if (!ok) return send_error(request, "400 Bad Request", "Index path must refer to an existing web asset");
    cJSON* response = cJSON_CreateObject();
    cJSON_AddBoolToObject(response, "ok", true);
    const esp_err_t err = send_json(request, response);
    cJSON_Delete(response);
    return err;
}

esp_err_t asset_rename_handler(httpd_req_t* request) {
    if (!request_is_admin(request)) return ESP_OK;
    char* body = nullptr;
    std::size_t length = 0;
    if (!read_request_body(request, 1024U, &body, &length)) return send_error(request, "400 Bad Request", "Expected small JSON body");
    cJSON* root = cJSON_ParseWithLength(body, length);
    cJSON* from = cJSON_IsObject(root) ? cJSON_GetObjectItemCaseSensitive(root, "from") : nullptr;
    cJSON* to = cJSON_IsObject(root) ? cJSON_GetObjectItemCaseSensitive(root, "to") : nullptr;
    const bool ok = cJSON_IsString(from) && cJSON_IsString(to) && from->valuestring != nullptr &&
                    to->valuestring != nullptr && config_store::rename_asset(from->valuestring, to->valuestring);
    cJSON_Delete(root);
    std::free(body);
    if (!ok) return send_error(request, "400 Bad Request", "Rename failed; check both paths and ensure the destination does not exist");
    cJSON* response = cJSON_CreateObject();
    cJSON_AddBoolToObject(response, "ok", true);
    const esp_err_t err = send_json(request, response);
    cJSON_Delete(response);
    return err;
}

esp_err_t calibration_list_handler(httpd_req_t* request) {
    DIR* directory = opendir("/data/calibration");
    if (directory == nullptr) return send_error(request, "500 Internal Server Error", "Could not open calibration directory");

    cJSON* root = cJSON_CreateObject();
    cJSON_AddBoolToObject(root, "ok", true);
    cJSON* files = cJSON_AddArrayToObject(root, "files");
    struct dirent* entry = nullptr;
    while ((entry = readdir(directory)) != nullptr) {
        char path[128]{};
        if (!config_store::make_calibration_storage_path(entry->d_name, path, sizeof(path))) continue;
        struct stat file_stats {};
        if (stat(path, &file_stats) != 0 || !S_ISREG(file_stats.st_mode)) continue;

        char* contents = nullptr;
        std::size_t length = 0;
        const bool readable = config_store::read_file(path, &contents, &length);
        cJSON* validation = readable ? cJSON_ParseWithLength(contents, length) : nullptr;
        const bool valid = cJSON_IsObject(validation);
        cJSON_Delete(validation);
        std::free(contents);

        cJSON* item = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "name", entry->d_name);
        cJSON_AddNumberToObject(item, "size_bytes", static_cast<double>(file_stats.st_size));
        cJSON_AddBoolToObject(item, "validation_ok", valid);
        cJSON_AddItemToArray(files, item);
    }
    closedir(directory);
    const esp_err_t err = send_json(request, root);
    cJSON_Delete(root);
    return err;
}

esp_err_t calibration_delete_handler(httpd_req_t* request) {
    if (!request_is_admin(request)) return ESP_OK;
    char filename[80]{};
    if (!safe_web_path_from_uri(request->uri, "/api/calibration/", filename, sizeof(filename))) {
        return send_error(request, "400 Bad Request", "Invalid calibration filename");
    }
    char path[128]{};
    if (!config_store::make_calibration_storage_path(filename, path, sizeof(path))) {
        return send_error(request, "400 Bad Request", "Calibration filename must be a simple .json filename");
    }
    if (unlink(path) != 0) return send_error(request, "404 Not Found", "Calibration file not found");
    cJSON* response = cJSON_CreateObject();
    cJSON_AddBoolToObject(response, "ok", true);
    const esp_err_t err = send_json(request, response);
    cJSON_Delete(response);
    return err;
}

esp_err_t calibration_upload_handler(httpd_req_t* request) {
    if (!request_is_admin(request)) return ESP_OK;
    char filename[80]{};
    if (!safe_web_path_from_uri(request->uri, "/api/calibration/", filename, sizeof(filename))) {
        return send_error(request, "400 Bad Request", "Invalid calibration filename");
    }
    char path[128]{};
    if (!config_store::make_calibration_storage_path(filename, path, sizeof(path))) {
        return send_error(request, "400 Bad Request", "Calibration filename must be a simple .json filename");
    }
    char* body = nullptr;
    std::size_t length = 0;
    if (request->content_len > 65536U) {
        return send_error(request, "413 Payload Too Large", "Calibration body is too large");
    }
    if (request->content_len == 0U) {
        body = static_cast<char*>(std::calloc(1U, 1U));
        if (body == nullptr) return send_error(request, "500 Internal Server Error", "Out of memory");
    } else if (!read_request_body(request, 65536U, &body, &length)) {
        return send_error(request, "400 Bad Request", "Could not read calibration body");
    }

    // Calibration is deliberately non-critical: persist the submitted bytes even
    // when the JSON or its application-level structure is invalid.
    const bool saved = config_store::write_file_atomic(path, body, length);
    cJSON* validation = cJSON_ParseWithLength(body, length);
    const bool valid_json_object = cJSON_IsObject(validation);
    cJSON_Delete(validation);
    std::free(body);
    if (!saved) return send_error(request, "500 Internal Server Error", "Could not save calibration file");

    cJSON* response = cJSON_CreateObject();
    cJSON_AddBoolToObject(response, "saved", true);
    cJSON_AddBoolToObject(response, "validation_ok", valid_json_object);
    cJSON_AddStringToObject(response, "validation_message", valid_json_object ? "Valid JSON object" : "Saved, but JSON is invalid or not an object");
    const esp_err_t err = send_json(request, response, "201 Created");
    cJSON_Delete(response);
    return err;
}

esp_err_t restart_handler(httpd_req_t* request) {
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

void sse_task(void* argument) {
    auto* request = static_cast<httpd_req_t*>(argument);
    std::uint64_t cursors[kMaxSensors]{};
    // Begin at the live edge. Historical samples are fetched explicitly via
    // /api/history so a new SSE client is not flooded with the entire ring.
    s_server.sensors->get_latest_sequences(cursors, kMaxSensors);
    Sample samples[kMaxSseBatch]{};
    constexpr std::size_t kSseFrameSize = 8192;
    auto* frame = static_cast<char*>(std::malloc(kSseFrameSize));
    if (frame == nullptr) {
        httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR, "Out of memory");
        httpd_req_async_handler_complete(request);
        s_sse_clients.fetch_sub(1, std::memory_order_relaxed);
        vTaskDelete(nullptr);
        return;
    }
    std::int64_t last_keepalive_us = esp_timer_get_time();

    httpd_resp_set_type(request, "text/event-stream; charset=utf-8");
    httpd_resp_set_hdr(request, "Cache-Control", "no-cache, no-transform");
    httpd_resp_set_hdr(request, "Connection", "keep-alive");
    httpd_resp_set_hdr(request, "X-Accel-Buffering", "no");

    // Flush headers immediately so EventSource reaches its open state even
    // when no sensor has produced a sample yet.
    bool connected = httpd_resp_send_chunk(request, ": connected\n\n", HTTPD_RESP_USE_STRLEN) == ESP_OK;
    while (connected) {
        const std::size_t count = s_server.sensors->copy_new_samples(cursors, samples, kMaxSseBatch);
        if (count > 0U) {
            std::size_t used = 0;
            const std::uint64_t event_id = s_sse_event_id.fetch_add(1, std::memory_order_relaxed) + 1U;
            int written = std::snprintf(frame, kSseFrameSize, "id: %llu\nevent: samples\ndata: {\"samples\":[",
                                        static_cast<unsigned long long>(event_id));
            if (written < 0 || static_cast<std::size_t>(written) >= kSseFrameSize) break;
            used = static_cast<std::size_t>(written);
            for (std::size_t i = 0; i < count; ++i) {
                written = std::snprintf(frame + used, kSseFrameSize - used,
                    "%s{\"sensor_id\":%u,\"seq\":%llu,\"timestamp_us\":%lld,\"raw\":%ld}",
                    i == 0U ? "" : ",", samples[i].sensor_id,
                    static_cast<unsigned long long>(samples[i].sequence),
                    static_cast<long long>(samples[i].timestamp_us), static_cast<long>(samples[i].raw_value));
                if (written < 0 || static_cast<std::size_t>(written) >= kSseFrameSize - used) break;
                used += static_cast<std::size_t>(written);
            }
            if (used + 4U < kSseFrameSize) {
                std::memcpy(frame + used, "]}\n\n", 4U);
                used += 4U;
                connected = httpd_resp_send_chunk(request, frame, used) == ESP_OK;
            }
        } else if (esp_timer_get_time() - last_keepalive_us > 15000000LL) {
            connected = httpd_resp_send_chunk(request, ": keep-alive\n\n", HTTPD_RESP_USE_STRLEN) == ESP_OK;
            last_keepalive_us = esp_timer_get_time();
        }
        if (!connected) break;
        vTaskDelay(pdMS_TO_TICKS(12));  // ~83.3 Hz; close to the requested 80 Hz.
    }

    httpd_resp_send_chunk(request, nullptr, 0);
    std::free(frame);
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

esp_err_t start_http_server(const Settings& settings, SensorManager* sensors) {
    if (sensors == nullptr || !settings.http_enabled) return ESP_ERR_INVALID_ARG;
    s_server.settings = settings;
    s_server.sensors = sensors;

    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port = settings.http_port;
    config.ctrl_port = settings.http_port == 80U ? 32768U : static_cast<std::uint16_t>(settings.http_port + 1U);
    config.max_open_sockets = 8;
    config.max_uri_handlers = 24;
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
    static constexpr UriRoute routes[] = {
        {"/stream", HTTP_GET, sse_handler},
        {"/api/device", HTTP_GET, device_handler},
        {"/api/history", HTTP_GET, history_handler},
        {"/api/files", HTTP_GET, files_list_handler},
        {"/api/config/settings", HTTP_PUT, json_config_handler},
        {"/api/config/sensors", HTTP_PUT, json_config_handler},
        {"/api/config/webui", HTTP_PUT, json_config_handler},
        {"/api/files/index", HTTP_POST, asset_index_handler},
        {"/api/files/rename", HTTP_POST, asset_rename_handler},
        {"/api/calibration", HTTP_GET, calibration_list_handler},
        {"/api/calibration/*", HTTP_DELETE, calibration_delete_handler},
        {"/api/files/*", HTTP_PUT, asset_upload_handler},
        {"/api/files/*", HTTP_DELETE, asset_delete_handler},
        {"/api/calibration/*", HTTP_PUT, calibration_upload_handler},
        {"/api/restart", HTTP_POST, restart_handler},
        {"/data/settings/*", HTTP_GET, settings_file_handler},
        {"/data/calibration/*", HTTP_GET, calibration_file_handler},
        {"/*", HTTP_GET, static_file_handler},
    };
    for (const UriRoute& route : routes) {
        const esp_err_t register_error = register_uri(s_server.handle, route.uri, route.method, route.handler);
        if (register_error != ESP_OK) {
            httpd_stop(s_server.handle);
            s_server.handle = nullptr;
            return register_error;
        }
    }

    ESP_LOGI(kTag, "HTTP server listening on port %u", settings.http_port);
    return ESP_OK;
}

}  // namespace app
