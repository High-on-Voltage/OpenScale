#pragma once
#include <cstdint>
#include <cstddef>
#include <string>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"

namespace openscale {
struct StreamEvent {
    char id[48];
    char name[20];
    char data[640];
};

void event_bus_init(const char *boot_id);
StreamEvent event_make_local(const char *event_name, const char *json_data);
void event_publish(const char *event_name, const char *json_data);
QueueHandle_t event_subscribe();
void event_unsubscribe(QueueHandle_t queue);
uint64_t event_counter();
size_t event_subscriber_count();
}
