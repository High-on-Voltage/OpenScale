#pragma once

#include <cstddef>
#include <cstdint>

#include "app_types.hpp"
#include "esp_err.h"

namespace app::config_store {

esp_err_t init_filesystem();
bool load_settings(Settings& out, char* error, std::size_t error_size);
bool load_sensors(SensorConfigList& out, char* error, std::size_t error_size);
bool validate_settings_json(const char* json, std::size_t length, Settings* parsed,
                            char* error, std::size_t error_size);
bool validate_sensors_json(const char* json, std::size_t length, SensorConfigList* parsed,
                           char* error, std::size_t error_size);

bool save_settings_json(const char* json, std::size_t length);
bool save_settings_struct(const Settings& settings);
bool save_sensors_json(const char* json, std::size_t length);
bool save_webui_settings_json(const char* json, std::size_t length);

bool read_file(const char* absolute_path, char** data, std::size_t* length);
bool write_file_atomic(const char* absolute_path, const void* data, std::size_t length);

bool get_index_path(char* output, std::size_t output_size);
bool set_index_path(const char* web_path);
bool make_asset_storage_path(const char* web_path, char* output, std::size_t output_size);
bool ensure_asset_parent_directory(const char* web_path);
bool save_asset_gzip(const char* web_path, const void* data, std::size_t length);
bool delete_asset(const char* web_path);
bool rename_asset(const char* from_web_path, const char* to_web_path);
bool is_protected_default_asset(const char* web_path);
bool make_calibration_storage_path(const char* filename, char* output, std::size_t output_size);

}  // namespace app::config_store
