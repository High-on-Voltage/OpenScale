## Overall

I found no wrong formulas. The interpolation, MAD constant (1/0.6745 ≈ 1.4826), 3×MAD gate, population SD, EMA α, AR(1) n_eff, U = k·u_c caveat, per-tail trimming and unit-conversion direction are all correct. The mass/weight terminology is also right. The problems are in justifications, two internal inconsistencies, one numerical hazard, some modelling gaps and a few citation details. They are listed by importance.

## Substantive problems

**1. §3: the argument for "calibrate, then average" doesn't follow.** The fact that f(mean(raw)) ≠ mean(f(raw)) shows the two methods differ, not which is right.
- If noise is additive in the raw domain and the load is steady, f(mean raw) is the consistent estimator. mean(f(raw)) is biased at a kink (Jensen's inequality, about 0.4 × σ_raw × slope change at worst).
- If the load moves during the window, mean(f(raw)) is the correct definition of time-averaged mass.
- So Method B is defensible but purpose-dependent, and for a near-linear load cell the difference is tiny. Calling it "critical" and implying the alternative is wrong overstates it. "Method B" is also used without "A" being defined in this document.

**2. §4 vs §5: the tare definitions disagree.** §4's raw-reference tare is f(raw_tare), which is f(mean raw) if raw_tare is a mean. §5's Auto-Tare is mean(f(raw_i)). These differ when the tare window straddles an anchor, and the first contradicts §3. §5 also says to store the "raw mean and/or raw sample snapshot". With only the mean, a reprocess can't reproduce the original tare. Require the snapshot, or define the reprocessing tare explicitly.

**3. §10: the sliding Σx²/n − MA² variance is numerically fragile in mg.**
- Cancellation: at 1 kg (10⁶ mg), x² ≈ 10¹², so rounding error in Σx²/n is about 10⁻⁴ mg² per update. At 50 kg it is about 0.3 mg², which swamps a sub-mg noise variance.
- Silent failure: the `max(0, …)` clamp hides negative results by reporting SD = 0.
- Drift: add/subtract updates with no periodic rebuild accumulate error over long runs.
- Link to §2: "Float64 is ample" holds for storage but not for this formula, and mg (vs g) inflates x² by 10⁶.
- Fix: use shifted sums or a Welford-style update, recompute every N samples, and optionally use compensated summation.

**4. §10: EMA over a selection.** Resetting at the first sample gives the initial value a weight of e^(−T/τ). With τ = 120 s on a 10 s selection, about 92% of the output is the first sample, so it isn't a comparable interval statistic. Use normalized (bias-corrected) weights, or label it an "end-of-selection filtered value". Also guard Δt ≤ 0, since a timestamp reset makes α negative.

**5. §4: interpolating through noisy anchors.** A piecewise-linear interpolant passes exactly through every measured anchor, so anchor noise becomes slope kinks. For a near-linear sensor a (weighted) least-squares fit usually has lower uncertainty. The document doesn't discuss this trade-off. Refs 5–7 (NIST handbook calibration sections), as far as I know, cover regression-fitted curves, so their formulas apply to an interpolant only by analogy.

**6. §10: Hampel/MAD gate when MAD = 0.** Quantized or tied data can make MAD zero, so the threshold collapses to zero and everything not equal to the median is rejected. Add a scale floor. A window spanning a load step also makes the gate arbitrary.

**7. §10: "evenly spaced" subsampling (4,096 points).** Systematic sampling can alias with periodic disturbances such as mains pickup or vibration, biasing the median and trimmed mean. Stratified or random sampling, or exact computation, avoids this. Sorting a Float64Array of 10⁶ values is fast, so the cap may be unnecessary.

**8. §12: inverse-variance weighting.** If weights come from within-run s²/n, long or quiet runs dominate. That contradicts the next sentence, and §9 says s²/n is too small for autocorrelated data. Weights should reflect between-placement variance.

**9. §5: "latest tare" for historical selections.** Applying the newest tare to old samples contradicts "tare is an event" and can give meaningless net values if the container changed. Default to the tare in force at the time, re-expressed under the current calibration, with "latest tare" as an explicit option.

## Gaps

- **Air buoyancy / conventional mass (§1, §6):** OIML R 76-1 says "mass" is preferably meant as conventional mass, the result of weighing in air per R 111 and D 28. `assignedMass` doesn't say whether it is conventional or true mass. For a ~2700 kg/m³ weight the two differ by about 3×10⁻⁴ (≈30 mg at 100 g), which is large against a mg display.

## References

- **Ref 1:** The standard is OIML R 76-1:2006 (Part 1). The definition of a weighing instrument matches what §1 says.
- **Ref 4:** Verified: the title, Metrologia and DOI are correct. The page range is S276–S281.
- **Ref 9:** NIST lists it as "Allan variance of time series models for measurement data", Metrologia 45, 549–561 (2008). The document's wording differs ("of … Models of") and gives no journal, volume or pages.
- **Not opened:** refs 2, 3, 5–8, 10 and ref 9's URL.

## Minor

- §4: "strictly increasing" and "unique" are redundant after sorting. The real requirement is that mass be strictly monotonic in raw with the same slope sign in all segments. Say whether inverted-polarity sensors are allowed.
- §8: "Resolution" mixes display step with measurement resolution. "Accuracy … true/reference value" conflates two different things (a true value is unknowable).
- §10: the trimmed-mean rounding rule and minimum n are unspecified. After a tare reset the early window has few samples (SD = 0 at n = 1), so flag it as warming up.
- §7: "normalized JSON" needs a canonical form (key order, number serialization, e.g. RFC 8785), or identical content hashes differently.
- Notation is inconsistent: (r_1,m_1) vs r1, and `n` is reused for window size, tare samples and total samples.

I couldn't check the companion handoff document, the code, the unit factors or the demo calibration numbers. Only the text was available.
