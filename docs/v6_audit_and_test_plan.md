# Mass Telemetry Workbench: v6 audit, test plan, v7.0 increment

Scope: line-by-line read of `telemetry_workbench_v6.html` (1,114 lines), the Handoff, the Decision Record and the Sonnet review. Method: the real inline script was loaded headlessly in Node (`audit_harness.js`, DOM stub, no uPlot, no timers). The harness covers calibration, units, tare, rolling statistics, estimators, selection maths and hashing. It does **not** cover rendering, pointer/touch, uPlot behaviour, memory or frame rate; those need the browser checklist in section 4, which has not been run.

## 1. Baseline result (v6, measured)

| Area | Result |
|---|---|
| Interpolation, extrapolation values, out-of-range flag (kinked test curve) | pass |
| Unit factors (µg, mg, g, kg, oz, lb, oz t, st), round trip; `raw` rejected as a mass | pass |
| Rolling MA/SD vs brute force across ring wrap and a tare epoch | pass |
| Tare does not rewrite earlier samples; applies from the next sample | pass |
| Selection mean/SD (streamed) vs brute force | pass |
| Rolling SD with large offset (raw about 2e9, true SD 1.87) | **fail**: raw SD 59.9; mass SD **0** (the clamp hides it) |
| Hampel/MAD gate when MAD = 0 | **fail**: also rejects a sample 0.4 from the median |
| Calibration with non-monotonic mass, or an Infinity raw anchor | **fail**: accepted |
| Revision hash vs JSON key order | **fail**: changes with key order |

Also verified by arithmetic: all unit factors; the 52 bytes/sample figure (6 x Float64 + 1 x Int32); the demo anchors (three ~100 g observations average 5000 counts).

The demo curve is exactly linear (250 mg/count in both segments) and the simulator spans exactly the anchor range 4600-5400. The demo therefore cannot exercise nonlinear behaviour; the harness uses its own kinked curve for that.

## 2. Findings

Status: **Fixed** = in v7.0 and covered by a test. **Open** = not changed; the planned handling is stated.

| # | Sev. | Finding | Status |
|---|---|---|---|
| 1 | High | Sliding sum(x^2)/n - MA^2 cancels catastrophically for large mean and small noise; the `max(0,...)` clamp then reports SD = 0. Same pattern in `calculateStd` and the selection stream. | **Fixed**: shifted sums (reference reset with the window/tare epoch) and Welford |
| 2 | Med | "Hampel + mean" collapses when MAD = 0 (likely with integer counts) and is not a local Hampel filter | **Fixed**: mean-absolute-deviation fallback; relabelled "Global MAD filter + mean (Hampel-style)". A true local Hampel is still open |
| 3 | Med | `prepareCalibration` accepts non-finite or non-monotonic responses | **Fixed**: finite check, strict monotonicity with one slope sign (inverted polarity allowed) |
| 4 | Med | Revision fingerprint depends on key order; acquisition and tare could start before the real revision id existed (placeholder `embedded-demo-v1`) | **Fixed**: canonical sorted-key JSON; acquisition starts after the hash. Revision ids differ from v6; nothing is persisted, so no impact |
| 5 | Med | Selection EMA is seeded with the first sample, which keeps weight e^(-T/tau) | **Disclosed** in the selection readout; maths unchanged |
| 6 | Low | `innerHTML` receives calibration names/IDs unescaped. Safe today (inline constant), unsafe once import exists | **Fixed**: `esc()` |
| 7 | Low | CSV lacked an out-of-range flag; text fields were not quoted | **Fixed**: new last column `calibration_out_of_range`; quoting. Existing columns unchanged |
| 8 | High for hardware | Acquisition is a 12.5 ms `setInterval` with **synthetic timestamps** (`nextTime += 12.5`). Browsers throttle background tabs, so samples would arrive far below 80 Hz while timestamps still claim 80 Hz | **Open**: v7.1 wall-clock catch-up for the simulator; a real ESP32 must supply device timestamps |
| 9 | Med | A selection spanning a tare boundary: "Original" averages net values from different zero references, and `contextChanged` only compares the tare at the selection start with the latest | **Open**: v7.1 warns when a selection crosses a boundary |
| 10 | Low | Auto-Tare averages the last MA-window samples including out-of-range ones, with no flag | **Open**: v7.1 stores the out-of-range count in the tare event and warns |
| 11 | Low | `calibrateNetFromRawTare` / `calibrateNetFromMassTare` are unused; the live path implements Record section 5 | **Open**: keep for tests or delete after the Record is corrected |
| 12 | Low | Shifted sums still accumulate add/subtract rounding over very long runs; the reference never re-centres | **Open**: periodic exact rebuild or re-centring; measure at 1M+ first |
| 13 | Low | CSV export builds one string array (2M rows is heavy) | **Open**: chunked Blob parts |
| 14 | Info | Robust estimators sort up to 4,096 values every frame; selection subsampling is evenly spaced (aliasing possible, disclosed) | **Open**: profile in a browser before changing |

