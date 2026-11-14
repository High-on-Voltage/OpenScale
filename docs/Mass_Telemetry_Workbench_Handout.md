# Mass Telemetry Workbench: handout v14.1 (addendum to v14; read after v14. Specifies the NEXT round. Nothing here is implemented yet.)

Baseline stays `telemetry_workbench_v14.*` + `audit_harness_v14.js`. Rules unchanged: every new behaviour gets a harness test, none weakened; pure functions DOM-free; thresholds as named constants echoed in the UI; new file keys additive (`schemaVersion` 1); the app never claims an uncertainty it cannot support. User profile unchanged (enthusiast, plain wording, Claude manages everything).

## 1. Decisions taken (user agreed to all)
1. Off-centre loading, creep, zero drift and temperature sensitivity are **measured as part of the calibration** and stored in `calibration.json` (new `characterization` block, next to `uncertainty`).
2. **Use conditions** (reading delay, time since tare, expected temperature difference) are NOT calibration data: they live in `sensor_settings.json` (or on the measurement).
3. **Long-term drift** (weeks) is a log of check weighings, a separate growing file linked to the calibration revision; server storage later. Not part of the next round beyond the file format.
4. **Temperature in two forms:** typed manual estimate (labelled "user estimate") and a real sensor channel. **Temperature correction of the mass readings is postponed** (later opt-in, own calibration epoch, because it changes the raw-to-mass pipeline). The next round only displays, records, and puts temperature into the uncertainty.
5. **Auxiliary channels are open:** temperature is processed by us; any other channel gets storage, alignment, graph, CSV and history so the user can do what they like with it. No user formulas yet.
6. Temperature and load-cell samples come from **one device and one clock**: alignment is by timestamp.
7. The ESP32 chip temperature is not used as load-cell temperature.

