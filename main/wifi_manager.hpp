#pragma once

#include "app_types.hpp"
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "esp_netif.h"
#include "esp_event.h"
#include <cstdint>

namespace app {

class WifiManager {
public:
    esp_err_t start(const Settings& settings, const WifiConfig& wifi);
    bool is_station_connected() const { return station_connected_; }
    bool is_access_point_active() const { return access_point_active_; }

private:
    static void event_handler(void* argument, esp_event_base_t event_base,
                              std::int32_t event_id, void* event_data);
    void on_event(esp_event_base_t event_base, std::int32_t event_id, void* event_data);
    esp_err_t start_access_point(const WifiConfig& wifi);

    EventGroupHandle_t event_group_ = nullptr;
    esp_netif_t* sta_netif_ = nullptr;
    esp_netif_t* ap_netif_ = nullptr;
    int retry_count_ = 0;
    bool station_connected_ = false;
    bool access_point_active_ = false;
};

}  // namespace app
