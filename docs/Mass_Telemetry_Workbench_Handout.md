# Mass Telemetry Workbench: handout after v9

Use together with `telemetry_workbench_v9.html` (the baseline). Optional: `audit_harness.js` (headless tests), `v9_changes.md`.

## 1. Fixed constraints (do not change without asking)
- Single-file HTML. AGPLv3 header and attribution unchanged. The only external dependency is uPlot from the jsDelivr CDN, **pinned** via `UPLOT_VERSION` (1.6.32 was the newest release I could verify; to upgrade, change only that constant).
- 80 Hz acquisition (simulated today). Immutable raw ring buffer, incremental processing, live/zoom behaviour, full-resolution default, optional min/max downsampling.
- The embedded calibration is **illustrative only**, not valid for the user's hardware. Never claim accuracy or measurement uncertainty the data cannot support. The spread values are observed scatter, not uncertainty.
- Mathematical rationale goes into **English source comments**. Distinguish implemented features from planned ones. Ask only when a product decision truly blocks progress; otherwise take a conservative, documented choice. The user values human-readable code and incremental change, not rebuilds.

## 2. Architecture (what exists in v9)
- **Data:** typed arrays per sample: time (Float64), raw counts (Int32), `massMg`, rawMA, rawSD, massMA, massSD (about 52 B/sample). The canonical mass unit is **mg**; unit selection is presentation only. Ring capacity is selectable (10k to 1M or unlimited, growing in 100k steps).
- **Ingest:** `appendSample(raw)` calibrates per sample (`calibrateAbsolute`: piecewise-linear interpolation, linear extrapolation, flagged `outOfRange`), subtracts the tare in force, and updates rolling sums in O(1). Sums are **shifted by a reference** (`rawRef`, `massRef`) and exactly rebuilt every 8,192 samples (`refreshRollingSums`). `rebuildDerived()` recomputes the derived arrays after a window change.
- **Tare:** an **event** (`state.tareEvents`: `effectiveFromTime`, `tareMassMg`, raw snapshot, out-of-range count). Net = absolute mass minus the tare in force **at that sample's time**. The tare is the mean of f(raw_i) over the tare window. Statistics windows never cross a tare.
- **Calibration:** `CALIBRATION` (active, switchable), `EMBEDDED_CALIBRATION`, `state.calibrations` (history with `effectiveFromTime`), `calibrationAt(t)`. Import validates structure and monotonicity (`validateCalibrationConfig`). Fingerprint = SHA-256 of canonical (sorted-key) JSON, FNV fallback on `file://` (labelled). **Stored masses are never recomputed.** A calibration change starts a new epoch: the tare is reset, a running measurement is aborted, and a "Cal" marker is drawn.
- **Estimators** (`estimate()`): mean, median, trimmed mean, global MAD filter + mean (Hampel-style, MAD=0 fallback), EMA. Each returns a **matching σ**: SD, 1.4826×MAD, SD of retained samples (biased low), SD of kept samples (biased low), exponentially weighted SD. One **window** setting drives the chart curve, spread, panel and Auto-Tare. Robust estimators use at most the newest 4,096 samples.
- **Chart:** `buildEstimatorCurve()` gives centre and ±1σ for the selected estimator. Mean uses the stored rolling values, EMA runs sample by sample with a 7τ warm-up, and the sort-based estimators use a sparse aligned grid plus cache and interpolation when many samples are visible.
- **Selection and Measurement:** `calculateSelection(first,end,settings)` returns original (as recorded) and current (re-calibrated, latest tare) results, with `crossesTare`, `crossesCalibration` and `calibrationChanged` flags. `startMeasurement()` collects the next N samples (settings captured at start), reuses `calculateSelection`, highlights the samples (amber) and logs an entry. Tare, calibration change, buffer shrink or a sampling gap cancel it.
- **Hook for the next milestone:** `analyzeInterval(first,end)` currently returns "not-analyzed". It is called by Selection and Measurement and stored with their results.
- **Simulator:** `tick()` generates samples from wall-clock time (catch-up of at most 400 samples, then a timestamp gap). A real device replaces this.
- **UI layout:** header (status, Pause, +100k test samples, theme, Settings with Calibration); four metric columns (mass + spread with the settings panel under both, tare + tare options, measurement); full-width main chart and navigator (click or drag moves the main view); a control bar below the navigator (Track Live, Select interval, Export CSV, Buffer limit); then Display options / Selection analysis / Navigation, then the log.
- **CSV:** per row the recorded calibration revision and an out-of-range flag. `moving_average_net_mg` and `spread_sigma_mg` stay the arithmetic mean and SD whatever estimator is selected.

