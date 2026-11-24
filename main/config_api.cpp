#include "config_api.hpp"
#include "build_info.h"
#include "webui_build_info.h"
#include "device_log.hpp"
#include "event_bus.hpp"
#include "factory_defaults.hpp"
#include "security.hpp"
#include "storage.hpp"
#include "system_state.hpp"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "cJSON.h"
#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <cmath>
#include <limits>
#include <string>
#include <vector>

namespace openscale {
namespace {
constexpr char TAG[] = "config_api";

std::string request_path(httpd_req_t *req) {
    const char *uri = req->uri;
    const char *query = std::strchr(uri, '?');
    return std::string(uri, query ? static_cast<size_t>(query - uri) : std::strlen(uri));
}

bool json_integer(const cJSON *value, int minimum, int maximum) {
    return cJSON_IsNumber(value) && std::isfinite(value->valuedouble) &&
           std::floor(value->valuedouble) == value->valuedouble &&
           value->valuedouble >= minimum && value->valuedouble <= maximum;
}

std::string json_escape(const char *value) {
    std::string escaped;
    const char *input = value ? value : "";
    escaped.reserve(std::strlen(input) + 8);
    static constexpr char HEX[] = "0123456789abcdef";
    for (const unsigned char *p = reinterpret_cast<const unsigned char *>(input); *p; ++p) {
        switch (*p) {
            case '"': escaped += "\\\""; break;
            case '\\': escaped += "\\\\"; break;
            case '\b': escaped += "\\b"; break;
            case '\f': escaped += "\\f"; break;
            case '\n': escaped += "\\n"; break;
            case '\r': escaped += "\\r"; break;
            case '\t': escaped += "\\t"; break;
            default:
                if (*p < 0x20) {
                    escaped += "\\u00";
                    escaped += HEX[*p >> 4];
                    escaped += HEX[*p & 0x0f];
                } else {
                    escaped += static_cast<char>(*p);
                }
        }
    }
    return escaped;
}

void replace_marker(std::string &text, const char *marker, const std::string &value) {
    const size_t position = text.find(marker);
    if (position != std::string::npos) text.replace(position, std::strlen(marker), value);
}

esp_err_t send_error(httpd_req_t *req, int status, const char *code, const char *message) {
    // Keep the response shape static; escape only the values inserted into it.
    std::string body = R"json({"error":{"code":"__CODE__","message":"__MESSAGE__"}})json";
    replace_marker(body, "__CODE__", json_escape(code ? code : "internal_error"));
    replace_marker(body, "__MESSAGE__", json_escape(message ? message : "Unexpected error"));
    const char *http_status = "400 Bad Request";
    switch (status) {
        case 401: http_status = "401 Unauthorized"; break;
        case 403: http_status = "403 Forbidden"; break;
        case 404: http_status = "404 Not Found"; break;
        case 405: http_status = "405 Method Not Allowed"; break;
        case 413: http_status = "413 Payload Too Large"; break;
        case 500: http_status = "500 Internal Server Error"; break;
        case 507: http_status = "507 Insufficient Storage"; break;
        default: break;
    }
    httpd_resp_set_status(req, http_status);
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, body.c_str(), body.size());
}

bool check_auth(httpd_req_t *req) {
    if (!security::password_is_set() || security::verify_http_basic(req)) return true;
    return false;
}

bool check_mutation(httpd_req_t *req) {
    if (!check_auth(req)) { send_error(req, 401, "authentication_required", "Administrator credentials required"); return false; }
    if (!security::check_csrf(req)) { send_error(req, 403, "csrf_invalid", "Missing or invalid X-CSRF-Token"); return false; }
    return true;
}

bool read_request_body(httpd_req_t *req, std::vector<uint8_t> &body, size_t maximum) {
    if (req->content_len > maximum) { (void)send_error(req, 413, "request_too_large", "Request body exceeds maxUploadBytes"); return false; }
    body.resize(req->content_len);
    size_t received = 0;
    while (received < body.size()) {
        const int amount = httpd_req_recv(req, reinterpret_cast<char *>(body.data() + received), body.size() - received);
        if (amount <= 0) { body.clear(); (void)send_error(req, 400, "incomplete_body", "Could not read complete request body"); return false; }
        received += static_cast<size_t>(amount);
    }
    return true;
}

std::string json_string(cJSON *json) {
    char *printed = cJSON_Print(json);
    std::string result = printed ? printed : "{}";
    if (printed) cJSON_free(printed);
    return result;
}

bool save_json(const std::string &path, cJSON *root) {
    const std::string text = json_string(root);
    return storage::write_file_atomic(path, reinterpret_cast<const uint8_t *>(text.data()), text.size()) == ESP_OK;
}

cJSON *parse_file(const std::string &path) {
    std::vector<uint8_t> data;
    if (storage::read_file(path, data, OPEN_SCALE_MAX_UPLOAD_BYTES) != ESP_OK || data.empty()) return nullptr;
    return cJSON_ParseWithLength(reinterpret_cast<const char *>(data.data()), data.size());
}

bool auth_for_config_get(const std::string &name) {
    return name == "settings.json" || name == "wifi.json";
}

bool validate_document(const std::string &name, cJSON *root, std::string &why) {
    if (!cJSON_IsObject(root)) { why = "top-level JSON value must be an object"; return false; }
    const cJSON *schema = cJSON_GetObjectItemCaseSensitive(root, "schemaVersion");
    if (!json_integer(schema, 1, 1)) { why = "schemaVersion must equal 1"; return false; }
    if (name == "sensors.json") {
        const cJSON *sensors = cJSON_GetObjectItemCaseSensitive(root, "sensors");
        if (!cJSON_IsArray(sensors)) { why = "sensors must be an array"; return false; }
        std::vector<int> ids;
        for (int i = 0; i < cJSON_GetArraySize(sensors); ++i) {
            const cJSON *sensor = cJSON_GetArrayItem(sensors, i);
            const cJSON *id = cJSON_GetObjectItemCaseSensitive(sensor, "id");
            const cJSON *type = cJSON_GetObjectItemCaseSensitive(sensor, "type");
            const cJSON *enabled = cJSON_GetObjectItemCaseSensitive(sensor, "enabled");
            const cJSON *rate = cJSON_GetObjectItemCaseSensitive(sensor, "rate_hz");
            const cJSON *capacity = cJSON_GetObjectItemCaseSensitive(sensor, "ringbuffer_size_samples");
            const cJSON *raw = cJSON_GetObjectItemCaseSensitive(sensor, "rawFormat");
            if (!json_integer(id, 0, 65535) || !cJSON_IsString(type) || !cJSON_IsBool(enabled) ||
                !json_integer(rate, 1, 1000000) || !json_integer(capacity, 1, 1000000) ||
                !cJSON_IsString(raw)) {
                why = "each sensor requires integer id, rate_hz and ringbuffer_size_samples, type, enabled and rawFormat"; return false;
            }
            if (std::find(ids.begin(), ids.end(), id->valueint) != ids.end()) { why = "sensor IDs must be unique"; return false; }
            ids.push_back(id->valueint);
            if (std::strcmp(type->valuestring, "hx711") == 0) {
                const cJSON *hx = cJSON_GetObjectItemCaseSensitive(sensor, "hx711");
                if (!cJSON_IsObject(hx)) {
                    why = "HX711 sensor requires an hx711 driver object"; return false;
                }
                const cJSON *dout = cJSON_GetObjectItemCaseSensitive(hx, "dout_gpio");
                const cJSON *sck = cJSON_GetObjectItemCaseSensitive(hx, "sck_gpio");
                const cJSON *rate_gpio = cJSON_GetObjectItemCaseSensitive(hx, "rate_gpio");
                const cJSON *gain = cJSON_GetObjectItemCaseSensitive(hx, "gain");
                const bool gain_valid = !gain || cJSON_IsNull(gain) ||
                    (cJSON_IsString(gain) &&
                     (!std::strcmp(gain->valuestring, "A128") ||
                      !std::strcmp(gain->valuestring, "A64") ||
                      !std::strcmp(gain->valuestring, "B32")));
                if (std::strcmp(raw->valuestring, "int24") != 0 ||
                    !json_integer(dout, 0, 255) || !json_integer(sck, 0, 255) ||
                    (rate->valueint != 10 && rate->valueint != 80) ||
                    (rate_gpio && !cJSON_IsNull(rate_gpio) && !json_integer(rate_gpio, 0, 255)) ||
                    !gain_valid) {
                    why = "HX711 requires rawFormat int24, GPIO numbers, rate_hz 10 or 80 and a supported gain"; return false;
                }
            }
        }
    } else if (name == "units.json") {
        if (!cJSON_IsString(cJSON_GetObjectItemCaseSensitive(root, "baseUnit")) ||
            !cJSON_IsString(cJSON_GetObjectItemCaseSensitive(root, "defaultUnit")) ||
            !cJSON_IsArray(cJSON_GetObjectItemCaseSensitive(root, "units"))) {
            why = "units.json requires baseUnit, defaultUnit and units[]"; return false;
        }
    } else if (name == "wifi.json") {
        const cJSON *networks = cJSON_GetObjectItemCaseSensitive(root, "networks");
        const cJSON *ap = cJSON_GetObjectItemCaseSensitive(root, "ap");
        if (!cJSON_IsArray(networks) || !cJSON_IsObject(ap)) { why = "wifi.json requires networks[] and ap object"; return false; }
        const cJSON *ap_enabled = cJSON_GetObjectItemCaseSensitive(ap, "enabled");
        const cJSON *ap_prefix = cJSON_GetObjectItemCaseSensitive(ap, "ssidPrefix");
        const cJSON *ap_channel = cJSON_GetObjectItemCaseSensitive(ap, "channel");
        const cJSON *ap_max = cJSON_GetObjectItemCaseSensitive(ap, "maxStations");
        const cJSON *ap_keep = cJSON_GetObjectItemCaseSensitive(ap, "keepApWhenConnected");
        const cJSON *ap_password = cJSON_GetObjectItemCaseSensitive(ap, "password");
        if (!cJSON_IsBool(ap_enabled) || !cJSON_IsString(ap_prefix) || !ap_prefix->valuestring[0] ||
            std::strlen(ap_prefix->valuestring) > 25 || !json_integer(ap_max, 1, 10) || !cJSON_IsBool(ap_keep) ||
            (ap_channel && !cJSON_IsNull(ap_channel) && !json_integer(ap_channel, 1, 13))) {
            why = "AP requires enabled, ssidPrefix, maxStations, keepApWhenConnected and a valid channel"; return false;
        }
        if (ap_password && !cJSON_IsNull(ap_password) && (!cJSON_IsString(ap_password) || std::strlen(ap_password->valuestring) < 8 || std::strlen(ap_password->valuestring) > 63)) {
            why = "AP password must be 8 to 63 bytes or null"; return false;
        }
        std::vector<int> ids;
        for (int i = 0; i < cJSON_GetArraySize(networks); ++i) {
            const cJSON *entry = cJSON_GetArrayItem(networks, i);
            const cJSON *id = cJSON_GetObjectItemCaseSensitive(entry, "id");
            const cJSON *ssid = cJSON_GetObjectItemCaseSensitive(entry, "ssid");
            const cJSON *password = cJSON_GetObjectItemCaseSensitive(entry, "password");
            const cJSON *priority = cJSON_GetObjectItemCaseSensitive(entry, "priority");
            const cJSON *ip = cJSON_GetObjectItemCaseSensitive(entry, "ip");
            const cJSON *subnet = cJSON_GetObjectItemCaseSensitive(entry, "subnet");
            if (!cJSON_IsString(ssid) || !ssid->valuestring[0] || std::strlen(ssid->valuestring) > 32) { why = "each Wi-Fi network requires an ssid of 1 to 32 bytes"; return false; }
            if (id && !json_integer(id, 1, std::numeric_limits<int>::max() - 1)) { why = "Wi-Fi network IDs must be positive integers"; return false; }
            if (cJSON_IsNumber(id)) {
                if (std::find(ids.begin(), ids.end(), id->valueint) != ids.end()) { why = "Wi-Fi network IDs must be unique"; return false; }
                ids.push_back(id->valueint);
            }
            if (priority && !json_integer(priority, std::numeric_limits<int>::min(), std::numeric_limits<int>::max())) { why = "Wi-Fi priorities must be integers"; return false; }
            if (password && !cJSON_IsNull(password) &&
                (!cJSON_IsString(password) ||
                 (std::strlen(password->valuestring) != 0 &&
                  (std::strlen(password->valuestring) < 8 || std::strlen(password->valuestring) > 63)))) {
                why = "Wi-Fi passwords must be empty, 8 to 63 bytes, or null"; return false;
            }
            if ((ip && !cJSON_IsNull(ip) && !cJSON_IsString(ip)) || (subnet && !cJSON_IsNull(subnet) && !cJSON_IsString(subnet)) ||
                ((cJSON_IsString(ip) && ip->valuestring[0]) != (cJSON_IsString(subnet) && subnet->valuestring[0]))) {
                why = "static Wi-Fi ip and subnet must be supplied together as strings"; return false;
            }
        }
    } else if (name == "settings.json") {
        const cJSON *network = cJSON_GetObjectItemCaseSensitive(root, "network");
        const cJSON *webserver = cJSON_GetObjectItemCaseSensitive(root, "webserver");
        const cJSON *buffer = cJSON_GetObjectItemCaseSensitive(root, "buffer");
        const cJSON *hostname = cJSON_GetObjectItemCaseSensitive(network, "hostname");
        const cJSON *index = cJSON_GetObjectItemCaseSensitive(webserver, "http_indexpath");
        const cJSON *https = cJSON_GetObjectItemCaseSensitive(webserver, "https");
        const cJSON *enabled = cJSON_GetObjectItemCaseSensitive(https, "enabled");
        const cJSON *security_object = cJSON_GetObjectItemCaseSensitive(webserver, "security");
        const cJSON *budget = cJSON_GetObjectItemCaseSensitive(buffer, "ringbuffer_max_total_size_bytes");
        const cJSON *queue = cJSON_GetObjectItemCaseSensitive(buffer, "queue_capacity");
        if (!cJSON_IsObject(network) || !cJSON_IsString(hostname) || !cJSON_IsObject(webserver) ||
            !cJSON_IsString(index) || index->valuestring[0] != '/' || std::strstr(index->valuestring, "..") ||
            !cJSON_IsObject(https) || !cJSON_IsBool(enabled) || !cJSON_IsObject(security_object) ||
            !cJSON_IsObject(buffer) || !json_integer(budget, 1024, std::numeric_limits<int>::max()) ||
            !json_integer(queue, 1, 4096)) {
            why = "settings.json requires network.hostname, webserver index/https/security and valid buffer settings"; return false;
        }
        if (cJSON_IsTrue(enabled)) { why = "HTTPS is deferred and cannot be enabled"; return false; }
    }
    return true;
}

bool preserve_settings_password(cJSON *incoming) {
    cJSON *webserver = cJSON_GetObjectItemCaseSensitive(incoming, "webserver");
    if (!cJSON_IsObject(webserver)) {
        webserver = cJSON_CreateObject();
        if (!webserver) return false;
        cJSON_AddItemToObject(incoming, "webserver", webserver);
    }
    cJSON *security = cJSON_GetObjectItemCaseSensitive(webserver, "security");
    if (!cJSON_IsObject(security)) {
        security = cJSON_CreateObject();
        if (!security) return false;
        cJSON_AddItemToObject(webserver, "security", security);
    }
    const cJSON *password = cJSON_GetObjectItemCaseSensitive(security, "password");
    const bool has_password_field = password != nullptr;
    if (has_password_field && !cJSON_IsNull(password) && !cJSON_IsString(password)) return false;
    if (cJSON_IsString(password)) {
        const size_t length = std::strlen(password->valuestring);
        if (length < 8 || length > 128) return false;
    }
    const std::string new_password = cJSON_IsString(password) ? password->valuestring : "";
    const bool remove_password = cJSON_IsNull(password);

    cJSON *existing = parse_file("/data/settings/settings.json");
    const cJSON *old_webserver = cJSON_GetObjectItemCaseSensitive(existing, "webserver");
    const cJSON *old_security = cJSON_GetObjectItemCaseSensitive(old_webserver, "security");
    const cJSON *old_verifier = cJSON_GetObjectItemCaseSensitive(old_security, "passwordVerifier");
    cJSON_DeleteItemFromObjectCaseSensitive(security, "password");
    cJSON_DeleteItemFromObjectCaseSensitive(security, "passwordSet");
    cJSON_DeleteItemFromObjectCaseSensitive(security, "passwordVerifier");
    bool ok = true;
    if (has_password_field) {
        if (!remove_password) ok = security::set_password_verifier(incoming, new_password.c_str());
    } else if (cJSON_IsObject(old_verifier)) {
        cJSON *copy = cJSON_Duplicate(old_verifier, 1);
        ok = copy && cJSON_AddItemToObject(security, "passwordVerifier", copy);
    }
    cJSON_Delete(existing);
    return ok;
}

void preserve_wifi_passwords(cJSON *incoming) {
    cJSON *new_networks = cJSON_GetObjectItemCaseSensitive(incoming, "networks");
    cJSON *old = parse_file("/data/settings/wifi.json");
    const cJSON *old_networks = cJSON_GetObjectItemCaseSensitive(old, "networks");
    int next_id = 1;
    for (int i = 0; i < cJSON_GetArraySize(old_networks); ++i) {
        const cJSON *id = cJSON_GetObjectItemCaseSensitive(cJSON_GetArrayItem(old_networks, i), "id");
        if (cJSON_IsNumber(id)) next_id = std::max(next_id, id->valueint + 1);
    }
    for (int i = 0; i < cJSON_GetArraySize(new_networks); ++i) {
        const cJSON *id = cJSON_GetObjectItemCaseSensitive(cJSON_GetArrayItem(new_networks, i), "id");
        if (cJSON_IsNumber(id)) next_id = std::max(next_id, id->valueint + 1);
    }
    for (int i = 0; i < cJSON_GetArraySize(new_networks); ++i) {
        cJSON *network = cJSON_GetArrayItem(new_networks, i);
        cJSON *id = cJSON_GetObjectItemCaseSensitive(network, "id");
        if (!cJSON_IsNumber(id)) {
            cJSON_AddNumberToObject(network, "id", next_id++);
            id = cJSON_GetObjectItemCaseSensitive(network, "id");
        }
        cJSON *password = cJSON_GetObjectItemCaseSensitive(network, "password");
        if (!password) {
            for (int j = 0; j < cJSON_GetArraySize(old_networks); ++j) {
                const cJSON *old_network = cJSON_GetArrayItem(old_networks, j);
                const cJSON *old_id = cJSON_GetObjectItemCaseSensitive(old_network, "id");
                const cJSON *old_password = cJSON_GetObjectItemCaseSensitive(old_network, "password");
                if (cJSON_IsNumber(old_id) && old_id->valueint == id->valueint && cJSON_IsString(old_password)) {
                    cJSON_AddStringToObject(network, "password", old_password->valuestring);
                    break;
                }
            }
        } else if (cJSON_IsNull(password)) {
            cJSON_DeleteItemFromObjectCaseSensitive(network, "password");
        }
        cJSON_DeleteItemFromObjectCaseSensitive(network, "passwordSet");
    }
    cJSON *new_ap = cJSON_GetObjectItemCaseSensitive(incoming, "ap");
    const cJSON *old_ap = cJSON_GetObjectItemCaseSensitive(old, "ap");
    if (cJSON_IsObject(new_ap)) {
        const cJSON *password = cJSON_GetObjectItemCaseSensitive(new_ap, "password");
        if (!password) {
            const cJSON *old_password = cJSON_GetObjectItemCaseSensitive(old_ap, "password");
            if (cJSON_IsString(old_password)) cJSON_AddStringToObject(new_ap, "password", old_password->valuestring);
            else if (cJSON_IsNull(old_password)) cJSON_AddNullToObject(new_ap, "password");
        }
        cJSON_DeleteItemFromObjectCaseSensitive(new_ap, "passwordSet");
    }
    cJSON_Delete(old);
}

std::string resource_name(const std::string &path) {
    constexpr char prefix[] = "/data/settings/";
    if (path.rfind(prefix, 0) != 0) return {};
    const std::string name = path.substr(sizeof(prefix) - 1);
    if (name.find('/') != std::string::npos) return {};
    if (name == "settings.json" || name == "wifi.json" || name == "sensors.json" ||
        name == "units.json" || name == "webui-settings.json") return name;
    return {};
}

bool calibration_name_valid(const std::string &path) {
    constexpr char prefix[] = "/data/calibration/calibration_";
    if (path.rfind(prefix, 0) != 0 || path.size() > 180) return false;
    const std::string filename = path.substr(sizeof(prefix) - 1);
    if (filename.size() < 8 || filename.substr(filename.size() - 5) != ".json") return false;
    const size_t split = filename.find('_');
    if (split == std::string::npos || split == 0 || split == filename.size() - 6) return false;
    for (char c : filename.substr(0, split)) if (!std::isdigit(static_cast<unsigned char>(c))) return false;
    const std::string profile = filename.substr(split + 1, filename.size() - split - 6);
    for (char c : profile) if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '.' || c == '_' || c == '-')) return false;
    return true;
}

