#pragma once

#include <cstddef>
#include <cstdint>

#include "esp_err.h"
#include "freertos/FreeRTOS.h"

namespace app {

constexpr std::size_t kMaxSensors = 16;
constexpr std::size_t kMaxWifiNetworks = 8;
constexpr std::size_t kMaxSensorName = 40;
constexpr std::size_t kMaxSensorType = 24;
constexpr std::size_t kMaxUnitName = 24;
constexpr std::size_t kMaxRawFormat = 16;
constexpr std::size_t kMaxGainName = 8;
constexpr std::size_t kMaxSsid = 32;
constexpr std::size_t kMaxWifiPassword = 64;
constexpr std::size_t kMaxHostname = 33;
constexpr std::size_t kMaxApPrefix = 24;
constexpr std::size_t kMaxSaltHex = 33;
constexpr std::size_t kMaxHashHex = 65;
constexpr std::size_t kMaxIndexPath = 128;
constexpr std::size_t kDefaultMaxUploadBytes = 524288;

struct Settings {
    // v0.5 settings.json fields.
    char hostname[kMaxHostname] = "";  // Generated from the base MAC on first successful setup.
    bool redirect_to_hostname = true;
    char http_indexpath[kMaxIndexPath] = "/default.html";
    std::size_t ringbuffer_max_total_size_bytes = 262144;
    std::size_t queue_capacity = 64;
    bool https_enabled = false;  // Rejected while TLS is not operational.

    // Internal verifier fields. Never returned by a GET API representation.
    char admin_salt_hex[kMaxSaltHex] = "";
    char admin_hash_hex[kMaxHashHex] = "";
    std::uint32_t pbkdf2_iterations = 100000;
};

struct WifiNetwork {
    std::uint16_t id = 0;
    char ssid[kMaxSsid + 1] = "";
    char password[kMaxWifiPassword + 1] = "";
    std::int32_t priority = 0;
};

struct WifiConfig {
    std::size_t network_count = 0;
    WifiNetwork networks[kMaxWifiNetworks]{};
    bool ap_enabled = true;
    char ap_ssid_prefix[kMaxApPrefix] = "OpenScale";
    std::uint8_t ap_channel = 1;
    std::uint8_t ap_max_stations = 4;
    bool keep_ap_when_connected = false;
    char ap_password[kMaxWifiPassword + 1] = "";
};

struct WarningThreshold {
    bool enabled = false;
    double threshold = 0.0;
    double hysteresis = 0.0;
};

struct SensorConfig {
    std::uint16_t id = 0;
    char name[kMaxSensorName] = "";
    char type[kMaxSensorType] = "hx711";
    char unit[kMaxUnitName] = "ADC count";
    char raw_format[kMaxRawFormat] = "int24";
    bool enabled = false;
    std::uint32_t rate_hz = 80;
    std::size_t ringbuffer_size_samples = 1024;
    WarningThreshold overload{};
    WarningThreshold underload{};

    // HX711-specific fields. rate_gpio is optional; without it the module's
    // RATE pin must be strapped to the desired hardware rate.
    int dout_gpio = -1;
    int sck_gpio = -1;
    int rate_gpio = -1;
    char gain[kMaxGainName] = "A128";
};

struct SensorConfigList {
    std::size_t count = 0;
    std::size_t queue_capacity = 64;  // Sourced from settings.json.buffer.queue_capacity.
    SensorConfig items[kMaxSensors]{};
};

struct Sample {
    std::uint16_t sensor_id = 0;
    std::uint16_t reserved = 0;
    std::uint32_t flags = 0;  // Computed when serializing API/history/live responses.
    std::uint64_t sequence = 0;
    std::uint64_t timestamp_us = 0;  // Monotonic microseconds since boot.
    std::uint64_t raw_value = 0;     // Native value bit pattern, zero-extended to uint64.
};

struct RingEntry {
    std::uint64_t sequence = 0;
    std::uint64_t timestamp_us = 0;
    std::uint64_t raw_value = 0;
};

}  // namespace app
