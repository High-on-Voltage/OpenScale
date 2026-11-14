# Mass Telemetry Workbench: changes in v13 (read after the v12.4 handout; this overrides it where they differ)

Files: `telemetry_workbench_v13.html` + `telemetry_workbench_v13.js` (keep together), `audit_harness_v13.js` (`node audit_harness_v13.js telemetry_workbench_v13.html`; **250 checks pass** = v12's 190 + 60 new), `sensors_example.json` unchanged.
**Still not opened in a browser** (v11, v12, v13): header/chart layout, axis sizing, legend spacing, modal layout, SVG plots, localStorage, wizard with a live stream. The harness covers logic only.

## 1. Small items
- **Y axes** (both charts) are now as wide as their widest tick label (uPlot auto-size recipe), so large numbers with separators fit. Navigator X axis is taller (labels were clipped).
- **Legend overlap:** cause was a fixed CSS height (`#mainChart`, `#miniChart`, and a mobile rule) equal to the plot height, so the legend overflowed. Fixed heights removed; legend has padding.
- **Navigator** now lives in the main chart panel, without its own title. It refreshes every 50 ms below 5,000 samples, 100 ms below 20,000, 160 ms below 60,000, then 250 ms.
- **Header:** `[title] [sensor selector] [test-signal select] ... [buttons] [status, right-bound]`. My reading of "streaming identifier right and right-bound"; moving the status elsewhere is one element move in the header.
- **Wizard, 2 Observations:** previous/next buttons around the load drop-down; manual entry is one collapsible box (closed by default, state kept); the validity result of every recorded observation is expandable (full check list, also stored in the file as `validityChecks`).

## 2. Bugs
- **"4 recording" with 3 unreachable streams:** the status counted every listed, un-paused sensor. It now counts sensors whose link is really live (test signal running, or an open server connection): "1 of 4 sensors streaming". Pause all / Resume all still act on everything.
- **Navigator flicker at a full buffer:** reproduced in the harness. Once the ring wrapped, a cached min/max bucket became the *oldest* bucket after part of it had been overwritten; its stored sample indices then pointed at evicted slots and mapped to the newest sample, which gave the "single line at the end". Cached buckets are now used only while all their samples are still retained. Regression test at capacities 1,000 and 10,000.

## 3. Milestones from the v12.4 handout, section 7
1. **Weighted fitting** (`fitCalibration(points, model, {weighting})`): `equal` (default, bit-identical to v12), `shrinkage` (nu0 = 3), `variance-model` (sigma = c0 + c1 m). Fallback chain variance-model -> shrinkage -> equal, announced in `weighting.reason`. Floor on sigma. Reduced chi-square, weights and standardised residuals in the Fit tab (table + third plot). Written to `fit.weighting`, `fit.chiSquare`, `fit.reducedChiSquare`, `fit.warnings`.
   *Measured benefit (400 seeded runs, sigma growing 0.3 -> 20 counts, 9 masses x 4 placements):* slope error vs equal weights: shrinkage about 7 % lower, variance model about 39 % lower. Shrinkage is deliberately cautious; with few placements the variance model is the stronger choice but needs 3 masses with 2+ placements. The piecewise-linear model averages replicates and is not weighted.
2. **Weight groups:** `referenceWeightGroups`, `referenceWeights[].groupId`, `massBasis` nominal | assigned, `aggregation` mean-of-placements | variance-components. Nominal groups are written with `traceable: false` and a note. Per group: one-way variance components (within-weight and between-weight SD, F, informal "weights differ" verdict) and **relative masses** per weight (`relativeMassToGroupMean`, with approximate standard error). v12 files are migrated (equal-mass weights become one group).
   *Grouping rule as built:* the fit still pools by **effective mass** (v12 rule). A group with basis "nominal" makes its members the same mass; with basis "assigned" members keep their own masses and deviating ones become separate masses. So "explicit groupId" decides the mass, not a separate pooling mechanism.
3. **Simple / Advanced** (`wizardMode` in `ui-settings.json`, default `simple`, autosaved, switch in the wizard header, no data lost). Simple: typed list ("3 x 100 g, 1 x 200 g"), wizard proposes the next placement (3 per mass; group members take turns), fixed 10 s recordings, plain verdicts ("settled", "still drifting", ...), model chosen automatically (straight line if >= 3 masses, dof left and no point off the line by more than 0.5 % of the span, otherwise point-to-point), shrinkage weights, plain-language warnings, reminder to check with a known weight.
   **"Include anyway"** in both modes: stored as `included`, `overrideReason`, `overrideAt`, `fit.overriddenObservations`; survives a file round trip. A fit without degrees of freedom is allowed, warning stored in `fit.warnings`.
4. **Regression:** `weighting: equal` reproduces v12 numbers (test X4).
- **Section 8 (Qty):** removed. Combinations are made in a dialog with one checkbox per weight.

## 4. Not done (needs your decision or is a larger step)
- **Hysteresis / reverse order (section 9)** and **uncertainty (section 10, stages 1-3).** You asked earlier for uncertainty information with a warning for uncertified weights; v13 only adds the warning ("not certified ... can only be as accurate as the weights") and `traceable: false`, not numbers. Stage 1 (per-weight uncertainty input) is the logical next step.
- Advanced extras from section 6 still open: leave-one-out residuals, environment fields, full fit-report export.
- Simple-mode constants are rules of thumb: 3 placements, 10 s, 0.5 % line tolerance, nu0 = 3, sigma floor, 5 % variance-model minimum. All are named constants at the top of the wizard / fit code.
- Browser checklist: header wrap on narrow screens, axis widths with real data, legend spacing, wizard Simple flow with a live stream, include-anyway button, collapsible manual box.
