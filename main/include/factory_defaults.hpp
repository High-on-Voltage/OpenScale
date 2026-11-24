#pragma once

namespace openscale::factory_defaults {

// Returns a pointer to an immutable, NUL-terminated factory JSON document
// embedded in the application image, or nullptr for an unknown filename.
const char *get(const char *filename) noexcept;

} // namespace openscale::factory_defaults
