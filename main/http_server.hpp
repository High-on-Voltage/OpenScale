#pragma once

#include "app_types.hpp"
#include "esp_err.h"

namespace app {
class SensorManager;

esp_err_t start_http_server(const Settings& settings, SensorManager* sensors);

}  // namespace app
