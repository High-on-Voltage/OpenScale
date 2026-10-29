#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_system.h"
#include "hx711.h"

// Define your GPIO pins
#define CONFIG_EXAMPLE_DOUT_GPIO 16
#define CONFIG_EXAMPLE_PD_SCK_GPIO 4

void hx711_task(void *pvParameter) {
    hx711_t dev = {
        .dout = CONFIG_EXAMPLE_DOUT_GPIO,
        .pd_sck = CONFIG_EXAMPLE_PD_SCK_GPIO,
        .gain = HX711_GAIN_A_128 // Channel A, 128 gain
    };

    // Initialize the HX711 device descriptor
    ESP_ERROR_CHECK(hx711_init(&dev));

    int32_t raw_val = 0;

    while (1) {
        // hx711_wait checks if DOUT goes LOW (data ready) with a timeout (in ms)
        if (hx711_wait(&dev, 100) == ESP_OK) {
            // Read raw data safely (the component internally uses portMUX critical sections)
            if (hx711_read_data(&dev, &raw_val) == ESP_OK) {
                printf("Lossless Raw HX711 Value: %ld\n", raw_val);
            }
        } else {
            // Handle timeout if the sensor is disconnected or slow
            vTaskDelay(pdMS_TO_TICKS(10));
        }
    }
}

void app_main(void) {
    // Pin the sampling task to Core 0 to isolate it from system tasks/WiFi on Core 1
    xTaskCreatePinnedToCore(hx711_task, "hx711_task", 2048, NULL, 5, NULL, 0);
}