#pragma once
#include "esp_err.h"
#include <cstdint>
namespace openscale {
struct WifiRuntimeStatus { bool connected; bool rssi_valid; int rssi; char ip[16]; uint32_t clients_connected; };
esp_err_t wifi_manager_start();
WifiRuntimeStatus wifi_manager_status();
}
