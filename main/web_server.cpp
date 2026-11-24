#include "web_server.hpp"
#include "build_info.h"
#include "webui_build_info.h"
#include "config_api.hpp"
#include "device_log.hpp"
#include "event_bus.hpp"
#include "sensor_pipeline.hpp"
#include "storage.hpp"
#include "system_state.hpp"
#include "wifi_manager.hpp"
#include "security.hpp"
#include "esp_chip_info.h"
#include "esp_flash.h"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_vfs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "cJSON.h"
#include <algorithm>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <string>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <vector>

namespace openscale {
namespace {
constexpr char TAG[] = "http";
constexpr size_t MAX_HISTORY_CHUNK = 5000;
httpd_handle_t s_server = nullptr;

esp_err_t send_json(httpd_req_t *req, const std::string &body) {
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_send(req, body.c_str(), body.size());
}

bool get_query_value(httpd_req_t *req, const char *key, char *out, size_t out_size) {
    if (!req->uri || !std::strchr(req->uri, '?')) return false;
    char query[256]{};
    if (httpd_req_get_url_query_str(req, query, sizeof(query)) != ESP_OK) return false;
    return httpd_query_key_value(query, key, out, out_size) == ESP_OK;
}

enum class QueryNumberResult { Missing, Valid, Invalid };

QueryNumberResult get_query_u64(httpd_req_t *req, const char *key, uint64_t &value) {
    char text[32]{};
    if (!get_query_value(req, key, text, sizeof(text))) return QueryNumberResult::Missing;
    if (!text[0]) return QueryNumberResult::Invalid;
    for (const unsigned char *p = reinterpret_cast<const unsigned char *>(text); *p; ++p)
        if (*p < '0' || *p > '9') return QueryNumberResult::Invalid;
    char *end = nullptr;
    errno = 0;
    const unsigned long long parsed = std::strtoull(text, &end, 10);
    if (errno == ERANGE || !end || *end) return QueryNumberResult::Invalid;
    value = static_cast<uint64_t>(parsed);
    return QueryNumberResult::Valid;
}

void set_history_headers(httpd_req_t *req, const HistorySnapshot &snapshot,
                         bool truncated, size_t returned) {
    char value[32]{};
    std::snprintf(value, sizeof(value), "%u", static_cast<unsigned>(returned));
    httpd_resp_set_hdr(req, "X-History-Returned", value);
    if (returned) {
        std::snprintf(value, sizeof(value), "%llu", static_cast<unsigned long long>(snapshot.samples.front().n));
        httpd_resp_set_hdr(req, "X-History-First-Id", value);
        std::snprintf(value, sizeof(value), "%llu", static_cast<unsigned long long>(snapshot.samples.back().n));
        httpd_resp_set_hdr(req, "X-History-Last-Id", value);
    }
    if (snapshot.total_used) {
        std::snprintf(value, sizeof(value), "%llu", static_cast<unsigned long long>(snapshot.latest_id));
        httpd_resp_set_hdr(req, "X-History-Latest-Id", value);
        std::snprintf(value, sizeof(value), "%llu", static_cast<unsigned long long>(snapshot.oldest_id));
        httpd_resp_set_hdr(req, "X-History-Oldest-Id", value);
    }
    httpd_resp_set_hdr(req, "X-History-Truncated", truncated ? "true" : "false");
    httpd_resp_set_hdr(req, "X-History-Max-Chunk", "5000");
}

esp_err_t api_device(httpd_req_t *req) {
    esp_chip_info_t chip{};
    esp_chip_info(&chip);
    uint32_t flash_bytes = 0;
    (void)esp_flash_get_size(nullptr, &flash_bytes);
    const size_t psram_total = heap_caps_get_total_size(MALLOC_CAP_SPIRAM);
    const bool psram_present = psram_total > 0;
    char json[1800]{};
    std::snprintf(json, sizeof(json),
        "{\"productName\":\"OpenScale\",\"firmwareVersion\":\"%s\",\"webuiVersion\":\"%s\",\"buildId\":\"%s\",\"gitCommit\":\"%s\",\"espIdfVersion\":\"%s\","
        "\"chip\":{\"model\":%d,\"revision\":%d,\"cores\":%d},"
        "\"flash\":{\"physicalBytes\":%u},\"psram\":{\"present\":%s,\"totalBytes\":%u},"
        "\"capabilities\":{\"wifi\":true,\"ethernet\":false,\"hx711\":true,\"sse\":true,\"historyBinary\":true},"
        "\"protocolVersion\":%d,\"fileFormatVersions\":{\"settings\":1,\"wifi\":1,\"sensors\":1,\"units\":1,\"webuiSettings\":1,\"calibration\":1,\"historyBinary\":1},"
        "\"maxUploadBytes\":%u,\"maxHistoryChunk\":%u}",
        OPEN_SCALE_FIRMWARE_VERSION, OPEN_SCALE_WEBUI_VERSION, OPEN_SCALE_BUILD_ID, OPEN_SCALE_GIT_COMMIT,
        esp_get_idf_version(), static_cast<int>(chip.model), chip.revision, chip.cores,
        flash_bytes, psram_present ? "true" : "false", static_cast<unsigned>(psram_total),
        OPEN_SCALE_PROTOCOL_VERSION, OPEN_SCALE_MAX_UPLOAD_BYTES, static_cast<unsigned>(MAX_HISTORY_CHUNK));
    return send_json(req, json);
}

esp_err_t api_status(httpd_req_t *req) {
    const size_t heap_free = esp_get_free_heap_size();
    const size_t heap_min = esp_get_minimum_free_heap_size();
    const size_t heap_largest = heap_caps_get_largest_free_block(MALLOC_CAP_8BIT);
    const size_t psram_total = heap_caps_get_total_size(MALLOC_CAP_SPIRAM);
    const size_t psram_free = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    const size_t psram_largest = heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM);
    struct statvfs fs{};
    uint64_t fs_total = 0, fs_free = 0;
    if (storage::ready() && statvfs("/fs", &fs) == 0) {
        fs_total = static_cast<uint64_t>(fs.f_blocks) * fs.f_frsize;
        fs_free = static_cast<uint64_t>(fs.f_bavail) * fs.f_frsize;
    }
    uint32_t flash_bytes = 0;
    (void)esp_flash_get_size(nullptr, &flash_bytes);
    const auto sensors = sensor_pipeline_status();
    const auto wifi = wifi_manager_status();
    const std::string pending = pending_changes_json();
    const uint64_t fs_used = fs_total >= fs_free ? fs_total - fs_free : 0;
    const std::string ip_json = wifi.ip[0] ? (std::string("\"") + wifi.ip + "\"") : "null";
    std::string json;
    const std::string rssi_json = wifi.rssi_valid ? std::to_string(wifi.rssi) : "null";
    char part[1400]{};
    std::snprintf(part, sizeof(part),
        "{\"bootId\":\"%s\",\"uptimeUs\":%llu,\"csrfToken\":\"%s\",\"pendingChanges\":%s,\"unixtimestamp\":null,\"openSseConnections\":%u,"
        "\"memory\":{\"heapFree\":%u,\"heapMinFree\":%u,\"heapLargestBlock\":%u,\"psramTotal\":%u,\"psramFree\":%u,\"psramLargestBlock\":%u},"
        "\"flash\":{\"physicalTotal\":%u,\"filesystemTotal\":%llu,\"filesystemUsed\":%llu,\"filesystemFree\":%llu},"
        "\"wifi\":{\"connected\":%s,\"rssi\":%s,\"ip\":%s,\"clientsConnected\":%u},\"sensors\":[",
        boot_id(), static_cast<unsigned long long>(esp_timer_get_time()), csrf_token(), pending.c_str(),
        static_cast<unsigned>(event_subscriber_count()),
        static_cast<unsigned>(heap_free), static_cast<unsigned>(heap_min), static_cast<unsigned>(heap_largest),
        static_cast<unsigned>(psram_total), static_cast<unsigned>(psram_free), static_cast<unsigned>(psram_largest),
        flash_bytes, static_cast<unsigned long long>(fs_total),
        static_cast<unsigned long long>(fs_used), static_cast<unsigned long long>(fs_free),
        wifi.connected ? "true" : "false", rssi_json.c_str(), ip_json.c_str(),
        static_cast<unsigned>(wifi.clients_connected));
    json += part;
    bool first = true;
    for (const auto &sensor : sensors) {
        if (!first) json += ',';
        first = false;
        char item[512]{};
        std::snprintf(item, sizeof(item),
            "{\"sensorId\":%d,\"state\":\"%s\",\"rate_hz\":%u,\"sensorUptimeUs\":%llu,\"configRevision\":%llu,\"warningRevision\":%llu,\"ringBufferCapacity\":%u,\"ringBufferUsed\":%llu,\"oldestId\":%llu,\"latestId\":%llu,\"queueDrops\":%llu,\"readErrors\":%llu}",
            sensor.sensor_id, sensor.state.c_str(), sensor.rate_hz,
            static_cast<unsigned long long>(sensor.sensor_uptime_us),
            static_cast<unsigned long long>(sensor.config_revision),
            static_cast<unsigned long long>(sensor.warning_revision), sensor.capacity,
            static_cast<unsigned long long>(sensor.total_used),
            static_cast<unsigned long long>(sensor.oldest_id),
            static_cast<unsigned long long>(sensor.latest_id),
            static_cast<unsigned long long>(sensor.queue_drops),
            static_cast<unsigned long long>(sensor.read_errors));
        json += item;
    }
    json += "]}";
    return send_json(req, json);
}

esp_err_t api_history(httpd_req_t *req) {
    uint64_t sensor_id = 0, from_id = 0, to_id = 0, limit_value = 5000;
    if (get_query_u64(req, "sensor_id", sensor_id) != QueryNumberResult::Valid || sensor_id > 65535) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "sensor_id is required and must be an unsigned integer");
        return ESP_OK;
    }
    const auto from_result = get_query_u64(req, "from_id", from_id);
    const auto to_result = get_query_u64(req, "to_id", to_id);
    if (from_result == QueryNumberResult::Invalid || to_result == QueryNumberResult::Invalid ||
        (from_result == QueryNumberResult::Valid) != (to_result == QueryNumberResult::Valid) ||
        (from_result == QueryNumberResult::Valid && from_id > to_id)) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "from_id and to_id must be a valid unsigned integer pair");
        return ESP_OK;
    }
    const auto limit_result = get_query_u64(req, "limit", limit_value);
    if (limit_result == QueryNumberResult::Invalid || limit_value == 0) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "limit must be a positive integer");
        return ESP_OK;
    }
    limit_value = std::clamp<uint64_t>(limit_value, 1, MAX_HISTORY_CHUNK);
    const bool have_from = from_result == QueryNumberResult::Valid;
    char format[16]{};
    (void)get_query_value(req, "format", format, sizeof(format));
    if (format[0] && std::strcmp(format, "json") != 0 && std::strcmp(format, "bin") != 0) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "format must be json or bin");
        return ESP_OK;
    }

    HistorySnapshot snapshot{};
    bool truncated = false;
    if (!sensor_pipeline_history(static_cast<int>(sensor_id), from_id, to_id,
                                 static_cast<size_t>(limit_value), have_from, snapshot, truncated)) {
        httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "Unknown sensor_id");
        return ESP_OK;
    }
    set_history_headers(req, snapshot, truncated, snapshot.samples.size());
    if (std::strcmp(format, "bin") == 0) {
        httpd_resp_set_type(req, "application/octet-stream");
        const size_t record_size = 28;
        std::vector<uint8_t> payload(12 + snapshot.samples.size() * record_size, 0);
        payload[0] = 'H'; payload[1] = 'I'; payload[2] = 'S'; payload[3] = 'T';
        payload[4] = 1; // u16 version 1, little-endian
        const uint32_t count = static_cast<uint32_t>(snapshot.samples.size());
        for (unsigned i = 0; i < 4; ++i) payload[8 + i] = static_cast<uint8_t>(count >> (8 * i));
        size_t offset = 12;
        auto put_u64 = [&](uint64_t value) {
            for (unsigned i = 0; i < 8; ++i) payload[offset++] = static_cast<uint8_t>(value >> (8 * i));
        };
        for (const auto &sample : snapshot.samples) {
            put_u64(sample.n); put_u64(sample.t_us); put_u64(sample.raw);
            const uint32_t flags = sensor_pipeline_sample_flags(static_cast<int>(sensor_id), sample.raw);
            for (unsigned i = 0; i < 4; ++i) payload[offset++] = static_cast<uint8_t>(flags >> (8 * i));
        }
        return httpd_resp_send(req, reinterpret_cast<const char *>(payload.data()), payload.size());
    }

    std::string json = "{\"sensorId\":" + std::to_string(sensor_id) + ",\"samples\":[";
    for (size_t i = 0; i < snapshot.samples.size(); ++i) {
        if (i) json += ',';
        const auto &sample = snapshot.samples[i];
        json += "{\"n\":" + std::to_string(sample.n) +
                ",\"t\":" + std::to_string(sample.t_us) +
                ",\"raw\":" + std::to_string(sample.raw) +
                ",\"flags\":" + std::to_string(sensor_pipeline_sample_flags(static_cast<int>(sensor_id), sample.raw)) + "}";
    }
    json += "],\"returned\":" + std::to_string(snapshot.samples.size()) + ",\"firstId\":";
    json += snapshot.samples.empty() ? "null" : std::to_string(snapshot.samples.front().n);
    json += ",\"lastId\":";
    json += snapshot.samples.empty() ? "null" : std::to_string(snapshot.samples.back().n);
    json += ",\"latestId\":";
    json += snapshot.total_used ? std::to_string(snapshot.latest_id) : "null";
    json += ",\"oldestId\":";
    json += snapshot.total_used ? std::to_string(snapshot.oldest_id) : "null";
    json += std::string(",\"truncated\":") + (truncated ? "true}" : "false}");
    return send_json(req, json);
}

