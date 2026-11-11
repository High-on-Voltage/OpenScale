# Mass Telemetry Workbench - Scientific & Mathematical Decision Record

**Purpose:** Preserve the project's scientific terminology, mathematical choices, assumptions, rationale and open questions. This is a design record, not a claim that the prototype is a certified measurement instrument.

**Companion document:** Read `Mass_Telemetry_Workbench_Project_Handoff` for architecture, current UI, file status and next-session prompt.

---

## 1. Measurement terminology: mass versus weight

A strain-gauge load cell responds to mechanical load/force through deformation and electronics. A weighing instrument uses the action of gravity on the object to determine and indicate its mass. In scientific and metrological labels, use **mass** and mass units (mg, g, kg). The everyday verbs “weigh” and “weighing” are acceptable in user-facing language.

Weight, strictly as a force, is measured in newtons:

F = m × g

The project does not currently intend to report force in newtons. It is a mass-indicating weighing system calibrated against reference masses. The indication can depend on local gravity and operating conditions; transporting a scale to a different location may require gravity compensation or recalibration, depending on accuracy requirements.

OIML R 76 defines a weighing instrument as an instrument used to determine mass by using the action of gravity. NIST distinguishes mass from gravitational weight and recommends using mass when mass is meant. See References.

## 2. Canonical unit and display conversion

### Decision

- Canonical internal mass unit: **milligram (mg)**.
- Internal calibrated values use `Float64Array`.
- Raw sensor counts remain `Int32Array`.
- Display-unit selection is a presentation conversion only; it must not trigger recalibration or recomputation of stored history/statistics.
- `Raw` is a diagnostic mode, not a physical unit.

The application selected mg rather than kg because this is primarily a fine scale. Float64 precision is ample for the proposed mass ranges; choosing mg is a modeling/ergonomics decision, not a fundamental limitation of IEEE-754 double precision.

### Unit conversion convention

Each registry entry has a factor expressed as **mg per one display unit**:

mass_mg = mass_display × factor

mass_display = mass_mg / factor

Initial and planned units include µg, mg, g, kg, avoirdupois oz/lb, troy oz and stone. Avoid ambiguous `oz`: use explicit identifiers such as `oz_av` and `oz_troy`. Fluid ounces are volume units and do not belong in a mass-unit registry.

Locale formatting uses `Intl.NumberFormat`. CSV numeric fields must remain locale-independent (decimal point, not decimal comma) for interoperability.

### Precision versus accuracy

Displayed decimal places are not a claim of accuracy. The user may override the unit's default number of decimals (currently intended range 0-10) to see small changes. Do not round internal values before filtering, calibration, aggregation or export. Optionally indicate when the displayed resolution is finer than the characterized measurement resolution, but do not prevent the user from seeing extra digits.

## 3. Data pipeline and calibration order

The core pipeline is:

1. Acquire raw count `r_i` and relative timestamp `t_i`.
2. Preserve raw count and time unchanged.
3. Apply calibration to each raw sample to obtain absolute mass `m_i` in mg.
4. Apply the tare event active at that sample's timestamp to obtain net mass.
5. Calculate arithmetic MA and standard deviation in calibrated mass units.
6. Format values in the selected display unit only at the presentation boundary.

### Why calibration precedes averaging

The calibration function may be nonlinear (piecewise linear with different segment slopes). In general:

f(mean(raw)) is generally not equal to mean(f(raw)).

Therefore the selected method is **B: calibrate each sample first, then average calibrated mass values**. Auto-Tare likewise uses the average of individually calibrated samples, not merely calibration of the average raw count. Keep an explanatory comment directly above the source pipeline; this is a critical mathematical decision.

## 4. Calibration function

### Current method

Piecewise-linear calibration anchors pair raw response `r` with reference mass `m` (converted to mg). For adjacent anchors `(r_1,m_1)` and `(r_2,m_2)`:

