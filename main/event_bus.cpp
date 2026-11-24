#include "event_bus.hpp"
#include "esp_timer.h"
#include "freertos/semphr.h"
#include <cstdio>
#include <cstring>
#include <array>
#include <cstddef>

namespace openscale {
namespace {
constexpr size_t MAX_SUBSCRIBERS = 4;
struct Subscriber { QueueHandle_t queue{nullptr}; };
std::array<Subscriber, MAX_SUBSCRIBERS> s_subscribers{};
SemaphoreHandle_t s_subscriber_mutex = nullptr;
portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
char s_boot_id[16] = "00000000";
uint64_t s_event_counter = 0;
}

void event_bus_init(const char *boot_id) {
    if (!s_subscriber_mutex) s_subscriber_mutex = xSemaphoreCreateMutex();
    portENTER_CRITICAL(&s_mux);
    std::snprintf(s_boot_id, sizeof(s_boot_id), "%s", boot_id ? boot_id : "00000000");
    s_event_counter = 0;
    for (auto &sub : s_subscribers) sub.queue = nullptr;
    portEXIT_CRITICAL(&s_mux);
}

StreamEvent event_make_local(const char *event_name, const char *json_data) {
    StreamEvent event{};
    portENTER_CRITICAL(&s_mux);
    const uint64_t counter = ++s_event_counter;
    std::snprintf(event.id, sizeof(event.id), "%s-%llu", s_boot_id,
                  static_cast<unsigned long long>(counter));
    portEXIT_CRITICAL(&s_mux);
    std::snprintf(event.name, sizeof(event.name), "%s", event_name ? event_name : "message");
    std::snprintf(event.data, sizeof(event.data), "%s", json_data ? json_data : "{}");
    return event;
}

void event_publish(const char *event_name, const char *json_data) {
    if (!s_subscriber_mutex) return;
    xSemaphoreTake(s_subscriber_mutex, portMAX_DELAY);
    bool has_capacity = false;
    for (const auto &sub : s_subscribers) {
        if (sub.queue && uxQueueSpacesAvailable(sub.queue) > 0) { has_capacity = true; break; }
    }
    if (has_capacity) {
        // One globally assigned ID is shared by every subscriber that can accept it.
        const StreamEvent event = event_make_local(event_name, json_data);
        for (const auto &sub : s_subscribers) {
            if (sub.queue && uxQueueSpacesAvailable(sub.queue) > 0)
                (void)xQueueSend(sub.queue, &event, 0);
        }
    }
    xSemaphoreGive(s_subscriber_mutex);
}

QueueHandle_t event_subscribe() {
    QueueHandle_t queue = xQueueCreate(24, sizeof(StreamEvent));
    if (!queue) return nullptr;
    if (!s_subscriber_mutex) { vQueueDelete(queue); return nullptr; }
    xSemaphoreTake(s_subscriber_mutex, portMAX_DELAY);
    for (auto &sub : s_subscribers) {
        if (!sub.queue) { sub.queue = queue; xSemaphoreGive(s_subscriber_mutex); return queue; }
    }
    xSemaphoreGive(s_subscriber_mutex);
    vQueueDelete(queue);
    return nullptr;
}

void event_unsubscribe(QueueHandle_t queue) {
    if (!queue) return;
    if (s_subscriber_mutex) xSemaphoreTake(s_subscriber_mutex, portMAX_DELAY);
    for (auto &sub : s_subscribers) if (sub.queue == queue) sub.queue = nullptr;
    if (s_subscriber_mutex) xSemaphoreGive(s_subscriber_mutex);
    vQueueDelete(queue);
}

uint64_t event_counter() {
    portENTER_CRITICAL(&s_mux);
    const uint64_t value = s_event_counter;
    portEXIT_CRITICAL(&s_mux);
    return value;
}

size_t event_subscriber_count() {
    size_t count = 0;
    if (!s_subscriber_mutex) return count;
    xSemaphoreTake(s_subscriber_mutex, portMAX_DELAY);
    for (const auto &sub : s_subscribers) if (sub.queue) ++count;
    xSemaphoreGive(s_subscriber_mutex);
    return count;
}
}
