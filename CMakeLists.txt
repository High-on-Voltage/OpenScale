cmake_minimum_required(VERSION 3.16)

# IDF consumes PROJECT_VER during project(); asset generation must therefore
# happen before project() discovers/configures components and creates the FATFS image.
set(PROJECT_VER "0.3.0")
set(OPEN_SCALE_FIRMWARE_VERSION "0.3.0")

find_package(Python3 REQUIRED COMPONENTS Interpreter)

# Reconfigure when either source tree changes. The source directories are read-only
# inputs to the packaging step; all generated content lives under the hidden cache.
file(GLOB_RECURSE OPEN_SCALE_WEB_INPUTS CONFIGURE_DEPENDS
    LIST_DIRECTORIES false
    "${CMAKE_CURRENT_LIST_DIR}/WebUI/*"
    "${CMAKE_CURRENT_LIST_DIR}/www/*"
    "${CMAKE_CURRENT_LIST_DIR}/assets/default/*"
    "${CMAKE_CURRENT_LIST_DIR}/tools/*.py"
)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${OPEN_SCALE_WEB_INPUTS})
set(OPEN_SCALE_UPLOT_CACHE_MARKER "${CMAKE_CURRENT_LIST_DIR}/.prebuild/uplot/e995b061e9fc5476a6d862cd2fb2ebc7452ca012/.complete")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${OPEN_SCALE_UPLOT_CACHE_MARKER}")

set(OPEN_SCALE_GENERATED_DIR "${CMAKE_BINARY_DIR}/generated")
file(MAKE_DIRECTORY "${OPEN_SCALE_GENERATED_DIR}")
execute_process(
    COMMAND "${Python3_EXECUTABLE}"
            "${CMAKE_CURRENT_LIST_DIR}/tools/prepare_web_assets.py"
            --project-root "${CMAKE_CURRENT_LIST_DIR}"
            --virtual-root "${CMAKE_CURRENT_LIST_DIR}/.prebuild/virtual_www"
            --generated-header "${OPEN_SCALE_GENERATED_DIR}/webui_build_info.h"
    WORKING_DIRECTORY "${CMAKE_CURRENT_LIST_DIR}"
    RESULT_VARIABLE OPEN_SCALE_ASSET_RESULT
)
if(NOT OPEN_SCALE_ASSET_RESULT EQUAL 0)
    message(FATAL_ERROR "OpenScale web asset preparation failed (${OPEN_SCALE_ASSET_RESULT})")
endif()

string(TIMESTAMP OPEN_SCALE_BUILD_ID "%Y%m%d-%H%M%S" UTC)
set(OPEN_SCALE_GIT_COMMIT "unknown")
execute_process(
    COMMAND git rev-parse --short=12 HEAD
    WORKING_DIRECTORY "${CMAKE_CURRENT_LIST_DIR}"
    OUTPUT_VARIABLE OPEN_SCALE_GIT_COMMIT
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET
    RESULT_VARIABLE OPEN_SCALE_GIT_RESULT
)
if(NOT OPEN_SCALE_GIT_RESULT EQUAL 0 OR OPEN_SCALE_GIT_COMMIT STREQUAL "")
    set(OPEN_SCALE_GIT_COMMIT "unknown")
endif()
configure_file(
    "${CMAKE_CURRENT_LIST_DIR}/main/include/build_info.h.in"
    "${OPEN_SCALE_GENERATED_DIR}/build_info.h"
    @ONLY
)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(OpenScale)

message(STATUS "OpenScale firmware version: ${OPEN_SCALE_FIRMWARE_VERSION}")
message(STATUS "OpenScale Git commit: ${OPEN_SCALE_GIT_COMMIT}")