f(r) = m1 + ((r - r1) / (r2 - r1)) × (m2 - m1)

Runtime preparation sorts anchors by raw response and requires at least two anchors with finite, strictly increasing, unique raw values. The monotonic-response assumption must be checked; non-monotonic sensor behavior may indicate a wrong load sequence, hysteresis, sensor issues or invalid data.

### Outside the calibration interval

Decision: linearly extrapolate using the nearest end segment and flag the result as outside the calibrated range. The warning is essential. Extrapolation is a mathematical continuation, not validated measurement performance. Consider a user-configurable maximum extrapolation distance later; do not allow silent unbounded confidence.

### Tare functions

Absolute calibration:

m_absolute = f(raw)

Raw-reference tare:

m_net = f(raw) - f(raw_tare)

Already-calibrated tare:

m_net = f(raw) - tare_mass_mg

These should remain separate, explicit functions to prevent unit/context mistakes. A raw tare reference is recalibrated with the active calibration when a historical selection is explicitly reprocessed. A manual calibrated tare is already a physical mass and is converted into mg.

## 5. Tare is an event, not a mutation

### Decision

A tare is a timestamped event effective from a specific future sample time. It does not rewrite raw samples or earlier displayed net measurements.

For a sample at time `t_i`, find the most recent tare event `e` with `effectiveFromTime <= t_i`:

net_mass_i = absolute_mass_i - tare_mass_for_event_e

Auto-Tare uses the mean of individually calibrated absolute masses from the selected tare window:

tare_mass_e = (1 / n) × sum(f(raw_i)) for the selected tare samples

The event also stores raw reference information (raw mean and/or raw sample snapshot) for diagnostics and potential recalibration. The calibrated tare mass is the actual subtraction quantity.

A moving-average window must not mix net mass values from different tare epochs. On a tare boundary, reset the net-mass rolling MA/EMA state (or otherwise explicitly segment the window).

### Historical selection interpretations

A selected interval should report both:

- **As recorded:** original calibrated history and tare context applicable at each timestamp.
- **Current interpretation:** selected raw samples recalibrated with the currently active calibration and latest tare.

Warn when tare or calibration context differs. Do not silently overwrite the as-recorded result. If a calibration changes, preserve the old calibration revision/configuration sufficiently to reproduce the old result; the current v6 demonstration has only one embedded calibration and no profile-import UI yet.

## 6. Meta Calibration data model

Keep these entities distinct:

### `referenceWeights`

Physical reference objects. Each must have a unique human-readable ID/name, especially if several have the same nominal mass. Suggested fields include:

- `weightId`, `name` or label.
- `nominalMass` and unit.
- `assignedMass` (certificate/assigned value) and its unit, if available.
- `referenceUncertainty` with uncertainty type and coverage factor when relevant.
- Optional certificate ID, manufacturer, class, serial number, notes, date and source.

### `referenceLoads`

**A reference load is a composition of one or more physical weights.** It can represent one physical weight or a combination of smaller weights. Suggested components: `{weightId, quantity}`. The reference load's assigned mass is derived from its components, with uncertainty propagation and covariance considered where appropriate.

This supports future tests such as two individual 50 g weights measured separately and then together. Such a comparison can reveal nonlinearity, platform placement effects or load-distribution effects. Without independently known assigned masses, it cannot establish which component weight is wrong.

### `observations`

Each actual placement/measurement run is a distinct observation. If the same physical weight is removed and placed again, retain the same `weightId` but create a new `observationId`, timestamp, `placementRunId` and placement sequence/index. Keep repeated placements separate in the source data.

Suggested observation statistics:

- `rawMean`, `rawMedian`, `rawStdDev`, `rawMAD`.
- `rawMin`, `rawMax`.
- `sampleCount`, `durationMs`, `recordedAt`.
- Optional outlier method/parameters and accepted/rejected sample counts.
- Optional loading history/direction, temperature, humidity, warm-up time and hardware metadata.

