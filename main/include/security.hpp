#pragma once
#include "esp_http_server.h"
#include "cJSON.h"
namespace openscale::security {
bool password_is_set();
bool verify_http_basic(httpd_req_t *req);
bool check_csrf(httpd_req_t *req);
bool set_password_verifier(cJSON *settings_root, const char *password);
void redact_settings(cJSON *root);
void redact_wifi(cJSON *root);
}