## 2. `sensors.json`: auxiliary channels
Each channel is its own entry (same list as the load cells; `kind` distinguishes them):
```json
{"id":"t-body","kind":"temperature","name":"Load cell body","sseUrl":"/stream/t","rateHz":1,
 "unit":"°C","conversion":{"type":"polynomial","coefficients":[-12.3,0.0042]},"attachedTo":["scale-1"],
 "deviceId":"esp32-1"}
```
- `kind`: `loadcell` (default, as today) | `temperature` | `generic`. `unit` is the unit of the converted value.
- `conversion` (applied by the UI to the channel's native `raw` value): `polynomial` (coefficients c0, c1, … = 1 to x), `steinhart-hart` {a,b,c} (raw = resistance Ω → K → °C), `beta` {beta, r0, t0, rSeries}, `direct` (no conversion). A conversion failure marks the sample invalid, never silently zero.
- `attachedTo`: array of load-cell ids, may be empty; stated only on the aux entry (one place to edit). A temperature channel attached to several cells serves all of them; a cell may have several (e.g. body + ambient): the user picks the **primary** one per cell for the uncertainty (`primaryTemperature` in the sensor settings).
- `deviceId` (optional, default = `sseUrl`): sensors with the same device share **one time origin** (today every sensor sets its own origin at its first sample; that must change so that an aux channel and its load cell line up). Origin = first accepted timestamp of the device.
- User corrections of a conversion (e.g. an ice-point offset) are saved via `sensor_settings.json` (password for writes as in v14); the firmware values stay the defaults.
- SSE sample of an aux channel: `{"id":"t-body","t":<device ms>,"raw":<float>,"n":<sample id>}` (float, not rounded to integer counts). History API identical (`sensor=<aux id>`); binary layout v2 proposal: as v1 but 16-byte records (u32 id, u32 ms, f64 raw).

## 3. Aux pipeline (separate from the load-cell state)
- Own light ring buffer per channel: time (f64), raw (f64), id (f64), converted value (f64), capacity as the load cells (default 100,000). The load-cell pipeline and its tests stay untouched.
- Pause / reconnect / gap detection by id and history merge behave as for load cells (reuse `ingest`, `noteGap`, `mergeSampleLists`).
- `auxValueAt(channel, t)`: linear interpolation to a load-cell sample time; NaN if the neighbouring aux samples are further apart than `AUX_MAX_GAP_FACTOR` × the channel period (never extrapolated).
- Graph: right-hand axis in the main chart (and optionally the navigator), one toggle per channel in Display options, hidden when a channel has no data in view; own unit label; legend entry. CSV export: trailing columns `aux_<id>` only when attached channels exist (the 11 base columns stay as tested in v13).
- Temperature specifics: show **rate of change** (K/min over a settable window) next to the value; the sensor lags the strain gauge, the rate often matters more than the absolute value.

## 4. `characterization` block in `calibration.json`
```
characterization: {
  status: "measured" | "partly measured" | "user-estimate" | "none",
  eccentricity: { testMassMg, centreRaw, positions:[{name, raw, devMg}], maxAbsDevMg, fractionOfLoad, source:"measured"|"user-estimate", observationIds:[…] },
  creep:        { testMassMg, settleS, samples:[{tS, fraction}], source, observationIds },
  zeroDrift:    { rateMgPerH, seMgPerH, durationS, source, observationIds },
  temperature:  { referenceC, zeroMgPerK, zeroSe, spanPpmPerK, spanSe, source:"measured"|"user-estimate", channelId|null, note }
}
```
Tests are recorded with the existing capture machinery (tagged observations, validity checks, include-anyway override, `removedAndReplaced` where relevant) and stored in `observations[]` with a `purpose` key (`calibration` default | `eccentricity` | `creep` | `zero-drift`). They never enter the calibration fit.

## 5. Wizard steps (Advanced: new tab "5 Characterization"; Simple: optional "Extra checks" after Finish, each skippable)
1. **Eccentricity:** one weight of about a third of capacity (user chooses), centre then four edge positions (guided like the placement plan), each recorded as usual. Deviation per position `devMg = (raw_i − raw_centre) / slope`; `fractionOfLoad = max|devMg| / testMass`. Plain wording: "How much does the reading change if you put the weight off-centre?"
2. **Creep:** place a weight, record for N minutes (default 5, up to 30); `fraction(t) = (r(t) − r(settle)) / (r(settle) − r_empty)` at t = 30 s, 1 min, 2 min, 5 min … (those that fit), settle time chosen by the user (default 10 s).
3. **Zero drift:** record the empty platform for N minutes (default 10, up to 60); weighted linear fit of mass vs time gives rate ± standard error in mg/h (the validity checks must not flag it for a step; a flagged recording is left out unless "include anyway").
4. **Temperature sensitivity:** (a) *with a sensor:* needs the observations to have different temperatures (warm-up or two sessions); regress the empty-platform raw and the span readings against the recorded mean temperature; refuse and say why if the temperature range is < `TEMP_FIT_MIN_RANGE_K` (default 2 K); (b) *without:* type "zero shift mg per 10 K" and "span ppm per K" (datasheet or own estimate), source = `user-estimate`.
Every observation also stores the mean / min / max temperature of its recording for each attached temperature channel (`temperatures:{id:{mean,min,max,unit}}`), automatically.

## 6. Use conditions (`sensor_settings.json`, per load cell, additive keys)
`useConditions: { readingDelayS, sessionSinceTareS, temperatureDeltaK, primaryTemperature }`. Defaults: reading delay 30 s, time since tare 3,600 s, temperatureDeltaK 3 (typed ±, used when no sensor). Shown in the Settings Menu, Sensor tab, in plain words, with the effect on the number.

## 7. New uncertainty components (added to `computeUncertainty`; each listed in the details, each says measured / user estimate)
All rectangular unless stated, standard uncertainty = half-width / √3, dof = ∞ for typed limits, the fit's dof for measured fractions where a standard error exists.
- **Off-centre:** half-width `a = fractionOfLoad × m` (m = mass of the result). Correction of an earlier statement: the centre is the reference, so the largest deviation IS the half-width; there is **no extra ÷ 2**. Scales with the load (stored as a fraction, ppm-like), not one number for the whole range.
- **Creep:** half-width `|fraction(readingDelayS)| × m`, interpolated in the stored curve (constant beyond its ends, flagged).
- **Zero drift:** half-width `|rate| × sessionSinceTareS`, with the standard error of the rate added in quadrature to the half-width before dividing by √3.
- **Temperature:** `ΔT` = largest |T_now − referenceC| over the measurement (sensor) or `temperatureDeltaK` (typed). Half-width `sqrt((zeroMgPerK·ΔT)² + (spanPpmPerK·1e-6·m·ΔT)²)`. Label part "(temperature: your estimate)" unless both sensitivity and ΔT come from measurement/sensor.
- Label examples: `(estimated, repeatability, creep and zero drift measured; temperature your estimate; not traceable)`. A component not measured stays on the "not included" list exactly as today (temperature, creep, off-centre, drift are removed from that list only when included).
- If creep/drift/eccentricity was recorded under a different calibration revision than the active one, say so in the component note.

## 8. Long-term drift (format only)
`checkweighings.json` (or server resource): `{schemaVersion:1, calibrationRevisionId, entries:[{recordedAt, weightId, referenceMassMg, readingMg, sigmaMg, neff, temperatureC|null, note}]}`. Used later for a drift-over-time chart and a "re-check due" hint; no component in the uncertainty yet.

## 9. Harness tests required (in addition to the usual round-trip, validity and escaping tests)
Conversion functions against known values (Steinhart-Hart 10 kΩ NTC at 25 °C = 25.00 °C, polynomial, beta); aux ring buffer wrap, gaps, history merge; `auxValueAt` interpolation and the max-gap rule; shared device time origin (aux and load cell aligned to the same timestamp); eccentricity / creep / drift fits against constructed data with known answers; temperature regression with known slope, refusal below the range limit; each new component against a hand calculation; label wording for all measured / estimate combinations; wizard tabs render; file round trip; old files without `characterization` still load and say "not characterized".

## 10. Open points for the next session
- Units: K vs °C for ΔT (proposal: always K for differences, °C for values).
- Whether Simple mode shows the extra checks as one optional step or three.
- Creep and drift recording lengths are rules of thumb (named constants); revisit after real measurements.
- Firmware: float `raw` for aux channels, shared clock, history for aux ids, `deviceId` in the sensor list.
