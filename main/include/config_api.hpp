#pragma once
#include "esp_http_server.h"
namespace openscale {
esp_err_t config_resource_handler(httpd_req_t *req);
esp_err_t calibration_resource_handler(httpd_req_t *req);
esp_err_t static_mutation_handler(httpd_req_t *req);
esp_err_t restart_handler(httpd_req_t *req);
}
