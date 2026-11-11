# Mass Telemetry Workbench v8: changes, decisions, open items

Base: v7.0 (v6 + audit fixes). Verified headlessly with `node audit_harness.js telemetry_workbench_v8.html` (all tests pass, including 9 v7 tests and 20 new v8 test groups). Not verified: anything that needs a browser (layout, legend, navigator interaction, uPlot rendering). See section 4.

## 1. Requested changes

| Request | Implementation |
|---|---|
| Latest uPlot | Pinned to **1.6.32** through one constant `UPLOT_VERSION`; CSS and JS are both loaded from it (static `<link>` tags removed). 1.6.32 is the newest release I could verify; I found no evidence of a newer one. |
| Settings below "Current measured mass" | Unit, decimals, estimator and one **Window** control sit in a compact panel under the value. Trim % shows only for the trimmed mean, EMA τ only for EMA. The Settings menu is an empty placeholder. |
| Unify duplicates | The moving-average window and the estimator window are now **one** "Window (samples)" control. It drives the chart average, the spread and the panel estimator. "Signal processing" is gone; the buffer limit selector is under the main graph and applies on change (no Apply button). |
| Tare options | Auto-Tare and manual tare are in a panel under "Current tare"; removed from the toolbar. |
| Navigator | Click centres the main view on that time (span unchanged); dragging makes the dragged range the main view, live while dragging. Mouse and touch. |
| Fixed legend | `min-width` and tabular numerals on legend values. |
| Remove MA / σ-band toggles | Removed with their dead code. |
| Grams 3 decimals | `decimals: 3` in the unit table. |

## 2. Measurement feature

Inputs "Duration (s)" and "Samples (80 Hz)" are linked (5 s = 400 samples). Start collects the **next** N samples, reduces them with the panel estimator (settings captured at the press), highlights them in amber (also while in progress) and writes a `measurement` log entry. It reuses `calculateSelection()`, so the result equals selecting the same samples on the graph. Clicking the log entry re-selects the samples.

It is cancelled, with a log note, by: a tare, a calibration change, a buffer limit below its size, a sampling gap. The card shows σ, sample count, out-of-range count, and "Validity analysis: not implemented yet".
`analyzeInterval(first, end)` is the single hook for the later analysis. Measurement, Selection analysis and the wizard all call it and store its result.

## 3. Planned v7.1-v7.3 items now committed (calibration creator excluded)

- **Simulator pacing:** samples come from elapsed wall-clock time. A long stall produces at most 400 catch-up samples; the rest becomes a visible timestamp gap. (Simulator only; a device supplies its own timestamps.)
- **Selection provenance:** `crossesTare`, `crossesCalibration`, `calibrationChanged` flags and warnings. The stored calibration revision is the one the samples were *recorded* with.
- **Auto-Tare** stores and shows the number of out-of-range samples in its window.
- **Calibration import/export/restore demo:** structure validation (schema, units, duplicate ids, references, finite and strictly monotonic anchors); size limit 2 MB; `contentHash` mismatch warning; escaped output. A new calibration starts a new **epoch**: previous calibrations stay in `state.calibrations`, earlier samples are never recomputed, the tare is reset, and a marker "Cal" is drawn. CSV carries the recorded revision per row.
- **Periodic exact refresh** of the rolling sums every 8,192 samples; **chunked CSV**; unused Method A/B helpers removed.

## 4. Browser checklist additions (not run)

1. Layout at desktop and phone widths: four columns, settings and tare panels, buffer row under the graph; no overlap.
2. Legend width stays constant while moving the cursor (CSS assumes uPlot's `.u-value` markup).
3. Navigator: click, drag, and touch drag; the main chart follows; Track Live returns.
4. Measurement: 1 s, 5 s and 30 s; amber highlight grows; log entry; cancel; tare mid-measurement.
5. Import a valid file, an invalid file, an edited file (hash warning); check the "Cal" marker, tare reset, CSV.
6. Background the tab for 60 s: about 4,800 samples expected, or a gap marker after long stalls.

## 5. Open items and decisions

- `uPlot@latest` (unpinned) was **not** used on purpose: a pinned version keeps the file reproducible and cannot break silently.
- Panel and tare statistics now respect the tare/calibration epoch (a behaviour change from v7, which averaged across a tare).
- Interpolation vs regression and air buoyancy / conventional mass remain Decision Record topics; Record wording corrections from the Sonnet review are still to be applied to the document.
- Robust estimators still sort up to 4,096 values per frame; not profiled.
- Samples carry no device counter yet (see the next milestone).

## 6. Next milestone: analysis (design notes)

- Implement as **pure functions on arrays** (`analyzeInterval` calls them), so the Node harness can test them against synthetic signals: white noise, drift, a step, a 50 Hz tone, a gap.
- Checks: autocorrelation to lag K and effective sample size; Allan deviation over octave averaging times; step detection (CUSUM or first/second-half mean test); vibration (spectral peak or excess high-lag correlation); gap and duplicate detection from the ESP32 counter.
- Output: `{status: 'ok' | 'suspect' | 'invalid', checks: [{id, value, threshold, verdict}]}`; thresholds visible and documented, never silent.
- ESP32 counter: store as `Uint32Array` (+4 bytes/sample). Timestamps stay authoritative; the counter detects dropped/duplicated frames, and a gap splits the interval into segments, because autocorrelation and Allan deviation assume uniform sampling. Measurement should record the achieved rate and duration, not only N.
