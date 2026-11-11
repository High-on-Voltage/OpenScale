# Mass Telemetry Workbench - Project Handoff

**Purpose:** Carry the complete project context into a fresh ChatGPT session without having to reconstruct the design discussion.

**Current implementation file:** `telemetry_workbench_v6.html`  
**Current project state:** v6 is the current working prototype. Attach this HTML file to the next session together with this handoff and the scientific/mathematical decision record.

**Important:** This document distinguishes implemented behavior in v6 from agreed requirements and future work. Source inspection is not the same as full real-browser verification. No real sensor hardware or traceable calibration data has yet been supplied.

---

## 1. Project purpose

Build a responsive, self-contained browser-based mass telemetry and weighing dashboard. It began as an 80 Hz sensor visualization, but has evolved into a small measurement and calibration system.

The application is intended to:

- Acquire sensor readings locally in the browser (currently simulated at 80 Hz).
- Preserve raw sensor counts and timestamps without rewriting historical samples.
- Convert raw counts into calibrated mass using a user calibration profile.
- Apply timestamped tare events without changing previous measurements.
- Plot calibrated instantaneous mass, an arithmetic moving average and a standard-deviation spread band.
- Support long histories (the user has tested 1 million samples successfully with downsampling enabled).
- Provide alternate estimators for the main numeric readout and selections.
- Keep measurement context and events in an interactive session log.
- Eventually connect to an ESP32 and use its real sensor stream, startup/warm-up history and hardware metadata.

This is not currently a certified or legally verified weighing instrument. The embedded calibration data is illustrative software-test data only.

## 2. Files and current baseline

The latest prototype is `telemetry_workbench_v6.html` (single HTML file, approximately 93 KB at the time of handoff). Use it as the implementation baseline; do not silently revert to v5 or earlier.

The HTML embeds:

- CSS and JavaScript.
- An inline `unitConfig` JSON block.
- An inline `calibrationConfig` JSON block containing demonstration data.
- The GNU AGPLv3 header and attribution `AI Collaborator` (add your own name).

The only external runtime dependency is uPlot from jsDelivr CDN (CSS and asynchronously loaded JS). The dashboard shell and simulated acquisition start before uPlot finishes loading. Internet access is required for the chart library. The telemetry and calculations otherwise run locally.

**Next-session instruction:** Open and inspect the attached v6 file before editing. Do not rely only on this document for source-level behavior; use the current file as the source of truth.

## 3. Product and interaction requirements

### Responsive application

- Must work on desktop, tablet and smartphone.
- Touch-friendly controls and chart interactions.
- Dark theme is the default; light theme can be toggled.
- Settings are in a click/tap-operated floating gear menu, not hover-only.
- Browser locale is used for displayed number separators via `Intl.NumberFormat`.

### Acquisition and raw storage

- Nominal sample rate: 80 Hz (12.5 ms period).
- Runtime/timestamps: `Float64Array` in relative milliseconds.
- Original sensor counts: `Int32Array`.
- Raw sensor history must never be modified by tare, calibration, unit conversion, smoothing, outlier handling or display formatting.
- Fixed buffer options currently include 10k, 50k, 100k, 250k, 500k, 1M and 2M samples.
- Unlimited mode grows in chunks of 100,000 samples. It is not literally unlimited: browser/device memory remains the ultimate limit.
- A button adds 100,000 synthetic test samples in 10,000-sample animation-frame batches.

### Simulator

The current simulator produces **bounded marching randomness**: a slowly wandering random walk with occasional direction changes, mean reversion toward roughly 5,000 raw counts, and small measurement noise. It is a test signal only and must never be presented as real sensor data or a calibration.

### Calibration and mass

- Use technical quantity terminology **mass**, not force/weight, in primary technical labels and data fields. Everyday wording such as “weighing” is fine where natural.
- A load cell responds to mechanical force/strain; the weighing instrument uses gravity and a calibration/reference relationship to indicate mass.
- Canonical internal mass unit: **milligrams (mg)**.
- All calibrated buffers and statistics remain in mg. Unit selection changes presentation only and does not recalculate history.
- The display-unit registry currently includes micrograms, mg, g, kg, avoirdupois oz/lb, troy oz, stone and a special Raw diagnostic mode.
- A unit's `factor` is the number of milligrams per one display unit. Convert display value to mg by multiplication; convert mg to display units by division.
- Raw is a diagnostic mode, not a physical mass unit.