### `calibrationAnchors`

The reduced raw-to-reference-mass anchor set consumed by the runtime interpolation function. Anchors should reference their source observation IDs and record how they were aggregated.

### Repeated equal-value weights: aggregation caveat

Do not conflate equal nominal mass with exactly equal assigned mass. If certificates provide different assigned values, preserve those values and uncertainties. Only group/aggregate them when metrologically justified.

The demo currently uses the arithmetic mean of three observation-level raw means for three nominal 100 g weights. This is illustrative. Future design must decide whether replicate placements receive equal weight, whether an inverse-variance weighted aggregation is appropriate, and how correlated/common reference uncertainty is handled. Do not simply pool all raw samples or weight longer observations more heavily without considering the experimental design.

A same physical weight repeatedly removed/replaced is a repeatability/placement experiment. It should be separate from measuring three different physical weights of the same nominal mass. Keep both use cases distinguishable in the schema.

### Calibration creator

The calibration creator/wizard is future work. Runtime calibration from embedded JSON is present. Future UI should have:

- Simple mode for guided collection and automatic calculations.
- Professional mode exposing statistics, sample counts, uncertainty fields, validation, outlier settings, loading direction and diagnostic detail.

Both modes should generate the same versioned JSON schema.

## 7. Calibration identity and provenance

Use two identities:

- Stable `profileId`: identifies the calibration profile across edits.
- Revision identity/hash: identifies the exact content of a particular saved revision.

Every revision should include timestamp and source metadata. A content hash should be computed from normalized JSON with the hash field excluded. SHA-256 is preferred; a non-cryptographic fallback (such as FNV-1a) must be explicitly labeled as a fallback and never called cryptographic.

Measurement log entries should record the profile ID and exact revision/hash used. If historical reproducibility is required, archive or embed the exact calibration revision, not just its short hash.

## 8. What uncertainty means (and does not mean)

Do not collapse all quality measures into one number. Distinguish:

- **Resolution:** smallest digital/display increment.
- **Repeatability:** variation under repeated conditions.
- **Precision:** closeness/agreement of repeated results.
- **Accuracy:** closeness to the true/reference value (not established by decimal places).
- **Standard uncertainty u:** an estimated standard deviation associated with a result.
- **Expanded uncertainty U:** commonly `U = k u_c`, where `u_c` is combined standard uncertainty and `k` is a coverage factor. A typical `k≈2` is common but does not guarantee exact 95% coverage in every distribution/degrees-of-freedom situation.

### Separate uncertainty contributors

1. Reference mass uncertainty (certificate/assigned value).
2. Sensor repeatability/noise under the calibration measurement conditions.
3. Calibration-model uncertainty (limited points, curve form, interpolation and calibration experiment repeatability).
4. Future measurement variability.
5. Tare estimation uncertainty.
6. Drift, temperature, humidity, mounting and loading/unloading effects.
7. Quantization/resolution and ADC effects where relevant.

Some contributors may be correlated. Reference weights from the same batch/certificate or combinations using common components can have shared systematic uncertainty. Do not automatically combine all uncertainty components as independent.

If uncertainty data are missing, report **not characterized** or **not available**. Never invent a numeric accuracy/uncertainty from sample spread alone.

### Calibration-model uncertainty and check weights

Calibration curve uncertainty comes from limited calibration data and repeatability of the calibration experiment. An independent check weight is measured after the curve is constructed and is not used to fit the curve. Checks near lower, middle and upper portions of the range help evaluate the calibration model in use.

A residual is:

`e_i = measured_mass_i - reference_mass_i`

Residuals from independent checks provide evidence about model performance. They are not automatically the complete model uncertainty; reference uncertainty, repeated measurement variability and other effects still need accounting.

