# The root CMakeLists generates this immutable defaults source in the build
# tree before ESP-IDF component discovery begins.
set(OPEN_SCALE_FACTORY_DEFAULTS_CPP "${CMAKE_BINARY_DIR}/generated/factory_defaults.cpp")
if(NOT EXISTS "${OPEN_SCALE_FACTORY_DEFAULTS_CPP}")
    message(FATAL_ERROR "Missing generated factory defaults: ${OPEN_SCALE_FACTORY_DEFAULTS_CPP}")
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