bool is_gzip(const std::vector<uint8_t> &body) { return body.size() >= 2 && body[0] == 0x1f && body[1] == 0x8b; }

esp_err_t write_result(httpd_req_t *req, const char *status, const char *saved_path = nullptr) {
    std::string body = R"json({"status":"__STATUS__","saved":true,"errors":[],"warnings":[],"pendingChanges":__PENDING__})json";
    replace_marker(body, "__STATUS__", json_escape(status ? status : "applied"));
    replace_marker(body, "__PENDING__", saved_path
        ? (std::string("[\"") + json_escape(saved_path) + "\"]")
        : "[]");
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, body.c_str(), body.size());
}

esp_err_t write_wifi_result(httpd_req_t *req, const cJSON *canonical) {
    cJSON *redacted = cJSON_Duplicate(canonical, 1);
    if (!redacted) return send_error(req, 500, "serialization_failed", "Could not prepare canonical Wi-Fi configuration");
    security::redact_wifi(redacted);
    const std::string config = json_string(redacted);
    cJSON_Delete(redacted);
    std::string body = R"json({"status":"needs-restart","saved":true,"errors":[],"warnings":[],"pendingChanges":["wifi.json"],"configuration":__CONFIG__})json";
    replace_marker(body, "__CONFIG__", config);
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, body.c_str(), body.size());
}