## 3. Sonnet review, reconciled

**Agree, handled in code:** variance numerics (confirmed by test), MAD = 0, EMA seed (disclosed), monotonicity requirement, canonical JSON. Subsampling aliasing is recorded as open (#14).

**Agree, Record wording only (no code change):**
- Section 3: "critical" overstates it. The choice is purpose-dependent: calibrate-then-average is the time-averaged-mass definition; calibrating the mean is the consistent estimator for a steady load. For a near-linear cell they are nearly identical. "Method B" is also used without "Method A" being defined.
- Section 4 raw-reference tare f(raw_tare) vs section 5 mean of f(raw_i): the code follows section 5 and stores the raw sample snapshot, so reprocessing is reproducible.
- Section 8 resolution/accuracy wording.
- Section 12: inverse-variance weights must reflect between-placement variance, not within-run s^2/n.

**Partly disagree:** "alpha negative on a timestamp reset". The code clamps dt to >= 0, so alpha = 0 and the sample is ignored. No crash, but no update either; worth a guard once real timestamps exist.

**Model decisions, not code:** interpolation through noisy anchors vs weighted least squares; air buoyancy and conventional mass (`assignedMass` should declare its basis; for ~2700 kg/m^3 weights the difference is about 3e-4); "latest tare" on historical selections (the selection already shows both as-recorded and current).

**Not independently verified by me:** bibliographic details of refs 2-10. My sandbox had no network access, so I opened no reference and did not confirm the review's statements about refs 4 and 9.

## 4. Test plan

**Automated now** (`node audit_harness.js telemetry_workbench_v7.html`): tests T1-T9 above. To add: golden CSV snapshot; tare at the exact ring-wrap sample; capacity shrink then rebuild; MA-window change with two tare epochs.

**Browser checklist (not performed; no browser was available):**
1. Console clean; uPlot CDN loads; page works from `file://` (FNV fallback path labelled).
2. 5 s live window fills then scrolls; wheel, pinch, pan, navigator; Track Live.
3. Leave the tab in the background for 60 s, then compare the sample count with 4,800 (finding 8).
4. Unit and precision changes leave stored mg untouched (export before and after).
5. Tare marker position; tare at buffer wrap; selection crossing a tare (finding 9).
6. Out-of-range: force raw beyond 4600-5400 and check the warning and the CSV column.
7. 100k test samples; 1M buffer with downsampling on and off; record memory and FPS per device.
8. CSV opened under a decimal-comma locale; column count is 11.
9. Touch: select mode, pinch, navigator drag on a phone.

## 5. Next increments

- **v7.1:** findings 8, 9, 10; harness additions.
- **v7.2:** calibration JSON import with full validation and the `esc()` path; keep the embedded demo as fallback.
- **v7.3:** selection context and provenance; then the calibration creator (simple, then professional).
- **Not started and not claimed:** uncertainty budget, autocorrelation/Allan diagnostics, ESP32, weight certificates. The embedded calibration remains illustrative only.
