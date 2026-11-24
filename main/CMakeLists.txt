# Convert the source-controlled JSON documents into immutable byte arrays in
# the build directory. The readable source files are never rewritten.
set(OPEN_SCALE_FACTORY_DEFAULTS_CPP "${CMAKE_CURRENT_BINARY_DIR}/factory_defaults.cpp")
execute_process(
    COMMAND "${Python3_EXECUTABLE}"
            "${CMAKE_CURRENT_LIST_DIR}/../tools/generate_factory_defaults.py"
            --defaults-dir "${CMAKE_CURRENT_LIST_DIR}/../assets/default"
            --output "${OPEN_SCALE_FACTORY_DEFAULTS_CPP}"
    WORKING_DIRECTORY "${CMAKE_CURRENT_LIST_DIR}/.."
    RESULT_VARIABLE OPEN_SCALE_DEFAULTS_RESULT
)
if(NOT OPEN_SCALE_DEFAULTS_RESULT EQUAL 0)
    message(FATAL_ERROR "OpenScale factory-default embedding failed (${OPEN_SCALE_DEFAULTS_RESULT})")
endif()

idf_component_register(
    SRCS
        "${OPEN_SCALE_FACTORY_DEFAULTS_CPP}"
        "main.cpp"
        "storage.cpp"
        "device_log.cpp"
        "event_bus.cpp"
        "sensor_pipeline.cpp"
        "security.cpp"
        "config_api.cpp"
        "web_server.cpp"
        "wifi_manager.cpp"
        "serial_console.cpp"
    INCLUDE_DIRS
        "include"
        "${CMAKE_BINARY_DIR}/generated"
    REQUIRES
        esp_timer
        esp_http_server
        esp_wifi
        esp_event
        esp_netif
        esp_system
        nvs_flash
        fatfs
        wear_levelling
        mbedtls
        esp_driver_gpio
        esp_driver_uart
        console
        spi_flash
        hx711
)

# Factory filesystem image: static assets are already gzip payloads in the virtual root.
fatfs_create_spiflash_image(storage "${CMAKE_SOURCE_DIR}/.prebuild/virtual_www" FLASH_IN_PROJECT)

# The source uses C++20 designated initializers for ESP-IDF C structs.
target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_20)