Calibration points used to fit the curve are not independent checks of that same fitted curve: a piecewise-linear curve passes through its anchors by construction. Leave-one-out cross-validation can be a useful internal diagnostic, especially for interior anchors, but it is not equivalent to an independent check artifact and can be optimistic.

NIST describes check standards and calibrated-value uncertainty from calibration curves in its Engineering Statistics Handbook (see references).

## 9. 80 Hz autocorrelation and effective sample size

### Why 80 samples/second does not imply 80 independent samples/second

The sensor/measurement chain can make adjacent readings statistically related:

- Load-cell amplifier or ADC digital/analog filtering.
- Mechanical vibration and settling.
- Electrical filtering and smoothing.
- Slow drift and low-frequency noise.

This is not merely temperature drift. It can occur over milliseconds because the measurement system has memory/filtering. Temperature drift is an additional, usually slower influence.

For independent samples, a common estimate of the standard uncertainty of the arithmetic mean is:

u(mean) ≈ s / sqrt(n)

This is not generally valid for autocorrelated observations. NIST explicitly warns that the traditional independent-sample approach is inappropriate for autocorrelated data.

### Autocorrelation and approximate effective sample count

For a stationary time series with autocorrelation `rho_k` at lag `k`, one common approximation is:

n_eff ≈ n / (1 + 2 × sum(rho_k)), summed over positive lags under suitable truncation

For a simplified AR(1) process with lag-one correlation `rho`, a rough approximation is:

n_eff ≈ n × (1 - rho) / (1 + rho)  [rough AR(1) approximation]

These are model-dependent approximations. Real analysis needs suitable truncation/windowing of the autocorrelation sum, stationarity checks and uncertainty estimates. Do not blindly apply the AR(1) expression to real data.

### Allan deviation

Allan deviation (square root of Allan variance) compares averages over adjacent time intervals as a function of averaging time. It can show where averaging improves stability and where longer averaging stops helping or becomes worse because drift/random-walk-like processes dominate.

Reserve an advanced diagnostics module for:

- Stable-load recordings.
- Histogram and distribution diagnostics.
- Autocorrelation plot.
- Effective sample-size/uncertainty estimate under stated assumptions.
- Allan deviation versus averaging time.
- Drift and stationarity checks.

The current prototype does not calculate effective sample size or Allan deviation.

## 10. Statistical estimators

### Main graph: arithmetic moving average

Decision: the primary MA series on the main graph remains the conventional arithmetic moving average of individually calibrated net-mass samples. Compute using sliding sum and sum of squares in O(1) per new sample (after calibration), with rebuilds only on explicit MA-window or relevant configuration changes.

For a window of `n` calibrated values:

MA = (1 / n) × sum(x_i)

The current implementation uses population-style variance:

population_SD = sqrt(max(0, sum(x_i²) / n - MA²))

This is a descriptive spread over the current window. Review whether the UI label/documentation should say population SD, or whether future statistical reporting needs sample SD (`n-1`) for a specific inferential purpose. Do not casually change the divisor without deciding what statistic is intended.

### Panel estimators

The current panel supports:

1. Arithmetic mean.
2. Median.
3. Trimmed mean (default 10% removed from each tail; configurable 1-30%).
4. Hampel + mean (currently a global median/MAD outlier gate, not a local rolling Hampel filter).
5. Exponential moving average (EMA).

The same selected estimator is used for graph selections and is recorded in the selection log. Raw samples are never deleted or overwritten by estimator rejection.

### Median and MAD

MAD = median(abs(x_i - median(x)))

For normally distributed data, a scaled MAD estimate of standard deviation is approximately:

robust_SD ≈ MAD / 0.6745 ≈ 1.4826 × MAD

MAD is robust to isolated extreme values. It is not “moving average deviation.”

### Trimmed mean

Sort the values, remove the configured percentage from each tail, then average the remainder. The trim percentage in the current UI is per tail (10% per tail means 20% total removed). Retain rejected count and parameters in logs.

