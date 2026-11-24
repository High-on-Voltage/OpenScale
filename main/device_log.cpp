#include "device_log.hpp"
#include "event_bus.hpp"
#include "esp_timer.h"
#include "freertos/semphr.h"
#include <array>
#include <cstdio>
#include <cstring>
#include <algorithm>

namespace openscale {
namespace {
constexpr size_t LOG_CAPACITY = 128;
struct StoredEntry {
    uint64_t id{};
    uint64_t t{};
    char type[32]{};
    char message[160]{};
    char details[256]{};
};
std::array<StoredEntry, LOG_CAPACITY> s_entries{};
size_t s_head = 0;
size_t s_count = 0;
uint64_t s_next_id = 1;
SemaphoreHandle_t s_mutex = nullptr;

void ensure_mutex() { if (!s_mutex) s_mutex = xSemaphoreCreateMutex(); }
void json_escape(const char *in, char *out, size_t cap) {
    size_t used = 0;
    if (!cap) return;
    for (const unsigned char *p = reinterpret_cast<const unsigned char *>(in ? in : ""); *p && used + 2 < cap; ++p) {
        if (*p == '"' || *p == '\\') { out[used++] = '\\'; out[used++] = static_cast<char>(*p); }
        else if (*p < 0x20) { out[used++] = ' '; }
        else out[used++] = static_cast<char>(*p);
    }
    out[used] = 0;
}
}

void device_log_init() { ensure_mutex(); }

void device_log_add(const char *type, const char *message, const char *details_json) {
    ensure_mutex();
    if (s_mutex) xSemaphoreTake(s_mutex, portMAX_DELAY);
    StoredEntry &entry = s_entries[s_head];
    entry = {};
    entry.id = s_next_id++;
    entry.t = static_cast<uint64_t>(esp_timer_get_time());
    std::snprintf(entry.type, sizeof(entry.type), "%s", type ? type : "info");
    std::snprintf(entry.message, sizeof(entry.message), "%s", message ? message : "");
    std::snprintf(entry.details, sizeof(entry.details), "%s", details_json ? details_json : "{}");
    s_head = (s_head + 1) % LOG_CAPACITY;
    if (s_count < LOG_CAPACITY) ++s_count;
    const StoredEntry copy = entry;
    if (s_mutex) xSemaphoreGive(s_mutex);

    char escaped[320]{};
    char json[640]{};
    json_escape(copy.message, escaped, sizeof(escaped));
    std::snprintf(json, sizeof(json),
                  "{\"logEntryId\":%llu,\"t\":%llu,\"type\":\"%s\",\"message\":\"%s\",\"details\":%s}",
                  static_cast<unsigned long long>(copy.id),
                  static_cast<unsigned long long>(copy.t), copy.type, escaped, copy.details);
    event_publish("device_log", json);
}

std::vector<DeviceLogEntry> device_log_snapshot(uint64_t after_id, size_t limit) {
    std::vector<DeviceLogEntry> result;
    ensure_mutex();
    if (s_mutex) xSemaphoreTake(s_mutex, portMAX_DELAY);
    const size_t oldest = (s_head + LOG_CAPACITY - s_count) % LOG_CAPACITY;
    for (size_t i = 0; i < s_count; ++i) {
        const StoredEntry &e = s_entries[(oldest + i) % LOG_CAPACITY];
        if (e.id <= after_id) continue;
        if (result.size() >= std::min(limit, LOG_CAPACITY)) break;
        result.push_back({e.id, e.t, e.type, e.message, e.details});
    }
    if (s_mutex) xSemaphoreGive(s_mutex);
    return result;
}

uint64_t device_log_oldest_id() {
    ensure_mutex();
    if (s_mutex) xSemaphoreTake(s_mutex, portMAX_DELAY);
    const uint64_t id = s_count ? s_entries[(s_head + LOG_CAPACITY - s_count) % LOG_CAPACITY].id : 0;
    if (s_mutex) xSemaphoreGive(s_mutex);
    return id;
}

uint64_t device_log_latest_id() {
    ensure_mutex();
    if (s_mutex) xSemaphoreTake(s_mutex, portMAX_DELAY);
    const uint64_t id = s_next_id - 1;
    if (s_mutex) xSemaphoreGive(s_mutex);
    return id;
}
}
