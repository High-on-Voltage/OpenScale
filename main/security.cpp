#include "security.hpp"

#include <cstdio>
#include <cstring>

#include "esp_random.h"
#include "mbedtls/md.h"
#include "mbedtls/pkcs5.h"

namespace app::security {
namespace {
constexpr std::size_t kSaltBytes = 16;
constexpr std::size_t kHashBytes = 32;
constexpr std::uint32_t kIterations = 100000;

bool hex_encode(const unsigned char* input, std::size_t length, char* output, std::size_t output_size) {
    if (output_size < (length * 2U + 1U)) return false;
    static constexpr char kHex[] = "0123456789abcdef";
    for (std::size_t i = 0; i < length; ++i) {
        output[i * 2U] = kHex[(input[i] >> 4U) & 0x0fU];
        output[i * 2U + 1U] = kHex[input[i] & 0x0fU];
    }
    output[length * 2U] = '\0';
    return true;
}

int hex_value(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

bool hex_decode(const char* input, unsigned char* output, std::size_t output_length) {
    if (input == nullptr || std::strlen(input) != output_length * 2U) return false;
    for (std::size_t i = 0; i < output_length; ++i) {
        const int high = hex_value(input[i * 2U]);
        const int low = hex_value(input[i * 2U + 1U]);
        if (high < 0 || low < 0) return false;
        output[i] = static_cast<unsigned char>((high << 4) | low);
    }
    return true;
}

bool derive(const char* password, const unsigned char* salt, std::size_t salt_length,
            std::uint32_t iterations, unsigned char* output, std::size_t output_length) {
    const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    if (info == nullptr) return false;

    mbedtls_md_context_t context;
    mbedtls_md_init(&context);
    int rc = mbedtls_md_setup(&context, info, 1);
    if (rc == 0) {
        rc = mbedtls_pkcs5_pbkdf2_hmac(
            &context,
            reinterpret_cast<const unsigned char*>(password), std::strlen(password),
            salt, salt_length, iterations, static_cast<std::uint32_t>(output_length), output);
    }
    mbedtls_md_free(&context);
    return rc == 0;
}

bool constant_time_equal(const unsigned char* a, const unsigned char* b, std::size_t length) {
    unsigned char difference = 0;
    for (std::size_t i = 0; i < length; ++i) difference |= static_cast<unsigned char>(a[i] ^ b[i]);
    return difference == 0;
}
}  // namespace

esp_err_t set_admin_password(Settings& settings, const char* password) {
    if (password == nullptr || std::strlen(password) < 8U || std::strlen(password) > 128U) {
        return ESP_ERR_INVALID_ARG;
    }

    unsigned char salt[kSaltBytes]{};
    unsigned char hash[kHashBytes]{};
    esp_fill_random(salt, sizeof(salt));
    if (!derive(password, salt, sizeof(salt), kIterations, hash, sizeof(hash))) {
        return ESP_FAIL;
    }

    if (!hex_encode(salt, sizeof(salt), settings.admin_salt_hex, sizeof(settings.admin_salt_hex)) ||
        !hex_encode(hash, sizeof(hash), settings.admin_hash_hex, sizeof(settings.admin_hash_hex))) {
        return ESP_ERR_INVALID_SIZE;
    }
    settings.pbkdf2_iterations = kIterations;
    return ESP_OK;
}

bool verify_admin_password(const Settings& settings, const char* password) {
    if (password == nullptr || settings.admin_hash_hex[0] == '\0' || settings.admin_salt_hex[0] == '\0') {
        return false;
    }

    unsigned char salt[kSaltBytes]{};
    unsigned char expected[kHashBytes]{};
    unsigned char actual[kHashBytes]{};
    if (!hex_decode(settings.admin_salt_hex, salt, sizeof(salt)) ||
        !hex_decode(settings.admin_hash_hex, expected, sizeof(expected))) {
        return false;
    }

    const std::uint32_t iterations = settings.pbkdf2_iterations < 10000U
        ? 10000U : settings.pbkdf2_iterations;
    if (!derive(password, salt, sizeof(salt), iterations, actual, sizeof(actual))) return false;
    return constant_time_equal(expected, actual, sizeof(actual));
}

}  // namespace app::security
