#pragma once
#include <cstddef>
#include <string>
#include <vector>
#include "esp_err.h"

namespace openscale::storage {
esp_err_t init();
bool ready();
esp_err_t read_file(const std::string &path, std::vector<uint8_t> &out, size_t max_bytes = 1024 * 1024);
esp_err_t write_file_atomic(const std::string &path, const uint8_t *data, size_t size);
esp_err_t remove_file(const std::string &path);
esp_err_t make_directories(const std::string &path);
std::string physical_path(const std::string &url_path);
}
