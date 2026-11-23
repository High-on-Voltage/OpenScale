#include "sensor_manager.hpp"

#include <algorithm>
#include <cstring>
#include <cstdio>
#include <strings.h>
#include <new>

#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_attr.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"

namespace app {
namespace {
constexpr char kTag[] = "sensors";
constexpr std::uint32_t kHx711ReadyTimeoutMs = 1000;

void IRAM_ATTR hx711_ready_isr(void* argument) {
    auto task = static_cast<TaskHandle_t>(argument);
    BaseType_t higher_priority_task_woken = pdFALSE;
    vTaskNotifyGiveFromISR(task, &higher_priority_task_woken);
    if (higher_priority_task_woken == pdTRUE) portYIELD_FROM_ISR();
}
portMUX_TYPE s_hx711_mux = portMUX_INITIALIZER_UNLOCKED;

bool configure_hx711(const SensorConfig& config) {
    gpio_config_t input{};
    input.pin_bit_mask = (1ULL << config.dout_gpio);
    input.mode = GPIO_MODE_INPUT;
    input.pull_up_en = GPIO_PULLUP_DISABLE;
    input.pull_down_en = GPIO_PULLDOWN_DISABLE;
    input.intr_type = GPIO_INTR_NEGEDGE;
    if (gpio_config(&input) != ESP_OK) return false;

    gpio_config_t output{};
    output.pin_bit_mask = (1ULL << config.sck_gpio);
    output.mode = GPIO_MODE_OUTPUT;
    output.pull_up_en = GPIO_PULLUP_DISABLE;
    output.pull_down_en = GPIO_PULLDOWN_DISABLE;
    output.intr_type = GPIO_INTR_DISABLE;
    if (gpio_config(&output) != ESP_OK || gpio_set_level(static_cast<gpio_num_t>(config.sck_gpio), 0) != ESP_OK) return false;

    if (config.rate_gpio >= 0) {
        gpio_config_t rate{};
        rate.pin_bit_mask = (1ULL << config.rate_gpio);
        rate.mode = GPIO_MODE_OUTPUT;
        rate.pull_up_en = GPIO_PULLUP_DISABLE;
        rate.pull_down_en = GPIO_PULLDOWN_DISABLE;
        rate.intr_type = GPIO_INTR_DISABLE;
        if (gpio_config(&rate) != ESP_OK) return false;
        if (gpio_set_level(static_cast<gpio_num_t>(config.rate_gpio), config.rate_hz == 80U ? 1 : 0) != ESP_OK) return false;
    }
    return true;
}

bool hx711_read(const SensorConfig& config, std::int32_t* output) {
    if (output == nullptr) return false;
    std::uint32_t value = 0;
    int gain_pulses = 1;  // A128
    if (strcasecmp(config.gain, "A64") == 0) gain_pulses = 3;
    else if (strcasecmp(config.gain, "B32") == 0) gain_pulses = 2;

    // The critical section prevents task switches during the timing-sensitive
    // 24-bit transfer. The ROM delay routine is safe in this short section.
    portENTER_CRITICAL(&s_hx711_mux);
    for (int bit = 0; bit < 24; ++bit) {
        gpio_set_level(static_cast<gpio_num_t>(config.sck_gpio), 1);
        esp_rom_delay_us(1);
        value = (value << 1U) | static_cast<std::uint32_t>(gpio_get_level(static_cast<gpio_num_t>(config.dout_gpio)) & 1);
        gpio_set_level(static_cast<gpio_num_t>(config.sck_gpio), 0);
        esp_rom_delay_us(1);
    }
    for (int pulse = 0; pulse < gain_pulses; ++pulse) {
        gpio_set_level(static_cast<gpio_num_t>(config.sck_gpio), 1);
        esp_rom_delay_us(1);
        gpio_set_level(static_cast<gpio_num_t>(config.sck_gpio), 0);
        esp_rom_delay_us(1);
    }
    portEXIT_CRITICAL(&s_hx711_mux);

    // Sign-extend the HX711's 24-bit two's-complement result.
    if ((value & 0x00800000U) != 0U) value |= 0xff000000U;
    *output = static_cast<std::int32_t>(value);
    return true;
}
}  // namespace

SensorManager::~SensorManager() {
    // The firmware is normally reset as a whole. Tasks are not dynamically
    // stopped/reconfigured in this milestone, but owned ring memory is released
    // if initialization fails before the manager is started.
    for (std::size_t i = 0; i < sensor_count_; ++i) delete[] states_[i].ring;
    if (sample_queue_ != nullptr) vQueueDelete(sample_queue_);
    if (ring_mutex_ != nullptr) vSemaphoreDelete(ring_mutex_);
}

bool SensorManager::initialize(const SensorConfigList& config, std::size_t max_ring_bytes) {
    if (config.count > kMaxSensors || config.queue_capacity == 0U) return false;
    sensor_count_ = config.count;
    queue_capacity_ = config.queue_capacity;
    ring_bytes_used_ = 0;

    for (std::size_t i = 0; i < sensor_count_; ++i) {
        states_[i].config = config.items[i];
        states_[i].capacity = config.items[i].ringbuffer_size_samples;
        const std::size_t bytes = states_[i].capacity * sizeof(RingEntry);
        if (bytes > max_ring_bytes || ring_bytes_used_ > max_ring_bytes - bytes) {
            ESP_LOGE(kTag, "Ring buffer budget exceeded at sensor ID %u", config.items[i].id);
            return false;
        }
        states_[i].ring = new (std::nothrow) RingEntry[states_[i].capacity]{};
        if (states_[i].ring == nullptr) {
            ESP_LOGE(kTag, "Not enough memory for sensor %u ring buffer", config.items[i].id);
            return false;
        }
        ring_bytes_used_ += bytes;
        worker_contexts_[i] = {this, i};
    }

    sample_queue_ = xQueueCreate(static_cast<UBaseType_t>(queue_capacity_), sizeof(Sample));
    ring_mutex_ = xSemaphoreCreateMutex();
    if (sample_queue_ == nullptr || ring_mutex_ == nullptr) {
        ESP_LOGE(kTag, "Could not allocate sample queue or ring mutex");
        return false;
    }
    ESP_LOGI(kTag, "Allocated %u bytes for %u sensor ring buffer(s); queue capacity %u",
             static_cast<unsigned>(ring_bytes_used_), static_cast<unsigned>(sensor_count_),
             static_cast<unsigned>(queue_capacity_));
    return true;
}

bool SensorManager::start() {
    if (started_ || sample_queue_ == nullptr || ring_mutex_ == nullptr) return false;
    const esp_err_t isr_error = gpio_install_isr_service(0);
    if (isr_error != ESP_OK && isr_error != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(kTag, "Could not install GPIO ISR service: %s", esp_err_to_name(isr_error));
        return false;
    }
    if (xTaskCreate(collector_task_entry, "sample_collector", 4096, this, 8, nullptr) != pdPASS) {
        ESP_LOGE(kTag, "Could not start sample collector task");
        return false;
    }

    for (std::size_t i = 0; i < sensor_count_; ++i) {
        const SensorConfig& cfg = states_[i].config;
        if (!cfg.enabled) continue;
        if (strcasecmp(cfg.type, "hx711") != 0) {
            ESP_LOGW(kTag, "Sensor %u uses unsupported type '%s'; configuration retained but no task started",
                     cfg.id, cfg.type);
            continue;
        }
        char task_name[20]{};
        std::snprintf(task_name, sizeof(task_name), "hx711_%u", cfg.id);
        if (xTaskCreate(sensor_task_entry, task_name, 3072, &worker_contexts_[i], 5, nullptr) != pdPASS) {
            ESP_LOGE(kTag, "Could not start acquisition task for sensor %u", cfg.id);
        }
    }
    started_ = true;
    return true;
}

void SensorManager::collector_task_entry(void* argument) {
    static_cast<SensorManager*>(argument)->collector_task();
}

void SensorManager::sensor_task_entry(void* argument) {
    auto* context = static_cast<WorkerContext*>(argument);
    context->owner->sensor_task(context->index);
}

void SensorManager::collector_task() {
    Sample sample{};
    while (true) {
        if (xQueueReceive(sample_queue_, &sample, pdMS_TO_TICKS(100)) == pdTRUE) {
            append_sample(sample);
        }
    }
}

bool SensorManager::append_sample(const Sample& sample) {
    if (xSemaphoreTake(ring_mutex_, portMAX_DELAY) != pdTRUE) return false;
    bool found = false;
    for (std::size_t i = 0; i < sensor_count_; ++i) {
        SensorState& state = states_[i];
        if (state.config.id != sample.sensor_id) continue;
        state.ring[state.write_index] = {sample.sequence, sample.timestamp_us, sample.raw_value};
        state.write_index = (state.write_index + 1U) % state.capacity;
        if (state.count < state.capacity) ++state.count;
        found = true;
        break;
    }
    xSemaphoreGive(ring_mutex_);
    return found;
}

void SensorManager::sensor_task(std::size_t index) {
    SensorState& state = states_[index];
    const SensorConfig& config = state.config;
    if (!configure_hx711(config)) {
        state.read_errors.fetch_add(1, std::memory_order_relaxed);
        ESP_LOGE(kTag, "GPIO initialization failed for sensor %u", config.id);
        vTaskDelete(nullptr);
        return;
    }
    const TaskHandle_t this_task = xTaskGetCurrentTaskHandle();
    const esp_err_t isr_error = gpio_isr_handler_add(static_cast<gpio_num_t>(config.dout_gpio), hx711_ready_isr, this_task);
    if (isr_error != ESP_OK) {
        state.read_errors.fetch_add(1, std::memory_order_relaxed);
        ESP_LOGE(kTag, "Could not attach DOUT interrupt for sensor %u: %s", config.id, esp_err_to_name(isr_error));
        vTaskDelete(nullptr);
        return;
    }

    if (xSemaphoreTake(ring_mutex_, portMAX_DELAY) == pdTRUE) {
        state.started_at_us = static_cast<std::uint64_t>(esp_timer_get_time());
        state.task_active.store(true, std::memory_order_release);
        xSemaphoreGive(ring_mutex_);
    }
    ESP_LOGI(kTag, "HX711 sensor %u ready (rate setting %u Hz; gain %s)", config.id, config.rate_hz, config.gain);
    while (true) {
        // DOUT falling edge signals that the next conversion is ready. First
        // inspect the level to handle a conversion that completed before the
        // interrupt was attached. After a notification, inspect it again: a
        // notification can be stale when DOUT was already low on loop entry.
        if (gpio_get_level(static_cast<gpio_num_t>(config.dout_gpio)) != 0) {
            if (ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(kHx711ReadyTimeoutMs)) == 0U) {
                state.read_errors.fetch_add(1, std::memory_order_relaxed);
                continue;
            }
        }
        if (gpio_get_level(static_cast<gpio_num_t>(config.dout_gpio)) != 0) {
            continue;  // A stale/spurious notification; wait for the next edge.
        }
        std::int32_t raw = 0;
        if (!hx711_read(config, &raw)) {
            state.read_errors.fetch_add(1, std::memory_order_relaxed);
            continue;
        }

        Sample sample{};
        sample.sensor_id = config.id;
        sample.sequence = ++state.next_sequence;
        sample.timestamp_us = esp_timer_get_time();
        // The wire contract always transports an unsigned 64-bit raw value.
        // For HX711 int24, retain only its low 24-bit two's-complement pattern.
        sample.raw_value = static_cast<std::uint64_t>(static_cast<std::uint32_t>(raw) & 0x00ffffffU);
        if (xQueueSend(sample_queue_, &sample, 0) != pdTRUE) {
            state.queue_drops.fetch_add(1, std::memory_order_relaxed);
        }
    }
}

