#pragma once

#include "app_types.hpp"

namespace app::security {

// Stores a PBKDF2-HMAC-SHA256 verifier and random 16-byte salt in Settings.
esp_err_t set_admin_password(Settings& settings, const char* password);

// Verify an HTTP Basic-auth password against the configured verifier.
bool verify_admin_password(const Settings& settings, const char* password);

}  // namespace app::security
