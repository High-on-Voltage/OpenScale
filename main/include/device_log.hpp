#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace openscale {
struct DeviceLogEntry {
    uint64_t log_entry_id{};
    uint64_t t_us{};
    std::string type;
    std::string message;
    std::string details_json;
};

void device_log_init();
void device_log_add(const char *type, const char *message, const char *details_json = "{}");
std::vector<DeviceLogEntry> device_log_snapshot(uint64_t after_id = 0, size_t limit = 128);
uint64_t device_log_latest_id();
uint64_t device_log_oldest_id();
}