std::size_t SensorManager::queue_depth() const {
    return sample_queue_ != nullptr ? static_cast<std::size_t>(uxQueueMessagesWaiting(sample_queue_)) : 0U;
}

std::size_t SensorManager::get_stats(SensorStats* output, std::size_t capacity) {
    if (output == nullptr || capacity == 0U || ring_mutex_ == nullptr) return 0U;
    const std::size_t count = std::min(sensor_count_, capacity);
    if (xSemaphoreTake(ring_mutex_, portMAX_DELAY) != pdTRUE) return 0U;
    for (std::size_t i = 0; i < count; ++i) {
        const SensorState& state = states_[i];
        SensorStats& stats = output[i];
        stats.config = state.config;
        stats.task_active = state.task_active.load(std::memory_order_acquire);
        stats.buffered_samples = state.count;
        stats.capacity = state.capacity;
        stats.queue_drops = state.queue_drops.load(std::memory_order_relaxed);
        stats.read_errors = state.read_errors.load(std::memory_order_relaxed);
        stats.sensor_uptime_us = state.started_at_us == 0U ? 0U :
            static_cast<std::uint64_t>(esp_timer_get_time()) - state.started_at_us;
        if (state.count > 0U) {
            const std::size_t oldest_index = (state.write_index + state.capacity - state.count) % state.capacity;
            stats.oldest_sequence = state.ring[oldest_index].sequence;
            stats.newest_sequence = state.ring[(state.write_index + state.capacity - 1U) % state.capacity].sequence;
        }
    }
    xSemaphoreGive(ring_mutex_);
    return count;
}

