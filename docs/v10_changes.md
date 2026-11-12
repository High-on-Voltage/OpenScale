# v10 changes

## Fixes requested
| Request | Cause found in v9 | Change |
|---|---|---|
| Estimator change reloads the navigator | The select handler destroyed and rebuilt both charts | Charts are created independently; estimator change rebuilds only the main chart. Crosshair sync looks up the other chart at event time. The rebuilt main chart also keeps the responsive height (v9 reset it to 390 px). |
| Navigator flickers | Stride sampling (every k-th sample) changed k and phase as the buffer grew/wrapped | Min/max buckets of 2^L samples aligned to absolute sample numbers, complete buckets cached; ~4 points per pixel (v9: 1,600 total) |
| Y axis swims | Both edges moved a fraction towards the data extent on every frame | Per-edge dead-band with latch (`autoYStep`): moves only when data enters half the padding or >12 % of the span is empty; stops within 2 % of target |
| Y axis after background tab | Damping from stale values | One undamped step (`snapY`) after `visibilitychange` or a >2 s render gap, then normal damping |
| Log hover / click highlight | Hover did not exist; click highlighted only selection/measurement, only in the main chart; tare/calibration entries had no highlight; navigator never had one | Hover and click highlight in both charts for all entry types (white dashed = hover, blue = clicked); tare/calibration as lines |
| Event information on hover | n/a | Tooltip for tare/calibration markers, a lane at the top edge listing every logged selection/measurement, and any currently highlighted selection/measurement (also while running) |

## New
- Validity analysis (pure functions, thresholds visible in every result): gaps/duplicates (timestamps, optional device counter), autocorrelation and effective sample size, Allan deviation, CUSUM step vs trend, spectral vibration lines. Shown in Selection analysis, Measurement, log rows and tooltips.
- `hampelLocal` (sliding Hampel) and `emaNorm` (seed-normalised EMA); old `hampel` and `ema` kept.
- Settings: simulator test signal (wandering / quiet / hum / steps).