void restart_task(void *) { vTaskDelay(pdMS_TO_TICKS(500)); esp_restart(); }
}

esp_err_t config_resource_handler(httpd_req_t *req) {
    const std::string name = resource_name(request_path(req));
    if (name.empty()) return send_error(req, 404, "not_found", "Unknown settings resource");
    const std::string path = "/data/settings/" + name;
    if (req->method == HTTP_GET) {
        if (auth_for_config_get(name) && security::password_is_set() && !security::verify_http_basic(req))
            return send_error(req, 401, "authentication_required", "Administrator credentials required");
        cJSON *root = parse_file(path);
        if (!root) {
            const char *defaults = factory_defaults::get(name.c_str());
            root = defaults ? cJSON_Parse(defaults) : nullptr;
        }
        if (!root) return send_error(req, 500, "config_unavailable", "Could not load configuration resource");
        if (name == "settings.json") security::redact_settings(root);
        if (name == "wifi.json") security::redact_wifi(root);
        const std::string body = json_string(root);
        cJSON_Delete(root);
        httpd_resp_set_type(req, "application/json");
        httpd_resp_set_hdr(req, "Cache-Control", "no-store");
        return httpd_resp_send(req, body.c_str(), body.size());
    }
    if (!check_mutation(req)) return ESP_OK;
    if (req->method == HTTP_DELETE) {
        const char *default_text = factory_defaults::get(name.c_str());
        if (!default_text) return send_error(req, 500, "factory_default_unavailable", "Factory default is not embedded");
        cJSON *defaults = cJSON_Parse(default_text);
        if (!defaults || !save_json(path, defaults)) { cJSON_Delete(defaults); return send_error(req, 507, "storage_failed", "Could not restore factory defaults"); }
        cJSON_Delete(defaults);
        if (name == "settings.json" || name == "wifi.json" || name == "sensors.json") {
            pending_change_add(name.c_str());
            return write_result(req, "needs-restart", name.c_str());
        }
        return write_result(req, "applied");
    }
    char content_type[64]{};
    if (httpd_req_get_hdr_value_str(req, "Content-Type", content_type, sizeof(content_type)) != ESP_OK ||
        std::strncmp(content_type, "application/json", 16) != 0)
        return send_error(req, 400, "content_type_required", "Configuration writes require Content-Type: application/json");
    std::vector<uint8_t> body;
    if (!read_request_body(req, body, OPEN_SCALE_MAX_UPLOAD_BYTES)) return ESP_OK;
    cJSON *incoming = cJSON_ParseWithLength(reinterpret_cast<const char *>(body.data()), body.size());
    if (!incoming) return send_error(req, 400, "malformed_json", "Request body is not valid JSON");
    std::string why;
    if (!validate_document(name, incoming, why)) {
        cJSON_Delete(incoming);
        return send_error(req, 400, "validation_failed", why.c_str());
    }
    if (name == "settings.json" && !preserve_settings_password(incoming)) {
        cJSON_Delete(incoming);
        return send_error(req, 400, "password_invalid", "security.password must be a string of 8 to 128 bytes or null");
    }
    if (name == "wifi.json") preserve_wifi_passwords(incoming);
    if (!save_json(path, incoming)) { cJSON_Delete(incoming); return send_error(req, 507, "storage_failed", "Could not store configuration"); }
    if (name == "wifi.json") {
        pending_change_add(name.c_str());
        const esp_err_t result = write_wifi_result(req, incoming);
        cJSON_Delete(incoming);
        return result;
    }
    cJSON_Delete(incoming);
    if (name == "sensors.json" || name == "settings.json") pending_change_add(name.c_str());
    if (name == "sensors.json") return write_result(req, "needs-restart", "sensors.json");
    if (name == "settings.json") return write_result(req, "needs-restart", "settings.json");
    return write_result(req, "applied");
}