### Calibration function

- Calibration anchors map raw sensor response to reference mass.
- Reference mass values are converted from the unit declared on each anchor or the calibration profile into canonical mg.
- Anchors are sorted by raw response and must have strictly increasing unique raw values.
- The calibration function uses piecewise-linear interpolation between neighboring anchors.
- Outside the first/last anchor it extrapolates using the nearest segment and returns an explicit `outOfRange` flag.
- Out-of-range samples must be visibly flagged; extrapolation is not evidence that the sensor is valid outside the calibrated span.
- The source has separate functions for absolute calibration, raw-tare net mass and already-calibrated-mass tare.

### Tare

- Tare is an event, not an edit to raw or historical calibrated samples.
- A tare event records event ID, timestamp, effective-from runtime, method, tare mass in mg, raw tare reference when available, source sample count, previous tare and calibration revision.
- A tare event applies only to future samples. Earlier samples remain interpreted with the tare active at their own timestamps.
- Auto-Tare uses the mean of individually calibrated absolute samples in the current MA window. This follows the agreed statistically correct order for potentially nonlinear calibration.
- Manual tare is entered as a mass in the selected display unit and converted to mg.
- Chart tare markers are vertical historical event markers.
- A new tare resets the calibrated rolling MA/EMA window so one MA window does not mix two different net-zero epochs.
- Tare events are logged.

### Main chart and navigator

- Main chart displays calibrated instantaneous net mass, arithmetic moving average, and the upper/lower one-standard-deviation band.
- Raw diagnostic mode displays sensor counts instead of calibrated mass.
- Zero-to-lower-spread fill and zero-to-instantaneous-mass fill are independent options.
- The always-show-zero-line option is separate from either fill. A fill uses zero as a geometric boundary; it must not force the visible zero reference line or a zero gridline.
- Main chart supports live tracking, wheel zoom, pinch zoom, drag-to-pan, Shift-drag selection and touch selection mode.
- Default live viewport is 5 seconds. It fills first and then scrolls; zooming changes the active live window span.
- Historical inspection pauses automatic live following. Track Live returns to newest samples.
- Y-axis automatic scaling has a configurable response slider for gradual movement; manual Y min/max controls are also available.
- Optional min/max-envelope downsampling is disabled by default (full resolution). When enabled for large visible windows it buckets samples and keeps local extrema instead of simply skipping every Nth sample. It targets roughly a few points per horizontal pixel.
- Main downsampling currently chooses extrema from the instantaneous displayed series, then uses those same sample indices for MA and spread. It does not mathematically guarantee preservation of independent MA or band extrema; revisit if needed.
- Mini navigator displays retained history, has a Time legend and gridlines, and supports viewport selection by dragging.
- Main chart and navigator have synchronized X crosshairs. This crosshair is distinct from log-entry highlighting.

### Numeric panel and estimators

- Main chart MA remains arithmetic moving average.
- Moving-average window is adjustable by slider and numeric input; current range 2-10,000 samples. Updating the window rebuilds historical derived series.
- The current-value panel offers arithmetic mean, median, trimmed mean, Hampel + mean and EMA.
- Robust estimator window is bounded at 4,096 samples.
- Trimmed mean currently removes a configurable percentage from each tail (default 10%, range 1-30%).
- EMA uses a time constant in seconds and actual sample time deltas.
- The panel spread is a descriptive sample-window standard deviation, not a complete uncertainty of the mean.
- The current Hampel implementation is a global median/MAD outlier gate over the bounded panel/selection window, not a classical local rolling Hampel filter. Consider renaming it or implementing a true local Hampel filter later.

### Selection, log and export

