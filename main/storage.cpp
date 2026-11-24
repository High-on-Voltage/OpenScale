#include "storage.hpp"
#include "esp_log.h"
#include "esp_vfs_fat.h"
#include "wear_levelling.h"
#include <cstdio>
#include <cstring>
#include <sys/stat.h>
#include <cerrno>
#include <unistd.h>

namespace {
constexpr char TAG[] = "storage";
constexpr char MOUNT_PATH[] = "/fs";
constexpr char PARTITION_LABEL[] = "storage";
wl_handle_t s_wl_handle = WL_INVALID_HANDLE;
bool s_ready = false;

bool safe_relative_path(const std::string &path) {
    // Only canonical absolute virtual paths are accepted. Reject aliases such as
    // //data/... and repeated separators before mapping into the FATFS mount.
    if (path.size() < 2 || path[0] != '/' || path[1] == '/' || path.back() == '/') return false;
    if (path.find('\\') != std::string::npos || path.find('\0') != std::string::npos ||
        path.find("//") != std::string::npos) return false;
    size_t start = 1;
    while (start < path.size()) {
        const size_t end = path.find('/', start);
        const std::string part = path.substr(start, end == std::string::npos ? std::string::npos : end - start);
        if (part.empty() || part == "." || part == "..") return false;
        if (end == std::string::npos) break;
        start = end + 1;
    }
    return true;
}
}

namespace openscale::storage {
esp_err_t init() {
    esp_vfs_fat_mount_config_t config{};
    config.format_if_mount_failed = false; // Never destroy user data automatically.
    config.max_files = 16;
    config.allocation_unit_size = 4096;
    const esp_err_t err = esp_vfs_fat_spiflash_mount_rw_wl(MOUNT_PATH, PARTITION_LABEL, &config, &s_wl_handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "FATFS mount failed (%s); no format attempted", esp_err_to_name(err));
        s_ready = false;
        return err;
    }
    s_ready = true;
    (void)make_directories("/data/settings");
    (void)make_directories("/data/calibration");
    ESP_LOGI(TAG, "Mounted FATFS partition '%s' at %s", PARTITION_LABEL, MOUNT_PATH);
    return ESP_OK;
}

bool ready() { return s_ready; }

std::string physical_path(const std::string &url_path) {
    if (!safe_relative_path(url_path)) return {};
    return std::string(MOUNT_PATH) + url_path;
}

esp_err_t make_directories(const std::string &path) {
    if (!s_ready || !safe_relative_path(path)) return ESP_ERR_INVALID_STATE;
    std::string current(MOUNT_PATH);
    size_t start = 1;
    while (start <= path.size()) {
        const size_t end = path.find('/', start);
        const std::string segment = path.substr(start, end == std::string::npos ? std::string::npos : end - start);
        if (!segment.empty()) {
            current += "/" + segment;
            if (mkdir(current.c_str(), 0775) != 0 && errno != EEXIST) {
                ESP_LOGE(TAG, "mkdir %s failed: errno=%d", current.c_str(), errno);
                return ESP_FAIL;
            }
        }
        if (end == std::string::npos) break;
        start = end + 1;
    }
    return ESP_OK;
}

esp_err_t read_file(const std::string &path, std::vector<uint8_t> &out, size_t max_bytes) {
    out.clear();
    const std::string full = physical_path(path);
    if (!s_ready || full.empty()) return ESP_ERR_INVALID_STATE;
    FILE *file = fopen(full.c_str(), "rb");
    if (!file) return errno == ENOENT ? ESP_ERR_NOT_FOUND : ESP_FAIL;
    if (fseek(file, 0, SEEK_END) != 0) { fclose(file); return ESP_FAIL; }
    const long size = ftell(file);
    if (size < 0 || static_cast<size_t>(size) > max_bytes) { fclose(file); return ESP_ERR_INVALID_SIZE; }
    rewind(file);
    out.resize(static_cast<size_t>(size));
    const size_t read = out.empty() ? 0 : fread(out.data(), 1, out.size(), file);
    const bool ok = read == out.size() && !ferror(file);
    fclose(file);
    if (!ok) { out.clear(); return ESP_FAIL; }
    ESP_LOGD(TAG, "Read %s (%u bytes)", path.c_str(), static_cast<unsigned>(out.size()));
    return ESP_OK;
}

esp_err_t write_file_atomic(const std::string &path, const uint8_t *data, size_t size) {
    const std::string full = physical_path(path);
    if (!s_ready || full.empty() || (!data && size)) return ESP_ERR_INVALID_STATE;
    const size_t slash = full.find_last_of('/');
    if (slash != std::string::npos) {
        const std::string parent = full.substr(0, slash);
        // Create directories via the URL-space path, not by accepting arbitrary physical paths.
        const size_t url_slash = path.find_last_of('/');
        if (url_slash > 0) (void)make_directories(path.substr(0, url_slash));
        (void)parent;
    }
    const std::string temp = full + ".tmp";
    FILE *file = fopen(temp.c_str(), "wb");
    if (!file) return ESP_FAIL;
    const size_t written = size ? fwrite(data, 1, size, file) : 0;
    const bool ok = written == size && fflush(file) == 0;
    const int close_result = fclose(file);
    if (!ok || close_result != 0) { unlink(temp.c_str()); return ESP_FAIL; }
    const std::string backup = full + ".bak";
    (void)unlink(backup.c_str());
    const bool had_old = (rename(full.c_str(), backup.c_str()) == 0);
    if (!had_old && errno != ENOENT) { unlink(temp.c_str()); return ESP_FAIL; }
    if (rename(temp.c_str(), full.c_str()) != 0) {
        if (had_old) (void)rename(backup.c_str(), full.c_str());
        unlink(temp.c_str());
        return ESP_FAIL;
    }
    if (had_old) (void)unlink(backup.c_str());
    return ESP_OK;
}

esp_err_t remove_file(const std::string &path) {
    const std::string full = physical_path(path);
    if (!s_ready || full.empty()) return ESP_ERR_INVALID_STATE;
    if (unlink(full.c_str()) == 0) return ESP_OK;
    return errno == ENOENT ? ESP_ERR_NOT_FOUND : ESP_FAIL;
}
}