esp_err_t calibration_resource_handler(httpd_req_t *req) {
    const std::string path = request_path(req);
    if (!calibration_name_valid(path)) return send_error(req, 404, "not_found", "Invalid calibration resource path");
    if (req->method == HTTP_GET) {
        std::vector<uint8_t> body;
        if (storage::read_file(path, body, OPEN_SCALE_MAX_UPLOAD_BYTES) != ESP_OK)
            return send_error(req, 404, "not_found", "Calibration profile not found");
        httpd_resp_set_type(req, "application/json");
        httpd_resp_set_hdr(req, "Content-Encoding", "gzip");
        return httpd_resp_send(req, reinterpret_cast<const char *>(body.data()), body.size());
    }
    if (!check_mutation(req)) return ESP_OK;
    if (req->method == HTTP_DELETE) {
        if (storage::remove_file(path) != ESP_OK) return send_error(req, 404, "not_found", "Calibration profile not found");
        return write_result(req, "applied");
    }
    char encoding[32]{};
    char content_type[64]{};
    if (httpd_req_get_hdr_value_str(req, "Content-Encoding", encoding, sizeof(encoding)) != ESP_OK || std::strcmp(encoding, "gzip") != 0)
        return send_error(req, 400, "gzip_required", "Calibration uploads require Content-Encoding: gzip");
    if (httpd_req_get_hdr_value_str(req, "Content-Type", content_type, sizeof(content_type)) != ESP_OK || std::strncmp(content_type, "application/json", 16) != 0)
        return send_error(req, 400, "content_type_required", "Calibration uploads require Content-Type: application/json");
    std::vector<uint8_t> body;
    if (!read_request_body(req, body, OPEN_SCALE_MAX_UPLOAD_BYTES)) return ESP_OK;
    if (storage::write_file_atomic(path, body.data(), body.size()) != ESP_OK)
        return send_error(req, 507, "storage_failed", "Could not store calibration profile");
    return write_result(req, "applied");
}

