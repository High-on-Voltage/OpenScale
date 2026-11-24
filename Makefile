IDF_PY ?= idf.py
PYTHON ?= python3
PROJECT_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))

.PHONY: all build flash flash-app monitor clean fetch-uplot refresh-uplot help

all: build

build:
	$(IDF_PY) build

# First provisioning only: includes the generated factory FATFS image.
flash:
	$(IDF_PY) flash

# Routine firmware updates: leave the persistent FATFS partition untouched.
flash-app:
	$(IDF_PY) app-flash

monitor:
	$(IDF_PY) monitor

# Explicitly requested refresh. Normal builds reuse the hidden commit-pinned cache.
fetch-uplot refresh-uplot:
	$(PYTHON) tools/fetch_uplot.py --project-root "$(PROJECT_ROOT)" --force

clean:
	$(IDF_PY) fullclean
	rm -rf .prebuild/plain_webroot .prebuild/gzip_webroot .prebuild/virtual_www

help:
	@echo "make build          - prepare gzip assets, then build firmware"
	@echo "make fetch-uplot    - explicitly re-download the pinned uPlot source"
	@echo "make flash          - first provisioning; also flashes factory FATFS image"
	@echo "make flash-app      - flash firmware only; preserve the FATFS data partition"
	@echo "make monitor        - open the serial monitor"
	@echo "make clean          - clean IDF build outputs (keeps the uPlot cache)"