### Hampel caution

A classical rolling Hampel identifier uses a local moving median and local MAD around each point to flag local outliers. The current v6 implementation instead computes one median/MAD for the entire bounded estimator window, flags values farther than roughly `3 × 1.4826 × MAD`, and averages the accepted values. It is useful as a simple robust gate but is not a fully local Hampel filter. Consider renaming it `Global MAD-filtered mean` or implementing local rolling Hampel later. Do not silently call the current method a complete Hampel implementation.

### EMA

EMA is stateful, exponentially weighted and uses actual elapsed time:

alpha = 1 - exp(-delta_t / tau)

EMA_t = alpha × x_t + (1 - alpha) × EMA_(t-1)

`tau` is a time constant in seconds. EMA follows changes more smoothly but introduces response delay. Current default tau is 0.5 s; UI range is approximately 0.025-120 s. The chart's main MA remains arithmetic. The panel can use EMA. For interval selection, the EMA is reset at the selection's first sample and calculated across that interval.

### Computation limits

- Main arithmetic MA window currently 2-10,000 samples, computed incrementally.
- Robust panel estimator window currently capped at 4,096 samples.
- For large selection intervals, mean and EMA process all samples in streaming O(N) loops with constant extra memory.
- Median, trimmed mean and global MAD/Hampel selection use up to 4,096 evenly spaced samples in a large selection and disclose that the result is based on a bounded subset. This is an approximation; future versions may use workers or more sophisticated streaming algorithms.

## 11. Outliers and preserving evidence

The existence of an extreme sample does not prove that it is an error. It could be an electrical spike, a mechanical impact, a real load change or an important event.

Decision: raw history is immutable. Outlier handling is a derived estimator choice. Always record:

- Method and parameters.
- Number of total samples.
- Number accepted/used.
- Number flagged/rejected.
- Whether the result is a sample or subsampled estimate.

The user can compare mean, median, trimmed mean and robust-filtered result. Future calibration creation can offer simple/professional settings; beginners need not see every diagnostic by default.

## 12. Meta Calibration and repeatability experiments

Distinguish these experimental designs:

1. Different physical weights with the same nominal mass.
2. Repeated removal/replacement measurements of the same physical weight.
3. A combined reference load made from multiple physical weights.
4. Repeated measurement of a combined load.

They answer different questions.

- Multiple same-nominal weights can characterize variation between physical standards and sensor response, but common manufacturing/certificate error does not vanish through averaging.
- Repeated placements of the same weight can characterize placement repeatability and loading/unloading effects.
- Combining weights tests additivity, nonlinearity and mechanical load-distribution effects.
- Combined reference mass uncertainty must preserve component uncertainties and covariance/common systematic terms.

Keep each physical weight's human-readable name and unique ID. Keep every placement as its own observation. Virtual/aggregated anchors are a derived representation, never a replacement for original records.

Aggregation policy remains open: equal weight per independent placement, inverse-variance weighting, pooled readings or other designs must be selected based on the experiment and covariance assumptions. Longer sample duration should not automatically make one placement dominate the group.

## 13. Calibration validation and hysteresis

Calibration points used to construct the piecewise curve do not independently validate the same curve. Use independent check weights where possible, ideally at lower, middle and upper regions.

Loading/unloading history and previous load should eventually be recorded. Hysteresis means the output at the same applied load can depend on approach direction/history. Future diagnostics may compare:

- Same load approached from below versus above.
- Loading versus unloading cycles.
- Repeat placements at the same level.
- Time since load change / settling interval.

Automated half-guided calibration and automatic loading-direction detection are future topics; do not implement without a clearly defined protocol and evidence.

## 14. Unresolved / future scientific topics