esp_err_t api_device_log(httpd_req_t *req) {
    uint64_t after_id = 0, limit = 128;
    const auto after_result = get_query_u64(req, "after_id", after_id);
    const auto limit_result = get_query_u64(req, "limit", limit);
    if (after_result == QueryNumberResult::Invalid || limit_result == QueryNumberResult::Invalid || limit == 0) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "after_id and limit must be unsigned integers; limit must be positive");
        return ESP_OK;
    }
    limit = std::min<uint64_t>(limit, 128);
    const auto entries = device_log_snapshot(after_id, static_cast<size_t>(limit));
    const uint64_t latest = device_log_latest_id();
    const uint64_t oldest = device_log_oldest_id();
    auto quote = [](const std::string &value) {
        cJSON *node = cJSON_CreateString(value.c_str());
        char *printed = node ? cJSON_PrintUnformatted(node) : nullptr;
        std::string result = printed ? printed : "\"\"";
        if (printed) cJSON_free(printed);
        cJSON_Delete(node);
        return result;
    };
    std::string json = "{\"entries\":[";
    for (size_t i = 0; i < entries.size(); ++i) {
        if (i) json += ',';
        const auto &e = entries[i];
        json += "{\"logEntryId\":" + std::to_string(e.log_entry_id) +
                ",\"t\":" + std::to_string(e.t_us) +
                ",\"type\":" + quote(e.type) +
                ",\"message\":" + quote(e.message) + ",\"details\":";
        cJSON *details = cJSON_Parse(e.details_json.c_str());
        char *printed = details ? cJSON_PrintUnformatted(details) : nullptr;
        json += printed ? printed : "{}";
        if (printed) cJSON_free(printed);
        cJSON_Delete(details);
        json += "}";
    }
    json += "],\"returned\":" + std::to_string(entries.size()) +
            ",\"oldestLogEntryId\":" + (oldest ? std::to_string(oldest) : "null") +
            ",\"latestLogEntryId\":" + (latest ? std::to_string(latest) : "null") +
            ",\"truncated\":" + ((after_id && oldest && after_id < oldest - 1) ? "true}" : "false}");
    return send_json(req, json);
}