## 3. Decisions to keep
- Calibrate each sample first, then average (the mean of f(raw)), not f(mean raw). The choice is purpose-dependent and nearly identical for near-linear cells; do not call it "critical".
- A selection's "original" value uses the calibration and tare recorded at the time. "Current" re-applies the active calibration and latest tare. Both are shown, with warnings.
- Any selection, measurement or window crossing a tare or calibration boundary is flagged or prevented.
- Escape every text from calibration files before `innerHTML` (`esc()`).
- The EMA is seeded with the first sample (seed weight e^(-T/τ)); this is disclosed in the readouts.

## 4. Planned features (in order)
1. **Analysis milestone (next).** Implement as **pure functions on arrays** behind `analyzeInterval`, so the Node harness can test them on synthetic signals (white noise, drift, step, 50 Hz tone, gap). Checks: autocorrelation and effective sample size, Allan deviation, step (moved weight) detection (CUSUM or first/second-half test), vibration (spectral peak or excess correlation), gap and duplicate detection. Result shape: `{status:'ok'|'suspect'|'invalid', checks:[{id,value,threshold,verdict}]}` with visible, documented thresholds. It is shared by Measurement, Selection analysis and the wizard, and it should flag invalid data rather than silently alter results.
2. **Calibration creator wizard**, after analysis: first a simple version, then a professional one (reference weights, observations, anchors, validation metadata). It reuses the same analysis functions and writes the existing calibration JSON schema (`schemaVersion` 1).
3. **ESP32 integration.** The device supplies a **timestamp** and a **per-sample counter**. Timestamps are authoritative; the counter detects dropped or duplicated frames (a gap splits an interval into segments, because autocorrelation and Allan deviation need uniform sampling). Store the counter in a `Uint32Array` (+4 B/sample). Measurement should record the achieved rate and duration, not only N. `appendSample` must accept a device time and reject non-monotonic times, because the binary searches assume sorted time.

## 5. Smaller open items
- Decision Record edits from the Sonnet review (not yet applied): soften §3 "critical" and define Method A/B; reconcile §4 and §5 tare wording; §8 resolution/accuracy wording; §12 weights must reflect between-placement variance; add air buoyancy / conventional mass (`assignedMass` should state its basis); discuss interpolation through noisy anchors vs weighted least squares.
- Optional "latest tare" for historical selections (currently both original and current are shown).
- A true local (sliding) Hampel filter; EMA seed-normalised weighting for selections.
- Export a self-contained measurement package (samples, calibration, tares).
- Profile the per-frame cost in a real browser (the 100k full-resolution view measured about 100-240 ms in Node, mostly existing drawing cost).

## 6. Not verified (needs a browser)
Layout at all widths and header wrapping; the legend's fixed width (it assumes uPlot's `.u-value` markup); navigator click, drag and touch; measurement highlight drawing; file import and export dialogs; behaviour in a throttled background tab; memory and frame rate at 1M samples. Run the checklist in `v6_audit_and_test_plan.md` §4 and `v8_changes_and_open_items.md` §4 first. I never opened the Record's bibliographic references (the sandbox had no network access).

## 7. Working method that worked
- **Audit first, then patch.** Audit the current code, record findings with severity and status, test, then change incrementally.
- **Python patch scripts** with asserted unique replacements (`rep`/`region`), then `node --check` on the extracted script.
- **Headless harness:** it loads the real inline script into a Node `vm` with a DOM stub, so it tests logic only (not rendering). The stub invents any element id, so also cross-check `$('id')` references against the HTML ids statically.
- Tests exist for calibration, units, tare epochs, rolling statistics, estimators and sigma, selection, measurement, import validation, pacing, CSV provenance, curve and layout contracts. Run `node audit_harness.js telemetry_workbench_v9.html`; all tests passed at v9.