- Selection uses the currently selected panel estimator.
- Selection shows original as-recorded result and a recalculated result using current calibration/latest tare, plus raw mean/spread, sample counts and out-of-range counts.
- It warns when the current tare context differs from the original context. Calibration-revision-change reporting is represented in the selection/log logic, but current UI does not yet support loading/changing calibration profiles.
- Robust estimators on large selections use at most 4,096 evenly spaced samples and disclose that not all selected samples were processed. Mean and EMA stream over all selected samples in O(N) with constant extra memory.
- Clicking a log entry jumps to the relevant time interval/event and highlights retained samples. If the samples have rolled out of the ring buffer, the event/result remains in the log and the UI reports that source samples are no longer available.
- CSV export includes runtime, raw counts, absolute mass mg, historical tare mg, net mass mg, MA, spread, tare event ID, profile ID and revision ID.

## 4. Calibration JSON structure currently embedded in v6

The current demo JSON has `schemaVersion: 1` and these main structures:

- `profileId`, `profileName`, `createdAt`, `modifiedAt`, `applicationVersion`.
- `calibrationUnit`, `calibrationMethod`.
- `sensor`: model, hardware ID, ADC resolution bits, sampling rate.
- `environment`: temperature, humidity and notes (currently null/reserved).
- `referenceWeights`: physical reference objects, each with unique `weightId`, human-readable `name`, nominal mass, optional assigned mass, unit and optional reference uncertainty.
- `referenceLoads`: compositions of one or more physical weights. A load can contain multiple `weightId` components and quantities.
- `observations`: individual measurement/placement runs with `observationId`, `weightId`, `loadId`, timestamp, `placementRunId`, `placementIndex`, replacement flag, raw mean, raw SD, raw median, raw MAD, sample count, duration and reserved outlier method.
- `calibrationAnchors`: mathematical raw-to-mass pairs used by the runtime interpolation engine, with source observation IDs and aggregation metadata.
- `validation`: currently `not-characterized`, with reserved checks and model uncertainty.
- `reserved`: warm-up time, load approach/direction, hysteresis analysis, temperature/humidity compensation.

The demo contains an empty/zero reference, three nominal 100 g physical weights with separate IDs/observations grouped into a virtual 100 g anchor, and a 200 g reference. All numbers are illustrative only.

### Meta Calibration decisions

- Repeated same-nominal-value weights should be retained individually as physical reference weights and separate observations.
- The calibration engine may use one virtual/aggregated anchor for a group of genuinely equivalent reference masses.
- Individual assigned/certificate masses and uncertainties must not be erased. If same-nominal weights have different assigned masses, do not treat them as exactly identical.
- A physical weight measured repeatedly after removal/replacement should keep the same `weightId`, but each placement should have its own `observationId`, timestamp and placement/run sequence metadata.
- `referenceLoads` represent compositions of reference weights. This supports future combinations of smaller weights without redesigning the schema.
- The current demo anchor uses the arithmetic mean of observation-level raw means for its three nominal 100 g weights. The scientifically preferred aggregation policy for unequal sample counts, unequal repeatability or unequal assigned-mass uncertainties remains a future decision. Do not assume pooled-sample or simple-mean aggregation is always correct.
- Combined-weight uncertainty must consider covariance/common systematic errors where relevant; uncertainty cannot automatically be combined as if all component weights were independent.
- Calibration creator/wizard and automatic meta-calibration grouping are future features. The current dashboard only loads the inline demo JSON; no calibration file import/export or creator UI exists yet.

## 5. Performance history and lessons learned

The project went through several performance and interaction fixes. Preserve these lessons when refactoring:

1. The early dashboard appeared stuttery because it redrew only every 100 ms (about 10 FPS) and recalculated all historical derived arrays on each render.
2. Move moving-average/spread calculation to sample ingestion or explicit rebuild operations. Do not rebuild all history on every animation frame.
3. Render through `requestAnimationFrame`; keep ingestion and rendering decoupled.
4. `uPlot.setData()` can reset scales. Set the new data first and then restore the desired X scale in the same batch.
5. The live window span must be decoupled from tracking state. In live mode, zoom changes the span; live follow still moves the viewport to newest samples.
6. Initial live window is 5 seconds; allow it to fill before scrolling.
7. Do not force downsampling by default. Full-resolution mode is the user preference. Min/max downsampling is an optional performance mode for large windows; user confirmed it works well with 1M samples.
8. Unlimited buffer should grow in 100k chunks, not double a large allocation. It still needs sensible safeguards/documentation because unlimited growth can exhaust device memory.
9. Zero-fill overlays must be independent of the zero reference line and must not force zero into the Y range or draw a zero gridline. The zero line is a separate explicit option.
10. Keep the navigator light and limited (the current mini data is capped around 1,600 points).