bool reserved_path(const std::string &path) {
    if (path.empty() || path[0] != '/' || path.find('%') != std::string::npos ||
        path.find('\\') != std::string::npos || path.find("..") != std::string::npos ||
        path.find("//") != std::string::npos || (path.size() > 1 && path.back() == '/')) return true;
    if (path == "/api" || path.rfind("/api/", 0) == 0 || path == "/data" || path.rfind("/data/", 0) == 0) return true;
    return false;
}

const char *mime_type(const std::string &path) {
    const size_t dot = path.find_last_of('.');
    const std::string ext = dot == std::string::npos ? "" : path.substr(dot);
    if (ext == ".html" || ext == ".htm") return "text/html; charset=utf-8";
    if (ext == ".js" || ext == ".mjs") return "text/javascript; charset=utf-8";
    if (ext == ".css") return "text/css; charset=utf-8";
    if (ext == ".json" || ext == ".map") return "application/json";
    if (ext == ".svg") return "image/svg+xml";
    if (ext == ".png") return "image/png";
    if (ext == ".jpg" || ext == ".jpeg") return "image/jpeg";
    if (ext == ".ico") return "image/x-icon";
    if (ext == ".woff2") return "font/woff2";
    if (ext == ".woff") return "font/woff";
    if (ext == ".txt") return "text/plain; charset=utf-8";
    return "application/octet-stream";
}

