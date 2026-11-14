# Mass Telemetry Workbench: handout v14 (read after v13.2; this overrides earlier handouts where they differ)

Baseline: `telemetry_workbench_v14.html` + `.js`, `audit_harness_v14.js` (all checks pass; run `node audit_harness_v14.js telemetry_workbench_v14.html`), `sensors_example.json` (unchanged). **Still not browser-tested.** Rule kept: every new behaviour has a harness test; no v13 check was weakened (the 250 v13 checks run unchanged).

## 1. What v14 implements (handout v13.2 sections)
| § | Feature | Where |
|---|---|---|
| 8 | Estimator length also in seconds (linked, samples ÷ rate); real time span next to sample counts (current value, selection, measurement, log, wizard) | window field, `fmtSpan` |
| 5 | Band modes: symmetric (default) / asymmetric / step-aware, Display options, stored in `ui-settings.json` as `bandMode` | `bandStats`, `buildEstimatorCurve` |
| 4 | Three "±" lines under the current value: σ, σ/√n_eff of the average, stability (max−min of the displayed value over the last window) | `updatePlusMinus` |
| 3 | Uncertainty (stage 1 typed weight tolerance/certificate, stage 2 components, stage 3 "± U (label)" on measurements, selections, log, tooltip; `uncertainty` block in the calibration file) | `computeUncertainty`, `buildUncertaintyProfile` |
| 2 | Hysteresis: `loadingDirection` per observation, mean(down)−mean(up) per mass, fit on both/up/down, optional return run in Simple mode, `reserved.loadingDirection` / `hysteresisAnalysis` filled | `hysteresisAnalysis` |
| 6 | Password (HTTP Basic, own dialog, writes only) | `serverWrite`, `authDialogPrompt` |
| 7 | History by independent range requests; sample ids; gap filling; merge into the ring buffer | `mergeHistory`, `historyLoadOlder` |
| 1 | Placements per mass (Simple, 2–10, default 3, wizard setting only); `basis` field of the weight tolerance | wizard |
| 8 | Advanced extras: leave-one-out residuals, environment fields (temperature, humidity, warm-up), full fit report export (JSON + text) | Fit tab |

## 2. Decisions I took that you should know about (please check)
1. **Extra uncertainty component "placement of the weighed object".** The handout lists (a) curve error from the fit, (b) reading noise, (c) resolution, (d) weight tolerance. A single weighing also puts the object down only once, so one more placement's scatter belongs in. It is a separate, switchable line (`UNC_INCLUDE_OBJECT_PLACEMENT`, shown in the component list). Without it the numbers would be lower and too optimistic.
2. **Resolution:** one count / √12; if the reading noise is ≥ 1 count it dithers the rounding and the term is divided by √n_eff (`UNC_DITHER_SIGMA_COUNTS`).
3. **Unknown n_eff** (interval shorter than 64 samples): n_eff = 1 is used (conservative: σ itself) and the component says so.
4. **Weight tolerance is all-or-nothing.** If any weight used has no typed value, the component is left out and the label stays "repeatability only" (a half-included tolerance would look more complete than it is). Independent weights give u/√n per mass level; a bias shared by all weights is stated as not reduced and not detectable.
5. **Labels:** `± U (estimated, repeatability only, not traceable)`; with typed tolerances for every weight `(estimated, not traceable)`; with hysteresis `(estimated, repeatability and hysteresis only, not traceable)`. The embedded demo calibration (and any older file) has no block: the app says why and shows no number.
6. **No repeats → no number.** If repeatability cannot be estimated (no reference mass placed twice for the piecewise model, no degrees of freedom), the block is `not-estimable` with a reason.
7. **Asymmetric band** is the literal definition (upper = mean of the samples above the centre value): after a down-step it equals the old level exactly; in steady noise it sits at about ±0.8 σ (narrower than the symmetric band). Not applied to EMA estimators.
8. **Step-aware band** restarts the *whole* estimator window (centre line and band, so the band stays centred) at a step found by the existing CUSUM statistic (step-like, ≥ 2 σ, Q ≥ 1.36). Needs ≥ 64 samples in the window; a ramp is a trend and does not restart.
9. **History: merge instead of "buffer live, then prepend".** Prepending while live samples keep flowing is valid at any moment, so live data is not held back. Merge is by time, duplicates by id (or by time if there is no id). Samples that no longer fit the buffer are dropped from the *oldest* end; a running measurement is cancelled if a sample is inserted into its interval. Data thrown away by **Pause** is never refilled (the first sample after resume is a new baseline); only real gaps (reconnect) are.
10. **Observations without a loading direction count as "up"** when "up only" is chosen.
11. **Hysteresis in the uncertainty:** half-width |down−up|/2, rectangular, only while the fit uses both directions.
12. The ± stability line uses T = estimator window (adjustable later, as planned).