std::size_t SensorManager::get_latest_sequences(std::uint64_t* output, std::size_t capacity) {
    if (output == nullptr || capacity == 0U || ring_mutex_ == nullptr) return 0U;
    const std::size_t count = std::min(sensor_count_, capacity);
    if (xSemaphoreTake(ring_mutex_, portMAX_DELAY) != pdTRUE) return 0U;
    for (std::size_t i = 0; i < count; ++i) {
        const SensorState& state = states_[i];
        output[i] = state.count == 0U ? 0U :
            state.ring[(state.write_index + state.capacity - 1U) % state.capacity].sequence;
    }
    xSemaphoreGive(ring_mutex_);
    return count;
}

std::size_t SensorManager::copy_new_samples(std::uint64_t* cursors, Sample* output,
                                           std::size_t output_capacity) {
    if (cursors == nullptr || output == nullptr || output_capacity == 0U || ring_mutex_ == nullptr || sensor_count_ == 0U) return 0U;
    if (xSemaphoreTake(ring_mutex_, portMAX_DELAY) != pdTRUE) return 0U;
    std::size_t copied = 0;
    const std::size_t per_sensor_quota = std::max<std::size_t>(1U, output_capacity / sensor_count_);
    for (std::size_t i = 0; i < sensor_count_ && copied < output_capacity; ++i) {
        const SensorState& state = states_[i];
        if (state.count == 0U) continue;
        const std::size_t oldest = (state.write_index + state.capacity - state.count) % state.capacity;
        const auto entry_at = [&state, oldest](std::size_t logical_index) -> const RingEntry& {
            return state.ring[(oldest + logical_index) % state.capacity];
        };

        // Per-sensor sequence values are monotonic in ring order. Binary-search
        // for the first sample newer than this client's cursor instead of
        // rescanning the entire history on every SSE dispatch.
        std::size_t low = 0;
        std::size_t high = state.count;
        while (low < high) {
            const std::size_t middle = low + (high - low) / 2U;
            if (entry_at(middle).sequence <= cursors[i]) low = middle + 1U;
            else high = middle;
        }
        std::size_t sensor_copied = 0;
        for (std::size_t j = low; j < state.count && copied < output_capacity &&
             sensor_copied < per_sensor_quota; ++j) {
            const RingEntry& entry = entry_at(j);
            output[copied++] = {state.config.id, 0, 0, entry.sequence, entry.timestamp_us, entry.raw_value};
            cursors[i] = entry.sequence;
            ++sensor_copied;
        }
    }
    xSemaphoreGive(ring_mutex_);
    std::sort(output, output + copied, [](const Sample& a, const Sample& b) {
        return a.timestamp_us < b.timestamp_us;
    });
    return copied;
}