std::string configured_index_path() {
    std::vector<uint8_t> bytes;
    if (storage::read_file("/data/settings/settings.json", bytes, 32768) == ESP_OK) {
        cJSON *root = cJSON_ParseWithLength(reinterpret_cast<const char *>(bytes.data()), bytes.size());
        const cJSON *webserver = cJSON_GetObjectItemCaseSensitive(root, "webserver");
        const cJSON *index = cJSON_GetObjectItemCaseSensitive(webserver, "http_indexpath");
        if (cJSON_IsString(index) && index->valuestring[0] == '/') {
            std::string path = index->valuestring;
            cJSON_Delete(root);
            if (!reserved_path(path)) return path;
        } else cJSON_Delete(root);
    }
    return "/default.html";
}

esp_err_t static_get(httpd_req_t *req) {
    const char *uri = req->uri ? req->uri : "/";
    const char *query = std::strchr(uri, '?');
    std::string path(uri, query ? static_cast<size_t>(query - uri) : std::strlen(uri));
    if (path == "/") path = configured_index_path();
    if (reserved_path(path)) {
        httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "Not found");
        return ESP_OK;
    }
    std::vector<uint8_t> data;
    const esp_err_t err = storage::read_file(path, data, 2 * 1024 * 1024);
    if (err != ESP_OK) {
        httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "Asset not found");
        return ESP_OK;
    }
    httpd_resp_set_type(req, mime_type(path));
    httpd_resp_set_hdr(req, "Content-Encoding", "gzip");
    httpd_resp_set_hdr(req, "Cache-Control", path == "/default.html" || path == "/default.js" ? "no-store" : "public, max-age=3600");
    return httpd_resp_send(req, reinterpret_cast<const char *>(data.data()), data.size());
}