### Current core memory estimate

The current v6 raw/derived ring storage contains six `Float64Array` buffers (`times`, `massMg`, raw MA/SD, mass MA/SD) plus one `Int32Array` raw buffer. That is approximately 52 bytes/sample, or about 52 MB decimal per 1,000,000 samples (about 49.6 MiB), excluding plot buffers, JS objects, log/events and browser/uPlot overhead. This corrects the earlier rough estimate that omitted one Float64 series.

## 6. Current implementation status versus future work

### Present in v6 source

- Single HTML with inline CSS/JS and AGPLv3 header attribution.
- Async uPlot CDN load; dashboard shell and 80 Hz simulation start before chart library completes.
- Bounded marching-randomness simulator.
- Typed ring buffers, fixed capacities and 100k-step unlimited growth.
- Inline unit and calibration JSON.
- Unit conversion with mg canonical base and raw diagnostics.
- Piecewise interpolation/extrapolation with out-of-range flag.
- Event-based tare, auto/manual tare and tare markers.
- Per-sample calibrated absolute mass and historical net mass.
- Arithmetic MA and SD series, panel estimators, unit/precision controls.
- Main chart, navigator, downsampling option, synchronized crosshair, zoom/pan/live tracking.
- Selection, log highlighting, CSV export, zero-fill options, zero-line toggle, smooth Y response.

### Not yet implemented or not production-ready

- Real ESP32 data connection, device metadata, warm-up information and historical samples from hardware.
- User calibration JSON file upload/import/export and schema validation UX.
- Calibration creation workflow (simple and professional modes).
- Full Meta Calibration UI, repeated-placement collection, group aggregation choices and composition-measurement workflow.
- Reference-weight certificates and complete uncertainty propagation.
- Independent check-weight validation and defensible calibration-model uncertainty.
- Autocorrelation/effective sample size and Allan deviation diagnostics.
- Environmental compensation and automatic hysteresis detection.
- User-defined JavaScript estimator/extensions.
- Export of a complete selected interval plus all associated raw samples/calibration context as a self-contained measurement package.
- Formal legal-metrology/OIML conformity or traceability claims.

## 7. Important implementation cautions for the next session

1. **Inspect the existing v6 source before changing code.** The handoff summarizes intended and observed source behavior, but source-level testing is still required.
2. **Validate calibration input strictly.** Require at least two anchors, finite numeric fields, supported mass units, strictly increasing raw values and a monotonic sensor response. Decide how duplicate/near-duplicate anchor raw values are handled (currently rejected as not unique).
3. **Don't confuse reference weights, reference loads, observations and anchors.** They are different entities.
4. **Don't claim uncertainty from standard deviation alone.** The current panel spread is descriptive repeatability/spread information.
5. **Do not silently discard outliers or raw samples.** All rejection must be a derived estimator result and logged.
6. **Don't recalculate the entire retained history on each render.** Full rebuilds are acceptable only on explicit settings/configuration changes and should be scheduled/progress-aware for large buffers.
7. **Check tare-window boundaries carefully.** A moving average should not combine net-mass values from different tare epochs.
8. **Keep CSV values locale-independent.** Use decimal point and stable field semantics in CSV even if the UI uses decimal comma.
9. **Keep the user's full-resolution option.** Downsample only when enabled.
10. **Test 1M samples** with downsampling on and off, and profile on actual browsers/devices before making FPS claims.
11. **Be explicit about calibration extrapolation.** Display an out-of-range warning and consider a configurable allowed extrapolation margin later.
12. **The FNV fallback is not cryptographic.** v6 uses SHA-256 via Web Crypto when available; in `file://` contexts where subtle crypto is unavailable it labels an FNV-1a fallback. Never call that a secure hash.
13. **Current demo calibration is not valid for actual hardware.** Replace it before real weighing.
14. **Current v6 calibration is an inline constant.** `calibrationRevisionId` and profile hash are computed at runtime; calibration change/upload workflow is still future work.
15. **Potential future defect to revisit:** robust estimator called “Hampel + mean” is currently a global median/MAD filter on the panel/selection window, not a classic rolling Hampel identifier.
16. **Potential future enhancement:** min/max downsampling currently chooses buckets from the instantaneous series only; consider preserving MA and band extrema independently if the display needs stricter envelope fidelity.
17. **Potential future enhancement:** unlimited buffer has 100k chunks but no absolute hard cap. Consider warnings, memory budget or an explicit user-defined max.