- Decide the replicate aggregation estimator and uncertainty model for Meta Calibration.
- Specify uncertainty propagation for composed reference loads, including covariance.
- Establish a complete uncertainty budget (reference standards, sensor repeatability, calibration model, future measurement, tare, environment, drift, resolution).
- Decide check-standard design and validation acceptance criteria.
- Add autocorrelation and effective-sample-size analysis.
- Add Allan deviation diagnostics and averaging-time recommendation.
- Decide whether current population SD or sample SD is the right displayed spread definition for each context.
- Implement a true local Hampel filter or rename the existing global-MAD estimator.
- Consider weighted means/robust algorithms based on measured data and clearly documented assumptions.
- Treat loading direction, hysteresis, temperature, humidity, warm-up and ESP32 sampling metadata as future additions.
- User-defined JS estimators/extensions are later work. If added, use a documented API and a security warning; a sandboxed iframe with restrictive sandbox/CSP/message API is possible, but sandboxing does not prevent CPU/memory exhaustion.

## 15. Authoritative and useful references

1. **OIML R 76:2006 - Non-automatic weighing instruments.** Official OIML page; scope and quantity classification for mass.  
   https://www.oiml.org/en/publications/recommendations/76/2006/
2. **NIST - SI Units: Mass.** Explains mass versus gravitational weight and common terminology.  
   https://www.nist.gov/pml/owm/si-units-mass
3. **NIST - Uncertainty analysis for autocorrelated measurement data.** Explains why the independent-observation formula is inappropriate for autocorrelated measurements; discusses Allan variance work.  
   https://www.nist.gov/programs-projects/uncertainty-analysis-autocorrelated-measurement-data
4. **Zhang (2006), Calculation of the uncertainty of the mean of autocorrelated measurements.** Metrologia.  
   https://doi.org/10.1088/0026-1394/43/4/S15
5. **NIST Engineering Statistics Handbook - Uncertainties of calibrated values.**  
   https://itl.nist.gov/div898/handbook/mpc/section3/mpc367.htm
6. **NIST Engineering Statistics Handbook - Uncertainty for linear calibration using check standards.**  
   https://itl.nist.gov/div898/handbook/mpc/section3/mpc3672.htm
7. **NIST Engineering Statistics Handbook - Data analysis and model validation.**  
   https://www.itl.nist.gov/div898/handbook/mpc/section3/mpc365.htm
8. **NIST - Median Absolute Deviation.** Defines MAD and its normal-distribution scaling.  
   https://itl.nist.gov/div898/software/dataplot/refman2/auxillar/mad.htm
9. **Zhang (2008), Allan Variance of Time Series Models of Measurement Data.**  
   https://www.nist.gov/publications/allan-variance-time-series-models-measurement-data
10. **MathWorks - Hampel outlier identifier.** Useful explanation of the local rolling median/MAD Hampel method (the current v6 “Hampel + mean” is a simpler global window method).  
    https://www.mathworks.com/help/signal/ref/hampel.html

---

## 16. Scientific principles to preserve in code reviews

- Raw counts and timestamps are source data. Never edit them during calibration, tare, unit conversion or filtering.
- Calibrate individual samples before averaging whenever calibration may be nonlinear.
- Use one explicitly documented canonical unit (mg) internally.
- Convert display units only at the UI/export presentation boundary.
- Tare is a timestamped event; never rewrite earlier values.
- Keep as-recorded and current-reprocessed historical interpretations distinct.
- A standard deviation of readings is not the uncertainty of their mean.
- Do not use `s/sqrt(n)` unless independence assumptions are justified or dependence is modeled.
- A larger sample count does not necessarily mean more independent information.
- Calibration anchors, reference weights, composed reference loads and observations are distinct entities.
- Do not treat nominally equal weights as identical assigned masses without evidence.
- A fitted calibration anchor is not an independent validation check.
- Extrapolated values must be flagged.
- Display decimals never establish accuracy.
- Outlier detection must be transparent, parameterized and non-destructive.
- Do not claim a complete uncertainty budget or legal-metrology conformity unless it has actually been established.