void send_sse_frame(httpd_req_t *req, const StreamEvent &event) {
    char frame[800]{};
    const int length = std::snprintf(frame, sizeof(frame), "id: %s\nevent: %s\ndata: %s\n\n", event.id, event.name, event.data);
    if (length > 0 && length < static_cast<int>(sizeof(frame))) (void)httpd_resp_send_chunk(req, frame, length);
}

void sse_task(void *arg) {
    auto *req = static_cast<httpd_req_t *>(arg);
    QueueHandle_t queue = event_subscribe();
    if (!queue) {
        httpd_resp_set_status(req, "503 Service Unavailable");
        (void)httpd_resp_send(req, "Too many SSE clients", HTTPD_RESP_USE_STRLEN);
        (void)httpd_req_async_handler_complete(req);
        vTaskDelete(nullptr);
        return;
    }
    httpd_resp_set_type(req, "text/event-stream");
    httpd_resp_set_hdr(req, "Cache-Control", "no-cache, no-transform");
    httpd_resp_set_hdr(req, "Connection", "keep-alive");
    httpd_resp_set_hdr(req, "X-Accel-Buffering", "no");
    (void)httpd_resp_send_chunk(req, ": OpenScale SSE\n\n", HTTPD_RESP_USE_STRLEN);
    // Log snapshot only; sample history is fetched independently via /api/history.
    const auto snapshot = device_log_snapshot(0, 128);
    for (const auto &entry : snapshot) {
        char json[640]{};
        std::snprintf(json, sizeof(json),
            "{\"logEntryId\":%llu,\"t\":%llu,\"type\":\"%s\",\"message\":\"%s\",\"details\":%s}",
            static_cast<unsigned long long>(entry.log_entry_id),
            static_cast<unsigned long long>(entry.t_us), entry.type.c_str(), entry.message.c_str(),
            entry.details_json.c_str());
        const StreamEvent local = event_make_local("device_log", json);
        send_sse_frame(req, local);
    }
    TickType_t last_keepalive = xTaskGetTickCount();
    while (true) {
        StreamEvent event{};
        if (xQueueReceive(queue, &event, pdMS_TO_TICKS(1000)) == pdTRUE) {
            char frame[800]{};
            const int length = std::snprintf(frame, sizeof(frame), "id: %s\nevent: %s\ndata: %s\n\n", event.id, event.name, event.data);
            if (length <= 0 || length >= static_cast<int>(sizeof(frame)) ||
                httpd_resp_send_chunk(req, frame, length) != ESP_OK) break;
        } else if (xTaskGetTickCount() - last_keepalive >= pdMS_TO_TICKS(15000)) {
            if (httpd_resp_send_chunk(req, ": keep-alive\n\n", HTTPD_RESP_USE_STRLEN) != ESP_OK) break;
            last_keepalive = xTaskGetTickCount();
        }
    }
    (void)httpd_resp_send_chunk(req, nullptr, 0);
    event_unsubscribe(queue);
    (void)httpd_req_async_handler_complete(req);
    vTaskDelete(nullptr);
}

