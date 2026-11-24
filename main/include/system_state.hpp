#pragma once
#include <string>
namespace openscale {
const char *boot_id();
const char *csrf_token();
void system_state_init();
void pending_change_add(const char *resource);
void pending_changes_clear();
std::string pending_changes_json();
}
