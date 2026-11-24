idf_component_register(
    SRCS
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
        json
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