esp_err_t sse_handler(httpd_req_t *req) {
    httpd_req_t *async_req = nullptr;
    const esp_err_t err = httpd_req_async_handler_begin(req, &async_req);
    if (err != ESP_OK) return err;
    if (xTaskCreate(sse_task, "sse_client", 6144, async_req, 4, nullptr) != pdPASS) {
        (void)httpd_req_async_handler_complete(async_req);
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

esp_err_t api_files(httpd_req_t *req) {
    cJSON *root = cJSON_CreateObject();
    cJSON *files = cJSON_AddArrayToObject(root, "files");
    cJSON *api = cJSON_AddArrayToObject(root, "apiPaths");
    const char *routes[][2] = {{"/api/device", "GET"}, {"/api/status", "GET"}, {"/api/device-log", "GET"},
        {"/api/history", "GET"}, {"/api/files", "GET"}, {"/stream", "GET"}, {"/api/restart", "POST"},
        {"/data/settings/<name>.json", "GET,PUT,DELETE"},
        {"/data/calibration/calibration_<sensorId>_<profileId>.json", "GET,PUT,DELETE"},
        {"/<static-asset-path>", "GET,PUT,DELETE"}};
    for (const auto &route : routes) {
        cJSON *entry = cJSON_CreateObject();
        cJSON_AddStringToObject(entry, "path", route[0]);
        cJSON *methods = cJSON_AddArrayToObject(entry, "methods");
        std::string method_list = route[1];
        size_t start = 0;
        while (start < method_list.size()) {
            const size_t comma = method_list.find(',', start);
            const std::string method = method_list.substr(start, comma == std::string::npos ? std::string::npos : comma - start);
            cJSON_AddItemToArray(methods, cJSON_CreateString(method.c_str()));
            if (comma == std::string::npos) break;
            start = comma + 1;
        }
        cJSON_AddItemToArray(api, entry);
    }
    std::vector<std::string> pending{ "/fs" };
    while (!pending.empty()) {
        const std::string current = pending.back();
        pending.pop_back();
        DIR *dir = opendir(current.c_str());
        if (!dir) continue;
        struct dirent *entry = nullptr;
        while ((entry = readdir(dir)) != nullptr) {
            if (entry->d_name[0] == '.') continue;
            const std::string full = current + "/" + entry->d_name;
            struct stat st{};
            if (stat(full.c_str(), &st) != 0) continue;
            if (S_ISDIR(st.st_mode)) {
                if (full.rfind("/fs/data", 0) != 0) pending.push_back(full);
                continue;
            }
            const std::string url = full.substr(3);
            cJSON *file = cJSON_CreateObject();
            cJSON_AddStringToObject(file, "path", url.c_str());
            cJSON_AddStringToObject(file, "kind", "asset");
            cJSON_AddStringToObject(file, "contentEncoding", "gzip");
            cJSON_AddNumberToObject(file, "sizeBytes", static_cast<double>(st.st_size));
            cJSON_AddBoolToObject(file, "protected", security::password_is_set());
            cJSON_AddBoolToObject(file, "readOnly", url == "/default.html" || url == "/default.js");
            cJSON_AddItemToArray(files, file);
        }
        closedir(dir);
    }
    // Calibration files are explicit /data resources and are never exposed through the generic asset walker.
    {
        const std::string calibration_dir = "/fs/data/calibration";
        DIR *dir = opendir(calibration_dir.c_str());
        if (dir) {
            struct dirent *entry = nullptr;
            while ((entry = readdir(dir)) != nullptr) {
                if (entry->d_name[0] == '.') continue;
                const std::string name = entry->d_name;
                if (name.rfind("calibration_", 0) != 0 || name.size() < 6 || name.substr(name.size() - 5) != ".json") continue;
                const std::string full = calibration_dir + "/" + name;
                struct stat st{};
                if (stat(full.c_str(), &st) != 0 || !S_ISREG(st.st_mode)) continue;
                const std::string url = "/data/calibration/" + name;
                cJSON *file = cJSON_CreateObject();
                cJSON_AddStringToObject(file, "path", url.c_str());
                cJSON_AddStringToObject(file, "kind", "calibration");
                cJSON_AddStringToObject(file, "contentEncoding", "gzip");
                cJSON_AddNumberToObject(file, "sizeBytes", static_cast<double>(st.st_size));
                cJSON_AddBoolToObject(file, "protected", security::password_is_set());
                cJSON_AddBoolToObject(file, "readOnly", false);
                cJSON_AddItemToArray(files, file);
            }
            closedir(dir);
        }
    }
    const char *settings[] = {"settings.json", "wifi.json", "sensors.json", "units.json", "webui-settings.json"};
    for (const char *name : settings) {
        std::string path = std::string("/data/settings/") + name;
        std::vector<uint8_t> bytes;
        cJSON *file = cJSON_CreateObject();
        cJSON_AddStringToObject(file, "path", path.c_str());
        cJSON_AddStringToObject(file, "kind", "settings");
        cJSON_AddStringToObject(file, "contentEncoding", "identity");
        if (storage::read_file(path, bytes) == ESP_OK) cJSON_AddNumberToObject(file, "sizeBytes", static_cast<double>(bytes.size()));
        else cJSON_AddNullToObject(file, "sizeBytes");
        cJSON_AddBoolToObject(file, "protected", security::password_is_set());
        cJSON_AddBoolToObject(file, "readOnly", false);
        cJSON_AddItemToArray(files, file);
    }
    char *printed = cJSON_PrintUnformatted(root);
    std::string body = printed ? printed : "{\"files\":[],\"apiPaths\":[]}";
    if (printed) cJSON_free(printed);
    cJSON_Delete(root);
    return send_json(req, body);
}
}

esp_err_t web_server_start() {
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port = 80;
    config.max_uri_handlers = 32;
    config.max_open_sockets = 8;
    config.lru_purge_enable = true;
    config.uri_match_fn = httpd_uri_match_wildcard;
    const esp_err_t err = httpd_start(&s_server, &config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "HTTP server start failed: %s", esp_err_to_name(err));
        return err;
    }
    const httpd_uri_t routes[] = {
        {.uri = "/api/device", .method = HTTP_GET, .handler = api_device, .user_ctx = nullptr},
        {.uri = "/api/status", .method = HTTP_GET, .handler = api_status, .user_ctx = nullptr},
        {.uri = "/api/history", .method = HTTP_GET, .handler = api_history, .user_ctx = nullptr},
        {.uri = "/api/device-log", .method = HTTP_GET, .handler = api_device_log, .user_ctx = nullptr},
        {.uri = "/api/files", .method = HTTP_GET, .handler = api_files, .user_ctx = nullptr},
        {.uri = "/stream", .method = HTTP_GET, .handler = sse_handler, .user_ctx = nullptr},
        {.uri = "/api/restart", .method = HTTP_POST, .handler = restart_handler, .user_ctx = nullptr},
        {.uri = "/data/settings/*", .method = HTTP_GET, .handler = config_resource_handler, .user_ctx = nullptr},
        {.uri = "/data/settings/*", .method = HTTP_PUT, .handler = config_resource_handler, .user_ctx = nullptr},
        {.uri = "/data/settings/*", .method = HTTP_DELETE, .handler = config_resource_handler, .user_ctx = nullptr},
        {.uri = "/data/calibration/*", .method = HTTP_GET, .handler = calibration_resource_handler, .user_ctx = nullptr},
        {.uri = "/data/calibration/*", .method = HTTP_PUT, .handler = calibration_resource_handler, .user_ctx = nullptr},
        {.uri = "/data/calibration/*", .method = HTTP_DELETE, .handler = calibration_resource_handler, .user_ctx = nullptr},
        {.uri = "/*", .method = HTTP_GET, .handler = static_get, .user_ctx = nullptr},
        {.uri = "/*", .method = HTTP_PUT, .handler = static_mutation_handler, .user_ctx = nullptr},
        {.uri = "/*", .method = HTTP_DELETE, .handler = static_mutation_handler, .user_ctx = nullptr},
    };
    for (const auto &route : routes) {
        const esp_err_t register_err = httpd_register_uri_handler(s_server, &route);
        if (register_err != ESP_OK) {
            ESP_LOGE(TAG, "Register route %s failed: %s", route.uri, esp_err_to_name(register_err));
            return register_err;
        }
    }
    ESP_LOGI(TAG, "HTTP server listening on port %u", config.server_port);
    return ESP_OK;
}
}
