# Mass Telemetry Workbench: handout v13.2 (read after v13; this overrides earlier handouts where they differ)

Baseline: `telemetry_workbench_v13.html` + `.js`, `audit_harness_v13.js` (250 checks pass), `sensors_example.json`. Not browser-tested so far. Keep the rule: every new behaviour gets a harness test; do not weaken existing ones.
User profile for design decisions: enthusiast, not a metrologist, cannot verify standards (e.g. OIML). Claude manages and implements everything below. Wording must be honest and short, and should teach lightly (e.g. "repeatability" vs "uncertainty").

## 1. Decisions taken
- **OIML class table: postponed.** Tolerances are typed in by the user. The input has a `basis` field (certificate | class-tolerance | user-estimate | none) so a verified table can be added later for professional users.
- **Placements per mass** (Simple mode, default 3, allowed 2 to 10): a wizard setting, not stored in `ui-settings.json`. More placements narrow the uncertainty because the t-factor shrinks.
- **Show more rather than less for now.** The user will decide after weeks of use which displays stay. Section 8 lists every duplicate or variant so nothing is forgotten.
- **Writes need a password if one is set** (section 6). Reads stay open.

## 2. Hysteresis / reverse order (old section 9)
Guided run up (empty, light ... heavy) then down; each observation gets `loadingDirection: "up" | "down"`; per mass the report is mean(down) - mean(up); the fit may use both directions (default; the curve is the mean path, hysteresis listed as a separate component) or one only. Optional "return run" in Simple mode. Fill `reserved.loadingDirection` / `hysteresisAnalysis`.

## 3. Uncertainty (old section 10), built as a repeatability-based estimate
Principle: the app can estimate **random** error from its own data. It cannot see a bias shared by all weights, temperature, creep, hysteresis (until section 2), off-centre loading, or drift between calibration and use. So the number is a lower bound and is always labelled, e.g. **"± 0.04 g (estimated, repeatability only, not traceable)"**. Never call it "uncertainty" without that qualifier unless a typed weight tolerance is included (then "estimated, not traceable").
- **Stage 1, inputs:** per weight `massUncertainty {value, unit, basis, coverageFactor, distribution}`. Certificate: u = U/k. Limits only (class tolerance, "±x mg"): rectangular, u = limit/sqrt 3. Weights without it: visible "not traceable" warning, `traceable: false` (already written for nominal groups).
- **Stage 2, components at mass m:** (a) placement repeatability propagated through the fit (standard error of the fitted curve at m from the residual SD and leverage; replicate-mean scatter for the anchors model); (b) reading noise = SD / sqrt(n_eff) of the measurement (n_eff already computed by the validity checks); (c) resolution; (d) typed weight uncertainty, group mean of n independent weights u/sqrt n, **common bias is NOT reduced and this is stated**. Combine root-sum-of-squares; expanded U = k u_c with k from the t-distribution for the effective degrees of freedom (about 2.4 for 95 % with 7 dof; wider with fewer). Listed as not included: temperature, creep, hysteresis, off-centre, drift.
- **Stage 3, display:** a measurement shows result ± U with the label above. File: separate block `uncertainty {status: "estimated", traceable: false, components: [...], combined, k, basis}`; `validation.status` stays `not-characterized`.
- Optional hint to the user: weight-group between-weight SD captures the random part of weight errors only.

## 4. "±" next to "Current measured mass" (small, under the value)
Three lines, each with a tooltip, to be compared over time:
1. spread σ of the estimator window (already in its own card);
2. uncertainty of the window average, about σ / sqrt(n_eff) (what a longer window improves);
3. **stability:** how much the displayed value itself changed during the last T seconds (max - min of the displayed estimator value over T; start with T = estimator window, make T adjustable later). This answers "is it still moving?" and is not repeatability.

