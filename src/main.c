#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "hx711.h"
#include <stdio.h>


#define CONFIG_EXAMPLE_DOUT_GPIO 16
#define CONFIG_EXAMPLE_PD_SCK_GPIO 4


// Define the maximum number of items the queue can hold.
// At 80Hz, a size of 80 holds 1 second of backlog data.
#define QUEUE_SIZE 80*10


// Global handle for the FreeRTOS queue
static QueueHandle_t hx711_queue = NULL;



void hx711_task(void *pvParameter) {
	hx711_t dev = {.dout = CONFIG_EXAMPLE_DOUT_GPIO,
								 .pd_sck = CONFIG_EXAMPLE_PD_SCK_GPIO,
								 .gain = HX711_GAIN_A_128};
	
	ESP_ERROR_CHECK(hx711_init(&dev));
	int32_t raw_val = 0;
	
	while (1) {
		// Wait for sensor data ready
		if (hx711_wait(&dev, 100) == ESP_OK) {
			if (hx711_read_data(&dev, &raw_val) == ESP_OK) {
				// Push the raw value into the queue safely from the task.
				// A timeout of 0 ensures we don't block the sampling loop if the queue
				// is full.
				xQueueSend(hx711_queue, &raw_val, 0);
			}
		} else {
			vTaskDelay(pdMS_TO_TICKS(10));
		}
	}
}




void app_main(void) {
	// 1. Create the thread-safe queue for 32-bit integers
	hx711_queue = xQueueCreate(QUEUE_SIZE, sizeof(int32_t));
	if (hx711_queue == NULL) {
		printf("Error: Failed to create HX711 queue!\n");
		return;
	}
	
	// 2. Start the high-priority background sampling task on Core 0
	xTaskCreatePinnedToCore(hx711_task, "hx711_task", 2048, NULL, 5, NULL, 0);
	
	int32_t current_val;
	
	// 3. Main loop processes data at its own convenience
	while (1) {
		// Wait for data from the queue (blocks up to 100ms so it doesn't waste CPU)
		if (xQueueReceive(hx711_queue, &current_val, pdMS_TO_TICKS(100)) ==
				pdTRUE) {
			// Success! Process your raw value here (filtering, moving average, etc.)
			printf("Processed Raw Value from Queue: %d\n", current_val);
		} else {
			// Handle timeout if no samples came in (e.g., sensor disconnected)
			// printf("Waiting for scale data...\n");
		}
	}
}
