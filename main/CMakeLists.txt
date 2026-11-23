# Build a deterministic, gzip-compressed virtual asset tree from /www and
# /WebUI. All generated files live under the hidden build prebuild directory;
# neither source tree is modified by the build.
find_package(Python3 REQUIRED COMPONENTS Interpreter)

set(PROJECT_ROOT "${CMAKE_SOURCE_DIR}")
set(PREBUILD_DIR "${CMAKE_CURRENT_BINARY_DIR}/.prebuild")
set(ASSET_GZIP_DIR "${PREBUILD_DIR}/gzip")
set(ASSET_PACK "${PREBUILD_DIR}/web_assets.pack")
set(ASSET_EMBED_ASM "${PREBUILD_DIR}/web_assets.S")

file(GLOB_RECURSE VIRTUAL_ASSET_INPUTS CONFIGURE_DEPENDS
    LIST_DIRECTORIES false
    "${PROJECT_ROOT}/www/*"
    "${PROJECT_ROOT}/WebUI/*")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    ${VIRTUAL_ASSET_INPUTS}
    "${PROJECT_ROOT}/VERSION"
    "${PROJECT_ROOT}/WebUI/VERSION"
    "${PROJECT_ROOT}/tools/pack_web_assets.py")

execute_process(
    COMMAND "${Python3_EXECUTABLE}" "${PROJECT_ROOT}/tools/pack_web_assets.py"
        --www "${PROJECT_ROOT}/www"
        --webui "${PROJECT_ROOT}/WebUI"
        --gzip-dir "${ASSET_GZIP_DIR}"
        --output "${ASSET_PACK}"
        --asm "${ASSET_EMBED_ASM}"
    RESULT_VARIABLE ASSET_PREBUILD_RESULT
    OUTPUT_VARIABLE ASSET_PREBUILD_OUTPUT
    ERROR_VARIABLE ASSET_PREBUILD_ERROR)
if(NOT ASSET_PREBUILD_RESULT EQUAL 0)
    message(FATAL_ERROR "Web asset prebuild failed:\n${ASSET_PREBUILD_ERROR}")
endif()
message(STATUS "${ASSET_PREBUILD_OUTPUT}")

file(READ "${PROJECT_ROOT}/VERSION" APP_FIRMWARE_VERSION)
string(STRIP "${APP_FIRMWARE_VERSION}" APP_FIRMWARE_VERSION)
file(READ "${PROJECT_ROOT}/WebUI/VERSION" APP_WEBUI_VERSION)
string(STRIP "${APP_WEBUI_VERSION}" APP_WEBUI_VERSION)

set(APP_GIT_COMMIT "unknown")
set(APP_BUILD_ID "local")
execute_process(
    COMMAND git rev-parse HEAD
    WORKING_DIRECTORY "${PROJECT_ROOT}"
    RESULT_VARIABLE GIT_RESULT
    OUTPUT_VARIABLE GIT_HASH
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET)
if(GIT_RESULT EQUAL 0 AND NOT GIT_HASH STREQUAL "")
    set(APP_GIT_COMMIT "${GIT_HASH}")
    string(SUBSTRING "${GIT_HASH}" 0 12 APP_BUILD_ID)
endif()

idf_component_register(
    SRCS
        "app_main.cpp"
        "config_store.cpp"
        "http_server.cpp"
        "security.cpp"
        "sensor_manager.cpp"
        "serial_console.cpp"
        "wifi_manager.cpp"
        "${ASSET_EMBED_ASM}"
    INCLUDE_DIRS "."
    REQUIRES
        console
        driver
        esp_event
        esp_hw_support
        spi_flash
        esp_http_server
        esp_netif
        esp_rom
        esp_system
        esp_timer
        esp_wifi
        fatfs
        freertos
        heap
        json
        lwip
        mbedtls
        nvs_flash
        wear_levelling
)

target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_17)
target_compile_definitions(${COMPONENT_LIB} PRIVATE
    APP_FIRMWARE_VERSION="${APP_FIRMWARE_VERSION}"
    APP_WEBUI_VERSION="${APP_WEBUI_VERSION}"
    APP_BUILD_ID="${APP_BUILD_ID}"
    APP_GIT_COMMIT="${APP_GIT_COMMIT}"
)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Wno-unused-parameter)