esp_err_t static_mutation_handler(httpd_req_t *req) {
    const std::string path = request_path(req);
    if (path == "/" || path.rfind("/api", 0) == 0 || path.rfind("/data", 0) == 0 ||
        path.rfind("/default.", 0) == 0 || path.find("..") != std::string::npos ||
        path.find('%') != std::string::npos || path.find('\\') != std::string::npos)
        return send_error(req, 404, "reserved_path", "This path is reserved");
    if (!check_mutation(req)) return ESP_OK;
    if (req->method == HTTP_DELETE) {
        if (storage::remove_file(path) != ESP_OK) return send_error(req, 404, "not_found", "Asset not found");
        return write_result(req, "applied");
    }
    char encoding[32]{};
    if (httpd_req_get_hdr_value_str(req, "Content-Encoding", encoding, sizeof(encoding)) != ESP_OK || std::strcmp(encoding, "gzip") != 0)
        return send_error(req, 400, "gzip_required", "Static asset uploads require Content-Encoding: gzip");
    std::vector<uint8_t> body;
    if (!read_request_body(req, body, OPEN_SCALE_MAX_UPLOAD_BYTES)) return ESP_OK;
    if (!is_gzip(body)) return send_error(req, 400, "invalid_gzip", "Static asset body is not a gzip stream");
    if (storage::write_file_atomic(path, body.data(), body.size()) != ESP_OK)
        return send_error(req, 507, "storage_failed", "Could not store static asset");
    return write_result(req, "applied");
}

esp_err_t restart_handler(httpd_req_t *req) {
    if (!check_mutation(req)) return ESP_OK;
    char event[160]{};
    std::snprintf(event, sizeof(event), "{\"state\":\"restarting\",\"message\":\"Restart requested\",\"t\":%llu}", static_cast<unsigned long long>(esp_timer_get_time()));
    event_publish("device", event);
    httpd_resp_set_type(req, "application/json");
    const esp_err_t sent = httpd_resp_send(req, "{\"status\":\"restarting\"}", HTTPD_RESP_USE_STRLEN);
    (void)xTaskCreate(restart_task, "restart_device", 2048, nullptr, 5, nullptr);
    return sent;
}
}
