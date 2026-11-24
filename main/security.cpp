#include "security.hpp"
#include "system_state.hpp"
#include "storage.hpp"
#include "esp_random.h"
#include "mbedtls/base64.h"
#include <psa/crypto.h>
#include <algorithm>
#include <array>
#include <cstring>
#include <string>
#include <vector>

namespace openscale::security {
namespace {
constexpr uint32_t PBKDF2_ITERATIONS = 120000;
constexpr size_t SALT_BYTES = 16;
constexpr size_t DERIVED_BYTES = 32;

std::string base64_encode(const uint8_t *data, size_t length) {
    std::vector<unsigned char> output(((length + 2) / 3) * 4 + 8);
    size_t written = 0;
    if (mbedtls_base64_encode(output.data(), output.size(), &written, data, length) != 0) return {};
    return std::string(reinterpret_cast<char *>(output.data()), written);
}

bool base64_decode(const char *input, std::vector<uint8_t> &output) {
    if (!input) return false;
    const size_t len = std::strlen(input);
    output.resize(len + 4);
    size_t written = 0;
    if (mbedtls_base64_decode(output.data(), output.size(), &written,
                              reinterpret_cast<const unsigned char *>(input), len) != 0) return false;
    output.resize(written);
    return true;
}

bool constant_time_equal(const uint8_t *a, const uint8_t *b, size_t n) {
    uint8_t diff = 0;
    for (size_t i = 0; i < n; ++i) diff |= static_cast<uint8_t>(a[i] ^ b[i]);
    return diff == 0;
}

bool derive(const char *password, size_t password_len, const uint8_t *salt,
            size_t salt_len, uint32_t iterations, uint8_t *output) {
    // ESP-IDF 6 uses Mbed TLS 4 / PSA Crypto for cryptographic primitives.
    if (psa_crypto_init() != PSA_SUCCESS) return false;

    psa_key_derivation_operation_t operation = PSA_KEY_DERIVATION_OPERATION_INIT;
    psa_status_t status = psa_key_derivation_setup(
        &operation, PSA_ALG_PBKDF2_HMAC(PSA_ALG_SHA_256));
    if (status != PSA_SUCCESS) return false;

    status = psa_key_derivation_input_integer(
        &operation, PSA_KEY_DERIVATION_INPUT_COST, iterations);
    if (status == PSA_SUCCESS) {
        status = psa_key_derivation_input_bytes(
            &operation, PSA_KEY_DERIVATION_INPUT_SALT, salt, salt_len);
    }
    if (status == PSA_SUCCESS) {
        status = psa_key_derivation_input_bytes(
            &operation, PSA_KEY_DERIVATION_INPUT_PASSWORD,
            reinterpret_cast<const uint8_t *>(password), password_len);
    }
    if (status == PSA_SUCCESS) {
        status = psa_key_derivation_output_bytes(&operation, output, DERIVED_BYTES);
    }

    // Always release the operation after setup, including failed input/output steps.
    const psa_status_t cleanup_status = psa_key_derivation_abort(&operation);
    return status == PSA_SUCCESS && cleanup_status == PSA_SUCCESS;
}

cJSON *read_settings() {
    std::vector<uint8_t> bytes;
    if (storage::read_file("/data/settings/settings.json", bytes, 32768) != ESP_OK) return nullptr;
    return cJSON_ParseWithLength(reinterpret_cast<const char *>(bytes.data()), bytes.size());
}

bool verify_password(const char *password, size_t password_len) {
    cJSON *root = read_settings();
    if (!root) return false;
    const cJSON *webserver = cJSON_GetObjectItemCaseSensitive(root, "webserver");
    const cJSON *security = cJSON_GetObjectItemCaseSensitive(webserver, "security");
    const cJSON *verifier = cJSON_GetObjectItemCaseSensitive(security, "passwordVerifier");
    const cJSON *salt_json = cJSON_GetObjectItemCaseSensitive(verifier, "salt");
    const cJSON *hash_json = cJSON_GetObjectItemCaseSensitive(verifier, "verifier");
    const cJSON *iterations_json = cJSON_GetObjectItemCaseSensitive(verifier, "iterations");
    std::vector<uint8_t> salt, expected;
    bool ok = cJSON_IsString(salt_json) && cJSON_IsString(hash_json) &&
              cJSON_IsNumber(iterations_json) && iterations_json->valuedouble == PBKDF2_ITERATIONS &&
              base64_decode(salt_json->valuestring, salt) && base64_decode(hash_json->valuestring, expected) &&
              salt.size() == SALT_BYTES && expected.size() == DERIVED_BYTES;
    uint8_t actual[DERIVED_BYTES]{};
    if (ok) ok = derive(password, password_len, salt.data(), salt.size(),
                        static_cast<uint32_t>(iterations_json->valueint), actual);
    if (ok) ok = constant_time_equal(actual, expected.data(), DERIVED_BYTES);
    std::memset(actual, 0, sizeof(actual));
    cJSON_Delete(root);
    return ok;
}
}

bool password_is_set() {
    cJSON *root = read_settings();
    if (!root) return false;
    const cJSON *webserver = cJSON_GetObjectItemCaseSensitive(root, "webserver");
    const cJSON *security = cJSON_GetObjectItemCaseSensitive(webserver, "security");
    const cJSON *verifier = cJSON_GetObjectItemCaseSensitive(security, "passwordVerifier");
    const bool set = cJSON_IsObject(verifier);
    cJSON_Delete(root);
    return set;
}

bool verify_http_basic(httpd_req_t *req) {
    const size_t length = httpd_req_get_hdr_value_len(req, "Authorization");
    if (!length || length > 512) return false;
    std::vector<char> header(length + 1, 0);
    if (httpd_req_get_hdr_value_str(req, "Authorization", header.data(), header.size()) != ESP_OK) return false;
    if (std::strncmp(header.data(), "Basic ", 6) != 0) return false;
    std::vector<uint8_t> decoded;
    if (!base64_decode(header.data() + 6, decoded) || decoded.empty()) return false;
    const auto separator = std::find(decoded.begin(), decoded.end(), static_cast<uint8_t>(':'));
    if (separator == decoded.end()) return false;
    const size_t password_offset = static_cast<size_t>(separator - decoded.begin()) + 1;
    const size_t password_len = decoded.size() - password_offset;
    const bool result = verify_password(reinterpret_cast<const char *>(decoded.data() + password_offset), password_len);
    std::fill(decoded.begin(), decoded.end(), 0);
    return result;
}

bool check_csrf(httpd_req_t *req) {
    const size_t length = httpd_req_get_hdr_value_len(req, "X-CSRF-Token");
    if (!length || length >= 80) return false;
    char token[80]{};
    if (httpd_req_get_hdr_value_str(req, "X-CSRF-Token", token, sizeof(token)) != ESP_OK) return false;
    return std::strcmp(token, csrf_token()) == 0;
}

bool set_password_verifier(cJSON *settings_root, const char *password) {
    if (!cJSON_IsObject(settings_root)) return false;
    cJSON *webserver = cJSON_GetObjectItemCaseSensitive(settings_root, "webserver");
    if (!cJSON_IsObject(webserver)) {
        webserver = cJSON_CreateObject();
        if (!webserver) return false;
        cJSON_AddItemToObject(settings_root, "webserver", webserver);
    }
    cJSON *security = cJSON_GetObjectItemCaseSensitive(webserver, "security");
    if (!cJSON_IsObject(security)) {
        security = cJSON_CreateObject();
        if (!security) return false;
        cJSON_AddItemToObject(webserver, "security", security);
    }
    cJSON_DeleteItemFromObjectCaseSensitive(security, "password");
    cJSON_DeleteItemFromObjectCaseSensitive(security, "passwordSet");
    cJSON_DeleteItemFromObjectCaseSensitive(security, "passwordVerifier");
    if (!password) return true;
    const size_t password_len = std::strlen(password);
    if (password_len < 8 || password_len > 128) return false;
    uint8_t salt[SALT_BYTES]{};
    uint8_t derived[DERIVED_BYTES]{};
    esp_fill_random(salt, sizeof(salt));
    if (!derive(password, password_len, salt, sizeof(salt), PBKDF2_ITERATIONS, derived)) return false;
    const std::string salt_b64 = base64_encode(salt, sizeof(salt));
    const std::string hash_b64 = base64_encode(derived, sizeof(derived));
    std::memset(derived, 0, sizeof(derived));
    cJSON *verifier = cJSON_CreateObject();
    cJSON_AddStringToObject(verifier, "algorithm", "PBKDF2-HMAC-SHA256");
    cJSON_AddStringToObject(verifier, "salt", salt_b64.c_str());
    cJSON_AddNumberToObject(verifier, "iterations", PBKDF2_ITERATIONS);
    cJSON_AddStringToObject(verifier, "verifier", hash_b64.c_str());
    cJSON_AddItemToObject(security, "passwordVerifier", verifier);
    return true;
}

void redact_settings(cJSON *root) {
    cJSON *webserver = cJSON_GetObjectItemCaseSensitive(root, "webserver");
    if (!cJSON_IsObject(webserver)) {
        webserver = cJSON_CreateObject();
        cJSON_AddItemToObject(root, "webserver", webserver);
    }
    cJSON *security = cJSON_GetObjectItemCaseSensitive(webserver, "security");
    if (!cJSON_IsObject(security)) {
        security = cJSON_CreateObject();
        cJSON_AddItemToObject(webserver, "security", security);
    }
    const cJSON *verifier = cJSON_GetObjectItemCaseSensitive(security, "passwordVerifier");
    const bool has_password = cJSON_IsObject(verifier);
    cJSON_DeleteItemFromObjectCaseSensitive(security, "password");
    cJSON_DeleteItemFromObjectCaseSensitive(security, "passwordVerifier");
    cJSON_DeleteItemFromObjectCaseSensitive(security, "passwordSet");
    cJSON_AddBoolToObject(security, "passwordSet", has_password);
}

void redact_wifi(cJSON *root) {
    cJSON *networks = cJSON_GetObjectItemCaseSensitive(root, "networks");
    if (cJSON_IsArray(networks)) {
        const int count = cJSON_GetArraySize(networks);
        for (int i = 0; i < count; ++i) {
            cJSON *entry = cJSON_GetArrayItem(networks, i);
            const cJSON *password = cJSON_GetObjectItemCaseSensitive(entry, "password");
            const bool password_set = cJSON_IsString(password) && password->valuestring[0];
            cJSON_DeleteItemFromObjectCaseSensitive(entry, "password");
            cJSON_DeleteItemFromObjectCaseSensitive(entry, "passwordSet");
            cJSON_AddBoolToObject(entry, "passwordSet", password_set);
        }
    }
    cJSON *ap = cJSON_GetObjectItemCaseSensitive(root, "ap");
    if (cJSON_IsObject(ap)) {
        const cJSON *password = cJSON_GetObjectItemCaseSensitive(ap, "password");
        const cJSON *enabled = cJSON_GetObjectItemCaseSensitive(ap, "enabled");
        const bool password_set = password ? (cJSON_IsString(password) && password->valuestring[0]) : cJSON_IsTrue(enabled);
        cJSON_DeleteItemFromObjectCaseSensitive(ap, "password");
        cJSON_DeleteItemFromObjectCaseSensitive(ap, "passwordSet");
        cJSON_AddBoolToObject(ap, "passwordSet", password_set);
    }
}
}
