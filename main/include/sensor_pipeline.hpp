#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace openscale {
struct SampleRecord {
    uint64_t n;
    uint64_t t_us;
    uint64_t raw;
};

struct HistorySnapshot {
    int sensor_id;
    std::vector<SampleRecord> samples;
    uint64_t oldest_id;
    uint64_t latest_id;
    uint64_t total_used;
    uint64_t queue_drops;
    uint64_t read_errors;
    uint64_t config_revision;
    uint64_t warning_revision;
    uint64_t sensor_uptime_us;
    uint32_t capacity;
    uint32_t rate_hz;
    std::string state;
};

void sensor_pipeline_init();
void sensor_pipeline_stop();
std::vector<HistorySnapshot> sensor_pipeline_status();
bool sensor_pipeline_history(int sensor_id, uint64_t from_id, uint64_t to_id,
                             size_t limit, bool use_range, HistorySnapshot &out,
                             bool &truncated);
uint32_t sensor_pipeline_sample_flags(int sensor_id, uint64_t raw);
}