## 8. Recommended next development sequence

1. Run v6 in real target browsers and audit current behaviors before feature work.
2. Add/validate calibration JSON import and schema validation; keep the embedded demo fallback.
3. Make revision identity deterministic and robust for normalized JSON; retain SHA-256 where supported and clearly labeled fallback elsewhere.
4. Add calibration profile selection / loading only after a safe schema and validation path exists.
5. Build independent unit tests for interpolation, extrapolation, unit conversion, raw/mass tare and event boundaries.
6. Improve selection recalculation and event/revision provenance.
7. Add calibration creator simple mode, then professional mode.
8. Add repeated placements and Meta Calibration aggregation policies; preserve individual observations.
9. Add metrological validation and uncertainty model only after enough data/provenance exists.
10. Add diagnostics (autocorrelation, effective sample count, Allan deviation, hysteresis) and extension API later.

## 9. Ready-to-paste prompt for a new ChatGPT session

> I am continuing the Mass Telemetry Workbench project. I am attaching three files: (1) the current `telemetry_workbench_v6.html`, (2) the Project Handoff document, and (3) the Scientific & Mathematical Decision Record. Please read both documents and inspect the actual HTML source before making changes. Treat v6 as the current baseline. Preserve the single-file HTML architecture, AGPLv3 header/attribution, uPlot CDN-only dependency, 80 Hz acquisition, immutable raw ring buffer, incremental processing, live/zoom behavior, full-resolution default and optional min/max downsampling. Do not rebuild or redesign working functionality unnecessarily. Distinguish current implementation from future plans as described in the handoff. The next phase should begin with a careful v6 code audit and test plan, then proceed incrementally. Do not claim scientific accuracy or measurement uncertainty that the current demo data cannot support. The embedded calibration is illustrative only, not valid for my hardware. Keep all important mathematical rationale in English source comments. Ask only when a genuinely unresolved product decision blocks progress; otherwise make a clearly documented, conservative implementation choice.

---

## 10. Current project facts at a glance

- **Baseline:** `telemetry_workbench_v6.html`, one AGPLv3 HTML file; uPlot is the only CDN dependency.
- **Acquisition:** 80 Hz bounded marching-randomness simulation; future ESP32 integration is planned.
- **Storage:** immutable raw `Int32Array`, relative-time and derived `Float64Array` ring buffers; 100k growth chunks in Unlimited mode.
- **Measurement:** canonical mg, inline demo calibration JSON, piecewise-linear interpolation/extrapolation warning, timestamped tare events.
- **Processing:** calibrated arithmetic MA/spread for the chart; selectable panel/selection estimators; raw diagnostic mode.
- **Navigation/performance:** 5 s live window, zoom/pan, navigator and crosshair, full resolution by default, optional min/max downsampling. User reports 1M samples work with downsampling enabled.
- **Still future:** real hardware stream, user calibration import/creator, full Meta Calibration workflow, defensible uncertainty analysis and advanced diagnostics.

## 11. First-session validation checklist

Before making feature changes in a new session:

1. Open v6 in the target browser(s); check the console and confirm the uPlot CDN loads successfully.
2. Verify the initial five-second live window, 80 Hz sample cadence, live tracking, wheel/pinch zoom, pan and navigator selection.
3. Verify that unit changes and display-precision changes do not rewrite or recalculate stored canonical mg values.
4. Verify that a new tare affects only future samples, while historical values remain unchanged; separately test current-tare historical recalculation.
5. Test interpolation between calibration anchors and extrapolation outside the range; confirm out-of-range flags are visible.
6. Run the 100k test-sample action and test a large window with optional min/max downsampling; monitor browser memory and responsiveness.
7. Inspect log and CSV output for timestamps, raw counts, canonical mass, tare context, calibration revision and estimator provenance.