std::size_t SensorManager::copy_history(std::uint16_t sensor_id, bool has_range,
                                       std::uint64_t from_id, std::uint64_t to_id,
                                       std::size_t limit, Sample* output,
                                       std::size_t output_capacity, bool* limit_truncated,
                                       HistoryInfo* info) {
    if (limit_truncated != nullptr) *limit_truncated = false;
    if (info != nullptr) *info = HistoryInfo{};
    if (output == nullptr || output_capacity == 0U || limit == 0U || ring_mutex_ == nullptr) return 0U;
    if (xSemaphoreTake(ring_mutex_, portMAX_DELAY) != pdTRUE) return 0U;
    std::size_t copied = 0;
    for (std::size_t i = 0; i < sensor_count_; ++i) {
        const SensorState& state = states_[i];
        if (state.config.id != sensor_id) continue;
        const std::size_t oldest = (state.write_index + state.capacity - state.count) % state.capacity;
        if (info != nullptr) {
            info->retained = state.count;
            if (state.count > 0U) {
                info->oldest_id = state.ring[oldest].sequence;
                info->latest_id = state.ring[(state.write_index + state.capacity - 1U) % state.capacity].sequence;
            }
        }
        const auto in_range = [has_range, from_id, to_id](std::uint64_t id) {
            return !has_range || (id >= from_id && id <= to_id);
        };
        std::size_t matching = 0;
        for (std::size_t j = 0; j < state.count; ++j) {
            if (in_range(state.ring[(oldest + j) % state.capacity].sequence)) ++matching;
        }
        const std::size_t take = std::min({matching, limit, output_capacity});
        const std::size_t skip = matching - take;
        if (limit_truncated != nullptr && matching > take) *limit_truncated = true;
        std::size_t matching_index = 0;
        for (std::size_t j = 0; j < state.count && copied < output_capacity; ++j) {
            const RingEntry& entry = state.ring[(oldest + j) % state.capacity];
            if (!in_range(entry.sequence)) continue;
            if (matching_index++ < skip) continue;
            output[copied++] = {state.config.id, 0, 0, entry.sequence, entry.timestamp_us, entry.raw_value};
        }
        break;
    }
    xSemaphoreGive(ring_mutex_);
    return copied;
}

}  // namespace app
