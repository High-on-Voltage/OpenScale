#pragma once

#include "app_types.hpp"
#include "esp_err.h"

namespace app {

esp_err_t start_serial_console(Settings* settings);

}  // namespace app
