# OpenScale ESP32 — Open Engineering Issues & Research Register

**Document author:** ChatGPT (OpenAI; GPT-6)  
**Co-author:** HoV (High-on-Voltage)  
**Created:** 2026-11-28  
**Status:** Reviewed; topics are deferred and no implementation is approved  
**Project baseline:** OpenScale firmware v0.3.0; ESP-IDF 6.1.1; ESP32; `esp-idf-lib/hx711` 1.1.1

This register tracks unresolved engineering issues, research questions, and possible future improvements in OpenScale ESP32. It is intended to support systematic, evidence-based investigation and traceable engineering decisions. Entries may describe confirmed limitations, suspected problems, or proposed improvements; inclusion does not imply that a root cause has been established or that implementation has been approved.

## Index

1. [Sample Timestamp Discrepancy: Read Completion vs. Conversion Readiness](#todo-1-sample-timestamp-discrepancy-read-completion-vs-conversion-readiness) — Capture the DOUT data-ready event rather than timestamping after the software read completes.
2. [Sensor acquisition architecture](#todo-2-review-sensor-acquisition-architecture-for-multiple-sensor-types) — Review the driver/acquisition boundary to support different sensor types and acquisition mechanisms.

---

## TODO 1: Sample Timestamp Discrepancy: Read Completion vs. Conversion Readiness

**Problem:** The sample timestamp currently records when the firmware finishes reading a sensor value, rather than when the sensor indicates that the conversion result is ready. This makes the timestamp potentially misleading as a representation of when the sample became available, and it includes readiness-detection delay when polling is used.

**Recorded:** 2026-11-28  
**Firmware version:** v0.3.0  
**Priority:** Medium  
**Status:** Deferred; investigate after the current HX711 #1 retest  
**Scope:** HX711 driver/acquisition integration and sample timestamp semantics

### Why

The current investigation has one additional result: the user reports that changing the FreeRTOS tick to 1 kHz fixed HX711 #2's 10/20 ms timing pattern. HX711 #1 still needs a separate retest. Keep 1 kHz as the present baseline; this TODO is about timestamp semantics and avoiding periodic readiness polling, not undoing that fix.

The current `acquisition_task()` in `main/sensor_pipeline.cpp` performs:

1. `hx711_wait()`
2. `hx711_read_data()`
3. `esp_timer_get_time()`
4. Submit the sample to `s_sample_queue`

Consequently, `SampleRecord::t_us` (published as `t`) records when the software finished reading the value, not when the HX711 indicated that the conversion result was ready. With polling, it also includes readiness-detection delay. The timestamp is high-resolution, but its event meaning is not ideal for a field presented as a sample timestamp.

The HX711 datasheet specifies that DOUT is high while data is unavailable and goes low when data is ready. Reading the result requires 25–27 PD_SCK pulses; the 25th pulse returns DOUT high. Thus, the falling edge is a natural hardware event to timestamp.

### Proposed approach

Use a GPIO falling-edge interrupt on each HX711 DOUT pin:

1. Install the ESP-IDF GPIO ISR service once for the application (not once per sensor); register a per-pin handler for each configured HX711.
2. Keep the ISR extremely short: capture `esp_timer_get_time()` and notify the corresponding acquisition task through an ISR-safe handoff.
3. Do **not** call `hx711_read_data()`, log, allocate memory, or perform blocking operations in the ISR.
4. Replace the acquisition task's `hx711_wait()` polling loop with a task-notification/event wait, retaining a timeout for sensor-error detection and shutdown responsiveness.
5. After waking, read the HX711 normally in task context and attach the captured DOUT-ready timestamp to the resulting sample. Keep the existing sample queue and collector path initially.

`esp_timer_get_time()` is documented as fast, lock-free, 1 µs-resolution, and usable from tasks and ISR routines. The GPIO driver provides a shared ISR service (`gpio_install_isr_service()`) and per-pin registration (`gpio_isr_handler_add()`).

### Integration points in the current layout

- `Sensor` already owns the DOUT GPIO and acquisition task handle. It is the natural owner of per-sensor interrupt state.
- `hx711_init()` configures DOUT as an input but disables its GPIO interrupt. The interrupt type/handler therefore needs to be configured after driver GPIO setup, or the driver integration needs a deliberate setup hook.
- `sensor_pipeline_init()` is the natural place to coordinate one-time GPIO ISR-service installation; per-sensor setup can register each DOUT handler.
- `acquisition_task()` can retain responsibility for calling `hx711_read_data()` and queueing the completed raw sample.
- `SampleRecord::t_us` and the SSE `t` field need a documented semantic: preferably **conversion-ready time** for interrupt-timestamped sensors. Consider recording timestamp source/semantics explicitly if other sensor types will differ.

### Important correctness details

- **Startup race:** DOUT may already be low when the interrupt handler is enabled. After registration/enabling, check the pin level and handle an already-ready conversion so the first event cannot be silently missed.
- **Event/timestamp handoff:** A 64-bit timestamp must be transferred safely from ISR to task. Choose and test a clear mechanism (for example, a small ISR-safe event queue carrying the timestamp, or a carefully synchronized per-sensor timestamp plus task notification). Do not assume a plain unsynchronised 64-bit shared variable is atomic on the 32-bit ESP32.
- **Overrun:** Track failed event handoffs and situations where the task cannot service a ready conversion before the next conversion. Do not silently overwrite timestamps or raw samples.
- **Shutdown/reconfiguration:** Disable/remove each GPIO handler before its task can be deleted or its sensor state released. Define a safe registration/removal lifecycle, especially before adding runtime sensor reconfiguration.
- **Global ownership:** The GPIO ISR service is a shared driver resource. A future common GPIO/interrupt manager may be preferable if other sensor drivers also need GPIO interrupts. Handle the already-installed state deliberately rather than assuming this pipeline owns the service.
- **IRAM:** Do not automatically enable `ESP_INTR_FLAG_IRAM`. It makes the handler's code and accessed data subject to IRAM/internal-RAM constraints. Decide whether the application needs the ISR to remain serviceable during flash-cache-disabled operations, then implement and test the complete IRAM-safe call/data path if required.
- **GPIO choice:** Confirm the selected DOUT pins support the intended interrupt use. On the original ESP32, observe the documented GPIO36/GPIO39 interrupt caveat when ADC or Wi-Fi/Bluetooth sleep mode is involved.

### Benefits and costs

**Benefits**

- Timestamp close to the actual DOUT data-ready edge, independent of the task's wake-up and read duration.
- Removes the periodic 1 ms DOUT polling wakeups introduced by the 1 kHz FreeRTOS tick.
- Keeps the HX711's clocked data transfer in task context and leaves the existing queue/collector architecture mostly intact.

**Costs / downsides**

- Small-to-moderate implementation complexity: ISR registration, per-sensor event handoff, startup race handling, overrun accounting, and cleanup.
- A small interrupt and task-notification/event-handoff cost per conversion; at 80 samples/s per HX711 this should be modest, but should be measured with all active sensors and network traffic.
- ISR-entry time is not a hardware-captured edge timestamp. Interrupt masking, higher-priority interrupts, and other system activity can delay ISR execution. `esp_timer_get_time()` has 1 µs resolution; that does **not** guarantee ±1 µs edge accuracy.
- DOUT-ready time is not the exact physical instant at which the load cell was measured. The HX711 is a sigma-delta ADC; describe this as a **conversion-ready timestamp**, not an instantaneous analog-sampling timestamp.

### Validation plan

- Temporarily toggle a spare diagnostic GPIO at ISR entry; compare that edge with HX711 DOUT using a logic analyzer.
- Record DOUT-ready timestamp, task wake/read start, read end, sample number, and event-handoff/overrun counters during a test capture.
- Test two HX711s simultaneously with Wi-Fi, SSE/HTTP activity, and representative storage/flash activity.
- Verify monotonic timestamps, no unexplained sample-number gaps, no event-handoff failures, and expected DOUT/PD_SCK sequencing.
- Compare timestamped captures before and after the change. Keep the 1 kHz FreeRTOS tick as the current baseline unless separate evidence justifies changing it.

### References

- ESP-IDF 6.1 GPIO API: https://docs.espressif.com/projects/esp-idf/en/v6.1.1/esp32/api-reference/peripherals/gpio.html
- ESP-IDF 6.1 ESP Timer API (including ISR use of `esp_timer_get_time()`): https://docs.espressif.com/projects/esp-idf/en/v6.1.1/esp32/api-reference/system/esp_timer.html
- ESP-IDF FreeRTOS task notifications: https://docs.espressif.com/projects/esp-idf/en/v6.1.1/esp32/api-reference/system/freertos_idf.html
- HX711 AVIA datasheet, serial interface and DOUT timing: https://e2e.ti.com/cfs-file/__key/communityserver-discussions-components-files/73/HX711.pdf
- Current HX711 component version: `esp-idf-lib/hx711` 1.1.1 (see `dependencies.lock`); source: https://github.com/esp-idf-lib/hx711/tree/1.1.1

---

## TODO 2: Review sensor acquisition architecture for multiple sensor types

**Recorded:** 2026-11-28  
**Firmware version:** v0.3.0  
**Priority:** Medium (architecture review; implementation only when another sensor type requires it)  
**Status:** Deferred

The current pipeline is HX711-oriented: one acquisition task per enabled sensor, readiness polling, a driver read, then a common sample queue and collector. That is workable for the current implementation but may not be the best abstraction for future sensors with different acquisition models.

### Possible future direction

Separate these responsibilities:

- **Sensor driver/adapter:** hardware setup, readiness mechanism (polling, GPIO data-ready interrupt, bus event, DMA, etc.), raw read, and sensor-specific error handling.
- **Acquisition/event layer:** associates a timestamp and timestamp semantics with the hardware event, sequences reads, detects overruns, and emits a common raw-sample record.
- **Common pipeline:** sample IDs, queueing, history, warning evaluation, and publishing/transport.

Avoid forcing every sensor into a GPIO-interrupt model. Prefer a small capability/configuration interface so each driver can use the mechanism appropriate to its hardware while producing a consistent sample record.

### Questions to resolve before redesign

- Are samples timestamped at data-ready, hardware capture, read completion, or another event? How is that semantic represented to the WebUI/API?
- Should drivers expose blocking `wait_ready()`, asynchronous events, or both?
- What is the standard overrun/backpressure policy for sensors that produce data faster than the task can read or the shared queue can accept it?
- Who owns GPIO ISR service installation and registration lifecycle when multiple drivers need interrupts?
- How are sensor reconfiguration, stop/restart, and resource cleanup coordinated without stale ISR/task references?
- Which data should be common (`timestamp`, raw payload, sample sequence, status flags), and which should remain driver-specific?

**Do not undertake a broad refactor solely to add HX711 DOUT timestamping.** First implement and validate the narrow adapter-level change, then use experience from additional sensor drivers to decide whether a larger abstraction is justified.