## 5. Spread band modes (toggle in Display options; keep all)
Cause of the observed overshoot (not a bug): band = window mean +/- window SD; after a step the window mixes old and new samples. For a clean step of height H with fraction f of new samples the upper edge is H(1 - f + sqrt(f(1-f))); maximum 1.207 H at f = 0.146, i.e. about 21 % above the old level.
1. **Symmetric sigma** (current).
2. **Asymmetric:** upper line = mean of the samples above the window mean (upper semi-deviation), lower line likewise; cannot exceed the old level after a down-step.
3. **Step-aware:** restart the band window after a change detected by the existing CUSUM step statistic (like a tare starts a new window); works for median-type estimators too.
Default stays 1 until the user decides.

## 6. Authentication (HTTP Basic, handled in our code)
- Server demands Basic auth **only when a password is set, and only for writes** (settings files, calibration files, other file changes). GET, SSE and history stay open (EventSource cannot send headers).
- Do not rely on the browser's native pop-up (not controllable, cannot be forgotten, behaves differently for streams). Own dialog: send `Authorization: Basic base64(user:password)` on write requests; on 401 ask once and retry; keep the password in memory for the tab (sessionStorage); optional "remember on this device" (localStorage, off by default); "forget password" button; never log it, never put it in URLs or exported files.
- Cross-origin note: if the UI is not served from the ESP32 itself, the server must allow the `Authorization` header (CORS preflight).
- Basic auth over plain HTTP sends the password readably; document "trusted home network or HTTPS only".
- Apply to: `UI_SETTINGS_URL` PUT/DELETE, `SENSOR_SETTINGS_URL` PUT, any future calibration upload/save.

## 7. History load of samples (design decision)
Chosen: **independent range request by the web UI**, not history inside the SSE stream.
- Live SSE: every sample carries `id` (monotonic sample ID) and device timestamp; use the SSE `id:` field so EventSource reconnects with `Last-Event-ID`.
- `GET /history?sensor=<id>&from_id=a&to_id=b` returns compact chunks (binary preferred; JSON acceptable at first) with id, t, raw. The server needs no notion of "new user".
- UI procedure: connect live and **buffer** live samples; learn the first live id; fetch the older range in chunks; **prepend** history, then append buffered live samples; deduplicate by id. The current ring buffer only appends, so prepending (and the derived arrays, tare epochs, navigator cache, rolling sums) needs new code and tests, including buffer limits.
- The same mechanism fills gaps after a reconnect (request the missing id range); a missing id range becomes an explicit timestamp gap in the data.
- Server assumptions to confirm during ESP32 firmware work: how many samples it can retain, chunk size limits, binary layout.

## 8. Small and medium items
- **Estimator length as time:** a time field (s) next to the sample count in the estimator settings, linked like in "Measurement" (one line, linear); duration = samples / rate.
- **Sampling time next to sample counts everywhere applicable** (current value detail, selection, log, measurement, wizard). With gaps show the actual time span, not samples / rate.
- Remaining Advanced extras: leave-one-out residuals, environment fields (temperature, humidity, warm-up), export of the full fit report.

## 9. To be checked by the user after some weeks of use (duplicates / variants)
- Spread shown in several places: spread card, chart band, selection result, measurement result, the new "±" lines under the current value (sections 4 and 5).
- Three band modes (section 5) and three weighting options (equal | shrinkage | variance model).
- Simple and Advanced wizard overlap (model choice, weights, warnings); "include anyway".
- Fit tab model comparison vs. the model Simple picks automatically.
- Estimator length in samples and in seconds (section 8).
- Header: sensor selector left, status right (position was a guess).
Decide which of these stay, which become the default, and which are removed.

## 10. Browser checklist (never done)
Header wrap on narrow screens, Y-axis widths with real numbers, legend spacing, navigator at a full buffer, wizard Simple flow with a live stream, include-anyway button, collapsible manual box, settings persistence across reload, Esc handling, auth dialog.

## 11. Working conventions
Pure functions stay DOM-free and are tested in the harness; thresholds are named constants at the top of the relevant section and are echoed in the UI; all new file keys are additive (`schemaVersion` stays 1, unknown keys are ignored); the app never claims an uncertainty it cannot support.
