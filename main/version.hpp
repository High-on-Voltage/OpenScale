#pragma once

#ifndef APP_FIRMWARE_VERSION
#define APP_FIRMWARE_VERSION "0.2.0"
#endif
#ifndef APP_WEBUI_VERSION
#define APP_WEBUI_VERSION "0.17"
#endif
#ifndef APP_BUILD_ID
#define APP_BUILD_ID "local"
#endif
#ifndef APP_GIT_COMMIT
#define APP_GIT_COMMIT "unknown"
#endif

namespace app::version {
inline constexpr char firmware[] = APP_FIRMWARE_VERSION;
inline constexpr char webui[] = APP_WEBUI_VERSION;
inline constexpr char build_id[] = APP_BUILD_ID;
inline constexpr char git_commit[] = APP_GIT_COMMIT;
}  // namespace app::version
