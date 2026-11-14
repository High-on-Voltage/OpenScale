#pragma once

#include <cstddef>
#include <cstdint>
#include <atomic>

#include "app_types.hpp"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"

namespace app {

struct SensorStats {
    SensorConfig config{};
    bool task_active = false;
    std::size_t buffered_samples = 0;
    std::size_t capacity = 0;
    std::uint64_t oldest_sequence = 0;
    std::uint64_t newest_sequence = 0;
    std::uint32_t queue_drops = 0;
    std::uint32_t read_errors = 0;
};

class SensorManager {
public:
    SensorManager() = default;
    ~SensorManager();

    bool initialize(const SensorConfigList& config, std::size_t max_ring_bytes);
    bool start();

    std::size_t sensor_count() const { return sensor_count_; }
    std::size_t ring_bytes_used() const { return ring_bytes_used_; }
    std::size_t queue_depth() const;
    std::size_t queue_capacity() const { return queue_capacity_; }

    std::size_t get_stats(SensorStats* output, std::size_t capacity);
    std::size_t get_latest_sequences(std::uint64_t* output, std::size_t capacity);
    std::size_t copy_new_samples(std::uint64_t* cursors, Sample* output,
                                 std::size_t output_capacity);
    std::size_t copy_history(std::uint16_t sensor_id, std::size_t limit,
                             Sample* output, std::size_t output_capacity);

private:
    struct SensorState {
        SensorConfig config{};
        RingEntry* ring = nullptr;
        std::size_t capacity = 0;
        std::size_t count = 0;
        std::size_t write_index = 0;
        std::uint64_t next_sequence = 0;
        std::atomic<std::uint32_t> queue_drops{0};
        std::atomic<std::uint32_t> read_errors{0};
        std::atomic<bool> task_active{false};
    };

    struct WorkerContext {
        SensorManager* owner = nullptr;
        std::size_t index = 0;
    };

    static void collector_task_entry(void* argument);
    static void sensor_task_entry(void* argument);
    void collector_task();
    void sensor_task(std::size_t index);
    bool append_sample(const Sample& sample);

    SensorState states_[kMaxSensors]{};
    WorkerContext worker_contexts_[kMaxSensors]{};
    std::size_t sensor_count_ = 0;
    std::size_t ring_bytes_used_ = 0;
    std::size_t queue_capacity_ = 0;
    QueueHandle_t sample_queue_ = nullptr;
    SemaphoreHandle_t ring_mutex_ = nullptr;
    bool started_ = false;
};

}  // namespace app
