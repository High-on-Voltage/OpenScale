#include "sensor_pipeline.hpp"
#include "device_log.hpp"
#include "event_bus.hpp"
#include "storage.hpp"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "hx711.h"
#include "driver/gpio.h"
#include "cJSON.h"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <memory>

namespace openscale {
namespace {
constexpr char TAG[] = "sensors";
constexpr uint32_t DEFAULT_QUEUE_CAPACITY = 64;
constexpr size_t DEFAULT_HISTORY_BUDGET = 256 * 1024;
constexpr uint32_t DEFAULT_HISTORY_CAPACITY = 1600;
constexpr uint32_t FLAG_OVERLOAD = 1U << 0;
constexpr uint32_t FLAG_UNDERLOAD = 1U << 1;
constexpr uint32_t FLAG_DISCONNECTED = 1U << 2;
constexpr uint32_t FLAG_SENSOR_ERROR = 1U << 3;
constexpr uint32_t FLAG_INVALID = 1U << 4;

struct QueuedSample { int sensor_id; SampleRecord sample; };
struct WarningConfig { bool enabled{false}; double threshold{0}; double hysteresis{0}; bool active{false}; };

struct Sensor {
    int id{-1};
    std::string type;
    std::string raw_format;
    std::string name;
    bool enabled{false};
    int dout_gpio{-1};
    int sck_gpio{-1};
    int rate_gpio{-1};
    uint32_t rate_hz{0};
    uint32_t requested_capacity{DEFAULT_HISTORY_CAPACITY};
    uint32_t capacity{0};
    SampleRecord *ring{nullptr};
    uint32_t head{0};
    uint32_t used{0};
    SemaphoreHandle_t ring_mutex{nullptr};
    TaskHandle_t task{nullptr};
    std::atomic<uint64_t> next_sample_id{0};
    std::atomic<uint64_t> queue_drops{0};
    std::atomic<uint64_t> read_errors{0};
    std::atomic<uint64_t> config_revision{1};
    std::atomic<uint64_t> warning_revision{1};
    std::atomic<bool> running{false};
    std::atomic<bool> read_error_active{false};
    std::atomic<uint64_t> started_at_us{0};
    WarningConfig overload;
    WarningConfig underload;
    hx711_gain_t gain{HX711_GAIN_A_128};
};

std::vector<std::unique_ptr<Sensor>> s_sensors;
QueueHandle_t s_sample_queue = nullptr;
TaskHandle_t s_collector_task = nullptr;
std::atomic<bool> s_stop{false};
uint32_t s_queue_capacity = DEFAULT_QUEUE_CAPACITY;
size_t s_history_budget = DEFAULT_HISTORY_BUDGET;

cJSON *load_json(const char *path) {
    std::vector<uint8_t> bytes;
    if (storage::read_file(path, bytes, 128 * 1024) != ESP_OK || bytes.empty()) return nullptr;
    return cJSON_ParseWithLength(reinterpret_cast<const char *>(bytes.data()), bytes.size());
}

bool json_number(const cJSON *object, const char *key, double &value) {
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(object, key);
    if (!cJSON_IsNumber(item) || !std::isfinite(item->valuedouble)) return false;
    value = item->valuedouble;
    return true;
}

void read_warning(const cJSON *sensor_json, const char *key, WarningConfig &out) {
    const cJSON *warnings = cJSON_GetObjectItemCaseSensitive(sensor_json, "warnings");
    const cJSON *warning = cJSON_GetObjectItemCaseSensitive(warnings, key);
    if (!cJSON_IsObject(warning)) return;
    const cJSON *enabled = cJSON_GetObjectItemCaseSensitive(warning, "enabled");
    if (cJSON_IsBool(enabled)) out.enabled = cJSON_IsTrue(enabled);
    (void)json_number(warning, "threshold", out.threshold);
    (void)json_number(warning, "hysteresis", out.hysteresis);
    if (out.hysteresis < 0) out.hysteresis = 0;
}

void read_settings() {
    std::vector<uint8_t> file_bytes;
    const esp_err_t read_result = storage::read_file("/data/settings/settings.json", file_bytes, 32768);
    cJSON *settings = read_result == ESP_OK && !file_bytes.empty()
        ? cJSON_ParseWithLength(reinterpret_cast<const char *>(file_bytes.data()), file_bytes.size()) : nullptr;
    if (read_result == ESP_ERR_NOT_FOUND) {
        static constexpr char defaults[] =
            "{\"schemaVersion\":1,\"network\":{\"hostname\":\"\"},\"webserver\":{\"redirectToHostname\":true,\"http_indexpath\":\"/default.html\",\"https\":{\"enabled\":false},\"security\":{}},\"buffer\":{\"ringbuffer_max_total_size_bytes\":262144,\"queue_capacity\":64}}";
        std::vector<uint8_t> bytes(defaults, defaults + sizeof(defaults) - 1);
        if (storage::ready()) (void)storage::write_file_atomic("/data/settings/settings.json", bytes.data(), bytes.size());
        settings = cJSON_Parse(defaults);
    } else if (!settings) {
        device_log_add("config_fallback", "Could not load settings.json; in-memory defaults are active",
                       "{\"file\":\"settings.json\",\"reason\":\"parse_error\",\"savedFileModified\":false}");
        static constexpr char defaults[] =
            "{\"schemaVersion\":1,\"network\":{\"hostname\":\"\"},\"webserver\":{\"redirectToHostname\":true,\"http_indexpath\":\"/default.html\",\"https\":{\"enabled\":false},\"security\":{}},\"buffer\":{\"ringbuffer_max_total_size_bytes\":262144,\"queue_capacity\":64}}";
        settings = cJSON_Parse(defaults); // Do not overwrite the corrupt saved file.
    }
    const cJSON *buffer = cJSON_GetObjectItemCaseSensitive(settings, "buffer");
    double number = 0;
    if (json_number(buffer, "queue_capacity", number) && number >= 1 && number <= 4096)
        s_queue_capacity = static_cast<uint32_t>(number);
    if (json_number(buffer, "ringbuffer_max_total_size_bytes", number) && number >= sizeof(SampleRecord))
        s_history_budget = static_cast<size_t>(number);
    cJSON_Delete(settings);
}

void create_default_sensor_file() {
    static constexpr char defaults[] = "{\"schemaVersion\":1,\"sensors\":[]}";
    std::vector<uint8_t> bytes(defaults, defaults + sizeof(defaults) - 1);
    (void)storage::write_file_atomic("/data/settings/sensors.json", bytes.data(), bytes.size());
}

void load_sensor_configs() {
    std::vector<uint8_t> file_bytes;
    const esp_err_t read_result = storage::read_file("/data/settings/sensors.json", file_bytes, 128 * 1024);
    cJSON *root = read_result == ESP_OK && !file_bytes.empty()
        ? cJSON_ParseWithLength(reinterpret_cast<const char *>(file_bytes.data()), file_bytes.size()) : nullptr;
    if (read_result == ESP_ERR_NOT_FOUND) {
        if (storage::ready()) create_default_sensor_file();
        root = cJSON_Parse("{\"schemaVersion\":1,\"sensors\":[]}");
    } else if (!root) {
        device_log_add("config_fallback", "Could not load sensors.json; no sensor definitions are active",
                       "{\"file\":\"sensors.json\",\"reason\":\"parse_error\",\"savedFileModified\":false}");
        root = cJSON_Parse("{\"schemaVersion\":1,\"sensors\":[]}"); // Never repair a corrupt file automatically.
    }
    const cJSON *array = cJSON_GetObjectItemCaseSensitive(root, "sensors");
    if (cJSON_IsArray(array)) {
        const int count = cJSON_GetArraySize(array);
        for (int i = 0; i < count; ++i) {
            const cJSON *item = cJSON_GetArrayItem(array, i);
            double id = -1, rate = 0, capacity = DEFAULT_HISTORY_CAPACITY;
            const cJSON *type = cJSON_GetObjectItemCaseSensitive(item, "type");
            const cJSON *enabled = cJSON_GetObjectItemCaseSensitive(item, "enabled");
            const cJSON *raw = cJSON_GetObjectItemCaseSensitive(item, "rawFormat");
            const cJSON *hx = cJSON_GetObjectItemCaseSensitive(item, "hx711");
            if (!json_number(item, "id", id) || id < 0 || id > 65535 || !cJSON_IsString(type) ||
                !cJSON_IsBool(enabled) || !json_number(item, "rate_hz", rate) ||
                !json_number(item, "ringbuffer_size_samples", capacity)) continue;
            if (std::strcmp(type->valuestring, "hx711") != 0 || !cJSON_IsObject(hx)) continue;
            if (!cJSON_IsString(raw) || std::strcmp(raw->valuestring, "int24") != 0) {
                device_log_add("sensor_error", "HX711 sensor requires rawFormat int24", "{}");
                continue;
            }
            double dout = -1, sck = -1;
            if (!json_number(hx, "dout_gpio", dout) || !json_number(hx, "sck_gpio", sck)) continue;
            if ((rate != 10 && rate != 80) || capacity < 1 || capacity > 1000000) continue;
            auto sensor = std::make_unique<Sensor>();
            sensor->id = static_cast<int>(id);
            sensor->type = type->valuestring;
            sensor->raw_format = raw->valuestring;
            const cJSON *name = cJSON_GetObjectItemCaseSensitive(item, "name");
            if (cJSON_IsString(name)) sensor->name = name->valuestring;
            sensor->enabled = cJSON_IsTrue(enabled);
            sensor->dout_gpio = static_cast<int>(dout);
            sensor->sck_gpio = static_cast<int>(sck);
            sensor->rate_hz = static_cast<uint32_t>(rate);
            sensor->requested_capacity = static_cast<uint32_t>(capacity);
            const cJSON *rate_gpio = cJSON_GetObjectItemCaseSensitive(hx, "rate_gpio");
            if (cJSON_IsNumber(rate_gpio)) sensor->rate_gpio = rate_gpio->valueint;
            const cJSON *gain = cJSON_GetObjectItemCaseSensitive(hx, "gain");
            if (cJSON_IsString(gain)) {
                if (std::strcmp(gain->valuestring, "A64") == 0) sensor->gain = HX711_GAIN_A_64;
                else if (std::strcmp(gain->valuestring, "B32") == 0) sensor->gain = HX711_GAIN_B_32;
                else sensor->gain = HX711_GAIN_A_128;
            }
            read_warning(item, "overload", sensor->overload);
            read_warning(item, "underload", sensor->underload);
            sensor->ring_mutex = xSemaphoreCreateMutex();
            if (sensor->ring_mutex) s_sensors.push_back(std::move(sensor));
        }
    }
    cJSON_Delete(root);
}

Sensor *find_sensor(int id) {
    for (auto &sensor : s_sensors) if (sensor->id == id) return sensor.get();
    return nullptr;
}

int32_t decode_int24(uint64_t raw) {
    uint32_t value = static_cast<uint32_t>(raw) & 0x00FFFFFFU;
    if (value & 0x00800000U) value |= 0xFF000000U;
    return static_cast<int32_t>(value);
}

uint32_t flags_for(const Sensor &sensor, uint64_t raw) {
    const double value = static_cast<double>(decode_int24(raw));
    uint32_t flags = 0;
    if (sensor.overload.enabled && value >= sensor.overload.threshold) flags |= FLAG_OVERLOAD;
    if (sensor.underload.enabled && value <= sensor.underload.threshold) flags |= FLAG_UNDERLOAD;
    return flags;
}

void process_warning(Sensor &sensor, const SampleRecord &sample) {
    const double value = static_cast<double>(decode_int24(sample.raw));
    auto transition = [&](WarningConfig &warning, const char *code, bool overload) {
        if (!warning.enabled) return;
        bool next = warning.active;
        if (overload) {
            if (!warning.active && value >= warning.threshold) next = true;
            else if (warning.active && value <= warning.threshold - warning.hysteresis) next = false;
        } else {
            if (!warning.active && value <= warning.threshold) next = true;
            else if (warning.active && value >= warning.threshold + warning.hysteresis) next = false;
        }
        if (next == warning.active) return;
        warning.active = next;
        char json[512]{};
        std::snprintf(json, sizeof(json),
            "{\"type\":\"sensor\",\"code\":\"%s\",\"active\":%s,\"sensor\":{\"sensorId\":%d,\"threshold\":%.17g,\"sample\":{\"n\":%llu,\"t\":%llu,\"raw\":%llu,\"flags\":%u}}}",
            code, next ? "true" : "false", sensor.id, warning.threshold,
            static_cast<unsigned long long>(sample.n),
            static_cast<unsigned long long>(sample.t_us),
            static_cast<unsigned long long>(sample.raw), flags_for(sensor, sample.raw));
        event_publish("warning", json);
        char details[160]{};
        std::snprintf(details, sizeof(details), "{\"sensorId\":%d,\"code\":\"%s\",\"active\":%s,\"n\":%llu,\"threshold\":%.17g}",
                      sensor.id, code, next ? "true" : "false",
                      static_cast<unsigned long long>(sample.n), warning.threshold);
        device_log_add("warning", "Sensor warning state changed", details);
    };
    transition(sensor.overload, "overload", true);
    transition(sensor.underload, "underload", false);
}

void publish_sample(const Sensor &sensor, const SampleRecord &sample) {
    char json[256]{};
    std::snprintf(json, sizeof(json),
        "{\"sensorId\":%d,\"n\":%llu,\"t\":%llu,\"raw\":%llu,\"flags\":%u}",
        sensor.id, static_cast<unsigned long long>(sample.n),
        static_cast<unsigned long long>(sample.t_us),
        static_cast<unsigned long long>(sample.raw), flags_for(sensor, sample.raw));
    event_publish("sample", json);
}

void ring_push(Sensor &sensor, const SampleRecord &sample) {
    if (!sensor.ring || !sensor.capacity) return;
    xSemaphoreTake(sensor.ring_mutex, portMAX_DELAY);
    sensor.ring[sensor.head] = sample;
    sensor.head = (sensor.head + 1) % sensor.capacity;
    if (sensor.used < sensor.capacity) ++sensor.used;
    xSemaphoreGive(sensor.ring_mutex);
}

void acquisition_task(void *arg) {
    auto *sensor = static_cast<Sensor *>(arg);
    hx711_t device{};
    device.dout = static_cast<gpio_num_t>(sensor->dout_gpio);
    device.pd_sck = static_cast<gpio_num_t>(sensor->sck_gpio);
    device.gain = sensor->gain;
    esp_err_t result = hx711_init(&device);
    if (result == ESP_OK && sensor->rate_gpio >= 0) {
        gpio_config_t config{};
        config.pin_bit_mask = 1ULL << sensor->rate_gpio;
        config.mode = GPIO_MODE_OUTPUT;
        config.pull_up_en = GPIO_PULLUP_DISABLE;
        config.pull_down_en = GPIO_PULLDOWN_DISABLE;
        config.intr_type = GPIO_INTR_DISABLE;
        result = gpio_config(&config);
        if (result == ESP_OK) result = gpio_set_level(static_cast<gpio_num_t>(sensor->rate_gpio), sensor->rate_hz == 80 ? 1 : 0);
    }
    if (result != ESP_OK) {
        sensor->read_error_active = true;
        sensor->read_errors++;
        char details[96]{};
        std::snprintf(details, sizeof(details), "{\"sensorId\":%d,\"code\":\"driver_init_failed\"}", sensor->id);
        device_log_add("sensor_error", "HX711 initialisation failed", details);
        sensor->running = false;
        vTaskDelete(nullptr);
        return;
    }

    sensor->started_at_us = static_cast<uint64_t>(esp_timer_get_time());
    sensor->running = true;
    const uint32_t timeout_ms = std::max<uint32_t>(200, (1000U / sensor->rate_hz) * 3U);
    while (!s_stop.load()) {
        int32_t raw_value = 0;
        result = hx711_wait(&device, timeout_ms);
        if (result == ESP_OK) result = hx711_read_data(&device, &raw_value);
        if (result != ESP_OK) {
            sensor->read_errors++;
            if (!sensor->read_error_active.exchange(true)) {
                char payload[192]{};
                std::snprintf(payload, sizeof(payload), "{\"sensorId\":%d,\"state\":\"error\",\"code\":\"read_timeout\",\"message\":\"HX711 read timeout\",\"t\":%llu}",
                              sensor->id, static_cast<unsigned long long>(esp_timer_get_time()));
                event_publish("sensor_error", payload);
                char details[96]{};
                std::snprintf(details, sizeof(details), "{\"sensorId\":%d,\"code\":\"read_timeout\"}", sensor->id);
                device_log_add("sensor_error", "HX711 read failed", details);
            }
            continue;
        }
        if (sensor->read_error_active.exchange(false)) {
            char payload[128]{};
            std::snprintf(payload, sizeof(payload), "{\"sensorId\":%d,\"state\":\"ok\",\"code\":\"recovered\",\"message\":\"HX711 read recovered\",\"t\":%llu}",
                          sensor->id, static_cast<unsigned long long>(esp_timer_get_time()));
            event_publish("sensor_error", payload);
        }
        const uint64_t n = ++sensor->next_sample_id;
        QueuedSample queued{};
        queued.sensor_id = sensor->id;
        queued.sample.n = n;
        queued.sample.t_us = static_cast<uint64_t>(esp_timer_get_time());
        queued.sample.raw = static_cast<uint64_t>(static_cast<uint32_t>(raw_value) & 0x00FFFFFFU);
        if (xQueueSend(s_sample_queue, &queued, 0) != pdTRUE) ++sensor->queue_drops;
    }
    sensor->running = false;
    vTaskDelete(nullptr);
}

void collector_task(void *) {
    QueuedSample queued{};
    while (!s_stop.load()) {
        if (xQueueReceive(s_sample_queue, &queued, pdMS_TO_TICKS(100)) != pdTRUE) continue;
        Sensor *sensor = find_sensor(queued.sensor_id);
        if (!sensor) continue;
        ring_push(*sensor, queued.sample);
        process_warning(*sensor, queued.sample);
        publish_sample(*sensor, queued.sample);
    }
    vTaskDelete(nullptr);
}

void allocate_rings() {
    size_t remaining = s_history_budget;
    for (auto &entry : s_sensors) {
        Sensor &sensor = *entry;
        const size_t wanted = static_cast<size_t>(sensor.requested_capacity) * sizeof(SampleRecord);
        const size_t bytes = std::min(wanted, remaining);
        const uint32_t actual = static_cast<uint32_t>(bytes / sizeof(SampleRecord));
        if (!actual) {
            device_log_add("sensor_error", "Sensor history disabled: configured memory budget exhausted", "{}");
            continue;
        }
        const size_t actual_bytes = static_cast<size_t>(actual) * sizeof(SampleRecord);
        sensor.ring = static_cast<SampleRecord *>(heap_caps_malloc(actual_bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
        if (!sensor.ring) sensor.ring = static_cast<SampleRecord *>(heap_caps_malloc(actual_bytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
        if (!sensor.ring) {
            device_log_add("sensor_error", "Sensor history allocation failed", "{}");
            continue;
        }
        sensor.capacity = actual;
        remaining -= actual_bytes;
    }
}
}

void sensor_pipeline_init() {
    read_settings();
    load_sensor_configs();
    allocate_rings();
    s_sample_queue = xQueueCreate(s_queue_capacity, sizeof(QueuedSample));
    if (!s_sample_queue) {
        device_log_add("sensor_error", "Could not create shared sample queue", "{}");
        return;
    }
    s_stop = false;
    if (xTaskCreate(collector_task, "sample_collector", 4096, nullptr, 6, &s_collector_task) != pdPASS) {
        device_log_add("sensor_error", "Could not start sample collector", "{}");
        return;
    }
    for (auto &entry : s_sensors) {
        Sensor &sensor = *entry;
        if (!sensor.enabled) continue;
        if (xTaskCreate(acquisition_task, "hx711_acquire", 4096, &sensor, 5, &sensor.task) != pdPASS) {
            device_log_add("sensor_error", "Could not start HX711 acquisition task", "{}");
        }
    }
    ESP_LOGI(TAG, "Configured %u sensor(s), queue=%u, history budget=%u bytes",
             static_cast<unsigned>(s_sensors.size()), s_queue_capacity,
             static_cast<unsigned>(s_history_budget));
}

void sensor_pipeline_stop() { s_stop = true; }

std::vector<HistorySnapshot> sensor_pipeline_status() {
    std::vector<HistorySnapshot> result;
    for (const auto &entry : s_sensors) {
        const Sensor &sensor = *entry;
        HistorySnapshot snapshot{};
        snapshot.sensor_id = sensor.id;
        snapshot.capacity = sensor.capacity;
        snapshot.rate_hz = sensor.rate_hz;
        snapshot.queue_drops = sensor.queue_drops.load();
        snapshot.read_errors = sensor.read_errors.load();
        snapshot.config_revision = sensor.config_revision.load();
        snapshot.warning_revision = sensor.warning_revision.load();
        const uint64_t started = sensor.started_at_us.load();
        snapshot.sensor_uptime_us = sensor.running.load() && started ? static_cast<uint64_t>(esp_timer_get_time()) - started : 0;
        snapshot.state = sensor.running.load() ? (sensor.read_error_active.load() ? "error" : "ok") : (sensor.enabled ? "error" : "disabled");
        xSemaphoreTake(sensor.ring_mutex, portMAX_DELAY);
        snapshot.total_used = sensor.used;
        if (sensor.used) {
            const uint32_t oldest_index = (sensor.head + sensor.capacity - sensor.used) % sensor.capacity;
            snapshot.oldest_id = sensor.ring[oldest_index].n;
            snapshot.latest_id = sensor.ring[(sensor.head + sensor.capacity - 1) % sensor.capacity].n;
        }
        xSemaphoreGive(sensor.ring_mutex);
        result.push_back(std::move(snapshot));
    }
    return result;
}

bool sensor_pipeline_history(int sensor_id, uint64_t from_id, uint64_t to_id,
                             size_t limit, bool use_range, HistorySnapshot &out,
                             bool &truncated) {
    Sensor *sensor = find_sensor(sensor_id);
    if (!sensor) return false;
    out = {};
    out.sensor_id = sensor_id;
    out.capacity = sensor->capacity;
    out.rate_hz = sensor->rate_hz;
    out.queue_drops = sensor->queue_drops.load();
    out.read_errors = sensor->read_errors.load();
    out.config_revision = sensor->config_revision.load();
    out.warning_revision = sensor->warning_revision.load();
    const uint64_t started = sensor->started_at_us.load();
    out.sensor_uptime_us = sensor->running.load() && started ? static_cast<uint64_t>(esp_timer_get_time()) - started : 0;
    out.state = sensor->running.load() ? "ok" : "error";
    truncated = false;
    if (!sensor->ring || !sensor->capacity) return true;
    xSemaphoreTake(sensor->ring_mutex, portMAX_DELAY);
    out.total_used = sensor->used;
    if (!sensor->used) { xSemaphoreGive(sensor->ring_mutex); return true; }
    const uint32_t oldest_index = (sensor->head + sensor->capacity - sensor->used) % sensor->capacity;
    out.oldest_id = sensor->ring[oldest_index].n;
    out.latest_id = sensor->ring[(sensor->head + sensor->capacity - 1) % sensor->capacity].n;
    if (use_range && (from_id < out.oldest_id || to_id > out.latest_id)) truncated = true;

    std::vector<SampleRecord> selected;
    selected.reserve(std::min<size_t>(sensor->used, limit));
    for (uint32_t i = 0; i < sensor->used; ++i) {
        const SampleRecord &sample = sensor->ring[(oldest_index + i) % sensor->capacity];
        if (use_range && (sample.n < from_id || sample.n > to_id)) continue;
        selected.push_back(sample);
    }
    if (selected.size() > limit) {
        selected.erase(selected.begin(), selected.end() - static_cast<ptrdiff_t>(limit));
        truncated = true;
    }
    out.samples = std::move(selected);
    xSemaphoreGive(sensor->ring_mutex);
    return true;
}

uint32_t sensor_pipeline_sample_flags(int sensor_id, uint64_t raw) {
    Sensor *sensor = find_sensor(sensor_id);
    return sensor ? flags_for(*sensor, raw) : 0;
}
}
