# Mass Telemetry Workbench v9: changes

Base: v8. Headless tests (`node audit_harness.js telemetry_workbench_v9.html`): all pass. Browser checks still outstanding (layout, legend, header wrap on narrow screens).

## Layout
- **Settings menu:** now holds Calibration (info, import, export, demo, messages). The right-hand column no longer has a Calibration panel.
- **Settings panel under "Current measured mass" + "Sensor spread":** both cards sit side by side; the panel spans both. Trim % / EMA τ appear only when relevant.
- **Header:** Pause and "+ 100k test samples" next to the theme toggle and Settings.
- **Below the navigator:** Track Live, Select interval, Export CSV, Buffer limit, sample count. The old top toolbar is gone.
- **Full width:** main chart and navigator span the page. The Display options / Selection analysis / Navigation panels form a row below them (wrapping on narrow screens), followed by the log.
- **Measurement:** a logarithmic slider (0.1 s to 300 s, snapping to 0.1 s above 1 s) plus the two text fields. The text fields stay authoritative: any value from 2 samples up to 100,000 (about 21 min) can be typed; larger values are clamped when you press Start, and the field shows the clamped value.

## Spread follows the estimator
The centre line and the ±1σ band of the main chart, the "Sensor spread" card, and the spread in Selection analysis / Measurement results now use the statistic that matches the selected estimator:

| Estimator | Centre | Spread (σ) |
|---|---|---|
| Arithmetic mean | mean | population SD |
| Median | median | 1.4826 × MAD (falls back to 1.2533 × mean absolute deviation if MAD = 0) |
| Trimmed mean | trimmed mean | SD of the retained samples (biased low) |
| Global MAD filter + mean | mean of kept samples | SD of the kept samples (biased low) |
| EMA | EMA | exponentially weighted SD, same τ |

Caveats shown or documented in the code comments:
- Different estimators give different statistics; their σ values are not directly comparable. Legend entries name the statistic ("Upper +1σ (MAD)").
- None of them is a measurement uncertainty.
- Net-mass windows never cross a tare (same rule as the panel).
- Many visible samples: median/trimmed/Hampel are evaluated on a sparse grid (aligned to absolute sample numbers, so panning reuses a cache) and interpolated between; "Curve every Nth sample" appears next to the view label. EMA is evaluated sample by sample with a 7τ warm-up.
- The CSV columns `moving_average_net_mg` and `spread_sigma_mg` remain the arithmetic mean and SD (stored at ingest), whatever estimator is selected.
- Changing the estimator re-creates the charts (the legend labels change).

Measured cost on a 100k-sample buffer in Node (not a browser): live-size view 1.5 ms once cached; whole-buffer view about 100-240 ms in full-resolution mode, most of which is the existing full-resolution drawing cost. Use the min/max downsampling option for large zoomed-out views.
