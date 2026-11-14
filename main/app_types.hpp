#pragma once

#include <cstddef>
#include <cstdint>

#include "esp_err.h"
#include "freertos/FreeRTOS.h"

namespace app {

constexpr std::size_t kMaxSensors = 16;
constexpr std::size_t kMaxSensorName = 40;
constexpr std::size_t kMaxSensorType = 16;
constexpr std::size_t kMaxGainName = 8;
constexpr std::size_t kMaxSsid = 32;
constexpr std::size_t kMaxWifiPassword = 64;
constexpr std::size_t kMaxHostname = 32;
constexpr std::size_t kMaxApPrefix = 24;
constexpr std::size_t kMaxAdminName = 24;
constexpr std::size_t kMaxSaltHex = 33;
constexpr std::size_t kMaxHashHex = 65;

struct Settings {
    char hostname[kMaxHostname] = "esp32-sensor";
    char wifi_ssid[kMaxSsid + 1] = "";
    char wifi_password[kMaxWifiPassword + 1] = "";
    char ap_ssid_prefix[kMaxApPrefix] = "ESP32-Sensor";
    std::uint32_t sta_timeout_ms = 12000;
    bool http_enabled = true;
    std::uint16_t http_port = 80;
    bool https_enabled = false;  // HTTPS is deliberately not implemented in this first milestone.
    char admin_username[kMaxAdminName] = "admin";
    char admin_salt_hex[kMaxSaltHex] = "";
    char admin_hash_hex[kMaxHashHex] = "";
    std::uint32_t pbkdf2_iterations = 100000;
    std::size_t max_ring_buffer_bytes = 262144;
    std::size_t max_upload_bytes = 524288;
};

struct SensorConfig {
    std::uint16_t id = 0;
    char name[kMaxSensorName] = "";
    char type[kMaxSensorType] = "hx711";
    bool enabled = false;
    std::uint32_t rate_hz = 80;
    std::size_t ring_buffer_samples = 1024;

    // HX711-specific fields. rate_gpio is optional; without it the module's
    // RATE pin must be strapped to the desired hardware rate.
    int dout_gpio = -1;
    int sck_gpio = -1;
    int rate_gpio = -1;
    char gain[kMaxGainName] = "A128";
};

struct SensorConfigList {
    std::size_t count = 0;
    std::size_t queue_capacity = 1024;
    SensorConfig items[kMaxSensors]{};
};

struct Sample {
    std::uint16_t sensor_id = 0;
    std::uint16_t flags = 0;
    std::uint32_t reserved = 0;
    std::uint64_t sequence = 0;
    std::int64_t timestamp_us = 0;
    std::int32_t raw_value = 0;
};

struct RingEntry {
    std::uint64_t sequence = 0;
    std::int64_t timestamp_us = 0;
    std::int32_t raw_value = 0;
};

}  // namespace app