## 3. File keys (all additive; `schemaVersion` stays 1)
- `referenceWeights[].massUncertainty {value, unit, basis: certificate|class-tolerance|user-estimate, coverageFactor, distribution, standardUncertaintyMg}`
- `observations[].loadingDirection` (`up|down|null`)
- `uncertainty {status: estimated|not-estimable, traceable:false, basis, coverageProbability:0.95, dof, k:{dof,value}, components:[{id,label,included,dof,table:[{massMg,uMg}],note}], notIncluded:[…], combined:{table:[{massMg,uMg,dof,k,UMg}]}}` – calibration-side components only; a measurement adds reading noise and resolution. `validation.status` stays `not-characterized`.
- `fit.hysteresisUse`, `reserved.loadingDirection` (`both|up|down|not-determined`), `reserved.hysteresisAnalysis {levels:[{massMg,nUp,nDown,meanUp,meanDown,diffCounts,diffMg,seMg}], maxAbsDiffMg, meanDiffMg}`
- `environment.temperatureC / relativeHumidityPercent`, `reserved.warmUpDurationSeconds`
- `ui-settings.json`: `bandMode`.
- Simple weight list accepts a tolerance: `3 x 100 g ±0.5 mg`.

## 4. Server assumptions (to confirm with the ESP32 firmware)
- SSE sample: `{"id":"<sensor>","t":<device ms>,"raw":<int>,"n":<monotonic sample id>}`; the event's SSE `id:` field = id of its last sample (Last-Event-ID).
- History: `GET <historyUrl>?sensor=<id>&from_id=a&to_id=b` (per-sensor `historyUrl` in the sensor list, or `HISTORY_URL`; both empty = off). JSON `{samples:[{n,t,raw}]}` or binary (`application/octet-stream`): `HIST` magic, u16 version 1, u16 0, u32 count, count × (u32 id, u32 device ms, i32 raw), little endian. Chunks of 5,000 ids requested; how many samples the device keeps and its maximum chunk size are open.
- Writes (`UI_SETTINGS_URL` PUT/DELETE, `SENSOR_SETTINGS_URL` PUT, `CALIBRATION_UPLOAD_URL` PUT): 401 when a password is set and the header is missing/wrong. If the UI is not served by the ESP32, the server must answer the CORS preflight and allow `Authorization`. Basic over plain HTTP is readable: trusted home network or HTTPS only (stated in the dialog and the Settings Menu).

## 5. Section 9 list, updated (what you can compare after some weeks)
Spread shown in: spread card, chart band, selection, measurement, the new ± lines, and now "± U" (different things: σ = single readings, ±avg = the average's repeatability, ± U = with calibration). Three band modes; three weightings; Simple/Advanced overlap; Fit-tab model comparison vs. Simple's automatic choice; window in samples and seconds; header layout; **new:** the "object placement" component on/off; hysteresis "both/up/down"; leave-one-out column; text vs. JSON fit report.

## 6. Browser checklist (never done; new items marked ★)
Header wrap, Y-axis widths, legend spacing, navigator at a full buffer, Simple wizard with a live stream, include-anyway, collapsible manual box, settings persistence, Esc handling, auth dialog (focus, Enter, Esc, password manager behaviour), ★ the three ± lines wrapping on narrow screens, ★ band mode switch (chart is rebuilt) and the legend labels, ★ window seconds field next to the slider, ★ wizard weights table width with the two new columns, ★ direction select per observation, ★ Simple "way down" flow with a live stream, ★ uncertainty details list in the measurement card and the selection panel, ★ negative time axis labels after history is merged in front of the stream origin.

## 7. Not done / next
Temperature, creep, off-centre loading and drift are listed as "not included" but not modelled. OIML class table postponed. CSV export has no sample-id column (would change the v13 column test). The device-side parts of §7 wait for the firmware.
