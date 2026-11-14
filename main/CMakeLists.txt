idf_component_register(
    SRCS
        "app_main.cpp"
        "config_store.cpp"
        "http_server.cpp"
        "security.cpp"
        "sensor_manager.cpp"
        "serial_console.cpp"
        "wifi_manager.cpp"
    INCLUDE_DIRS "."
    EMBED_FILES
        "www/default.html.gz"
        "www/default.js.gz"
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
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Wno-unused-parameter)
