"use strict";

// v11: RATE_HZ / PERIOD_MS mirror the nominal sampling rate of the sensor that is SHOWN (they are
// re-assigned by activateSensor()); every sensor keeps its own rate in state.rateHz.
const RATE_HZ_DEFAULT = 80;
let RATE_HZ = RATE_HZ_DEFAULT;
let PERIOD_MS = 1000 / RATE_HZ;
// ---- server connection (prepared, no server exists yet) ----
// SENSOR_LIST_URL: URL of the JSON sensor list, e.g. '/api/sensors'. null = test signal only.
// Expected JSON: an array (or {"sensors":[...]}) of {"id":"s1","name":"Scale 1","sseUrl":"/stream/a", ...}.
// Further keys (rateHz, details, ...) are kept; rateHz is read when the sensor is first created.
const SENSOR_LIST_URL = null;
const TEST_SENSOR_ID = 'test';
// Server sensors have no calibration of their own yet. Until one is imported they are shown as RAW
// counts rather than as masses computed with the illustrative demo calibration (conservative choice).
const SERVER_SENSOR_DEFAULT_UNIT = 'raw';
const $ = id => document.getElementById(id);
const UNIT_CONFIG = JSON.parse($('unitConfig').textContent);
const EMBEDDED_CALIBRATION = JSON.parse($('calibrationConfig').textContent);
let CALIBRATION = EMBEDDED_CALIBRATION;   // the ACTIVE calibration (switchable since v8)
const MAX_ROBUST_WINDOW = 4096;

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function fmtNumber(value, digits) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(navigator.language || undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(value);
}
function unitById(id) { return UNIT_CONFIG.units.find(unit => unit.id === id) || UNIT_CONFIG.units.find(unit => unit.id === UNIT_CONFIG.defaultUnit); }
function massToMg(value, unitId) {
  const unit = UNIT_CONFIG.units.find(item => item.id === unitId);
  if (!unit || !Number.isFinite(value) || unit.id === 'raw') throw new Error(`Unknown or non-physical mass unit: ${unitId}`);
  return value * unit.factor;
}
function mgToUnit(valueMg, unitId) {
  const unit = unitById(unitId);
  if (!unit || unit.id === 'raw') return valueMg;
  return valueMg / unit.factor;
}

// Calibration interpolation returns canonical milligrams. The source calibration values
// are converted from the unit declared in the calibration JSON, not from the display unit.
function prepareCalibration(config) {
  if (!config || config.schemaVersion !== 1 || !Array.isArray(config.calibrationAnchors) || config.calibrationAnchors.length < 2) {
    throw new Error('Calibration JSON must contain at least two calibration anchors.');
  }
  const anchors = config.calibrationAnchors.map(anchor => ({
    anchorId: anchor.anchorId,
    raw: Number(anchor.rawMean),
    massMg: massToMg(Number(anchor.referenceValue), anchor.referenceUnit || config.calibrationUnit),
    sourceObservationIds: anchor.sourceObservationIds || []
  })).sort((a, b) => a.raw - b.raw);
  for (let i = 1; i < anchors.length; i++) {
    if (!(anchors[i].raw > anchors[i - 1].raw)) throw new Error('Calibration anchor raw values must be unique and strictly increasing.');
  }
  // v7: every value must be finite (Infinity passes the ordering test above), and the response
  // must be strictly monotonic with ONE slope sign. A mass that rises then falls with raw counts
  // means a mislabelled load, hysteresis or a faulty sensor; interpolating it would silently map
  // two different masses to nearby counts. Either slope sign is accepted (inverted polarity),
  // but a sign change or a flat segment is rejected.
  let slopeSign = 0;
  for (let i = 0; i < anchors.length; i++) {
    if (!Number.isFinite(anchors[i].raw) || !Number.isFinite(anchors[i].massMg)) throw new Error('Calibration anchors must have finite raw and mass values.');
    if (i === 0) continue;
    const dm = anchors[i].massMg - anchors[i - 1].massMg;
    if (!(dm !== 0)) throw new Error('Calibration response must be strictly monotonic: two adjacent anchors have the same mass.');
    if (slopeSign && Math.sign(dm) !== slopeSign) throw new Error('Calibration response must be monotonic: mass direction changes between anchors.');
    slopeSign = Math.sign(dm);
  }
  return {...config, anchors, slopeSign, calibrationUnit: config.calibrationUnit || 'g'};
}
let calibration = prepareCalibration(CALIBRATION);   // prepared form of the active calibration
const EMBEDDED_PREPARED = calibration;

// Absolute calibration is deliberately separate from tare correction. Out-of-range
// readings are linearly extrapolated from the nearest segment and explicitly flagged.
function calibrateAbsolute(rawValue, config = calibration) {
  const points = config.anchors;
  const outside = rawValue < points[0].raw || rawValue > points[points.length - 1].raw;
  let left = 0;
  if (rawValue <= points[0].raw) left = 0;
  else if (rawValue >= points[points.length - 1].raw) left = points.length - 2;
  else {
    let lo = 0, hi = points.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (points[mid].raw <= rawValue) lo = mid;
      else hi = mid;
    }
    left = lo;
  }
  const a = points[left], b = points[left + 1];
  const fraction = (rawValue - a.raw) / (b.raw - a.raw);
  return {valueMg: a.massMg + fraction * (b.massMg - a.massMg), outOfRange: outside, segmentIndex: left, anchorIds: [a.anchorId, b.anchorId]};
}

// Tare definition used everywhere: the tare is a calibrated mass in mg, computed as the mean of
// f(raw_i) over the tare window (not f(mean raw)); the raw snapshot is stored so it can be
// re-evaluated under a different calibration. (v8 removed the two unused "Method A/B" helpers.)

// ---- per-sensor state (v11) ---------------------------------------------------------------------
// Every sensor owns one object like this: ring buffer, tares, calibration history, logs, selection, view
// and estimator settings. `lazy` = the derived arrays (massMg, rawMA, rawSD, massMA, massSD) are NOT
// allocated: a sensor that has never been shown only stores time + raw counts (8 + 4 bytes/sample).
// They are allocated and filled when the sensor is first shown (prepareStateForDisplay).
function createSensorState(opts = {}) {
  const N0 = 100000, D0 = opts.lazy ? 0 : N0;
  return {
  capacity: N0, unlimited: false, count: 0, head: 0,
  times: new Float64Array(N0), raw: new Int32Array(N0), massMg: new Float64Array(D0),
  rawMA: new Float64Array(D0), rawSD: new Float64Array(D0),
  massMA: new Float64Array(D0), massSD: new Float64Array(D0),
  derivedReady: !opts.lazy, unprocessed: 0,          // samples stored but not yet calibrated / averaged
  rateHz: opts.rateHz || RATE_HZ_DEFAULT, timeOrigin: null, rejected: 0, dropped: 0,   // device time origin; rejected / dropped sample counters
  calConfig: EMBEDDED_CALIBRATION, calPrepared: EMBEDDED_PREPARED,
  detailsOpen: {}, yBusy: false,
  nextTime: 0, paused: false, live: true,
  measurement: null, lastMeasurement: null, highlight: null,   // Measurement feature (v8)
  calibrations: [], fullHash: null, curveCache: {key:'', map:new Map()}, curveStride: 1,                             // calibration history (v8)
  simBase: null, simEmitted: 0, appended: 0,                    // simulator pacing / periodic sum refresh
 
  liveWindowSpan: 5000, viewMin: 0, viewMax: PERIOD_MS,
  window: 80, activeWindow: 80,
  rawSum: 0, rawSumSq: 0, rawCount: 0, rawRef: null,
  massSum: 0, massSumSq: 0, massCount: 0, massRef: null,
  rawEma: null, rawEmaTime: null, massEma: null, massEmaTime: null,
  rollingTareId: null,
  tareEvents: [], logs: [], selection: null, pendingSelection: null,
  mainPlot: null, miniPlot: null,
  manualY: false, yMin: -10, yMax: 10, autoYMin: null, autoYMax: null,
  maRebuildTimer: null, selectMode: false,
  plotBuffer: null,
  unitId: opts.unitId || UNIT_CONFIG.defaultUnit, precision: 'auto',
  estimator: 'mean', trimPercent: 10, emaTau: 0.5,
  seedValue: 5000, drift: 0, revisionId: 'embedded-demo-v1', hashType: 'embedded revision',
  // v10
  hampelHalf: 5, hampelSigma: 3,                       // sliding Hampel filter parameters
  miniCache: {key:'', map:new Map()},                  // navigator min/max buckets aligned to absolute sample numbers
  snapY: false, wasHidden: false, lastFrameTs: 0, autoYLatch: [false,false],   // Y-axis dead-band / snap
  hoverRange: null, logPinned: null,                   // log / graph hover highlight, clicked log entry
  simMode: 'wander', simOffset: 0, simN: 0
  };
}
// Module-level (not per-sensor) render bookkeeping: one render loop serves whichever sensor is shown.
let renderPending = false, miniLastRender = 0, testBatchRunning = false, tickTimer = null, chartsPending = true, embeddedFp = null;

// ---- sensor registry ----------------------------------------------------------------------------
// The code below was written against ONE global `state`. Instead of threading a parameter through
// ~150 functions, `state` is a pointer to the state of the sensor that is SHOWN (activeSensor); switching
// re-points it together with the few globals that mirror per-sensor data (CALIBRATION, calibration,
// RATE_HZ, PERIOD_MS). Consequences, by design:
//  * only the shown sensor is processed (calibration, rolling statistics, EMA, tare epochs, measurement);
//    every other sensor only stores time + raw counts (appendRawOnly) and catches up when it is shown;
//  * tares, calibration changes, measurements, selections and logs can only be created on the shown
//    sensor, so a sensor that is not shown never needs a tare/calibration epoch while it is away;
//  * a second chart for another sensor would need only a second container and its own plot pair:
//    plots live in the sensor's state (state.mainPlot / state.miniPlot).
const sensors = new Map();
let activeSensor = null;
let state = null;
function makeSensor(def) {
  const kind = def.kind || 'server';
  const rateHz = Number.isFinite(def.rateHz) && def.rateHz > 0 ? def.rateHz : RATE_HZ_DEFAULT;
  const sensor = {id: String(def.id), name: String(def.name || def.id), kind, sseUrl: def.sseUrl || null, details: def.details || {}, settings: {notes: ''}, unlisted: false,
    state: createSensorState({rateHz, lazy: kind !== 'test', unitId: kind === 'test' ? undefined : SERVER_SENSOR_DEFAULT_UNIT})};
  sensors.set(sensor.id, sensor);
  return sensor;
}
function withState(st, fn) { const prev = state; state = st; try { return fn(); } finally { state = prev; } }
const testSensor = makeSensor({id: TEST_SENSOR_ID, name: 'Test signal (simulated)', kind: 'test', rateHz: RATE_HZ_DEFAULT});
activeSensor = testSensor; state = testSensor.state;

function physicalIndex(i) { return (state.head + i) % state.capacity; }
function getTime(i) { return state.times[physicalIndex(i)]; }
function getRaw(i) { return state.raw[physicalIndex(i)]; }
function getMassMg(i) { return state.massMg[physicalIndex(i)]; }
function getRawMA(i) { return state.rawMA[physicalIndex(i)]; }
function getRawSD(i) { return state.rawSD[physicalIndex(i)]; }
function getMassMA(i) { return state.massMA[physicalIndex(i)]; }
function getMassSD(i) { return state.massSD[physicalIndex(i)]; }
function oldestTime() { return state.count ? getTime(0) : 0; }
function newestTime() { return state.count ? getTime(state.count - 1) : 0; }

function tareEventAt(timeMs) {
  let lo = 0, hi = state.tareEvents.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (state.tareEvents[mid].effectiveFromTime <= timeMs) lo = mid + 1;
    else hi = mid;
  }
  return lo ? state.tareEvents[lo - 1] : null;
}
function getNetMg(i) {
  const event = tareEventAt(getTime(i));
  return getMassMg(i) - (event ? event.tareMassMg : 0);
}
function currentTareEvent() { return state.tareEvents.length ? state.tareEvents[state.tareEvents.length - 1] : null; }
function currentTareMassMg() {
  const event = currentTareEvent();
  if (!event) return 0;
  // Re-evaluate raw-based tare references against the current calibration when a
  // historical selection is explicitly recalculated using the current calibration.
  if (event.calibrationRevisionId === state.revisionId || event.tareRaw == null) return event.tareMassMg;
  if (event.tareRawSamples?.length) {
    let sum = 0; for (const raw of event.tareRawSamples) sum += calibrateAbsolute(raw).valueMg;
    return sum / event.tareRawSamples.length;
  }
  return calibrateAbsolute(event.tareRaw).valueMg;
}
function currentTareLabel() {
  const event = currentTareEvent();
  if (!event) return 'None';
  return formatMass(event.tareMassMg);
}
function formatMass(valueMg, unitId = state.unitId) {
  const unit = unitById(unitId);
  if (unit.id === 'raw') return fmtNumber(valueMg, 0);
  const value = mgToUnit(valueMg, unit.id);
  const digits = state.precision === 'auto' ? unit.decimals : Number(state.precision);
  return `${fmtNumber(value, digits)} ${unit.symbol}`;
}
function displayUnitSymbol() {
  const unit = unitById(state.unitId);
  return unit.id === 'raw' ? 'counts' : unit.symbol;
}
function selectedMassToMg(value) { return massToMg(value, state.unitId); }

// The simulator produces a slowly wandering signal with direction changes and
// small measurement noise. It is a software test signal, not a real calibration.
function nextSensorValue(st = state) {
  const mode = st.simMode;
  if (mode !== 'wander') {
    // Quiet test signals for exercising the validity checks (v10): white-ish noise around 5000 counts.
    st.simN++;
    if (mode === 'steps' && Math.random() < 1 / 1200) st.simOffset += (Math.random() < 0.5 ? -1 : 1) * (20 + Math.random() * 40);
    const hum = mode === 'hum' ? 1.5 * Math.sin(2 * Math.PI * 50 * st.simN / RATE_HZ) : 0;   // 50 Hz at 80 Hz sampling -> 30 Hz alias
    return Math.round(Math.max(4600, Math.min(5400, 5000 + st.simOffset + hum + (Math.random() - 0.5) * 3)));
  }
  if (Math.random() < 0.018) st.drift = (Math.random() - 0.5) * 0.7;
  const pull = (5000 - st.seedValue) * 0.0015;
  st.seedValue = Math.max(4600, Math.min(5400, st.seedValue + st.drift + pull + (Math.random() - 0.5) * 1.8));
  return Math.round(st.seedValue + (Math.random() - 0.5) * 2);
}

// timeMs (optional): the device timestamp (ms, relative to the sensor's time origin). The caller
// (ingestSample) guarantees it is later than the newest stored sample, because the binary searches
// (lowerBoundTime, tareEventAt) assume sorted time. Without it the simulator clock is used.
function appendSample(rawValue, timeMs) {
  if (state.unlimited && state.count === state.capacity) resizeBuffers(state.capacity + 100000);
  const sampleTime = timeMs == null ? state.nextTime : timeMs;
  if (state.measurement && state.count && sampleTime - newestTime() > ANALYSIS_THRESHOLDS.gapFactor * PERIOD_MS) cancelMeasurement('sampling gap');

  // Maintain the raw rolling statistics independently of calibration and tare.
  if (state.rawCount >= state.activeWindow) {
    const oldRaw = getRaw(state.count - state.rawCount) - state.rawRef;
    state.rawSum -= oldRaw;
    state.rawSumSq -= oldRaw * oldRaw;
    state.rawCount--;
  }
  const activeTare = currentTareEvent();
  const activeTareId = activeTare ? activeTare.eventId : null;
  if (activeTareId !== state.rollingTareId) {
    // Reset calibrated rolling statistics at tare boundaries. This prevents one MA
    // window from mixing samples expressed relative to two different zero references.
    state.massSum = 0;
    state.massSumSq = 0;
    state.massCount = 0;
    state.massRef = null;
    state.massEma = null; state.massEmaTime = null;
    state.rollingTareId = activeTareId;
  }
  if (state.massCount >= state.activeWindow) {
    const oldMassNet = getNetMg(state.count - state.massCount) - state.massRef;
    state.massSum -= oldMassNet;
    state.massSumSq -= oldMassNet * oldMassNet;
    state.massCount--;
  }

  let writeIndex;
  if (state.count < state.capacity) {
    writeIndex = physicalIndex(state.count);
    state.count++;
  } else {
    state.head = (state.head + 1) % state.capacity;
    writeIndex = physicalIndex(state.count - 1);
  }

  const calibrated = calibrateAbsolute(rawValue);
  const tareMass = activeTare ? activeTare.tareMassMg : 0;
  const netMass = calibrated.valueMg - tareMass;
  state.times[writeIndex] = sampleTime;
  state.raw[writeIndex] = rawValue;
  state.massMg[writeIndex] = calibrated.valueMg;

  // Shifted sliding sums (v7). Var = E[d^2] - E[d]^2 with d = x - ref. The unshifted form
  // subtracts two nearly equal huge numbers when |mean| >> SD (e.g. 1e5 mg with sub-mg noise),
  // which loses all significant digits and, through the max(0,...) clamp, silently reports
  // SD = 0. Shifting by a reference inside the window (first value of the window/tare epoch)
  // makes d small so the cancellation is harmless. The reference is constant while the window
  // is non-empty; it is reset with the sums at a tare boundary and in rebuildDerived().
  if (state.rawCount === 0 || state.rawRef == null) state.rawRef = rawValue;
  const rawD = rawValue - state.rawRef;
  state.rawSum += rawD;
  state.rawSumSq += rawD * rawD;
  state.rawCount++;
  const rawMeanD = state.rawSum / state.rawCount;
  state.rawMA[writeIndex] = state.rawRef + rawMeanD;
  state.rawSD[writeIndex] = Math.sqrt(Math.max(0, state.rawSumSq / state.rawCount - rawMeanD * rawMeanD));

  if (state.massCount === 0 || state.massRef == null) state.massRef = netMass;
  const massD = netMass - state.massRef;
  state.massSum += massD;
  state.massSumSq += massD * massD;
  state.massCount++;
  const massMeanD = state.massSum / state.massCount;
  state.massMA[writeIndex] = state.massRef + massMeanD;
  state.massSD[writeIndex] = Math.sqrt(Math.max(0, state.massSumSq / state.massCount - massMeanD * massMeanD));

  // The panel EMA is a true stateful exponential filter, not a repeatedly restarted
  // finite-window approximation. Its time constant uses actual elapsed sample time.
  if (state.rawEma == null) state.rawEma = rawValue;
  else { const dt = Math.max(0, (sampleTime - state.rawEmaTime) / 1000); const alpha = 1 - Math.exp(-dt / state.emaTau); state.rawEma = alpha * rawValue + (1 - alpha) * state.rawEma; }
  if (state.massEma == null) state.massEma = netMass;
  else { const dt = Math.max(0, (sampleTime - state.massEmaTime) / 1000); const alpha = 1 - Math.exp(-dt / state.emaTau); state.massEma = alpha * netMass + (1 - alpha) * state.massEma; }
  state.rawEmaTime = sampleTime; state.massEmaTime = sampleTime;
  state.nextTime = sampleTime + PERIOD_MS;
  if ((++state.appended & 8191) === 0) refreshRollingSums();
  if (state.measurement) measurementSampleAdded(sampleTime);
}
// Every 8192 samples the shifted sums are recomputed exactly from the retained window and
// re-centred on the current mean. This bounds the rounding error that add/subtract updates
// accumulate over very long runs (cost: one pass over at most `window` samples).
function refreshRollingSums() {
  const end = state.count;
  let n = state.rawCount;
  if (n > 0) {
    let s = 0; for (let j = end - n; j < end; j++) s += getRaw(j);
    const ref = s / n; let d = 0, q = 0;
    for (let j = end - n; j < end; j++) { const x = getRaw(j) - ref; d += x; q += x * x; }
    state.rawRef = ref; state.rawSum = d; state.rawSumSq = q;
  }
  n = state.massCount;
  if (n > 0) {
    let s = 0; for (let j = end - n; j < end; j++) s += getNetMg(j);
    const ref = s / n; let d = 0, q = 0;
    for (let j = end - n; j < end; j++) { const x = getNetMg(j) - ref; d += x; q += x * x; }
    state.massRef = ref; state.massSum = d; state.massSumSq = q;
  }
}

// Rebuild both raw and calibrated derived series after an MA-window change.
// Calibration is applied to each raw sample before averaging: for a nonlinear
// calibration curve, calibrate(mean(raw)) is generally not equal to mean(calibrate(raw)).
function rebuildDerived() {
  state.rawSum = state.rawSumSq = state.rawCount = 0; state.rawRef = null;
  state.massSum = state.massSumSq = state.massCount = 0; state.massRef = null;
  state.rollingTareId = null;
  let activeTareId = null;
  for (let i = 0; i < state.count; i++) {
    const raw = getRaw(i);
    const time = getTime(i);
    const event = tareEventAt(time);
    const tareId = event ? event.eventId : null;
    if (tareId !== activeTareId) {
      state.massSum = state.massSumSq = state.massCount = 0; state.massRef = null;
      activeTareId = tareId;
    }
    if (state.rawCount >= state.window) {
      const old = getRaw(i - state.rawCount) - state.rawRef;
      state.rawSum -= old;
      state.rawSumSq -= old * old;
      state.rawCount--;
    }
    if (state.massCount >= state.window) {
      const oldNet = getNetMg(i - state.massCount) - state.massRef;
      state.massSum -= oldNet;
      state.massSumSq -= oldNet * oldNet;
      state.massCount--;
    }
    // Same shifted-sum scheme as appendSample(); see the rationale there.
    if (state.rawCount === 0 || state.rawRef == null) state.rawRef = raw;
    const rawD = raw - state.rawRef;
    state.rawSum += rawD; state.rawSumSq += rawD * rawD; state.rawCount++;
    const rawAvgD = state.rawSum / state.rawCount;
    const rawVar = Math.max(0, state.rawSumSq / state.rawCount - rawAvgD * rawAvgD);
    const ix = physicalIndex(i);
    state.rawMA[ix] = state.rawRef + rawAvgD; state.rawSD[ix] = Math.sqrt(rawVar);
    const net = getNetMg(i);
    if (state.massCount === 0 || state.massRef == null) state.massRef = net;
    const netD = net - state.massRef;
    state.massSum += netD; state.massSumSq += netD * netD; state.massCount++;
    const massAvgD = state.massSum / state.massCount;
    state.massMA[ix] = state.massRef + massAvgD;
    state.massSD[ix] = Math.sqrt(Math.max(0, state.massSumSq / state.massCount - massAvgD * massAvgD));
  }
  state.activeWindow = state.window;
  state.rollingTareId = state.count ? (tareEventAt(newestTime())?.eventId || null) : null;
}

function rebuildEMA() {
  state.rawEma = null; state.rawEmaTime = null;
  state.massEma = null; state.massEmaTime = null;
  let previousTareId = null;
  for (let i = 0; i < state.count; i++) {
    const time = getTime(i), raw = getRaw(i), event = tareEventAt(time), tareId = event ? event.eventId : null;
    if (i === 0 || time != null) {
      if (i > 0 && tareId !== previousTareId) { state.massEma = null; state.massEmaTime = null; }
      if (state.rawEma == null) state.rawEma = raw;
      else { const alpha = 1 - Math.exp(-Math.max(0, (time - state.rawEmaTime) / 1000) / state.emaTau); state.rawEma = alpha * raw + (1 - alpha) * state.rawEma; }
      const net = getNetMg(i);
      if (state.massEma == null) state.massEma = net;
      else { const alpha = 1 - Math.exp(-Math.max(0, (time - state.massEmaTime) / 1000) / state.emaTau); state.massEma = alpha * net + (1 - alpha) * state.massEma; }
      state.rawEmaTime = time; state.massEmaTime = time;
    }
    previousTareId = tareId;
  }
}

function resizeBuffers(requested) {
  const capacity = Math.max(1000, Math.floor(requested));
  const keep = Math.min(state.count, capacity);
  const start = state.count - keep;
  const oldCapacity = state.capacity;
  const D = state.derivedReady, dn = D ? capacity : 0;   // derived arrays exist only for sensors that have been shown
  const times = new Float64Array(capacity), raw = new Int32Array(capacity), mass = new Float64Array(dn);
  const rawMA = new Float64Array(dn), rawSD = new Float64Array(dn), massMA = new Float64Array(dn), massSD = new Float64Array(dn);
  for (let i = 0; i < keep; i++) {
    const oldIndex = start + i;
    times[i] = getTime(oldIndex); raw[i] = getRaw(oldIndex);
    if (D) {
      mass[i] = getMassMg(oldIndex);
      rawMA[i] = getRawMA(oldIndex); rawSD[i] = getRawSD(oldIndex);
      massMA[i] = getMassMA(oldIndex); massSD[i] = getMassSD(oldIndex);
    }
  }
  state.capacity = capacity; state.times = times; state.raw = raw; state.massMg = mass;
  state.rawMA = rawMA; state.rawSD = rawSD; state.massMA = massMA; state.massSD = massSD;
  state.count = keep; state.head = 0;
  state.window = Math.min(state.window, capacity);
  // On growth, copy the already-calculated derived history as well. This avoids
  // rescanning hundreds of thousands of samples at every 100k unlimited-buffer step.
  // On shrink, recalculate because the retained left edge may have lost MA context.
  if (D && capacity < oldCapacity) { rebuildDerived(); rebuildEMA(); }
  if (state.live) fitLiveWindow(); else clampHistoricalView();
}

function lowerBoundTime(ms) {
  let lo = 0, hi = state.count;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (getTime(mid) < ms) lo = mid + 1; else hi = mid; }
  return lo;
}
function visibleIndices() {
  if (!state.count) return [0, -1];
  const lo = Math.max(0, lowerBoundTime(state.viewMin) - 1);
  const hi = Math.min(state.count - 1, lowerBoundTime(state.viewMax));
  return [lo, Math.max(lo, hi)];
}
function colors() {
  const css = getComputedStyle(document.documentElement);
  return {raw:css.getPropertyValue('--raw').trim(),ma:css.getPropertyValue('--ma').trim(),band:css.getPropertyValue('--band').trim(),zero:css.getPropertyValue('--zero').trim(),muted:css.getPropertyValue('--muted').trim(),line:css.getPropertyValue('--line').trim()};
}
function createPlotBuffer(size) {
  return {x:new Float64Array(size),value:new Float64Array(size),ma:new Float64Array(size),upper:new Float64Array(size),lower:new Float64Array(size)};
}
function ensurePlotBuffers(required) {
  const current = state.plotBuffer?.x.length || 0;
  if (current >= required) return;
  let size = Math.max(4096, current || 0);
  while (size < required) size = Math.min(state.capacity, size * 2);
  state.plotBuffer = createPlotBuffer(size);
}
function chartValueAt(i, diagnostic) { return diagnostic ? getRaw(i) : getNetMg(i); }
function chartMAAt(i, diagnostic) { return diagnostic ? getRawMA(i) : getMassMA(i); }
function chartSDAt(i, diagnostic) { return diagnostic ? getRawSD(i) : getMassSD(i); }

// The min/max envelope preserves the local extrema in each time bucket instead of
// simply skipping points. Full-resolution mode plots every visible sample.
function buildVisibleData() {
  const [lo, hi] = visibleIndices();
  if (hi < lo) return [[], [], [], [], []];
  const count = hi - lo + 1;
  const diagnostic = state.unitId === 'raw';
  const pixelWidth = Math.max(320, Math.floor(state.mainPlot?.bbox?.width || $('mainChart').clientWidth || 800));
  const maxBuckets = Math.max(160, pixelWidth * 2);
  const useDownsample = $('downsampleToggle').checked && count > maxBuckets * 2;
  const outputCapacity = useDownsample ? Math.min(count, maxBuckets * 2) : count;
  ensurePlotBuffers(outputCapacity);
  const buf = state.plotBuffer;
  const curve = buildEstimatorCurve(lo, hi, diagnostic); state.curveStride = curve.stride;
  let out = 0;
  const write = i => {
    const value = chartValueAt(i, diagnostic), ma = curve.center(i), sd = curve.sigma(i);
    buf.x[out] = getTime(i) / 1000;
    buf.value[out] = diagnostic ? value : mgToUnit(value, state.unitId);
    buf.ma[out] = diagnostic ? ma : mgToUnit(ma, state.unitId);
    buf.upper[out] = diagnostic ? ma + sd : mgToUnit(ma + sd, state.unitId);
    buf.lower[out] = diagnostic ? ma - sd : mgToUnit(ma - sd, state.unitId);
    out++;
  };
  if (!useDownsample) {
    for (let i = lo; i <= hi; i++) write(i);
  } else {
    const bucketSize = Math.ceil(count / maxBuckets);
    for (let start = lo; start <= hi; start += bucketSize) {
      const end = Math.min(hi + 1, start + bucketSize);
      let minIndex = start, maxIndex = start;
      let minValue = chartValueAt(start, diagnostic), maxValue = minValue;
      for (let i = start + 1; i < end; i++) {
        const value = chartValueAt(i, diagnostic);
        if (value < minValue) { minValue = value; minIndex = i; }
        if (value > maxValue) { maxValue = value; maxIndex = i; }
      }
      if (minIndex === maxIndex) write(minIndex);
      else if (minIndex < maxIndex) { write(minIndex); write(maxIndex); }
      else { write(maxIndex); write(minIndex); }
    }
  }
  return [buf.x.subarray(0,out),buf.value.subarray(0,out),buf.ma.subarray(0,out),buf.upper.subarray(0,out),buf.lower.subarray(0,out)];
}
// Navigator data (v10). The old stride sampling (every k-th sample, k = ceil(n / 1600)) changed k and the
// sampling phase as the buffer grew or wrapped, so the curve flickered. Now the history is cut into
// buckets of B = 2^L samples ALIGNED TO ABSOLUTE SAMPLE NUMBERS and each bucket contributes its minimum
// and maximum (two points, in time order). A complete bucket never changes, so it is cached; only the
// partial first and last buckets are recomputed. B only changes when the sample count crosses a power of
// two times the bucket target (about 2 buckets per pixel), which is rare. Values are cached in canonical
// units (counts or mg); the unit conversion happens on output.
function buildMiniData() {
  const n = state.count;
  if (!n) return [new Float64Array(0), new Float64Array(0)];
  const diagnostic = state.unitId === 'raw';
  const width = Math.max(320, Math.floor(state.miniPlot?.bbox?.width || $('miniChart').clientWidth || 800));
  let target = 512; while (target < width * 2) target *= 2;
  let B = 1; while (Math.ceil(n / B) > target) B *= 2;
  const key = (diagnostic ? 'r' : 'm') + '|' + B, cache = state.miniCache;
  if (cache.key !== key) { cache.key = key; cache.map = new Map(); }
  const base = state.appended - n, firstId = Math.floor(base / B), lastId = Math.floor((base + n - 1) / B);
  if (cache.map.size > 3 * target) for (const id of cache.map.keys()) if (id < firstId) cache.map.delete(id);
  const val = i => diagnostic ? getRaw(i) : getNetMg(i), nb = lastId - firstId + 1;
  const x = new Float64Array(nb * 2), y = new Float64Array(nb * 2); let out = 0;
  for (let id = firstId; id <= lastId; id++) {
    let b = cache.map.get(id);
    if (!b) {
      const a = Math.max(id * B, base) - base, e = Math.min((id + 1) * B, base + n) - base;
      let mnI = a, mxI = a, mn = val(a), mx = mn;
      for (let i = a + 1; i < e; i++) { const v = val(i); if (v < mn) { mn = v; mnI = i; } if (v > mx) { mx = v; mxI = i; } }
      b = { mn, mx, mnI: mnI + base, mxI: mxI + base };   // absolute sample numbers
      if (id > firstId && id < lastId) cache.map.set(id, b);   // only complete buckets are stable
    }
    const put = (abs, v) => { x[out] = getTime(abs - base) / 1000; y[out] = diagnostic ? v : mgToUnit(v, state.unitId); out++; };
    if (b.mnI === b.mxI) put(b.mnI, b.mn);
    else if (b.mnI < b.mxI) { put(b.mnI, b.mn); put(b.mxI, b.mx); }
    else { put(b.mxI, b.mx); put(b.mnI, b.mn); }
  }
  return [x.subarray(0, out), y.subarray(0, out)];
}

function calibrationMarkerPlugin(){
  return {hooks:{drawAxes:[u=>{
    if(state.calibrations.length<2||!u.data[0]?.length)return;
    const ctx=u.ctx,dpr=window.devicePixelRatio||1;ctx.save();ctx.beginPath();ctx.rect(u.bbox.left,u.bbox.top,u.bbox.width,u.bbox.height);ctx.clip();
    ctx.strokeStyle='rgba(120,160,255,.85)';ctx.fillStyle='rgba(120,160,255,.95)';ctx.lineWidth=1;ctx.setLineDash([3,3]);ctx.font=`${11*dpr}px sans-serif`;
    for(const c of state.calibrations.slice(1)){const x=u.valToPos(c.effectiveFromTime/1000,'x',true);ctx.beginPath();ctx.moveTo(x,u.bbox.top);ctx.lineTo(x,u.bbox.top+u.bbox.height);ctx.stroke();ctx.fillText('Cal',x+4,u.bbox.top+12*dpr);}
    ctx.restore();
  }]}};
}
// ---- Highlight overlays shared by the main chart and the navigator (v10) --------------------------------
// teal = selected interval, amber = measurement samples (running or finished), blue = clicked log entry,
// white dashed = hovered log row / hovered event. Point events (tare, calibration) are drawn as lines.
// A thin lane at the top edge shows every logged selection / measurement so that it can be hovered.
function overlayRanges(){
  return [
    {r:state.selection,fill:'rgba(70,190,160,.12)',stroke:'rgba(70,190,160,.65)',w:1},
    {r:state.highlight,fill:'rgba(246,200,95,.14)',stroke:'rgba(246,200,95,.8)',w:1},
    {r:state.logPinned,fill:'rgba(120,200,255,.16)',stroke:'rgba(150,215,255,.95)',w:2},
    {r:state.hoverRange,fill:'rgba(255,255,255,.13)',stroke:'rgba(255,255,255,.95)',w:2,dash:[5,3]}
  ];
}
function drawSpans(u){
  const ctx=u.ctx,dpr=window.devicePixelRatio||1,top=u.bbox.top,h=u.bbox.height;
  for(const {r,fill,stroke,w,dash} of overlayRanges()){
    if(!r)continue;
    const x0=u.valToPos(r.t0/1000,'x',true),x1=u.valToPos(r.t1/1000,'x',true);
    ctx.save();ctx.strokeStyle=stroke;ctx.lineWidth=w*dpr;ctx.setLineDash(dash?dash.map(d=>d*dpr):[]);
    if(r.marker){ctx.beginPath();ctx.moveTo(Math.round(x0)+.5,top);ctx.lineTo(Math.round(x0)+.5,top+h);ctx.lineWidth=Math.max(2.5,w+1)*dpr;ctx.stroke();}
    else{const l=Math.min(x0,x1),wd=Math.max(2*dpr,Math.abs(x1-x0));ctx.fillStyle=fill;ctx.fillRect(l,top,wd,h);ctx.strokeRect(l+.5,top,Math.max(1,wd-1),h);}
    ctx.restore();
  }
  // event lane: logged selections (teal) and measurements (amber), 4 px high at the top edge
  ctx.save();
  for(const l of state.logs){
    if((l.type!=='selection'&&l.type!=='measurement')||!Number.isFinite(l.t0))continue;
    const x0=u.valToPos(l.t0/1000,'x',true),x1=u.valToPos(l.t1/1000,'x',true);
    if(x1<u.bbox.left||x0>u.bbox.left+u.bbox.width)continue;
    ctx.fillStyle=l.type==='measurement'?'rgba(246,200,95,.9)':'rgba(70,190,160,.9)';
    ctx.fillRect(Math.min(x0,x1),top,Math.max(2*dpr,Math.abs(x1-x0)),4*dpr);
  }
  ctx.restore();
}
function miniOverlayPlugin(){
  return {hooks:{drawClear:[u=>{
    if(!u.data[0]?.length)return;
    const ctx=u.ctx;ctx.save();ctx.beginPath();ctx.rect(u.bbox.left,u.bbox.top,u.bbox.width,u.bbox.height);ctx.clip();drawSpans(u);ctx.restore();
  }]}};
}
function redrawOverlays(){state.mainPlot?.redraw(false,false);state.miniPlot?.redraw(false,false);}
function rangeKey(r){return r?`${r.t0}|${r.t1}|${r.marker?1:0}`:'';}
function setHoverRange(r){if(rangeKey(r)===rangeKey(state.hoverRange))return;state.hoverRange=r;redrawOverlays();}
function logEntryOf(id){return state.logs.find(x=>(x.entryId||x.eventId)===id)||null;}
function logEntryRange(e){
  if(!e)return null;
  if(e.type==='tare'||e.type==='calibration')return{t0:e.effectiveFromTime,t1:e.effectiveFromTime,marker:true};
  if(e.type==='selection'||e.type==='measurement')return{t0:e.t0,t1:e.t1};
  return null;
}
// ---- Event hit-testing and tooltip --------------------------------------------------------------------------
// Priority: point markers (+-6 px) > logged spans in the top lane > spans that are drawn over the full
// height (current selection, running / last measurement, clicked log entry).
function describeEventHTML(e){
  const tt=x=>(x/1000).toFixed(2)+' s',raw=state.unitId==='raw';
  if(e.type==='tare')return `<strong>${esc(e.eventId)} · Tare</strong><br>${esc(e.method)}<br>Tare mass ${formatMass(e.tareMassMg)} · effective from ${tt(e.effectiveFromTime)}`+(e.tareRaw==null?'':`<br>Raw reference ${fmtNumber(e.tareRaw,2)} counts`);
  if(e.type==='calibration')return `<strong>Calibration change</strong><br>${esc(e.profileName)} · revision ${esc(e.revisionId)}<br>Effective from ${tt(e.effectiveFromTime)}`;
  if(e.type==='measuring')return `<strong>Measurement in progress</strong><br>${e.collected.toLocaleString()} / ${e.target.toLocaleString()} samples`;
  const val=raw?`${fmtNumber(e.rawEstimatorValue,0)} counts`:formatMass(e.originalValueMg),sig=raw?`${fmtNumber(e.rawSpread,2)} counts`:formatMass(e.spreadMg);
  return `<strong>${e.type==='measurement'?'Measurement':'Selection'} · ${e.totalSamples.toLocaleString()} samples</strong><br>${tt(e.t0)} – ${tt(e.t1)} (${((e.t1-e.t0)/1000).toFixed(2)} s)<br>Result ${val} · σ ${sig}<br>${esc(estimatorLabel(e.estimator))}`+analysisBadgeHTML(e.analysis,'<br>')+(e.crossesTare?'<br><span class="warning">spans a tare event</span>':'')+(e.crossesCalibration?'<br><span class="warning">spans a calibration change</span>':'');
}
function hitTestEvents(u,x,y){
  const t=u.posToVal(x,'x')*1000,tol=6*Math.abs(u.posToVal(1,'x')-u.posToVal(0,'x'))*1000,lane=(u===state.miniPlot?10:14),hits=[],seen=new Set();
  const add=(prio,entry,range)=>{if(seen.has(entry))return;seen.add(entry);hits.push({prio,entry,range});};
  for(const e of state.tareEvents)if(Math.abs(e.effectiveFromTime-t)<=tol)add(0,e,logEntryRange({type:'tare',effectiveFromTime:e.effectiveFromTime}));
  for(const l of state.logs)if(l.type==='calibration'&&Math.abs(l.effectiveFromTime-t)<=tol)add(0,l,logEntryRange(l));
  if(y<=lane)for(const l of state.logs)if((l.type==='selection'||l.type==='measurement')&&t>=l.t0-tol&&t<=l.t1+tol)add(1+(l.t1-l.t0)/1e12,l,logEntryRange(l));
  const inside=r=>r&&t>=r.t0&&t<=r.t1;
  if(state.measurement&&inside(state.highlight))add(2,{type:'measuring',collected:state.measurement.collected,target:state.measurement.target},state.highlight);
  else if(state.lastMeasurement&&inside(state.highlight))add(2,state.lastMeasurement,logEntryRange(state.lastMeasurement));
  if(state.logPinned&&inside(state.logPinned)){const pe=logEntryOf(state.logPinned.id);if(pe)add(2,pe,logEntryRange(pe));}
  if(state.selection&&inside(state.selection)){const same=state.logs.find(l=>l.type==='selection'&&l.t0===state.selection.t0&&l.t1===state.selection.t1);add(2,same||{type:'selection',...state.selection},{t0:state.selection.t0,t1:state.selection.t1});}
  hits.sort((a,b)=>a.prio-b.prio);return hits;
}
function hideEventTip(){const tip=$('eventTip');if(tip)tip.hidden=true;}
function showEventTip(hits,cx,cy){
  const tip=$('eventTip');if(!hits.length){tip.hidden=true;return;}
  tip.innerHTML=hits.slice(0,3).map(h=>describeEventHTML(h.entry)).join('<hr>');tip.hidden=false;
  const w=tip.offsetWidth,h=tip.offsetHeight;let x=cx+14,y=cy+16;
  if(x+w>window.innerWidth-8)x=cx-w-14;if(y+h>window.innerHeight-8)y=cy-h-14;
  tip.style.left=Math.max(4,x)+'px';tip.style.top=Math.max(4,y)+'px';
}
function wireEventHover(u){
  const over=u.over;
  over.addEventListener('pointermove',e=>{
    if(e.buttons){hideEventTip();return;}
    const rect=over.getBoundingClientRect(),hits=hitTestEvents(u,e.clientX-rect.left,e.clientY-rect.top);
    showEventTip(hits,e.clientX,e.clientY);
    const f=hits.find(h=>h.prio<2);setHoverRange(f?f.range:null);   // lane / marker hover also lights up both graphs
  });
  over.addEventListener('pointerleave',()=>{hideEventTip();setHoverRange(null);});
}
function zeroFillPlugin() {
  return {hooks:{drawClear:[u=>{
    if (!u.data[0]?.length) return;
    const xs=u.data[0], raw=u.data[1], lower=u.data[4], ctx=u.ctx;
    const yZero=u.valToPos(0,'y',true);
    ctx.save(); ctx.beginPath(); ctx.rect(u.bbox.left,u.bbox.top,u.bbox.width,u.bbox.height); ctx.clip();
    drawSpans(u);
    if (state.unitId === 'raw') { ctx.restore(); return; }
    const drawFill=(values,fill)=>{
      ctx.fillStyle=fill; ctx.beginPath();
      for(let i=0;i<xs.length;i++){
        const x=u.valToPos(xs[i],'x',true), y=u.valToPos(values[i],'y',true);
        if(i===0)ctx.moveTo(x,yZero);
        ctx.lineTo(x,y);
      }
      for(let i=xs.length-1;i>=0;i--)ctx.lineTo(u.valToPos(xs[i],'x',true),yZero);
      ctx.closePath(); ctx.fill();
    };
    // Fills are independent overlays. They use zero as a geometric boundary but do
    // not modify the Y range and do not draw a zero reference line.
    if($('zeroFillToggle').checked)drawFill(lower,'rgba(190,112,220,.18)');
    if($('zeroRawFillToggle').checked)drawFill(raw,'rgba(65,190,150,.13)');
    ctx.restore();
  }]}};
}

// Auto Y-axis with a dead-band (v10). The old rule moved both edges a fixed fraction towards the data
// extent on EVERY frame, so any wobble of the extent (the spread band is sampled, new samples enter and
// leave the window) made the view swim. Now each edge has its own hysteresis:
//   * it starts to move only when the data comes closer to that edge than half the padding (view too
//     tight; threshold AUTOY_TIGHT x pad) or when more than AUTOY_LOOSE x span of empty space has
//     opened up beyond the padding (view too loose);
//   * once started it eases towards the padded target at the configured response and stops again within
//     AUTOY_RELEASE x span of it.
// snap = true (first frame, or the first frame after the tab was in the background) places both edges
// exactly on the target and clears the latches; damping resumes with the next frame.
const AUTOY_TIGHT=0.5,AUTOY_LOOSE=0.12,AUTOY_RELEASE=0.02;
function autoYStep(cur,target,pad,response,latch,snap){
  if(!cur||snap||!(cur.max>cur.min)){latch[0]=latch[1]=false;return{min:target.min,max:target.max};}
  const S=cur.max-cur.min,out={min:cur.min,max:cur.max};
  const eMin=target.min-cur.min,eMax=cur.max-target.max;   // >0: view looser than needed, <0: data inside the padding
  const edges=[['min',eMin,target.min],['max',eMax,target.max]];
  for(let k=0;k<2;k++){
    const [name,e,t]=edges[k];
    if(!latch[k]&&(e<-AUTOY_TIGHT*pad||e>AUTOY_LOOSE*S))latch[k]=true;
    if(latch[k]){out[name]+=(t-out[name])*response;if(Math.abs(t-out[name])<=AUTOY_RELEASE*S)latch[k]=false;}
  }
  return out;
}
function makeMainOptions() {
  const c=colors();
  return {
    width:$('mainChart').clientWidth||800,height:mainChartHeight(),title:'',legend:{show:true},
    cursor:{show:true,x:true,y:false,drag:{x:false,y:false},focus:{prox:30}},
    select:{show:true,left:0,top:0,width:0,height:0},
    scales:{x:{time:false,auto:false},y:{auto:!state.manualY,range:(u,min,max)=>{
      if(state.manualY)return[state.yMin,state.yMax];
      if(!Number.isFinite(min)||!Number.isFinite(max))return[min,max];
      let targetMin=min,targetMax=max;
      if($('zeroLineToggle').checked&&state.unitId!=='raw'){targetMin=Math.min(0,targetMin);targetMax=Math.max(0,targetMax);}
      let span=targetMax-targetMin;if(!(span>0))span=Math.max(1,Math.abs(targetMax)*.02);
      const pad=span*.04;targetMin-=pad;targetMax+=pad;
      const response=clamp(Number($('yResponseRange').value||5)/100,.01,1);
      const next=autoYStep(state.autoYMin==null?null:{min:state.autoYMin,max:state.autoYMax},{min:targetMin,max:targetMax},pad,response,state.autoYLatch,state.snapY);
      state.autoYMin=next.min;state.autoYMax=next.max;state.yBusy=!!(state.autoYLatch[0]||state.autoYLatch[1]);return[next.min,next.max];
    }}},
    axes:[
      {stroke:c.muted,grid:{stroke:'rgba(130,150,180,.12)'},ticks:{stroke:c.line},values:(u,vals)=>vals.map(v=>`${v.toFixed(1)}s`)},
      {stroke:c.muted,grid:{stroke:'rgba(130,150,180,.12)',filter:(u,splits)=>splits.map(v=>(state.unitId!=='raw'&&!$('zeroLineToggle').checked&&Math.abs(v)<1e-12)?null:v)},ticks:{stroke:c.line},values:(u,vals)=>vals.map(v=>state.unitId==='raw'?fmtNumber(v,0):fmtNumber(v,displayDigits()))}
    ],
    series:[
      {label:'Time',value:(u,v)=>v==null?'—':`${v.toFixed(2)} s`},
      {label:state.unitId==='raw'?'Raw sensor counts':'Measured mass',stroke:c.raw,width:1.25,points:{show:false},value:(u,v)=>v==null?'—':(state.unitId==='raw'?`${fmtNumber(v,0)} counts`:`${fmtNumber(v,displayDigits())} ${displayUnitSymbol()}`)},
      {label:centerLabel(),stroke:c.ma,width:2.1,points:{show:false},value:(u,v)=>v==null?'—':(state.unitId==='raw'?`${fmtNumber(v,0)} counts`:`${fmtNumber(v,displayDigits())} ${displayUnitSymbol()}`)},
      {label:`Upper +1σ (${spreadShort(state.estimator)})`,stroke:'rgba(0,0,0,0)',width:0,points:{show:false},value:(u,v)=>v==null?'—':fmtNumber(v,displayDigits())},
      {label:`Lower −1σ (${spreadShort(state.estimator)})`,stroke:'rgba(0,0,0,0)',width:0,points:{show:false},value:(u,v)=>v==null?'—':fmtNumber(v,displayDigits())}
    ],
    bands:[{series:[3,4],fill:'rgba(190,112,220,.16)'}],
    hooks:{drawAxes:[u=>{
      const ctx=u.ctx;
      if(state.unitId!=='raw'&&$('zeroLineToggle').checked){
        const y=u.valToPos(0,'y',true);
        if(Number.isFinite(y)&&y>=u.bbox.top&&y<=u.bbox.top+u.bbox.height){ctx.save();ctx.strokeStyle=c.zero;ctx.lineWidth=2.6;ctx.globalAlpha=.92;ctx.beginPath();ctx.moveTo(u.bbox.left,Math.round(y)+.5);ctx.lineTo(u.bbox.left+u.bbox.width,Math.round(y)+.5);ctx.stroke();ctx.restore();}
      }
      // Tare events are historical reference changes. Draw vertical markers behind data.
      if(state.unitId!=='raw'){
        const min=state.viewMin/1000,max=state.viewMax/1000;
        ctx.save();ctx.strokeStyle='rgba(232,174,66,.85)';ctx.fillStyle='rgba(232,174,66,.95)';ctx.lineWidth=1.3;ctx.setLineDash([4,3]);
        for(const event of state.tareEvents){const xVal=event.effectiveFromTime/1000;if(xVal<min||xVal>max)continue;const x=u.valToPos(xVal,'x',true);ctx.beginPath();ctx.moveTo(x,u.bbox.top);ctx.lineTo(x,u.bbox.top+u.bbox.height);ctx.stroke();ctx.setLineDash([]);ctx.font='10px system-ui';ctx.fillText('Tare',x+3,u.bbox.top+12);ctx.setLineDash([4,3]);}
        ctx.restore();
      }
    }]},
    plugins:[zeroFillPlugin(),calibrationMarkerPlugin()]
  };
}
function makeMiniOptions(){
  const c=colors();
  return {
    width:$('miniChart').clientWidth||800,height:125,legend:{show:true},
    cursor:{show:true,x:true,y:false,drag:{x:false,y:false}},
    select:{show:true,left:0,top:0,width:0,height:0},
    scales:{x:{time:false,auto:false},y:{auto:true}},
    axes:[
      {show:true,stroke:c.muted,size:18,grid:{show:true,stroke:'rgba(130,150,180,.15)',width:1},ticks:{show:true,stroke:c.line},values:(u,vals)=>vals.map(v=>`${v.toFixed(0)}s`)},
      {show:true,stroke:c.muted,size:26,grid:{show:true,stroke:'rgba(130,150,180,.15)',width:1},ticks:{show:true,stroke:c.line},values:(u,vals)=>vals.map(v=>state.unitId==='raw'?fmtNumber(v,0):fmtNumber(v,displayDigits()))}
    ],
    series:[{label:'Time'},{label:state.unitId==='raw'?'Raw history':'Mass history',stroke:c.raw,width:1.1,points:{show:false}}],
    plugins:[miniOverlayPlugin()]
  };
}
// The main chart and the navigator are created and destroyed independently (v10): changing the
// estimator only relabels the main chart's series, so only that chart is rebuilt.
function createMainChart(){
  state.mainPlot=new uPlot(makeMainOptions(),[[],[],[],[],[]],$('mainChart'));
  wireMainInteractions();wireEventHover(state.mainPlot);wireCrosshairSync(state.mainPlot,'main');
}
function createMiniChart(){
  state.miniPlot=new uPlot(makeMiniOptions(),[[],[]],$('miniChart'));
  wireMiniInteractions();wireEventHover(state.miniPlot);wireCrosshairSync(state.miniPlot,'mini');
}
function createCharts(){
  if(!window.uPlot){$('mainChart').innerHTML='<p class="warning">uPlot could not be loaded. Check the internet connection to the approved CDN.</p>';return;}
  createMainChart();createMiniChart();
}
function destroyCharts(){if(state.mainPlot)state.mainPlot.destroy();if(state.miniPlot)state.miniPlot.destroy();state.mainPlot=null;state.miniPlot=null;}
function recreateMainChart(){if(!state.mainPlot)return;state.mainPlot.destroy();state.mainPlot=null;createMainChart();}
function displayDigits(){const unit=unitById(state.unitId);return state.precision==='auto'?unit.decimals:Number(state.precision);}

function fitLiveWindow(){if(!state.count){state.viewMin=0;state.viewMax=PERIOD_MS;return;}const first=oldestTime(),last=newestTime();state.viewMax=Math.max(last,first+PERIOD_MS);state.viewMin=Math.max(first,state.viewMax-state.liveWindowSpan);}
function clampHistoricalView(){const span=Math.max(PERIOD_MS,state.viewMax-state.viewMin),first=oldestTime(),last=newestTime();state.viewMin=clamp(state.viewMin,first,Math.max(first,last-span));state.viewMax=Math.min(last,state.viewMin+span);}
function updateViewLabel(){const s=Math.max(0,state.viewMax-state.viewMin)/1000;$('viewLabel').textContent=(state.curveStride>1?`Curve every ${state.curveStride}th sample · `:'')+(state.live?`Live · ${(state.liveWindowSpan/1000).toFixed(2)} s window`:`Historical · ${s.toFixed(2)} s span`);$('trackBtn').classList.toggle('primary',state.live);$('trackBtn').setAttribute('aria-pressed',String(state.live));}
function scheduleRender(){if(renderPending)return;renderPending=true;requestAnimationFrame(()=>{renderPending=false;renderFrame();});}
// v11: a historical view that has been moved to the far right edge switches Track Live back on. Not while an
// interval is selected / pinned, so that selecting something near the newest data does not move the view.
function autoTrackIfAtEnd(){
  if(state.live||!state.count||state.selection||state.logPinned)return;
  const span=Math.max(PERIOD_MS,state.viewMax-state.viewMin);
  if(state.viewMax>=newestTime()-Math.max(2*PERIOD_MS,0.005*span))setLive(true);
}
// A sensor without samples (just added from the server list, or paused from the start) has nothing to show.
function renderEmpty(){
  $('currentValue').textContent='—';$('currentSpread').textContent='—';$('tareValue').textContent='—';
  $('currentValueDetail').textContent='Waiting for data…';$('spreadDetail').textContent='—';$('tareDetail').textContent='—';$('rangeStatus').hidden=true;
  $('sampleCount').textContent='0 samples';updateViewLabel();updateMeasurementUI();
  if(state.mainPlot)state.mainPlot.setData([[],[],[],[],[]]);if(state.miniPlot)state.miniPlot.setData([[],[]]);
}
function renderFrame(){
  if(wiz.open)wizTick();
  if(!state.count){renderEmpty();return;}
  if(!state.live)autoTrackIfAtEnd();
  if(state.live)fitLiveWindow();
  updateMetrics();updateMeasurementUI();$('sampleCount').textContent=`${state.count.toLocaleString()} samples`;updateViewLabel();
  const ts=performance.now();
  if(state.lastFrameTs&&ts-state.lastFrameTs>2000)state.snapY=true;   // rendering was suspended (background tab): do not damp
  state.lastFrameTs=ts;
  if(!state.mainPlot)return;
  const data=buildVisibleData(),minX=state.viewMin/1000,maxX=Math.max(minX+PERIOD_MS/1000,state.viewMax/1000);
  state.mainPlot.batch(()=>{state.mainPlot.setData(data,true);state.mainPlot.setScale('x',{min:minX,max:maxX});if(state.manualY)state.mainPlot.setScale('y',{min:state.yMin,max:state.yMax});});
  state.snapY=false;   // damping resumes immediately after the one undamped frame
  // v11 fix: the Y damping advances once per RENDERED frame. While streaming that is every 12.5 ms, but a
  // paused chart renders only on interaction, so the axis stopped part-way to its target. As long as an
  // edge is still easing (latched), keep rendering until both edges have settled.
  if(state.yBusy&&!state.manualY)scheduleRender();
  const now=performance.now();if(now-miniLastRender>=250){updateMini();miniLastRender=now;}else updateMiniSelection();
  if(state.selection)updateSelectionReadout();
}
function updateMiniSelection(){if(!state.miniPlot)return;const left=state.miniPlot.valToPos(state.viewMin/1000,'x'),right=state.miniPlot.valToPos(state.viewMax/1000,'x');state.miniPlot.setSelect({left:Math.max(0,left),top:0,width:Math.max(1,right-left),height:state.miniPlot.height});}
function updateMini(){
  if(!state.miniPlot)return;const data=buildMiniData(),first=state.count?oldestTime()/1000:0,last=state.count?newestTime()/1000:PERIOD_MS/1000,maxX=Math.max(first+PERIOD_MS/1000,last);
  state.miniPlot.batch(()=>{state.miniPlot.setData(data,true);state.miniPlot.setScale('x',{min:first,max:maxX});});updateMiniSelection();
}

// Location estimators and the spread statistic that belongs to each of them. The spread is chosen
// to match the estimator, so the centre line and its +-1 sigma band describe the same statistic:
//   mean    -> population SD (divisor n)
//   median  -> robust sigma = 1.4826 x MAD (consistent with sigma for normal data). If MAD = 0
//              (more than half of the samples tied, typical for quantized counts) the scale falls
//              back to 1.2533 x mean absolute deviation about the median.
//   trimmed -> SD of the RETAINED samples. This is biased LOW (the tails were removed on purpose);
//              it describes the scatter of the data that entered the estimate.
//   hampel  -> SD of the samples kept by the 3-scale gate; biased low for the same reason.
//   ema     -> exponentially weighted SD with the same time constant (West 1979 recursion,
//              v <- a (v + (1-a) d^2), d = x - m, a = exp(-dt/tau)); seeded with v = 0, so like the
//              EMA itself it is only trustworthy after several time constants.
// These numbers describe observed scatter only; they are not measurement uncertainties, and
// values from different estimators are different statistics and must not be compared directly.
function medianOfSorted(a){const n=a.length;return n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2;}
// ---- Sliding (local) Hampel identifier (v10) ------------------------------------------------------
// Classical Hampel rule: sample i is an outlier if |x_i - med_i| > nSigma * 1.4826 * MAD_i, where med_i and
// MAD_i come from the 2k+1 samples centred on i (truncated at the ends of the series). Because the
// reference is LOCAL, a slow drift or a step does not make ordinary samples look like outliers, which
// is the weakness of the old global gate. Two documented choices:
//  * Scale floor. Quantized counts often give MAD = 0 inside 11 tied samples; the rule would then
//    flag every sample that differs by one count. The local scale is therefore never smaller than
//    (a) 1/3 of the series' noise level, estimated from FIRST DIFFERENCES (1.4826 MAD(diff) / sqrt 2, or the
//    mean-absolute-deviation analogue if that is 0), which a slow drift cannot inflate, and
//    (b) one quantisation step (the smallest gap between distinct values, ignoring gaps < 1e-9 of the range),
//    so a one-step deviation is never an outlier; and never below 1e-12.
//  * Flagged samples are EXCLUDED from the mean and SD (the classical filter replaces them with the
//    local median; replacement would insert synthetic values and bias the SD low even further).
//    The SD of the kept samples is still biased low and is not an uncertainty.
const HAMPEL_DEFAULT_HALF=5,HAMPEL_DEFAULT_SIGMA=3,HAMPEL_SELECTION_MAX=200000;
function hampelFlags(values,half,nSigma){
  const n=values.length,flags=new Uint8Array(n);if(n<3)return flags;
  const all=Float64Array.from(values).sort(),range=all[n-1]-all[0];let q=Infinity;
  for(let i=1;i<n;i++){const g=all[i]-all[i-1];if(g>1e-9*range&&g<q)q=g;}
  const df=new Float64Array(n-1);for(let i=1;i<n;i++)df[i-1]=values[i]-values[i-1];
  const dsort=Float64Array.from(df).sort(),dmed=medianOfSorted(dsort),gd=new Float64Array(n-1);
  for(let i=0;i<n-1;i++)gd[i]=Math.abs(df[i]-dmed);
  gd.sort();let gscale=1.4826*medianOfSorted(gd)/Math.SQRT2;
  if(!(gscale>0)){let sad=0;for(let i=0;i<n-1;i++)sad+=gd[i];gscale=1.2533*sad/(n-1)/Math.SQRT2;}
  const floor=Math.max(gscale/3,Number.isFinite(q)?q:0,1e-12),win=new Float64Array(2*half+1),dev=new Float64Array(2*half+1);
  for(let i=0;i<n;i++){
    const a=Math.max(0,i-half),b=Math.min(n-1,i+half),m=b-a+1,w=win.subarray(0,m),d=dev.subarray(0,m);
    for(let j=0;j<m;j++)w[j]=values[a+j];
    w.sort();const med=medianOfSorted(w);
    for(let j=0;j<m;j++)d[j]=Math.abs(w[j]-med);
    d.sort();const scale=Math.max(1.4826*medianOfSorted(d),floor);
    if(Math.abs(values[i]-med)>nSigma*scale)flags[i]=1;
  }
  return flags;
}
// ---- Seed-normalised EMA (v10) -----------------------------------------------------------------------
// The plain EMA is seeded with the first sample, which keeps weight exp(-T/tau) after T seconds: for a
// short interval the result is mostly that seed. Here the weights are those of the EMA kernel only,
//   w_i = (1 - a_i) * prod_{j>i} a_j,   a_j = exp(-dt_j / tau)   (the first sample counts as one nominal period),
// and are NORMALISED to sum to one, so no weight is left on a seed. Value = sum w x / sum w, spread = the
// weighted SD about that weighted mean. (This differs in meaning from the recursive "EW SD" of the plain
// EMA, which measures deviations from the moving mean and therefore includes drift.) With tau >> T the
// result tends to the arithmetic mean. Exact incremental form (West 1979 with exponential decay):
//   W' = a W + u,  m' = m + (u / W')(x - m),  S' = a S + u (x - m)(x - m'),  u = 1 - a,  sigma^2 = S / W.
// Kish effective sample size = (sum w)^2 / sum w^2 is tracked as sw, sw2 (both decay with a, a^2).
function emaNormStep(st,x,dtS,tau){
  const a=Math.exp(-Math.max(0,dtS)/tau),u=1-a,W=a*st.W+u;
  if(W>0){const d=x-st.m;st.m+=u/W*d;st.S=a*st.S+u*d*(x-st.m);}
  st.W=W;st.sw=a*st.sw+u;st.sw2=a*a*st.sw2+u*u;
}
function emaNormalised(values,times,tau){
  tau=Math.max(.025,Number(tau)||.5);const st={W:0,m:0,S:0,sw:0,sw2:0},n=values.length,hasT=!!times&&times.length>=n;
  for(let i=0;i<n;i++)emaNormStep(st,values[i],(i>0&&hasT)?(times[i]-times[i-1])/1000:PERIOD_MS/1000,tau);
  return{value:st.m,sigma:Math.sqrt(Math.max(0,st.S/st.W)),neff:st.sw2>0?st.sw*st.sw/st.sw2:0};
}
function estimate(values,times,method,options={}){
  const n=values.length;if(!n)return{value:NaN,used:0,rejected:0,sigma:NaN};
  if(method==='ema'){
    const tau=Math.max(.025,Number(options.tau)||.5);let m=values[0],v=0;
    for(let i=1;i<n;i++){const a=Math.exp(-Math.max(0,(times[i]-times[i-1])/1000)/tau),d=values[i]-m;m+=(1-a)*d;v=a*(v+(1-a)*d*d);}
    return{value:m,used:n,rejected:0,sigma:Math.sqrt(v)};
  }
  if(method==='emaNorm'){const r=emaNormalised(values,times,options.tau);return{value:r.value,used:n,rejected:0,sigma:r.sigma,neff:r.neff};}
  if(method==='hampelLocal'){
    const half=clamp(Math.round(Number(options.hampelHalf)||HAMPEL_DEFAULT_HALF),2,50),ns=clamp(Number(options.hampelSigma)||HAMPEL_DEFAULT_SIGMA,1,10);
    const flags=hampelFlags(values,half,ns),kept=[];
    for(let i=0;i<n;i++)if(!flags[i])kept.push(values[i]);
    if(!kept.length)return{value:medianOfSorted(Float64Array.from(values).sort()),used:0,rejected:n,sigma:0};
    return{value:kept.reduce((s,v)=>s+v,0)/kept.length,used:kept.length,rejected:n-kept.length,sigma:calculateStd(kept)};
  }
  if(method==='mean'||(method!=='median'&&method!=='trimmed'&&method!=='hampel'))return{value:values.reduce((sum,v)=>sum+v,0)/n,used:n,rejected:0,sigma:calculateStd(values)};
  const arr=values.slice().sort((a,b)=>a-b),median=medianOfSorted(arr);
  const robustSigma=()=>{
    const mad=medianOfSorted(arr.map(v=>Math.abs(v-median)).sort((a,b)=>a-b));let scale=1.4826*mad;
    if(!(scale>0)){let sad=0;for(const v of arr)sad+=Math.abs(v-median);scale=1.2533*sad/n;}
    return scale;
  };
  if(method==='median')return{value:median,used:n,rejected:0,sigma:robustSigma()};
  if(method==='trimmed'){
    const trim=Math.floor(n*clamp(Number(options.trimPercent)||10,1,30)/100),from=trim,to=Math.max(trim+1,n-trim),kept=arr.slice(from,to);
    return{value:kept.reduce((a,b)=>a+b,0)/kept.length,used:kept.length,rejected:n-kept.length,sigma:calculateStd(kept)};
  }
  // hampel (old, global): one 3 x robust-scale gate around the window median, then mean and SD of the kept samples
  const threshold=Math.max(3*robustSigma(),1e-9),kept=arr.filter(v=>Math.abs(v-median)<=threshold);
  if(!kept.length)return{value:median,used:1,rejected:n-1,sigma:0};
  return{value:kept.reduce((a,b)=>a+b,0)/kept.length,used:kept.length,rejected:n-kept.length,sigma:calculateStd(kept)};
}
function spreadShort(method){return({mean:'SD',median:'MAD',trimmed:'retained SD',hampel:'retained SD',hampelLocal:'retained SD',ema:'EW SD',emaNorm:'weighted SD'})[method]||'SD';}
function spreadDescription(method){return({mean:'population SD',median:'robust σ = 1.4826 × MAD',trimmed:'SD of retained samples (biased low)',hampel:'SD of retained samples (biased low)',hampelLocal:'SD of samples kept by the sliding Hampel test (biased low)',ema:'exponentially weighted SD',emaNorm:'exponentially weighted SD about the seed-normalised mean'})[method]||'SD';}
function centerLabel(){const raw=state.unitId==='raw',m=state.estimator;return m==='mean'?(raw?'Raw moving average':'Moving average'):`${raw?'Raw ':''}${estimatorLabel(m)}`;}
function estimatorOptions(){return{tau:state.emaTau,trimPercent:state.trimPercent,hampelHalf:state.hampelHalf,hampelSigma:state.hampelSigma};}
function isEmaMethod(m){return m==='ema'||m==='emaNorm';}
// ---- Estimator curve for the main chart ------------------------------------------------------------
// Centre line and band follow the selected estimator. Mean uses the exact O(1) rolling values stored
// at ingest. EMA is evaluated in one pass over the visible range plus a warm-up. Median / trimmed /
// Hampel are evaluated per sample from the window (never across a tare epoch). When many samples are
// visible they are evaluated on a sparse grid (aligned to absolute sample numbers, so panning reuses
// the cache) and linearly interpolated in between; the stride is shown next to the view label.
const CURVE_BUDGET=150000;   // about this many window samples may be sorted per frame
const CURVE_EMA_WARMUP=7;    // EMA warm-up in time constants (seed weight e^-7 = 0.09 %)
function absIndex(i){return state.appended-state.count+i;}
function epochBounds(diagnostic){const b=[0];if(!diagnostic)for(const e of state.tareEvents)b.push(lowerBoundTime(e.effectiveFromTime));return b;}
function epochStartFor(i,bounds){for(let k=bounds.length-1;k>=0;k--)if(bounds[k]<=i)return bounds[k];return 0;}
function buildEstimatorCurve(lo,hi,diagnostic){
  const method=state.estimator;
  if(method==='mean')return{stride:1,center:i=>chartMAAt(i,diagnostic),sigma:i=>chartSDAt(i,diagnostic)};
  const get=i=>diagnostic?getRaw(i):getNetMg(i),bounds=epochBounds(diagnostic);
  if(isEmaMethod(method)){
    const norm=method==='emaNorm',tau=Math.max(.025,state.emaTau),s0=Math.max(0,lo-Math.ceil(CURVE_EMA_WARMUP*tau*RATE_HZ)),starts=new Set(bounds);
    const C=new Float64Array(hi-lo+1),S=new Float64Array(hi-lo+1);let m=0,v=0,prevT=getTime(s0);
    const st={W:0,m:0,S:0,sw:0,sw2:0};
    for(let i=s0;i<=hi;i++){
      const x=get(i),t=getTime(i),reset=(i===s0||starts.has(i));
      if(norm){   // seed-normalised: exact weighted mean/SD of the samples since the epoch start (or warm-up start)
        if(reset){st.W=0;st.m=0;st.S=0;st.sw=0;st.sw2=0;emaNormStep(st,x,PERIOD_MS/1000,tau);}
        else emaNormStep(st,x,Math.max(0,(t-prevT)/1000),tau);
        m=st.m;v=st.S/st.W;
      }else if(reset){m=x;v=0;}
      else{const a=Math.exp(-Math.max(0,(t-prevT)/1000)/tau),d=x-m;m+=(1-a)*d;v=a*(v+(1-a)*d*d);}
      prevT=t;if(i>=lo){C[i-lo]=m;S[i-lo]=Math.sqrt(Math.max(0,v));}
    }
    return{stride:1,center:i=>C[i-lo],sigma:i=>S[i-lo]};
  }
  const w=Math.max(2,Math.min(state.window,MAX_ROBUST_WINDOW)),count=hi-lo+1;
  const costW=method==='hampelLocal'?w*(2*state.hampelHalf+2):w;   // the local Hampel test costs ~(2k+1) small sorts per sample
  const stride=Math.max(1,Math.ceil(count/Math.max(64,Math.floor(CURVE_BUDGET/Math.max(16,costW)))));
  const nodes=[];
  if(stride===1){for(let i=lo;i<=hi;i++)nodes.push(i);}
  else{nodes.push(lo);const a0=absIndex(lo);for(let i=lo+((stride-(a0%stride))%stride);i<hi;i+=stride)if(i>lo)nodes.push(i);if(nodes[nodes.length-1]!==hi)nodes.push(hi);}
  const key=`${diagnostic?'r':'m'}|${method}|${w}|${state.trimPercent}|${state.hampelHalf}|${state.hampelSigma}`;
  if(state.curveCache.key!==key||state.curveCache.map.size>60000)state.curveCache={key,map:new Map()};
  const cache=state.curveCache.map,NC=new Float64Array(nodes.length),NS=new Float64Array(nodes.length);
  for(let k=0;k<nodes.length;k++){
    const i=nodes[k],id=absIndex(i);let hit=cache.get(id);
    if(!hit){const a=Math.max(i-w+1,epochStartFor(i,bounds)),vals=new Array(i-a+1);for(let j=a;j<=i;j++)vals[j-a]=get(j);const r=estimate(vals,[],method,estimatorOptions());hit=[r.value,r.sigma];cache.set(id,hit);}
    NC[k]=hit[0];NS[k]=hit[1];
  }
  const at=(i,arr)=>{
    if(stride===1)return arr[i-lo];
    let l=0,r=nodes.length-1;while(l<r){const mid=(l+r+1)>>1;if(nodes[mid]<=i)l=mid;else r=mid-1;}
    if(nodes[l]>=i||l===nodes.length-1)return arr[l];
    return arr[l]+(i-nodes[l])/(nodes[l+1]-nodes[l])*(arr[l+1]-arr[l]);
  };
  return{stride,center:i=>at(i,NC),sigma:i=>at(i,NS)};
}
function collectCurrentWindow(n){ // newest n samples; the caller limits n to the current tare epoch
  n=Math.min(state.count,n);const start=state.count-n,values=new Array(n),times=new Array(n),raws=new Array(n);
  for(let j=0;j<n;j++){const i=start+j;values[j]=getNetMg(i);times[j]=getTime(i);raws[j]=getRaw(i);}
  return{values,times,raws};
}
// This standard deviation describes observed sample spread/repeatability only. It is NOT
// the uncertainty of the mean. At 80 Hz adjacent readings may be autocorrelated, so
// dividing by sqrt(n) without estimating effective independent sample count is unsafe.
// Welford's one-pass update (population SD, divisor n): numerically stable for any offset.
function calculateStd(values){if(!values.length)return NaN;let n=0,mean=0,m2=0;for(const v of values){n++;const d=v-mean;mean+=d/n;m2+=d*(v-mean);}return Math.sqrt(m2/n);}
function updateMetrics(){
  if(!state.count)return;
  const diagnostic=state.unitId==='raw',last=state.count-1,raw=getRaw(last),tare=currentTareEvent();
  // One window setting drives the chart average, the spread and the panel estimator. Net-mass
  // statistics use only the current tare/calibration epoch (a tare resets the window), so the
  // panel never mixes values that are relative to two different zero references.
  const epochStart=(!diagnostic&&tare)?Math.min(lowerBoundTime(tare.effectiveFromTime),last):0;
  const n=Math.max(1,Math.min(state.window,state.count-epochStart));
  const method=state.estimator,robust=method==='median'||method==='trimmed'||method==='hampel'||method==='hampelLocal';
  let value,used=n,rejected=0,sig=NaN;
  if(method==='mean')value=diagnostic?getRawMA(last):getMassMA(last);
  else if(isEmaMethod(method)){const c=buildEstimatorCurve(last,last,diagnostic);value=c.center(last);sig=c.sigma(last);}
  else{const w=collectCurrentWindow(Math.min(n,MAX_ROBUST_WINDOW));const r=estimate(diagnostic?w.raws:w.values,w.times,method,estimatorOptions());value=r.value;used=w.values.length;rejected=r.rejected;sig=r.sigma;}
  const spread=method==='mean'?(diagnostic?getRawSD(last):getMassSD(last)):sig;
  $('currentValueLabel').textContent=diagnostic?'Raw sensor estimator':'Current measured mass';
  $('currentValue').textContent=diagnostic?fmtNumber(value,0):formatMass(value);
  $('currentValueDetail').textContent=isEmaMethod(method)?`${method==='emaNorm'?'EMA (seed-normalised)':'EMA (seeded)'} · τ ${state.emaTau.toFixed(3)} s${diagnostic?' · counts':''}`:`${estimatorLabel(method)}${method==='hampelLocal'?` (k=${state.hampelHalf}, ${state.hampelSigma}σ)`:''} · ${used} samples${robust&&n>MAX_ROBUST_WINDOW?' (newest 4,096 of window)':''}${rejected?` · ${rejected} excluded`:''}${diagnostic?' · counts':''}`;
  $('currentValue').title=`Raw latest: ${raw} counts\nAbsolute calibrated mass: ${fmtNumber(getMassMg(last),3)} mg\nNet calibrated mass: ${fmtNumber(getNetMg(last),3)} mg\nCalibration: ${state.revisionId}`;
  const outside=calibrateAbsolute(raw).outOfRange&&!diagnostic;
  $('rangeStatus').hidden=!outside;if(outside)$('rangeStatus').textContent='Latest sample is outside the calibrated range (extrapolated).';
  $('spreadLabel').textContent=diagnostic?'Raw sensor spread (σ)':'Sensor spread (σ)';
  $('currentSpread').textContent=diagnostic?`${fmtNumber(spread,2)} counts`:formatMass(spread);
  $('spreadDetail').textContent=`${spreadDescription(method)} · repeatability only, not an uncertainty`;
  $('tareValue').textContent=diagnostic?(tare?(tare.tareRaw==null?'Manual mass tare':fmtNumber(tare.tareRaw,0)):'None'):(tare?formatMass(tare.tareMassMg):'None');
  $('tareDetail').textContent=tare?`${tare.method} · ${new Date(tare.createdAt).toLocaleTimeString()}${tare.outOfRangeCount?` · ${tare.outOfRangeCount} out-of-range samples`:''}`:'No tare event recorded';
  $('tareDetail').classList.toggle('warning',!!(tare&&tare.outOfRangeCount));
  $('tareUnitLabel').textContent=displayUnitSymbol();
  $('manualTareBtn').disabled=diagnostic;
  $('manualTareInput').disabled=diagnostic;
  $('uncertaintyStatus').textContent=calibration.validation?.status==='validated'?'Measurement uncertainty: see calibration validation metadata.':'Measurement uncertainty: not characterized by the embedded demonstration calibration. Sensor spread is repeatability information, not a complete uncertainty statement.';
}
function estimatorLabel(method){return({mean:'Arithmetic mean',median:'Median',trimmed:'Trimmed mean',hampel:'Global MAD filter + mean',hampelLocal:'Sliding Hampel filter + mean',ema:'Exponential moving average (EMA, seeded)',emaNorm:'EMA, seed-normalised'})[method]||'Arithmetic mean';}

function setLive(on){state.live=on;if(on)fitLiveWindow();updateViewLabel();}
function trackLive(){setLive(true);state.selection=null;state.logPinned=null;$('selectionSummary').textContent='No interval selected.';scheduleRender();}
function zoomBy(factor,anchorRatio=.5){const oldSpan=Math.max(PERIOD_MS,state.viewMax-state.viewMin),maxSpan=Math.max(500,state.capacity*PERIOD_MS),newSpan=clamp(state.liveWindowSpan*factor,250,maxSpan);state.liveWindowSpan=newSpan;if(state.live)fitLiveWindow();else{const anchor=state.viewMin+clamp(anchorRatio,0,1)*oldSpan;state.viewMin=clamp(anchor-anchorRatio*newSpan,oldestTime(),Math.max(oldestTime(),newestTime()-newSpan));state.viewMax=Math.min(newestTime(),state.viewMin+newSpan);}scheduleRender();}
function wheelZoom(e){e.preventDefault();const rect=state.mainPlot.over.getBoundingClientRect(),x=clamp(e.clientX-rect.left,0,rect.width);zoomBy(e.deltaY<0?.8:1.25,rect.width?x/rect.width:.5);}

function wireCrosshairSync(u,which){
  // The other chart is looked up at event time, so either chart can be recreated on its own.
  const over=u.over;
  over.addEventListener('pointermove',e=>{
    const other=which==='main'?state.miniPlot:state.mainPlot;if(!other)return;
    const rect=over.getBoundingClientRect(),x=clamp(e.clientX-rect.left,0,rect.width);
    other.setCursor({left:other.valToPos(u.posToVal(x,'x'),'x'),top:Math.max(2,other.bbox.height/2)});
  });
  over.addEventListener('pointerleave',()=>{(which==='main'?state.miniPlot:state.mainPlot)?.setCursor({left:-10,top:-10});});
}
function wireMainInteractions(){
  const over=state.mainPlot.over;let drag=null;
  over.addEventListener('wheel',wheelZoom,{passive:false});
  over.addEventListener('pointerdown',e=>{if(e.pointerType==='touch'||e.button!==0)return;const rect=over.getBoundingClientRect(),x=clamp(e.clientX-rect.left,0,rect.width),select=e.shiftKey||state.selectMode;drag={id:e.pointerId,startX:x,currentX:x,rect,mode:select?'select':'pan',startMin:state.viewMin,startMax:state.viewMax,moved:false};try{over.setPointerCapture(e.pointerId);}catch(_){}e.preventDefault();e.stopImmediatePropagation();},true);
  over.addEventListener('pointermove',e=>{if(!drag||drag.id!==e.pointerId)return;const x=clamp(e.clientX-drag.rect.left,0,drag.rect.width);drag.currentX=x;if(Math.abs(x-drag.startX)>3)drag.moved=true;if(drag.mode==='select'){state.mainPlot.setSelect({left:Math.min(x,drag.startX),top:0,width:Math.abs(x-drag.startX),height:state.mainPlot.height});}else if(drag.moved){state.live=false;const shift=-(x-drag.startX)*(drag.startMax-drag.startMin)/Math.max(1,drag.rect.width),span=drag.startMax-drag.startMin;const min=clamp(drag.startMin+shift,oldestTime(),Math.max(oldestTime(),newestTime()-span));state.viewMin=min;state.viewMax=Math.min(newestTime(),min+span);state.liveWindowSpan=span;scheduleRender();}e.preventDefault();e.stopImmediatePropagation();},true);
  const finish=e=>{if(!drag||drag.id!==e.pointerId)return;if(drag.mode==='select'&&drag.moved){const x0=state.mainPlot.posToVal(Math.min(drag.startX,drag.currentX),'x')*1000,x1=state.mainPlot.posToVal(Math.max(drag.startX,drag.currentX),'x')*1000;selectInterval(Math.min(x0,x1),Math.max(x0,x1));state.mainPlot.setSelect({left:0,top:0,width:0,height:0});}drag=null;if(state.selectMode)setSelectMode(false);e.preventDefault();e.stopImmediatePropagation();};
  over.addEventListener('pointerup',finish,true);over.addEventListener('pointercancel',finish,true);
  let touch=null,pinch=null;
  over.addEventListener('touchstart',e=>{const rect=over.getBoundingClientRect();if(e.touches.length===2){touch=null;const dx=e.touches[0].clientX-e.touches[1].clientX,center=(e.touches[0].clientX+e.touches[1].clientX)/2-rect.left;pinch={distance:Math.abs(dx),ratio:clamp(center/Math.max(1,rect.width),0,1)};}else if(e.touches.length===1){const x=clamp(e.touches[0].clientX-rect.left,0,rect.width);touch={startX:x,currentX:x,rect,mode:state.selectMode?'select':'pan',startMin:state.viewMin,startMax:state.viewMax,moved:false};pinch=null;}},{passive:true});
  over.addEventListener('touchmove',e=>{if(e.touches.length===2&&pinch){const dist=Math.abs(e.touches[0].clientX-e.touches[1].clientX);zoomBy(pinch.distance/Math.max(20,dist),pinch.ratio);pinch.distance=dist;}else if(e.touches.length===1&&touch){const x=clamp(e.touches[0].clientX-touch.rect.left,0,touch.rect.width);touch.currentX=x;if(Math.abs(x-touch.startX)>3)touch.moved=true;if(touch.mode==='select')state.mainPlot.setSelect({left:Math.min(x,touch.startX),top:0,width:Math.abs(x-touch.startX),height:state.mainPlot.height});else if(touch.moved){state.live=false;const shift=-(x-touch.startX)*(touch.startMax-touch.startMin)/Math.max(1,touch.rect.width),span=touch.startMax-touch.startMin,min=clamp(touch.startMin+shift,oldestTime(),Math.max(oldestTime(),newestTime()-span));state.viewMin=min;state.viewMax=Math.min(newestTime(),min+span);state.liveWindowSpan=span;scheduleRender();}}},{passive:true});
  over.addEventListener('touchend',()=>{if(touch&&touch.mode==='select'&&touch.moved){const a=state.mainPlot.posToVal(Math.min(touch.startX,touch.currentX),'x')*1000,b=state.mainPlot.posToVal(Math.max(touch.startX,touch.currentX),'x')*1000;selectInterval(Math.min(a,b),Math.max(a,b));state.mainPlot.setSelect({left:0,top:0,width:0,height:0});}touch=null;pinch=null;if(state.selectMode)setSelectMode(false);},{passive:true});
}
function wireMiniInteractions(){
  // Click = centre the main view on that time (span unchanged). Drag = the dragged range becomes
  // the main view, updated live while dragging. Mouse and touch share the same helpers.
  const over=state.miniPlot.over;let drag=null;
  const toMs=x=>state.miniPlot.posToVal(x,'x')*1000;
  const centreOn=ms=>{const span=Math.max(PERIOD_MS,state.viewMax-state.viewMin);state.live=false;state.viewMin=clamp(ms-span/2,oldestTime(),Math.max(oldestTime(),newestTime()-span));state.viewMax=Math.min(newestTime(),state.viewMin+span);scheduleRender();};
  const showRange=(a,b)=>{state.live=false;state.viewMin=Math.max(oldestTime(),a);state.viewMax=Math.min(newestTime(),Math.max(state.viewMin+PERIOD_MS,b));state.liveWindowSpan=Math.max(250,state.viewMax-state.viewMin);scheduleRender();};
  const begin=(x,rect,id)=>{drag={id,startX:x,rect,moved:false};centreOn(toMs(x));};
  const move=x=>{if(Math.abs(x-drag.startX)>3)drag.moved=true;if(drag.moved)showRange(toMs(Math.min(drag.startX,x)),toMs(Math.max(drag.startX,x)));};
  over.addEventListener('pointerdown',e=>{if(e.pointerType==='touch'||e.button!==0)return;const rect=over.getBoundingClientRect();begin(clamp(e.clientX-rect.left,0,rect.width),rect,e.pointerId);over.setPointerCapture?.(e.pointerId);e.preventDefault();e.stopImmediatePropagation();},true);
  over.addEventListener('pointermove',e=>{if(!drag||drag.id!==e.pointerId)return;move(clamp(e.clientX-drag.rect.left,0,drag.rect.width));},true);
  const finish=e=>{if(drag&&drag.id===e.pointerId)drag=null;};
  over.addEventListener('pointerup',finish,true);over.addEventListener('pointercancel',finish,true);
  over.addEventListener('touchstart',e=>{if(e.touches.length!==1)return;const rect=over.getBoundingClientRect();begin(clamp(e.touches[0].clientX-rect.left,0,rect.width),rect,'touch');e.preventDefault();},{passive:false});
  over.addEventListener('touchmove',e=>{if(!drag||drag.id!=='touch'||e.touches.length!==1)return;move(clamp(e.touches[0].clientX-drag.rect.left,0,drag.rect.width));e.preventDefault();},{passive:false});
  over.addEventListener('touchend',()=>{if(drag&&drag.id==='touch')drag=null;});
}

function sampleIndicesForEstimator(first,end,method,limit){
  const total=end-first;if(limit==null)limit=method==='hampelLocal'?HAMPEL_SELECTION_MAX:MAX_ROBUST_WINDOW;
  if(method==='mean'||method==='ema'||method==='emaNorm'||total<=limit)return Array.from({length:total},(_,i)=>first+i);
  // The local Hampel test needs CONTIGUOUS samples (neighbours spaced by a stride would not be local):
  // the newest `limit` samples are used. The UI discloses the bounded analysis.
  if(method==='hampelLocal')return Array.from({length:limit},(_,k)=>end-limit+k);
  // Median/trimmed/global-Hampel analysis is intentionally bounded for predictable UI cost.
  // Evenly spaced samples cover the selected interval; the UI discloses this approximation.
  const indices=new Array(limit),step=(total-1)/(limit-1);
  for(let i=0;i<limit;i++)indices[i]=first+Math.round(i*step);
  return indices;
}
function calculateSelection(first,end,settings={}){
  const method=settings.estimator||state.estimator, total=end-first, currentTare=currentTareMassMg();
  const selectedTau=settings.emaTau??state.emaTau, selectedTrim=settings.trimPercent??state.trimPercent;
  const selectedHalf=settings.hampelHalf??state.hampelHalf,selectedHSigma=settings.hampelSigma??state.hampelSigma;
  const options={tau:selectedTau,trimPercent:selectedTrim,hampelHalf:selectedHalf,hampelSigma:selectedHSigma};
  let emaNeff=null;
  let originalValueMg=0,currentValueMg=0,rawEstimatorValue=0,spreadMg=0,rawSpread=0,rawMean=0,usedSamples=0,rejectedSamples=0,outOfRangeCount=0;

  if(method==='mean'||method==='ema'||method==='emaNorm'){
    // Simple mean and EMA are streamed in O(N) with constant extra memory. A large
    // graph selection therefore does not allocate several million-element JS arrays.
    let sumOriginal=0,sumCurrent=0,sumRaw=0,wN=0,wMeanC=0,wM2C=0,wMeanR=0,wM2R=0; // Welford accumulators (stable SD)
    let emaOriginal=0,emaCurrent=0,emaRaw=0,previousTime=0,vC=0,vR=0;
    const mkEN=()=>({W:0,m:0,S:0,sw:0,sw2:0}),enO=mkEN(),enC=mkEN(),enR=mkEN(),tauN=Math.max(.025,selectedTau);   // vC/vR: exponentially weighted variances
    for(let i=first;i<end;i++){
      const raw=getRaw(i),time=getTime(i),original=getNetMg(i),absolute=calibrateAbsolute(raw),current=absolute.valueMg-currentTare;
      if(absolute.outOfRange)outOfRangeCount++;
      sumOriginal+=original;sumCurrent+=current;sumRaw+=raw;wN++;{const dC=current-wMeanC;wMeanC+=dC/wN;wM2C+=dC*(current-wMeanC);const dR=raw-wMeanR;wMeanR+=dR/wN;wM2R+=dR*(raw-wMeanR);}
      if(method==='emaNorm'){const dtN=i===first?PERIOD_MS/1000:Math.max(0,(time-previousTime)/1000);emaNormStep(enO,original,dtN,tauN);emaNormStep(enC,current,dtN,tauN);emaNormStep(enR,raw,dtN,tauN);}
      else if(method!=='ema'){/* mean: no EMA bookkeeping */}
      else if(i===first){emaOriginal=original;emaCurrent=current;emaRaw=raw;}
      else{const dt=Math.max(0,(time-previousTime)/1000),alpha=1-Math.exp(-dt/Math.max(.025,selectedTau));const dC=current-emaCurrent,dR=raw-emaRaw;vC=(1-alpha)*(vC+alpha*dC*dC);vR=(1-alpha)*(vR+alpha*dR*dR);emaOriginal=alpha*original+(1-alpha)*emaOriginal;emaCurrent=alpha*current+(1-alpha)*emaCurrent;emaRaw=alpha*raw+(1-alpha)*emaRaw;}
      previousTime=time;
    }
    usedSamples=total;rawMean=sumRaw/total;spreadMg=Math.sqrt(wM2C/total);rawSpread=Math.sqrt(wM2R/total);
    if(method==='mean'){originalValueMg=sumOriginal/total;currentValueMg=sumCurrent/total;rawEstimatorValue=rawMean;}
    else if(method==='emaNorm'){originalValueMg=enO.m;currentValueMg=enC.m;rawEstimatorValue=enR.m;spreadMg=Math.sqrt(Math.max(0,enC.S/enC.W));rawSpread=Math.sqrt(Math.max(0,enR.S/enR.W));emaNeff=enC.sw2>0?enC.sw*enC.sw/enC.sw2:null;}
    else{originalValueMg=emaOriginal;currentValueMg=emaCurrent;rawEstimatorValue=emaRaw;spreadMg=Math.sqrt(vC);rawSpread=Math.sqrt(vR);}
  }else{
    const indices=sampleIndicesForEstimator(first,end,method),origValues=[],currentValues=[],times=[],rawValues=[];
    for(const i of indices){
      const raw=getRaw(i),original=getNetMg(i),absolute=calibrateAbsolute(raw);
      origValues.push(original);currentValues.push(absolute.valueMg-currentTare);times.push(getTime(i));rawValues.push(raw);
      if(absolute.outOfRange)outOfRangeCount++;
    }
    const original=estimate(origValues,times,method,options),recalculated=estimate(currentValues,times,method,options),rawResult=estimate(rawValues,times,method,options);
    originalValueMg=original.value;currentValueMg=recalculated.value;rawEstimatorValue=rawResult.value;
    spreadMg=recalculated.sigma;rawMean=rawValues.reduce((a,b)=>a+b,0)/rawValues.length;rawSpread=rawResult.sigma;
    usedSamples=indices.length;rejectedSamples=recalculated.rejected;
  }
  const calFirst=calibrationAt(getTime(first)),calLast=calibrationAt(getTime(end-1));
  return {
    originalValueMg,currentValueMg,rawEstimatorValue,spreadMg,rawSpread,usedSamples,totalSamples:total,rawMean,
    firstIndex:first,lastIndex:end-1,t0:getTime(first),t1:getTime(end-1),
    estimator:method,estimatorWindow:state.window,trimPercent:selectedTrim,emaTau:selectedTau,hampelHalf:selectedHalf,hampelSigma:selectedHSigma,emaNeff,rejectedSamples,outOfRangeCount,
    // Provenance (v8): the revision stored here is the one the samples were RECORDED with.
    calibrationRevisionId:calLast.revisionId,crossesCalibration:calFirst!==calLast,
    calibrationChanged:calFirst.revisionId!==state.revisionId||calLast.revisionId!==state.revisionId,
    tareEventId:currentTareEvent()?.eventId||null,
    crossesTare:(tareEventAt(getTime(first))?.eventId||null)!==(tareEventAt(getTime(end-1))?.eventId||null),
    contextChanged:(currentTareEvent()?.eventId||null)!==(tareEventAt(getTime(first))?.eventId||null),
    analysis:analyzeInterval(first,end)
  };
}
function selectInterval(t0,t1,log=true){
  const first=lowerBoundTime(t0),end=lowerBoundTime(t1+0.0001);
  if(first>=end||first>=state.count)return;
  const selection=calculateSelection(first,end);
  state.selection=selection;delete state.detailsOpen.sel;state.live=false;
  const selectionSpan=Math.max(PERIOD_MS,selection.t1-selection.t0),viewSpan=Math.max(selectionSpan*1.2,state.liveWindowSpan);
  state.liveWindowSpan=viewSpan;state.viewMin=Math.max(oldestTime(),selection.t0-(viewSpan-selectionSpan)/2);state.viewMax=Math.min(newestTime(),state.viewMin+viewSpan);
  updateSelectionReadout();if(log)appendSelectionLog(selection);scheduleRender();
}
function updateSelectionReadout(){
  const s=state.selection;if(!s){$('selectionSummary').textContent='No interval selected.';return;}
  const changed=s.contextChanged?'<br><span class="warning">Tare context differs from the current tare. Both original and current interpretations are shown.</span>':'';
  const calibrationChanged=(s.calibrationChanged?'<br><span class="warning">Samples were recorded under a different calibration revision than the active one. “Original” uses the recorded calibration; “current” re-calibrates with the active one.</span>':'')+(s.crossesTare?'<br><span class="warning">The interval spans a tare event: the original result mixes values relative to different zero references.</span>':'')+(s.crossesCalibration?'<br><span class="warning">The interval spans a calibration change.</span>':'')+'<br>'+analysisHTML(s.analysis,true,'sel');
  const subsampled=s.usedSamples<s.totalSamples?` · bounded analysis used ${s.usedSamples.toLocaleString()} of ${s.totalSamples.toLocaleString()} samples`:'';
  setHTML($('selectionSummary'),`<strong>${s.totalSamples.toLocaleString()} selected samples</strong><br>`+
    `Time: <strong>${(s.t0/1000).toFixed(2)}–${(s.t1/1000).toFixed(2)} s</strong><br>`+
    `Estimator: <strong>${estimatorLabel(s.estimator)}</strong>`+
    // The selection EMA is seeded with the first selected sample, which keeps weight exp(-T/tau)
    // (product of the (1-alpha) factors). When T is not >> tau the result is mostly that seed,
    // so it is an end-of-selection filtered value, not an interval statistic.
    (s.estimator==='emaNorm'?` · no seed weight (normalised)${s.emaNeff?` · effective samples ≈ ${s.emaNeff.toFixed(1)}`:''}`:'')+(s.estimator==='hampelLocal'?` · k=${s.hampelHalf}, ${s.hampelSigma}σ`:'')+(s.estimator==='ema'?` · seed weight ${(100*Math.exp(-Math.max(0,s.t1-s.t0)/1000/Math.max(.025,s.emaTau))).toFixed(1)}%`:'')+`<br>`+
    (state.unitId==='raw'?`Raw estimator result: <strong>${fmtNumber(s.rawEstimatorValue,0)} counts</strong><br>`:`Original result: <strong>${formatMass(s.originalValueMg)}</strong><br>`+
    `Current calibration + latest tare: <strong>${formatMass(s.currentValueMg)}</strong><br>`)+
    `Current spread (σ, ${spreadDescription(s.estimator)}): <strong>${state.unitId==='raw'?fmtNumber(s.rawSpread,2)+' counts':formatMass(s.spreadMg)}</strong><br>`+
    `Raw average: <strong>${fmtNumber(s.rawMean,2)} counts</strong><br>`+
    (s.rejectedSamples?`Excluded by estimator: <strong>${s.rejectedSamples}</strong><br>`:'')+`Out-of-range samples in analysis: <strong>${s.outOfRangeCount}</strong>${subsampled}${changed}${calibrationChanged}`);
}
function appendLogEntry(entry){state.logs.unshift(entry);renderLog();}
function appendSelectionLog(s){const entry={type:'selection',entryId:`selection-${Date.now()}-${state.logs.length}`,createdAt:new Date().toISOString(),...s};appendLogEntry(entry);}
function addTareEvent(tareMassMg,{method='manual',tareRaw=null,tareRawSamples=null,sourceCount=0,outOfRangeCount=0}={}){
  const previous=currentTareEvent();
  const event={type:'tare',eventId:`tare-${String(state.tareEvents.length+1).padStart(4,'0')}`,createdAt:new Date().toISOString(),effectiveFromTime:state.nextTime,tareMassMg,tareRaw,method,sourceCount,outOfRangeCount,previousTareMassMg:previous?previous.tareMassMg:0,calibrationRevisionId:state.revisionId,tareRawSamples:tareRawSamples?Int32Array.from(tareRawSamples):null};
  // A new tare affects only future samples. Previously stored calibrated masses and
  // their tare-adjusted display values remain unchanged and can be reproduced from events.
  cancelMeasurement('tare event');   // a tare changes the zero reference, so a running measurement would mix epochs
  state.tareEvents.push(event);
  // Reset the calibrated MA window so it does not mix values relative to two tare epochs.
  state.massSum=0;state.massSumSq=0;state.massCount=0;state.massRef=null;state.massEma=null;state.massEmaTime=null;state.rollingTareId=event.eventId;
  appendLogEntry(event);
  return event;
}
function updateSelectionForNewContext(){
  if(!state.selection)return;
  const first=lowerBoundTime(state.selection.t0),end=lowerBoundTime(state.selection.t1+0.0001);
  if(first<end&&end<=state.count){const updated=calculateSelection(first,end);updated.contextChanged=true;state.selection=updated;}
  updateSelectionReadout();
}
function autoTare(){
  if(!state.count)return;
  // Average only samples recorded under the ACTIVE calibration (a calibration change starts a new epoch).
  const calStart=Math.min(lowerBoundTime(state.calibrations[state.calibrations.length-1].effectiveFromTime),state.count-1);
  const n=Math.max(1,Math.min(state.window,state.count-calStart)),start=state.count-n;
  let massSum=0,rawSum=0,outOfRangeCount=0;const rawSamples=new Int32Array(n);
  for(let j=0;j<n;j++){const i=start+j,r=getRaw(i);massSum+=getMassMg(i);rawSum+=r;rawSamples[j]=r;if(calibrateAbsolute(r).outOfRange)outOfRangeCount++;}
  addTareEvent(massSum/n,{method:'Auto-Tare · mean of calibrated samples',tareRaw:rawSum/n,tareRawSamples:rawSamples,sourceCount:n,outOfRangeCount});
  updateSelectionForNewContext();scheduleRender();
}
function manualTare(){
  if(state.unitId==='raw')return;
  const value=Number($('manualTareInput').value);if(!Number.isFinite(value)||value<0){alert('Enter a non-negative calibrated mass for the manual tare.');return;}
  const event=addTareEvent(selectedMassToMg(value),{method:'Manual calibrated tare',tareRaw:null,sourceCount:0});
  $('manualTareInput').value='';updateSelectionForNewContext();scheduleRender();
}
function setSelectMode(on){state.selectMode=on;$('selectModeBtn').setAttribute('aria-pressed',String(on));$('selectModeBtn').classList.toggle('primary',on);$('selectModeBtn').textContent=on?'Selecting… tap-drag':'Select interval';}

// ===== BEGIN VALIDITY ANALYSIS (pure functions on arrays; no DOM, no state) ==========================
// Purpose: decide whether an interval of raw samples is fit to be reduced to ONE number (mean, median,
// ...). The functions never alter results; they only describe the data and attach a verdict.
//
// Design rules
//  * Input is a plain array / typed array of RAW COUNTS plus (optionally) timestamps in ms. Raw counts
//    are used on purpose: a tare or a calibration change is a relabelling of the axis, not a change of
//    the physical signal, so it can neither create nor hide a step. All statistics below are scale-free,
//    so the verdicts do not depend on the unit or on the (illustrative) calibration.
//  * Autocorrelation, Allan deviation, the step test and the spectrum need UNIFORM sampling. The
//    series is therefore cut into uniform segments at every gap (see analysisSegments) and those tests
//    run on the longest segment. Segments longer than ANALYSIS_THRESHOLDS.maxSamples are cut to their
//    newest samples (the disclosure is part of the result).
//  * Every verdict is one of 'ok' | 'suspect' | 'invalid' | 'n/a'. 'n/a' = the check could not run
//    (too few samples); it never counts as a pass. All thresholds live in ANALYSIS_THRESHOLDS and are
//    echoed in every check ({warn, fail}) so the UI shows exactly what was applied.
//  * The thresholds are conservative rules of thumb written for this tool. They are NOT calibrated to
//    any particular balance, cell or environment, and a status of 'ok' does not certify an
//    uncertainty. 'ok' only means: none of these specific problems was detected.
// ---- minimum number of samples: the 'insufficient' status (v11) ---------------------------------------
// WHY A SAMPLE COUNT AND NOT A DURATION. Every check below works in the sample domain: autocorrelation
// lags, Allan averaging factors m, the CUSUM walk and the Welch segments are all counted in samples. A
// sensor that reports at 10 Hz and one at 80 Hz therefore need the SAME number of samples for the same
// statistical resolution; only the time it takes (N / f_s) differs. The requirement is derived from the
// smallest effect each check is supposed to resolve, and the largest requirement wins:
//  * autocorrelation: under white noise each rho_k has SD ~ 1/sqrt(n); the test band is 2/sqrt(n). The
//    'suspect' level n_eff/n = 0.30 corresponds to an AR(1) series with rho_1 = (1-0.30)/(1+0.30) ~ 0.54.
//    To resolve rho ~ 0.5 the band must be at most rho/2 = 0.25  ->  n >= (2 / 0.25)^2 = 64.
//  * step (CUSUM): a step of delta sigma in the middle of n samples gives Q = delta * sqrt(n) / 4. Q must
//    exceed the 5 % critical value 1.36 plus about one SD of margin (0.84, roughly 80 % power) for the
//    smallest step of interest, delta = 1.5 sigma  ->  n >= (4 * 2.2 / 1.5)^2 = 35.
//  * Allan deviation: averaging factors m = 1, 2, 4, ... up to N/4. Seeing a minimum followed by a rise
//    needs at least 5 octaves (m = 1..16)  ->  N >= 4 * 2^4 = 64.
//  * spectrum (Welch): segments of L >= 16 samples, at least 4 segments  ->  N >= 64.
// All four give <= 64, so 64 uniform samples is the minimum (0.8 s at 80 Hz, 6.4 s at 10 Hz). Below it the
// status is 'insufficient': a lack of evidence, NOT evidence of a problem and NOT a pass. A known problem
// (gaps, duplicates, out-of-range) still outranks it. These are rules of thumb for this tool; they say
// nothing about how long a particular sensor needs to SETTLE after a load change (a time, not a count).
const ANALYSIS_DESIGN = { acfRhoDetect: 0.5, stepDeltaSigma: 1.5, stepQcrit: 1.36, stepQpower: 0.84, allanOctaves: 5, welchSegments: 4, welchMinSegLen: 16 };
function analysisMinSamples(D = ANALYSIS_DESIGN) {
  const acf = Math.ceil(Math.pow(2 / (D.acfRhoDetect / 2), 2));
  const step = Math.ceil(Math.pow(4 * (D.stepQcrit + D.stepQpower) / D.stepDeltaSigma, 2));
  const allan = 4 * Math.pow(2, D.allanOctaves - 1);
  const welch = D.welchSegments * D.welchMinSegLen;
  return { acf, step, allan, welch, n: Math.max(acf, step, allan, welch) };
}
const ANALYSIS_THRESHOLDS = {
  minSamples: analysisMinSamples().n,   // below this: status 'insufficient' (derivation above)
  maxSamples: 40000,     // longest stretch analysed (cost is O(n * maxLag) for the autocorrelation)
  gapFactor: 1.5,        // a time step > 1.5 x the nominal period counts as a gap
  gapFailFraction: 0.05, // > 5 % of the expected samples missing -> invalid (any missing -> suspect)
  essWarn: 0.30,         // effective sample size / n below this -> suspect
  essFail: 0.02,         // ... below this -> invalid (the series is essentially one slowly varying value)
  stepWarn: 1.36,        // CUSUM statistic Q: 5 % critical value of the Kolmogorov distribution
  stepFail: 1.95,        // 0.1 % critical value; 'invalid' additionally needs a step of >= stepMinSigma
  stepMinSigma: 2,       // step size in units of the within-segment SD
  allanWarn: 1.5,        // sigma_A(longest tau) / min sigma_A above this -> averaging stopped helping
  vibWarn: 6,            // spectral line power / local median power (see analysisSpectrum)
  vibFail: 20,
  rangeFailFraction: 0.05 // > 5 % of the samples outside the calibrated range -> invalid
};

// ---- helpers ------------------------------------------------------------------------------------
function anMean(x, a = 0, b = x.length) { let s = 0; for (let i = a; i < b; i++) s += x[i]; return (b > a) ? s / (b - a) : NaN; }
function anSD(x, a = 0, b = x.length) {            // population SD, two-pass (stable for large offsets)
  const n = b - a; if (n < 1) return NaN; const m = anMean(x, a, b); let s = 0;
  for (let i = a; i < b; i++) { const d = x[i] - m; s += d * d; }
  return Math.sqrt(s / n);
}
function anMedianSorted(a) { const n = a.length; return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2; }
function anMedian(x) { return x.length ? anMedianSorted(Float64Array.from(x).sort()) : NaN; }
function anVerdict(value, warn, fail, higherIsWorse = true) {
  if (!Number.isFinite(value)) return 'n/a';
  const bad = (v, t) => (t == null) ? false : (higherIsWorse ? v >= t : v <= t);
  if (bad(value, fail)) return 'invalid';
  if (bad(value, warn)) return 'suspect';
  return 'ok';
}
const ANALYSIS_ORDER = { 'n/a': 0, ok: 1, suspect: 2, invalid: 3 };
function worstVerdict(checks) { let w = 'ok', seen = false; for (const c of checks) { if (c.verdict === 'n/a') continue; seen = true; if (ANALYSIS_ORDER[c.verdict] > ANALYSIS_ORDER[w]) w = c.verdict; } return seen ? w : 'n/a'; }

// ---- gaps, duplicates and uniform segments --------------------------------------------------------
// times: ms. counters (optional, from the device): integer per-sample counter. Timestamps are
// authoritative; the counter is an independent witness for dropped / repeated frames.
// A segment is a maximal run [start,end) with 0 < dt <= gapFactor * nominal between neighbours.
function analysisSegments(times, nominalMs, gapFactor = ANALYSIS_THRESHOLDS.gapFactor) {
  const n = times.length, segs = []; if (!n) return segs;
  let start = 0;
  for (let i = 1; i < n; i++) {
    const dt = times[i] - times[i - 1];
    if (!(dt > 0) || dt > gapFactor * nominalMs) { segs.push([start, i]); start = i; }
  }
  segs.push([start, n]); return segs;
}
function analysisGaps(times, nominalMs, counters = null) {
  const n = times.length, T = ANALYSIS_THRESHOLDS;
  let gaps = 0, missing = 0, duplicates = 0, backwards = 0, counterGaps = 0, counterMissing = 0, counterDup = 0;
  for (let i = 1; i < n; i++) {
    const dt = times[i] - times[i - 1];
    if (dt === 0) duplicates++;
    else if (dt < 0) backwards++;
    else if (dt > T.gapFactor * nominalMs) { gaps++; missing += Math.max(1, Math.round(dt / nominalMs) - 1); }
    if (counters) {
      const dc = counters[i] - counters[i - 1];
      if (dc === 0) counterDup++; else if (dc < 0 || dc > 1) { counterGaps++; counterMissing += Math.max(0, dc - 1); }
    }
  }
  const expected = n + missing, fraction = expected ? missing / expected : 0;
  let verdict = 'ok';
  if (duplicates || backwards || counterDup) verdict = 'invalid';
  else if (fraction > T.gapFailFraction) verdict = 'invalid';
  else if (gaps || counterGaps) verdict = 'suspect';
  const parts = [`${gaps} gap${gaps === 1 ? '' : 's'} (${missing} missing samples)`];
  if (duplicates) parts.push(`${duplicates} duplicate timestamp${duplicates === 1 ? '' : 's'}`);
  if (backwards) parts.push(`${backwards} backwards step${backwards === 1 ? '' : 's'}`);
  if (counters) parts.push(`counter: ${counterGaps} jump${counterGaps === 1 ? '' : 's'}, ${counterMissing} missing, ${counterDup} repeated`);
  return { id: 'gaps', label: 'Gaps and duplicates', value: fraction, valueText: `${(100 * fraction).toFixed(2)} % missing`, threshold: { warn: 'any gap', fail: T.gapFailFraction, failText: 'duplicate/backwards time, or > ' + (100 * T.gapFailFraction) + ' % missing' }, verdict, detail: parts.join('; '), gaps, missing, duplicates, backwards };
}

// ---- autocorrelation and effective sample size ----------------------------------------------------
// rho_k = sum (x_i - m)(x_{i+k} - m) / sum (x_i - m)^2 (biased estimator, always a valid correlation
// sequence). Effective sample size n_eff = n / (1 + 2 sum_{k>=1} rho_k) with the sum truncated at the
// first lag where rho_k falls below the white-noise band 2/sqrt(n) (the usual "initial positive
// sequence" rule): beyond that point the estimates are dominated by noise. n_eff is capped at n; an
// anticorrelated series would otherwise claim n_eff > n, which this tool does not exploit.
function analysisAutocorr(x, maxLag) {
  const n = x.length, m = anMean(x), K = Math.max(1, Math.min(maxLag | 0, n - 1));
  let c0 = 0; for (let i = 0; i < n; i++) { const d = x[i] - m; c0 += d * d; }
  const rho = new Float64Array(K + 1); rho[0] = 1;
  if (!(c0 > 0)) return { rho, neff: n, ratio: 1, rho1: 0, constant: true, lagUsed: 0 };
  for (let k = 1; k <= K; k++) { let s = 0; for (let i = 0; i + k < n; i++) s += (x[i] - m) * (x[i + k] - m); rho[k] = s / c0; }
  const band = 2 / Math.sqrt(n); let sum = 0, lagUsed = 0;
  for (let k = 1; k <= K; k++) { if (rho[k] < band) break; sum += rho[k]; lagUsed = k; }
  const neff = Math.max(1, Math.min(n, n / (1 + 2 * sum)));
  return { rho, neff, ratio: neff / n, rho1: rho[1], constant: false, lagUsed, truncated: lagUsed === K };
}
function analysisAutocorrCheck(x) {
  const T = ANALYSIS_THRESHOLDS, n = x.length;
  const r = analysisAutocorr(x, Math.min(200, Math.floor(n / 4)));
  return { id: 'autocorrelation', label: 'Autocorrelation / effective sample size', value: r.ratio, valueText: `n_eff ≈ ${r.neff.toFixed(1)} of ${n} (${(100 * r.ratio).toFixed(1)} %), ρ₁ = ${r.rho1.toFixed(2)}`,
    threshold: { warn: T.essWarn, fail: T.essFail, direction: 'below' }, verdict: anVerdict(r.ratio, T.essWarn, T.essFail, false),
    detail: r.truncated ? 'correlation still positive at the longest lag examined: n_eff is an upper bound' : (r.constant ? 'constant series' : `positive correlation up to lag ${r.lagUsed}`), neff: r.neff, rho1: r.rho1 };
}

// ---- Allan deviation ---------------------------------------------------------------------------------
// Overlapping Allan deviation of the reading series for averaging factors m = 1, 2, 4, ...:
//   sigma_A^2(m tau0) = 1 / (2 (N - 2m + 1)) * sum_j ( ybar_{j+m} - ybar_j )^2,  ybar_j = mean of x[j..j+m)
// computed with prefix sums (O(N) per m). For white noise sigma_A falls like tau^-1/2 (averaging helps);
// a minimum followed by a rise means drift/flicker noise takes over: averaging beyond tau_min does not
// reduce the scatter any further. The verdict compares sigma_A at the longest tau (m <= N/4, so at
// least 2 independent pairs) with the minimum. Values at long tau have few terms and are noisy.
function analysisAllan(x, dtS) {
  const N = x.length, pts = [];
  const S = new Float64Array(N + 1); for (let i = 0; i < N; i++) S[i + 1] = S[i] + (x[i] - x[0]);
  for (let m = 1; 4 * m <= N; m *= 2) {
    const terms = N - 2 * m + 1; if (terms < 2) break;
    let acc = 0;
    for (let j = 0; j < terms; j++) { const d = (S[j + 2 * m] - S[j + m]) / m - (S[j + m] - S[j]) / m; acc += d * d; }
    pts.push({ m, tau: m * dtS, adev: Math.sqrt(acc / (2 * terms)), terms });
  }
  return pts;
}
function analysisAllanCheck(x, dtS) {
  const T = ANALYSIS_THRESHOLDS, pts = analysisAllan(x, dtS);
  if (pts.length < 3) return { id: 'allan', label: 'Allan deviation', value: NaN, valueText: 'too few samples', threshold: { warn: T.allanWarn }, verdict: 'n/a', detail: '', points: pts };
  let best = pts[0]; for (const p of pts) if (p.adev < best.adev) best = p;
  const last = pts[pts.length - 1], ratio = best.adev > 0 ? last.adev / best.adev : (last.adev > 0 ? Infinity : 1);
  return { id: 'allan', label: 'Allan deviation', value: ratio, valueText: `minimum σ_A at τ = ${best.tau.toFixed(3)} s; σ_A(${last.tau.toFixed(2)} s) / minimum = ${Number.isFinite(ratio) ? ratio.toFixed(2) : '∞'}`,
    threshold: { warn: T.allanWarn, fail: null }, verdict: anVerdict(ratio, T.allanWarn, null, true),
    detail: best === last ? 'still falling at the longest τ: averaging keeps helping' : `averaging beyond ≈ ${best.tau.toFixed(2)} s no longer reduces the scatter`, points: pts, bestTauS: best.tau };
}

// ---- level step (moved weight) and drift --------------------------------------------------------------
// CUSUM change-point statistic. S_k = sum_{i<k} (x_i - xbar); under "constant level + stationary noise"
//   Q = max_k |S_k| / (sigma_LR sqrt(n))
// converges to the supremum of a Brownian bridge (Kolmogorov distribution: 5 % at 1.36, 0.1 % at 1.95).
// sigma_LR is the long-run SD of the RESIDUALS of the fitted two-level step, sigma * sqrt(n / n_eff), so
// moderately autocorrelated noise does not produce false alarms. If the residuals are still strongly
// correlated (n_eff < essWarn * n) the check reports n/a instead of a misleading verdict. The change point k* = argmax |S_k| is then classified: if a two-level step
// model leaves clearly less residual variance than a straight line (SSE_step < 0.8 SSE_line) the
// event is called a step, otherwise a trend/drift. 'invalid' needs both Q >= stepFail and a step of
// at least stepMinSigma within-segment SDs (a statistically detectable but tiny drift stays 'suspect').
function analysisStepCheck(x) {
  const T = ANALYSIS_THRESHOLDS, n = x.length, m = anMean(x);
  const none = { id: 'step', label: 'Level step / drift', value: NaN, valueText: 'n/a', threshold: { warn: T.stepWarn, fail: T.stepFail }, verdict: 'n/a', detail: '' };
  if (n < T.minSamples) return none;
  if (!(anSD(x) > 0)) return { ...none, value: 0, valueText: 'Q = 0.00 (constant series)', verdict: 'ok' };
  // change point: argmax |S_k| (independent of any variance estimate)
  let c = 0, best = 0, kStar = 1;
  for (let k = 1; k < n; k++) { c += x[k - 1] - m; if (Math.abs(c) > best) { best = Math.abs(c); kStar = k; } }
  const m1 = anMean(x, 0, kStar), m2 = anMean(x, kStar, n), delta = m2 - m1;
  // Noise level from the residuals of the two-level fit. Estimating sigma_LR from the raw data would
  // let a large step inflate the autocorrelation (and hence sigma_LR) and so hide itself.
  const res = new Float64Array(n); let sse = 0;
  for (let i = 0; i < n; i++) { res[i] = x[i] - (i < kStar ? m1 : m2); sse += res[i] * res[i]; }
  const sdWithin = Math.sqrt(sse / n), ac = analysisAutocorr(res, Math.min(200, Math.floor(n / 4)));
  const sigmaLR = sdWithin * Math.sqrt(n / ac.neff), Q = best / (sigmaLR * Math.sqrt(n));
  // straight-line least squares for the step-versus-trend comparison
  let sx = 0, sxx = 0, sy = 0, sxy = 0; for (let i = 0; i < n; i++) { sx += i; sxx += i * i; sy += x[i]; sxy += i * x[i]; }
  const den = n * sxx - sx * sx, b = den ? (n * sxy - sx * sy) / den : 0, a = (sy - b * sx) / n;
  let sseLine = 0; for (let i = 0; i < n; i++) { const r = x[i] - (a + b * i); sseLine += r * r; }
  const stepLike = sse < 0.8 * sseLine, sizeSigma = sdWithin > 0 ? Math.abs(delta) / sdWithin : Infinity;
  // If the residuals are still strongly correlated (drift, flicker noise) the Kolmogorov critical
  // values do not apply: report n/a and leave the verdict to the autocorrelation and Allan checks.
  if (ac.ratio < T.essWarn) return { ...none, value: Q, valueText: `not reliable: residual n_eff is only ${(100 * ac.ratio).toFixed(1)} % of n`, detail: 'strongly correlated noise; see the autocorrelation and Allan checks', changeIndex: kStar, delta };
  let verdict = anVerdict(Q, T.stepWarn, null, true);
  if (Q >= T.stepFail && sizeSigma >= T.stepMinSigma) verdict = 'invalid';
  return { id: 'step', label: 'Level step / drift', value: Q, valueText: `Q = ${Q.toFixed(2)}${verdict === 'ok' ? '' : `; ${stepLike ? 'step' : 'trend'} of ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} counts (${sizeSigma.toFixed(1)} σ) near sample ${kStar} of ${n}`}`,
    threshold: { warn: T.stepWarn, fail: T.stepFail, failText: `Q ≥ ${T.stepFail} and step ≥ ${T.stepMinSigma} σ` }, verdict,
    detail: verdict === 'ok' ? 'no evidence of a level change' : (stepLike ? 'abrupt level change: a weight may have been moved or placed' : 'gradual change: drift or creep'), changeIndex: kStar, delta, sizeSigma, stepLike };
}

// ---- spectrum: vibration / interference lines --------------------------------------------------------------
// Welch periodogram: linear detrend, Hann window, 50 % overlap, segment length L = largest power of two
// <= n/4 (so at least ~7 averaged segments), L >= 16. A "line" is a bin whose power exceeds the MEDIAN
// power of its neighbourhood (+-10 bins, excluding the bin and its two nearest neighbours) by the factor
// vibWarn / vibFail. The local median makes the test insensitive to the red (drifting) background of
// real sensors. With K averaged segments a white-noise bin is chi-square distributed with 2K degrees of
// freedom, so ratios above ~3 are already rare for K >= 7; the thresholds 6 and 20 are conservative.
// Frequencies above the Nyquist limit (fs/2 = 40 Hz at 80 Hz) alias: a 50 Hz mains tone appears at
// 30 Hz. The reported frequency is therefore the APPARENT frequency.
function analysisFFT(re, im) {                       // in-place iterative radix-2 FFT, length = power of two
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}
function analysisWelch(x, fs) {
  const n = x.length; let L = 16; while (L * 2 <= n / 4) L *= 2;
  if (n < 4 * L || L < 16) return null;
  const hop = L / 2, win = new Float64Array(L); let wsum2 = 0;
  for (let i = 0; i < L; i++) { win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / L); wsum2 += win[i] * win[i]; }
  const P = new Float64Array(L / 2 + 1), re = new Float64Array(L), im = new Float64Array(L); let K = 0;
  for (let s = 0; s + L <= n; s += hop) {
    let sx = 0, sxx = 0, sy = 0, sxy = 0;                               // linear detrend of this segment
    for (let i = 0; i < L; i++) { sx += i; sxx += i * i; sy += x[s + i]; sxy += i * x[s + i]; }
    const den = L * sxx - sx * sx, b = (L * sxy - sx * sy) / den, a = (sy - b * sx) / L;
    for (let i = 0; i < L; i++) { re[i] = (x[s + i] - (a + b * i)) * win[i]; im[i] = 0; }
    analysisFFT(re, im);
    for (let k = 0; k <= L / 2; k++) P[k] += re[k] * re[k] + im[k] * im[k];
    K++;
  }
  for (let k = 0; k <= L / 2; k++) P[k] /= K * wsum2 * fs;            // one-sided PSD up to a constant factor
  return { P, L, K, df: fs / L, fs };
}
function analysisSpectrumCheck(x, fs) {
  const T = ANALYSIS_THRESHOLDS, W = analysisWelch(x, fs);
  const na = { id: 'vibration', label: 'Vibration / interference lines', value: NaN, valueText: 'too few samples', threshold: { warn: T.vibWarn, fail: T.vibFail }, verdict: 'n/a', detail: '' };
  if (!W) return na;
  const { P, L, df } = W, half = L / 2; let bestRatio = 0, bestK = 0;
  const kMin = Math.max(3, Math.ceil(1.0 / df));                         // lines below ~1 Hz are drift / air flow, not vibration
  for (let k = kMin; k < half; k++) {
    const nb = []; for (let j = Math.max(1, k - 10); j <= Math.min(half, k + 10); j++) if (Math.abs(j - k) > 1) nb.push(P[j]);
    const med = anMedian(nb); const r = med > 0 ? P[k] / med : (P[k] > 0 ? Infinity : 0);
    if (r > bestRatio) { bestRatio = r; bestK = k; }
  }
  let tot = 0; for (let k = 1; k <= half; k++) tot += P[k];
  const frac = tot > 0 ? (P[bestK - 1] + P[bestK] + P[bestK + 1]) / tot : 0;
  const verdict = anVerdict(bestRatio, T.vibWarn, T.vibFail, true);
  const f = bestK * df;
  return { id: 'vibration', label: 'Vibration / interference lines', value: bestRatio, valueText: `strongest line ${bestRatio >= 1e4 ? '>1e4' : bestRatio.toFixed(1)}× its local floor at ${f.toFixed(2)} Hz (apparent), ${(100 * Math.min(1, frac)).toFixed(0)} % of the spectrum power`,
    threshold: { warn: T.vibWarn, fail: T.vibFail }, verdict, detail: verdict === 'ok' ? `resolution ${df.toFixed(2)} Hz, ${W.K} averaged segments` : 'periodic disturbance: frequencies above 40 Hz appear aliased', frequencyHz: f, powerFraction: frac, segments: W.K };
}

// ---- top level ------------------------------------------------------------------------------------------
// analyzeSeries(values, times, opts) -> { status, checks:[{id,value,threshold,verdict,...}], segments, ... }
//  values: raw counts; times: ms (same length); opts: { nominalMs, counters, outOfRangeCount }
function analyzeSeries(values, times, opts = {}) {
  const T = ANALYSIS_THRESHOLDS, n = values.length, nominalMs = opts.nominalMs || (1000 / 80);
  const checks = [];
  if (!n) return { status: 'n/a', checks, segments: [], n, analyzedN: 0, note: 'empty interval' };
  checks.push(analysisGaps(times, nominalMs, opts.counters || null));
  if (opts.outOfRangeCount != null) {
    const f = opts.outOfRangeCount / n;
    checks.push({ id: 'range', label: 'Calibrated range', value: f, valueText: `${opts.outOfRangeCount} of ${n} samples outside`, threshold: { warn: 'any', fail: T.rangeFailFraction }, verdict: opts.outOfRangeCount === 0 ? 'ok' : (f > T.rangeFailFraction ? 'invalid' : 'suspect'), detail: 'extrapolated mass values are not backed by a calibration anchor' });
  }
  const segs = analysisSegments(times, nominalMs);
  let seg = segs[0]; for (const s of segs) if (s[1] - s[0] > seg[1] - seg[0]) seg = s;
  let a = seg[0], b = seg[1], cut = false;
  if (b - a > T.maxSamples) { a = b - T.maxSamples; cut = true; }
  const x = Array.prototype.slice.call(values, a, b), segN = b - a, fs = 1000 / nominalMs;
  let note = segs.length > 1 ? `split into ${segs.length} uniform segments; time-series checks use the longest (${segN} samples)` : '';
  if (cut) note += (note ? '; ' : '') + `time-series checks use the newest ${T.maxSamples.toLocaleString ? T.maxSamples.toLocaleString() : T.maxSamples} samples`;
  const tooShort = segN < T.minSamples;
  if (tooShort) {
    const dur = (T.minSamples * nominalMs / 1000).toFixed(2);
    for (const [id, label] of [['autocorrelation', 'Autocorrelation / effective sample size'], ['allan', 'Allan deviation'], ['step', 'Level step / drift'], ['vibration', 'Vibration / interference lines']])
      checks.push({ id, label, value: NaN, valueText: `needs ≥ ${T.minSamples} uniform samples (${dur} s at ${fs.toFixed(fs < 10 ? 1 : 0)} Hz); have ${segN}`, threshold: {}, verdict: 'n/a', detail: '' });
    note += (note ? '; ' : '') + 'interval too short to validate';
  } else {
    const ac = analysisAutocorrCheck(x); checks.push(ac);
    checks.push(analysisAllanCheck(x, 1 / fs));
    checks.push(analysisStepCheck(x));
    checks.push(analysisSpectrumCheck(x, fs));
  }
  // 'insufficient' = not enough uniform samples to test anything. A problem that WAS found (gaps,
  // duplicates, out-of-range) outranks it; otherwise it replaces 'ok' (never reported as a pass).
  let status = worstVerdict(checks);
  if (tooShort && (status === 'ok' || status === 'n/a')) status = 'insufficient';
  return { status, checks, segments: segs.length, n, analyzedN: segN, note };
}
// ===== END VALIDITY ANALYSIS ============================================================================

// analyzeInterval: shared by Measurement, Selection analysis and (later) the calibration wizard. It
// gathers the RAW counts, timestamps and the out-of-range count (against the calibration each sample was
// RECORDED with) and hands them to the pure function analyzeSeries(). It never modifies a result.
// ESP32 milestone: pass the device's per-sample counter slice as opts.counters (already supported by
// analysisGaps) so dropped or repeated frames are detected independently of the timestamps.
function analyzeInterval(first,end){
  const n=end-first;if(n<=0)return{status:'n/a',checks:[],note:'empty interval'};
  const raws=new Float64Array(n),times=new Float64Array(n);let oor=0;
  for(let j=0;j<n;j++){const i=first+j,t=getTime(i),r=getRaw(i);raws[j]=r;times[j]=t;if(calibrateAbsolute(r,calibrationAt(t).config).outOfRange)oor++;}
  return analyzeSeries(raws,times,{nominalMs:PERIOD_MS,counters:null,outOfRangeCount:oor});
}
const VERDICT_ICON={ok:'✓',suspect:'⚠',invalid:'✖','n/a':'–',insufficient:'…'};
const STATUS_TEXT={ok:'no problem detected',suspect:'suspect',invalid:'invalid','n/a':'not analysed',insufficient:'insufficient data'};
function analysisThresholdText(c){
  const t=c.threshold||{},sym=t.direction==='below'?'≤':'≥',p=[];
  if(t.warn!=null)p.push(`suspect ${typeof t.warn==='number'?sym+' ':''}${t.warn}`);
  if(t.failText)p.push(`invalid: ${t.failText}`);else if(t.fail!=null)p.push(`invalid ${typeof t.fail==='number'?sym+' ':''}${t.fail}`);
  return p.join(' · ');
}
function analysisBadgeHTML(a,prefix=''){
  if(!a)return'';
  const bad=(a.checks||[]).filter(c=>c.verdict==='suspect'||c.verdict==='invalid').map(c=>c.label.split(' / ')[0]);
  const few=a.status==='insufficient'?` (${a.analyzedN||0} of ≥ ${ANALYSIS_THRESHOLDS.minSamples} uniform samples)`:'';
  return `${prefix}<span class="vbadge ${a.status==='n/a'?'na':a.status}">${VERDICT_ICON[a.status]||'–'} Validity: ${STATUS_TEXT[a.status]||a.status}${few}${bad.length?' ('+esc(bad.join(', '))+')':''}</span>`;
}
// key: identifies this <details> so that the open/closed state chosen by the user survives a re-render
// (v11 fix: the readouts used to be rewritten every frame, which collapsed the list immediately).
function analysisHTML(a,defaultOpen,key){
  if(!a)return'';
  const stored=key!=null&&state.detailsOpen&&Object.prototype.hasOwnProperty.call(state.detailsOpen,key);
  const open=stored?state.detailsOpen[key]:defaultOpen;
  const rows=(a.checks||[]).map(c=>`<div class="an-row ${c.verdict==='n/a'?'':c.verdict}"><strong>${VERDICT_ICON[c.verdict]} ${esc(c.label)}</strong>: ${esc(c.valueText||'')}<br><span class="small">${esc(c.detail||'')}${c.detail?' · ':''}${esc(analysisThresholdText(c))}</span></div>`).join('');
  const few=a.status==='insufficient'?`<div class="small">Too few uniform samples to test the validity of this interval (at least ${ANALYSIS_THRESHOLDS.minSamples} are needed; the number follows from the sample-count requirements of the individual checks and does not depend on the sampling rate). This is a lack of evidence, not a finding that something is wrong.</div>`:'';
  return `<details class="an"${key!=null?` data-key="${esc(key)}"`:''}${open?' open':''}><summary>${analysisBadgeHTML(a)}</summary>${rows}${few}${a.note?`<div class="small">${esc(a.note)}</div>`:''}<div class="small">Checks run on raw counts; thresholds are rules of thumb, not calibrated to this hardware. “No problem detected” is not an uncertainty statement.</div></details>`;
}
// Writes innerHTML only when the markup really changed (or the element was modified by someone else):
// no flicker, no collapsing of open <details> while streaming, and less work per frame.
function setHTML(el,html){if(el.__src===html&&el.innerHTML===el.__out)return;el.innerHTML=html;el.__src=html;el.__out=el.innerHTML;}

// ---- Measurement -------------------------------------------------------------------------------
// A measurement collects the next N samples after the button press and reduces them with the
// estimator chosen in the settings panel. It reuses calculateSelection(), so the result equals
// selecting the same samples on the graph. It is cancelled by a tare, a calibration change, a
// buffer shrink below its size, or a sampling gap, because any of these would make the interval
// inconsistent.
const MEASUREMENT_MAX_SAMPLES=100000;
function startMeasurement(){
  if(state.measurement){cancelMeasurement('cancelled by user');return;}
  const target=clamp(Math.floor(Number($('measSamples').value)||0),2,MEASUREMENT_MAX_SAMPLES);
  $('measSamples').value=target;syncMeasurementInputs('samples');   // show the clamped value
  beginMeasurement(target);
}
// hooks (v12, used by the calibration wizard): {tag, onDone(entry, firstIndex, endIndex), onCancel(reason)}
function beginMeasurement(target,hooks={}){
  if(!state.unlimited&&target>state.capacity){$('measProgress').textContent=`The buffer limit (${state.capacity.toLocaleString()} samples) is smaller than the requested ${target.toLocaleString()} samples.`;return false;}
  // Captured now so later changes of the estimator settings cannot alter a running measurement.
  state.measurement={id:`measurement-${Date.now()}`,target,collected:0,t0:state.nextTime,estimator:state.estimator,trimPercent:state.trimPercent,emaTau:state.emaTau,hampelHalf:state.hampelHalf,hampelSigma:state.hampelSigma,tag:hooks.tag||null,onDone:hooks.onDone||null,onCancel:hooks.onCancel||null};
  state.highlight={t0:state.nextTime,t1:state.nextTime};
  $('measProgress').textContent='';updateMeasurementUI();scheduleRender();return true;
}
function measurementSampleAdded(sampleTime){
  const m=state.measurement;m.collected++;state.highlight={t0:m.t0,t1:sampleTime};
  if(m.collected>=m.target)finishMeasurement();
}
function finishMeasurement(){
  const m=state.measurement;state.measurement=null;
  const first=lowerBoundTime(m.t0),end=state.count;
  const result=calculateSelection(first,end,{estimator:m.estimator,trimPercent:m.trimPercent,emaTau:m.emaTau,hampelHalf:m.hampelHalf,hampelSigma:m.hampelSigma});
  const entry={type:'measurement',entryId:m.id,createdAt:new Date().toISOString(),...result,targetSamples:m.target,nominalDurationS:m.target/RATE_HZ,tag:m.tag||null};   // result.analysis comes from calculateSelection
  state.lastMeasurement=entry;delete state.detailsOpen.meas;state.highlight={t0:result.t0,t1:result.t1};
  appendLogEntry(entry);updateMeasurementUI();scheduleRender();
  if(m.onDone)m.onDone(entry,first,end);
}
function cancelMeasurement(reason){
  if(!state.measurement)return;
  const cm=state.measurement;state.measurement=null;state.highlight=null;if(cm.onCancel)cm.onCancel(reason);
  appendLogEntry({type:'note',entryId:`note-${Date.now()}`,createdAt:new Date().toISOString(),text:`Measurement cancelled: ${reason}`});
  updateMeasurementUI();scheduleRender();
}
// The slider is logarithmic (0.1 s ... 300 s) because useful lengths span several decades. It snaps
// to 0.1 s above 1 s and to single samples below. The two text fields stay authoritative: any
// value from 2 up to MEASUREMENT_MAX_SAMPLES can be typed and is clamped when the measurement starts.
const MEAS_SLIDER_MIN_S=0.1,MEAS_SLIDER_MAX_S=300;
function sliderToSamples(p){let d=MEAS_SLIDER_MIN_S*Math.pow(MEAS_SLIDER_MAX_S/MEAS_SLIDER_MIN_S,p/1000);d=d>=1?Math.round(d*10)/10:Math.round(d*RATE_HZ)/RATE_HZ;return Math.max(2,Math.round(d*RATE_HZ));}
function samplesToSlider(n){return clamp(Math.round(1000*Math.log((n/RATE_HZ)/MEAS_SLIDER_MIN_S)/Math.log(MEAS_SLIDER_MAX_S/MEAS_SLIDER_MIN_S)),0,1000);}
function syncMeasurementInputs(source){
  if(source==='slider')$('measSamples').value=sliderToSamples(Number($('measSlider').value));
  else if(source==='duration')$('measSamples').value=Math.max(2,Math.round(Number($('measDuration').value)*RATE_HZ)||2);
  const n=Math.max(2,Math.floor(Number($('measSamples').value))||2),d=n/RATE_HZ;
  if(source!=='duration')$('measDuration').value=Number(d.toFixed(3));
  if(source!=='slider')$('measSlider').value=samplesToSlider(n);
  $('measSliderText').textContent=`${d>=60?(d/60).toFixed(1)+' min':Number(d.toFixed(3))+' s'} · ${n.toLocaleString()} samples`;
}
function updateMeasurementUI(){
  const m=state.measurement,last=state.lastMeasurement,raw=state.unitId==='raw';
  $('measureBtn').textContent=m?'Cancel measurement':'Start measurement';$('measureBtn').classList.toggle('primary',!m);
  $('measBar').hidden=!m;if(m)$('measBar').value=m.collected/m.target;
  $('measDuration').disabled=!!m;$('measSamples').disabled=!!m;$('measSlider').disabled=!!m;
  if(m){$('measValue').textContent='…';$('measDetail').textContent=`Measuring: ${m.collected.toLocaleString()} / ${m.target.toLocaleString()} samples`;$('measNote').textContent='';return;}
  if(!last){$('measValue').textContent='—';$('measDetail').textContent='No measurement yet';$('measNote').textContent='';return;}
  $('measValue').textContent=raw?`${fmtNumber(last.rawEstimatorValue,0)} counts`:formatMass(last.originalValueMg);
  $('measDetail').textContent=`σ ${raw?fmtNumber(last.rawSpread,2)+' counts':formatMass(last.spreadMg)} · ${last.totalSamples.toLocaleString()} samples (${(last.totalSamples/RATE_HZ).toFixed(2)} s) · ${estimatorLabel(last.estimator)}`;
  const notes=[];
  if(last.outOfRangeCount)notes.push(`<span class="warning">${last.outOfRangeCount} samples outside the calibrated range</span>`);
  // The EMA is seeded with the first sample, which keeps weight exp(-T/tau): see updateSelectionReadout().
  if(last.estimator==='emaNorm')notes.push(`EMA normalised${last.emaNeff?` · effective samples ≈ ${last.emaNeff.toFixed(1)}`:''}`);
  if(last.estimator==='ema')notes.push(`EMA seed weight ${(100*Math.exp(-Math.max(0,last.t1-last.t0)/1000/Math.max(.025,last.emaTau))).toFixed(1)}%`);
  if(last.usedSamples<last.totalSamples)notes.push('bounded analysis (subsampled)');
  notes.push(analysisHTML(last.analysis,false,'meas'));
  setHTML($('measNote'),notes.join(' · '));
}

// ---- Log -----------------------------------------------------------------------------------------
function renderLog(){
  $('logCount').textContent=`(${state.logs.length} entries)`;
  if(!state.logs.length){$('logList').innerHTML='<div class="small" style="padding:10px 0">No events yet.</div>';return;}
  $('logList').innerHTML=state.logs.map(entry=>{
    const time=new Date(entry.createdAt).toLocaleTimeString(),id=esc(entry.entryId||entry.eventId);
    const row=(cls,type,body)=>`<div class="log-row ${cls}" data-log-id="${id}" data-log-type="${type}"><time>${time}</time><div>${body}</div></div>`;
    const detail=e=>`${estimatorLabel(e.estimator)} · ${e.estimator==='trimmed'?e.trimPercent+'% trim · ':''}${(e.estimator==='ema'||e.estimator==='emaNorm')?'τ '+e.emaTau+' s · ':''}${e.estimator==='hampelLocal'?'k='+e.hampelHalf+', '+e.hampelSigma+'σ · ':''}${((e.t1-e.t0)/1000).toFixed(2)} s · Calibration ${esc(e.calibrationRevisionId)}`;
    if(entry.type==='tare')return row('event','tare',`<strong>${esc(entry.eventId)} · ${esc(entry.method)}</strong><br>Tare: ${formatMass(entry.tareMassMg)} · Raw reference: ${entry.tareRaw==null?'not applicable':fmtNumber(entry.tareRaw,2)+' counts'}${entry.outOfRangeCount?`<br><span class="warning">${entry.outOfRangeCount} of ${entry.sourceCount} tare samples were outside the calibrated range.</span>`:''}<br><span class="small">Effective from ${(entry.effectiveFromTime/1000).toFixed(2)} s · Calibration ${esc(entry.calibrationRevisionId)}</span>`);
    if(entry.type==='calibration')return row('calibration','calibration',`<strong>Calibration changed · ${esc(entry.profileName)}</strong><br>Revision ${esc(entry.revisionId)} · ${esc(entry.source)}<br><span class="small">Effective from ${(entry.effectiveFromTime/1000).toFixed(2)} s. Earlier samples keep their recorded calibration; the tare was reset.</span>`);
    if(entry.type==='note')return row('note','note',esc(entry.text));
    const result=state.unitId==='raw'?`Raw estimator: ${fmtNumber(entry.rawEstimatorValue,0)} counts`:(entry.type==='measurement'?`Result: <strong>${formatMass(entry.originalValueMg)}</strong> · σ ${formatMass(entry.spreadMg)}`:`Original: ${formatMass(entry.originalValueMg)} · Current: ${formatMass(entry.currentValueMg)}`);
    const title=entry.type==='measurement'?`Measurement · ${entry.totalSamples.toLocaleString()} samples (${entry.nominalDurationS.toFixed(2)} s nominal)${entry.tag?' · '+esc(entry.tag):''}`:`Selection · ${entry.totalSamples.toLocaleString()} samples`;
    return row(entry.type,entry.type,`<strong>${title}</strong><br>${result}${entry.analysis?'<br>'+analysisHTML(entry.analysis,false,'log:'+entry.entryId):''}<br><span class="small">${detail(entry)}</span>`);
  }).join('');
}
function jumpToLogEntry(id,type){
  if(type==='note')return;
  {const pe=logEntryOf(id),r=logEntryRange(pe);state.logPinned=r?{...r,id}:null;}   // blue highlight in both graphs
  if(type==='tare'||type==='calibration'){
    const point=type==='tare'?state.tareEvents.find(item=>item.eventId===id):state.logs.find(item=>item.entryId===id);if(!point)return;
    if(point.effectiveFromTime<oldestTime()||point.effectiveFromTime>newestTime()){$('selectionSummary').innerHTML='<span class="warning">This event is outside the retained sample buffer. Its log record is still available.</span>';return;}
    const half=state.liveWindowSpan/2;state.live=false;state.viewMin=clamp(point.effectiveFromTime-half,oldestTime(),Math.max(oldestTime(),newestTime()-state.liveWindowSpan));state.viewMax=Math.min(newestTime(),state.viewMin+state.liveWindowSpan);state.selection=null;
    $('selectionSummary').innerHTML=type==='tare'?`<strong>${esc(point.eventId)}</strong><br>${esc(point.method)}<br>Tare mass: <strong>${formatMass(point.tareMassMg)}</strong><br>Raw reference: <strong>${point.tareRaw==null?'not applicable':fmtNumber(point.tareRaw,2)+' counts'}</strong>`:`<strong>Calibration change</strong><br>${esc(point.profileName)} · revision ${esc(point.revisionId)}`;
    scheduleRender();return;
  }
  // 'selection' and 'measurement' entries: recompute from the retained samples with the stored settings.
  const entry=state.logs.find(item=>item.entryId===id);if(!entry)return;
  if(entry.t0<oldestTime()||entry.t1>newestTime()){$('selectionSummary').innerHTML='<span class="warning">Some or all of the samples are no longer retained in the ring buffer. The log result remains available.</span>';return;}
  const first=lowerBoundTime(entry.t0),end=lowerBoundTime(entry.t1+0.0001);
  delete state.detailsOpen.sel;state.selection=calculateSelection(first,end,{estimator:entry.estimator,trimPercent:entry.trimPercent,emaTau:entry.emaTau,hampelHalf:entry.hampelHalf,hampelSigma:entry.hampelSigma});
  state.live=false;const selectionSpan=Math.max(PERIOD_MS,entry.t1-entry.t0),viewSpan=Math.max(selectionSpan*1.2,state.liveWindowSpan);
  state.liveWindowSpan=viewSpan;state.viewMin=Math.max(oldestTime(),entry.t0-(viewSpan-selectionSpan)/2);state.viewMax=Math.min(newestTime(),state.viewMin+viewSpan);
  updateSelectionReadout();scheduleRender();
}

// ---- Export --------------------------------------------------------------------------------------
function downloadBlob(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);}
function exportCSV(){
  if(!state.count)return;
  const csvField=v=>/[",\n\r]/.test(String(v))?'"'+String(v).replace(/"/g,'""')+'"':v;
  // Built in chunks of 20,000 rows so a multi-million-row export never needs one giant string array.
  const parts=['runtime_ms,raw_sensor_counts,absolute_mass_mg,historical_tare_mass_mg,net_mass_mg,moving_average_net_mg,spread_sigma_mg,tare_event_id,calibration_profile_id,calibration_revision_id,calibration_out_of_range\n'];
  let rows=[];
  for(let i=0;i<state.count;i++){
    const time=getTime(i),event=tareEventAt(time),cal=calibrationAt(time),raw=getRaw(i);   // per-row: the calibration the sample was RECORDED with
    rows.push([time,raw,getMassMg(i),event?event.tareMassMg:0,getNetMg(i),getMassMA(i),getMassSD(i),event?event.eventId:'',csvField(cal.profileId),csvField(cal.revisionId),calibrateAbsolute(raw,cal.config).outOfRange?1:0].join(','));
    if(rows.length>=20000){parts.push(rows.join('\n')+'\n');rows=[];}
  }
  if(rows.length)parts.push(rows.join('\n')+'\n');
  downloadBlob(new Blob(parts,{type:'text/csv;charset=utf-8'}),`mass-telemetry-${String(activeSensor.id).replace(/[^\w.-]+/g,'_')}-${new Date().toISOString().replace(/[:.]/g,'-')}.csv`);
}

function setMovingAverageWindow(rawValue,immediate=false,preserveInput=false){
  if(rawValue===''||!Number.isFinite(Number(rawValue)))return;
  const value=clamp(Math.floor(Number(rawValue)),2,10000);state.window=Math.min(value,state.capacity);
  if(!preserveInput)$('windowInput').value=state.window;$('windowRange').value=state.window;
  if(state.maRebuildTimer)clearTimeout(state.maRebuildTimer);
  state.maRebuildTimer=setTimeout(()=>{state.maRebuildTimer=null;rebuildDerived();scheduleRender();},immediate?0:70);
}
function updateEstimatorFields(){$('trimField').hidden=state.estimator!=='trimmed';$('emaField').hidden=!isEmaMethod(state.estimator);$('hampelField').hidden=state.estimator!=='hampelLocal';$('hampelSigmaField').hidden=state.estimator!=='hampelLocal';}
function applyBufferSize(){
  const choice=$('bufferInput').value;state.unlimited=choice==='unlimited';
  if(!state.unlimited){
    const cap=clamp(Math.floor(Number(choice)||100000),1000,2000000);
    if(cap!==state.capacity){if(state.measurement&&state.measurement.target>cap)cancelMeasurement('buffer limit reduced below the measurement size');resizeBuffers(cap);}
  }
  $('windowInput').value=state.window;$('windowRange').value=state.window;
  if(state.maRebuildTimer){clearTimeout(state.maRebuildTimer);state.maRebuildTimer=null;}rebuildDerived();scheduleRender();
}
function addTestSamples(){
  if(testBatchRunning||!activeSensor||activeSensor.kind!=='test')return;
  const target=activeSensor;testBatchRunning=true;const button=$('testSamplesBtn'),total=100000,chunk=10000;let added=0;button.disabled=true;
  const run=()=>{const end=Math.min(total,added+chunk);for(;added<end;added++)ingestSample(target,nextSensorValue(target.state),undefined,true);button.textContent=`Adding test samples · ${Math.round(added/total*100)}%`;scheduleRender();if(added<total)requestAnimationFrame(run);else{testBatchRunning=false;button.disabled=false;button.textContent='＋ 100k test samples';scheduleRender();}};
  requestAnimationFrame(run);
}
function initializeManualYAxis(){
  if(!state.count)return;const i=state.count-1,center=state.unitId==='raw'?getRawMA(i):mgToUnit(getMassMA(i),state.unitId),sd=state.unitId==='raw'?getRawSD(i):mgToUnit(getMassSD(i),state.unitId),pad=Math.max(sd*5,Math.abs(center)*.02,state.unitId==='raw'?5:.001),low=Math.floor(center-pad*3),high=Math.ceil(center+pad*3),step=Math.max(.0001,(high-low)/2000);
  state.yMin=center-pad;state.yMax=center+pad;$('yMinRange').min=low;$('yMinRange').max=high;$('yMinRange').step=step;$('yMinRange').value=state.yMin;$('yMaxRange').min=low;$('yMaxRange').max=high;$('yMaxRange').step=step;$('yMaxRange').value=state.yMax;$('yMinText').textContent=fmtNumber(state.yMin,3);$('yMaxText').textContent=fmtNumber(state.yMax,3);
}
function mainChartHeight(){return Math.max(300,Math.min(560,window.innerHeight*.47));}
function resizeCharts(){if(!state.mainPlot||!state.miniPlot)return;state.mainPlot.setSize({width:$('mainChart').clientWidth,height:mainChartHeight()});state.miniPlot.setSize({width:$('miniChart').clientWidth,height:125});scheduleRender();}

function populateSettings(){
  const select=$('unitSelect');
  const groups=[...new Set(UNIT_CONFIG.units.map(u=>u.group))];
  for(const group of groups){const optgroup=document.createElement('optgroup');optgroup.label=group;for(const unit of UNIT_CONFIG.units.filter(u=>u.group===group)){const option=document.createElement('option');option.value=unit.id;option.textContent=`${unit.name}${unit.id==='raw'?'':' ('+unit.symbol+')'}`;optgroup.appendChild(option);}select.appendChild(optgroup);}
  select.value=state.unitId;
  const precision=$('precisionSelect');for(let i=0;i<=10;i++){const opt=document.createElement('option');opt.value=String(i);opt.textContent=`${i} decimal places`;precision.appendChild(opt);}precision.value='auto';
}
function openSettings(open){$('settingsMenu').hidden=!open;$('settingsBtn').setAttribute('aria-expanded',String(open));}
// Canonical serialisation (sorted keys) so the revision fingerprint does not depend on the
// key order of the JSON text. Numbers use JavaScript's shortest round-trip form, which is also
// what RFC 8785 specifies, so the same content hashes identically across engines.
function canonicalJson(v){if(Array.isArray(v))return'['+v.map(canonicalJson).join(',')+']';if(v&&typeof v==='object')return'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonicalJson(v[k])).join(',')+'}';return JSON.stringify(v);}
// Escape anything that will be placed in innerHTML. Required before calibration import exists:
// profile names and IDs will then be untrusted user input.
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);}
// ---- Calibration profiles ---------------------------------------------------------------------
// Stored masses are never recomputed. Every calibration that was active for part of the session is
// kept in state.calibrations with the time it became effective; calibrationAt(t) returns the one a
// sample was recorded with. Loading a new calibration also resets the tare (old tares are masses
// computed with the previous curve) and aborts a running measurement.
async function fingerprintConfig(config){
  const copy=JSON.parse(JSON.stringify(config));delete copy.contentHash;delete copy.revisionId;
  const text=canonicalJson(copy);
  if(globalThis.crypto?.subtle){try{const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));const hex=[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');return{id:hex.slice(0,12),type:'SHA-256',full:hex};}catch(_){}}
  // file:// contexts may not expose SubtleCrypto. This visibly labeled fallback is only a local
  // revision fingerprint; it must not be represented as a cryptographic hash.
  let hash=2166136261;for(let i=0;i<text.length;i++){hash^=text.charCodeAt(i);hash=Math.imul(hash,16777619);}
  return{id:`fnv-${(hash>>>0).toString(16).padStart(8,'0')}`,type:'FNV-1a fallback',full:null};
}
async function calculateCalibrationRevision(){const fp=await fingerprintConfig(CALIBRATION);state.revisionId=fp.id;state.hashType=fp.type;state.fullHash=fp.full;return fp;}
function calibrationAt(timeMs){for(let i=state.calibrations.length-1;i>=0;i--)if(state.calibrations[i].effectiveFromTime<=timeMs)return state.calibrations[i];return state.calibrations[0];}
function validateCalibrationConfig(config){
  const errors=[],warnings=[];let prepared=null;
  if(!config||typeof config!=='object'||Array.isArray(config))return{errors:['The top level must be a JSON object.'],warnings,prepared};
  if(config.schemaVersion!==1)errors.push('schemaVersion must be 1.');
  for(const key of['profileId','profileName'])if(typeof config[key]!=='string'||!config[key].trim())errors.push(`"${key}" must be a non-empty text.`);
  if(!UNIT_CONFIG.units.some(u=>u.id===config.calibrationUnit&&u.id!=='raw'))errors.push('"calibrationUnit" must be one of the supported mass units.');
  if(config.calibrationMethod!=='piecewise-linear')errors.push('Only calibrationMethod "piecewise-linear" is supported.');
  const list=v=>Array.isArray(v)?v:[];
  const ids=(items,key,label)=>{const seen=new Set();for(const item of list(items)){const id=item&&item[key];if(seen.has(id))errors.push(`Duplicate ${label} "${id}".`);seen.add(id);}return seen;};
  const weightIds=ids(config.referenceWeights,'weightId','weightId');ids(config.referenceLoads,'loadId','loadId');
  const obsIds=ids(config.observations,'observationId','observationId');ids(config.calibrationAnchors,'anchorId','anchorId');
  for(const load of list(config.referenceLoads))for(const part of list(load?.components))if(!weightIds.has(part?.weightId))errors.push(`Load "${load.loadId}" refers to unknown weight "${part?.weightId}".`);
  if(obsIds.size)for(const anchor of list(config.calibrationAnchors))for(const o of list(anchor?.sourceObservationIds))if(!obsIds.has(o))errors.push(`Anchor "${anchor.anchorId}" refers to unknown observation "${o}".`);
  try{prepared=prepareCalibration(config);}catch(error){errors.push(error.message);}
  if(!errors.length&&config.validation?.status!=='validated')warnings.push('Not metrologically validated: no uncertainty is claimed.');
  return{errors,warnings,prepared};
}
async function activateCalibration(config,source){
  const checked=validateCalibrationConfig(config);
  if(checked.errors.length)return checked;
  const target=state,fp=await fingerprintConfig(config);
  if(state!==target){checked.errors.push('The shown sensor changed while the calibration was being checked; nothing was applied. Select the sensor again and retry.');return checked;}
  if(fp.id===state.revisionId){checked.warnings.push('This calibration is already active; nothing changed.');checked.unchanged=true;return checked;}
  if(config.contentHash&&fp.full&&config.contentHash!==fp.full)checked.warnings.push('The file’s contentHash does not match its content (edited after export?). The recalculated fingerprint is used.');
  CALIBRATION=config;calibration=checked.prepared;state.calConfig=config;state.calPrepared=checked.prepared;state.revisionId=fp.id;state.hashType=fp.type;state.fullHash=fp.full;
  state.calibrations.push({effectiveFromTime:state.nextTime,revisionId:fp.id,profileId:config.profileId,hashType:fp.type,config:calibration,source});
  cancelMeasurement('calibration changed');
  addTareEvent(0,{method:'Tare reset · calibration changed'});
  appendLogEntry({type:'calibration',entryId:`calibration-${Date.now()}`,createdAt:new Date().toISOString(),effectiveFromTime:state.nextTime,revisionId:fp.id,profileId:config.profileId,profileName:config.profileName,source});
  state.autoYMin=null;state.autoYMax=null;updateCalibrationInfo();updateSelectionForNewContext();scheduleRender();
  return checked;
}
function showCalibrationMessages(errors,warnings,okText){
  $('calMessages').innerHTML=errors.map(e=>`<div class="warning">${esc(e)}</div>`).join('')+warnings.map(w=>`<div>${esc(w)}</div>`).join('')+(okText?`<div>${esc(okText)}</div>`:'');
}
async function importCalibrationFile(file){
  try{
    if(file.size>2e6)throw new Error('File is larger than 2 MB.');
    const result=await activateCalibration(JSON.parse(await file.text()),`file: ${file.name}`);
    showCalibrationMessages(result.errors,result.warnings,result.errors.length||result.unchanged?'':'Calibration imported and activated. Structure checked only; this is not a metrological validation.');
  }catch(error){showCalibrationMessages([`Could not import the file: ${error.message}`],[],'');}
}
async function restoreDemoCalibration(){
  const result=await activateCalibration(JSON.parse(JSON.stringify(EMBEDDED_CALIBRATION)),'embedded demo');
  showCalibrationMessages(result.errors,result.warnings,result.errors.length||result.unchanged?'':'Embedded illustrative demo calibration restored.');
}
function exportCalibration(){
  const out={...CALIBRATION,revisionId:state.revisionId};if(state.fullHash)out.contentHash=state.fullHash;
  downloadBlob(new Blob([JSON.stringify(out,null,2)],{type:'application/json'}),`calibration-${String(CALIBRATION.profileId).replace(/[^\w.-]+/g,'_')}-${state.revisionId}.json`);
}
function updateCalibrationInfo(){
  const weights=CALIBRATION.referenceWeights||[],count=state.calibrations.length;
  $('calibrationInfo').innerHTML=`Sensor: <strong>${esc(activeSensor.name)}</strong><br><strong>${esc(CALIBRATION.profileName)}</strong><br>Profile: ${esc(CALIBRATION.profileId)}<br>Revision: <strong>${esc(state.revisionId)}</strong> <span class="small">(${esc(state.hashType)})</span><br>Unit: ${esc(CALIBRATION.calibrationUnit)} · Anchors: ${calibration.anchors.length} · Reference weights: ${weights.length} · Observations: ${(CALIBRATION.observations||[]).length}<br>Validation: ${esc(CALIBRATION.validation?.status||'not characterized')}${count>1?`<br><span class="small">${count} calibration revisions used in this session.</span>`:''}`;
}

function initEvents(){
  $('pauseBtn').addEventListener('click',()=>setSensorPaused(activeSensor,!activeSensor.state.paused));
  $('pauseAllBtn').addEventListener('click',pauseAllToggle);
  $('sensorSelect').addEventListener('change',e=>activateSensor(e.target.value));
  $('sensorReloadBtn').addEventListener('click',()=>loadSensorList());
  $('navPanelToggle').addEventListener('change',e=>setNavPanelVisible(e.target.checked));
  // remember which validity lists the user opened / closed ('toggle' does not bubble, hence capture)
  document.addEventListener('toggle',e=>{const d=e.target;if(d&&d.classList&&d.classList.contains('an')&&d.dataset&&d.dataset.key)state.detailsOpen[d.dataset.key]=!!d.open;},true);
  $('trackBtn').addEventListener('click',trackLive);$('selectModeBtn').addEventListener('click',()=>setSelectMode(!state.selectMode));
  $('tareBtn').addEventListener('click',autoTare);$('manualTareBtn').addEventListener('click',manualTare);$('exportBtn').addEventListener('click',exportCSV);$('testSamplesBtn').addEventListener('click',addTestSamples);$('bufferInput').addEventListener('change',applyBufferSize);
  $('measureBtn').addEventListener('click',startMeasurement);$('measSlider').addEventListener('input',()=>syncMeasurementInputs('slider'));$('measDuration').addEventListener('input',()=>syncMeasurementInputs('duration'));$('measSamples').addEventListener('input',()=>syncMeasurementInputs('samples'));
  $('calImportBtn').addEventListener('click',()=>$('calFile').click());$('calFile').addEventListener('change',e=>{const f=e.target.files[0];e.target.value='';if(f)importCalibrationFile(f);});
  $('calExportBtn').addEventListener('click',exportCalibration);$('calDemoBtn').addEventListener('click',restoreDemoCalibration);
  $('windowRange').addEventListener('input',e=>setMovingAverageWindow(e.target.value,false,false));$('windowRange').addEventListener('change',e=>setMovingAverageWindow(e.target.value,true,false));$('windowInput').addEventListener('input',e=>setMovingAverageWindow(e.target.value,false,true));$('windowInput').addEventListener('change',e=>setMovingAverageWindow(e.target.value,true,false));
  $('estimatorSelect').addEventListener('change',e=>{state.estimator=e.target.value;updateEstimatorFields();recreateMainChart();scheduleRender();});
  $('hampelHalf').addEventListener('change',e=>{state.hampelHalf=clamp(Math.round(Number(e.target.value)||HAMPEL_DEFAULT_HALF),2,50);e.target.value=state.hampelHalf;scheduleRender();});
  $('hampelSigma').addEventListener('change',e=>{state.hampelSigma=clamp(Number(e.target.value)||HAMPEL_DEFAULT_SIGMA,1,10);e.target.value=state.hampelSigma;scheduleRender();});
  $('simModeSelect').addEventListener('change',e=>{state.simMode=e.target.value;state.simOffset=0;});
  $('trimPercent').addEventListener('input',e=>{state.trimPercent=Number(e.target.value);$('trimPercentText').textContent=`${state.trimPercent}%`;scheduleRender();});
  $('emaTau').addEventListener('change',e=>{state.emaTau=clamp(Number(e.target.value)||.5,.025,120);e.target.value=state.emaTau;rebuildEMA();scheduleRender();});
  $('unitSelect').addEventListener('change',e=>{state.unitId=e.target.value;state.autoYMin=null;state.autoYMax=null;const raw=state.unitId==='raw';$('rawModeToggle').checked=raw;$('mainChartTitle').textContent=raw?'Raw sensor diagnostics':'Measured mass';$('zeroFillToggle').disabled=raw;$('zeroRawFillToggle').disabled=raw;$('zeroLineToggle').disabled=raw;$('tareUnitLabel').textContent=displayUnitSymbol();$('manualTareInput').value='';if(state.mainPlot){destroyCharts();createCharts();}scheduleRender();});
  $('rawModeToggle').addEventListener('change',e=>{state.unitId=e.target.checked?'raw':UNIT_CONFIG.defaultUnit;$('unitSelect').value=state.unitId;$('unitSelect').dispatchEvent(new Event('change'));});
  $('precisionSelect').addEventListener('change',e=>{state.precision=e.target.value;scheduleRender();if(state.mainPlot){destroyCharts();createCharts();scheduleRender();}});
  $('settingsBtn').addEventListener('click',()=>openSettings($('settingsMenu').hidden));document.addEventListener('pointerdown',e=>{if(!$('settingsMenu').hidden&&!e.target.closest('.settings-wrap'))openSettings(false);});
  $('themeBtn').addEventListener('click',()=>{setTheme(uiTheme!=='light');uiSaveSoon();});
  $('yResponseRange').addEventListener('input',e=>{$('yResponseText').textContent=`${e.target.value}%`;scheduleRender();});
  ['zeroFillToggle','zeroRawFillToggle','zeroLineToggle','downsampleToggle'].forEach(id=>$(id).addEventListener('change',()=>{if(id==='zeroLineToggle'){state.autoYMin=null;state.autoYMax=null;}scheduleRender();}));
  $('yControlsToggle').addEventListener('change',e=>{$('yControls').hidden=!e.target.checked;state.manualY=e.target.checked;if(state.manualY)initializeManualYAxis();else{state.autoYMin=null;state.autoYMax=null;}scheduleRender();});
  $('yMinRange').addEventListener('input',e=>{state.yMin=Number(e.target.value);$('yMinText').textContent=fmtNumber(state.yMin,3);if(state.manualY)scheduleRender();});$('yMaxRange').addEventListener('input',e=>{state.yMax=Number(e.target.value);$('yMaxText').textContent=fmtNumber(state.yMax,3);if(state.manualY)scheduleRender();});
  $('autoYBtn').addEventListener('click',()=>{$('yControlsToggle').checked=false;$('yControls').hidden=true;state.manualY=false;state.autoYMin=null;state.autoYMax=null;scheduleRender();});
  $('zoomInBtn').addEventListener('click',()=>zoomBy(.75));$('zoomOutBtn').addEventListener('click',()=>zoomBy(1.33));
  $('backBtn').addEventListener('click',()=>{state.live=false;const span=state.viewMax-state.viewMin;const min=Math.max(oldestTime(),state.viewMin-span*.8);state.viewMin=min;state.viewMax=Math.min(newestTime(),min+span);scheduleRender();});
  $('forwardBtn').addEventListener('click',()=>{const span=state.viewMax-state.viewMin;const min=Math.min(newestTime()-span,state.viewMin+span*.8);state.viewMin=Math.max(oldestTime(),min);state.viewMax=Math.min(newestTime(),state.viewMin+span);if(state.viewMax>=newestTime()-PERIOD_MS)state.live=true;scheduleRender();});
  $('clearSelectionBtn').addEventListener('click',()=>{state.selection=null;state.logPinned=null;if(!state.measurement)state.highlight=null;$('selectionSummary').textContent='No interval selected.';scheduleRender();});$('clearLogBtn').addEventListener('click',()=>{state.logs=[];state.logPinned=null;state.hoverRange=null;renderLog();redrawOverlays();});
  $('logList').addEventListener('click',e=>{if(e.target.closest('details.an'))return;   // expanding the validity list must not jump to the entry
    const row=e.target.closest('[data-log-id]');if(row){jumpToLogEntry(row.dataset.logId,row.dataset.logType);redrawOverlays();}});
  $('logList').addEventListener('mouseover',e=>{const row=e.target.closest('[data-log-id]');setHoverRange(row?logEntryRange(logEntryOf(row.dataset.logId)):null);});
  $('logList').addEventListener('mouseleave',()=>setHoverRange(null));
  window.addEventListener('resize',resizeCharts);
  // Background tabs suspend requestAnimationFrame. On return the Y-axis is placed on the current data
  // in one undamped step (snapY), after which the normal damping resumes.
  document.addEventListener('visibilitychange',()=>{if(document.hidden)state.wasHidden=true;else if(state.wasHidden){state.wasHidden=false;state.snapY=true;scheduleRender();}});
}

// Simulator pacing (v8). Samples are generated from elapsed wall-clock time instead of one sample
// per timer callback. Browsers throttle timers in background tabs (often to 1 Hz); counting elapsed
// 12.5 ms periods keeps the simulated 80 Hz stream honest. After a long stall at most
// MAX_CATCHUP_SAMPLES are produced and the skipped time becomes a visible timestamp gap.
// A real device supplies its own timestamps and sample counter, which replaces this logic.
const MAX_CATCHUP_SAMPLES=400;
// The simulator drives every sensor of kind 'test' (currently one). Real sensors arrive through SSE.
function tick(){for(const s of sensors.values())if(s.kind==='test')simulateSensor(s);}
function simulateSensor(sensor){
  const st=sensor.state;if(st.paused)return;
  const period=1000/st.rateHz,now=performance.now();
  if(st.simBase==null){st.simBase=now;st.simEmitted=0;}
  let due=Math.floor((now-st.simBase)/period)-st.simEmitted;
  if(due<=0)return;
  if(due>MAX_CATCHUP_SAMPLES){
    const skipped=due-MAX_CATCHUP_SAMPLES;if(sensor===activeSensor)cancelMeasurement('sampling gap');
    st.nextTime+=skipped*period;st.simEmitted+=skipped;due=MAX_CATCHUP_SAMPLES;
  }
  for(let k=0;k<due;k++)ingestSample(sensor,nextSensorValue(st));
  st.simEmitted+=due;if(sensor===activeSensor)scheduleRender();
}

// ===== MULTI-SENSOR LAYER (v11) ======================================================================
// Ingest. All data of all sensors enters here. A sensor that is paused THROWS AWAY what arrives for it
// (counted in state.dropped). Only the shown sensor is processed; the others just store time + raw counts.
// timeMs: device time relative to the sensor's origin (undefined for the simulator). Non-monotonic or
// duplicate times are rejected (state.rejected) because the binary searches assume sorted time.
function ingestSample(sensor,raw,timeMs,force=false){
  const st=sensor.state;
  if(st.paused&&!force){st.dropped++;return false;}
  if(timeMs!=null&&st.count&&timeMs<=st.times[(st.head+st.count-1)%st.capacity]){st.rejected++;return false;}
  if(sensor===activeSensor)appendSample(raw,timeMs);else appendRawOnly(st,raw,timeMs);
  return true;
}
function appendRawOnly(st,raw,timeMs){
  withState(st,()=>{
    if(state.unlimited&&state.count===state.capacity)resizeBuffers(state.capacity+100000);
    const t=timeMs==null?state.nextTime:timeMs;
    let w;if(state.count<state.capacity){w=physicalIndex(state.count);state.count++;}else{state.head=(state.head+1)%state.capacity;w=physicalIndex(state.count-1);}
    state.times[w]=t;state.raw[w]=raw;state.nextTime=t+1000/state.rateHz;state.appended++;
    state.unprocessed=Math.min(state.count,state.unprocessed+1);
  });
}
// When a sensor is shown: allocate the derived arrays if needed, calibrate the samples stored while it was
// hidden (all of them were recorded under the sensor's current calibration, because calibration and tare
// can only be changed while a sensor is shown) and rebuild rolling statistics and EMA.
function prepareStateForDisplay(){
  if(!state.derivedReady){
    const n=state.capacity;state.massMg=new Float64Array(n);state.rawMA=new Float64Array(n);state.rawSD=new Float64Array(n);state.massMA=new Float64Array(n);state.massSD=new Float64Array(n);
    state.derivedReady=true;state.unprocessed=state.count;
  }
  if(state.unprocessed>0){
    const n=Math.min(state.unprocessed,state.count);
    for(let i=state.count-n;i<state.count;i++)state.massMg[physicalIndex(i)]=calibrateAbsolute(getRaw(i)).valueMg;
    state.unprocessed=0;rebuildDerived();rebuildEMA();
    state.curveCache={key:'',map:new Map()};state.miniCache={key:'',map:new Map()};
  }
}
function activateSensor(id){
  const next=sensors.get(id);if(!next||next===activeSensor)return;
  if(activeSensor){
    const old=activeSensor.state;
    withState(old,()=>{if(old.maRebuildTimer){clearTimeout(old.maRebuildTimer);old.maRebuildTimer=null;if(old.derivedReady)rebuildDerived();}cancelMeasurement('another sensor was selected');});
    old.hoverRange=null;hideEventTip();destroyCharts();
  }
  activeSensor=next;state=next.state;CALIBRATION=state.calConfig;calibration=state.calPrepared;RATE_HZ=state.rateHz;PERIOD_MS=1000/RATE_HZ;
  prepareStateForDisplay();
  state.snapY=true;state.autoYMin=null;state.autoYMax=null;state.lastFrameTs=0;
  if(state.live)fitLiveWindow();else clampHistoricalView();
  syncUIFromState();
  if(window.uPlot)createCharts();
  if(wiz.open)wizRender();
  scheduleRender();
}
const SELECTION_DEFAULT_HTML='No interval selected.<br>Shift-drag on the main chart or use Select interval mode.';
function syncUIFromState(){
  const raw=state.unitId==='raw',sim=activeSensor.kind==='test';
  $('unitSelect').value=state.unitId;$('rawModeToggle').checked=raw;$('mainChartTitle').textContent=raw?'Raw sensor diagnostics':'Measured mass';
  $('zeroFillToggle').disabled=raw;$('zeroRawFillToggle').disabled=raw;$('zeroLineToggle').disabled=raw;
  $('tareUnitLabel').textContent=displayUnitSymbol();$('manualTareInput').value='';$('precisionSelect').value=state.precision;
  $('estimatorSelect').value=state.estimator;$('trimPercent').value=state.trimPercent;$('trimPercentText').textContent=`${state.trimPercent}%`;
  $('emaTau').value=state.emaTau;$('hampelHalf').value=state.hampelHalf;$('hampelSigma').value=state.hampelSigma;updateEstimatorFields();
  $('windowRange').value=state.window;$('windowInput').value=state.window;$('bufferInput').value=state.unlimited?'unlimited':String(state.capacity);
  $('yControlsToggle').checked=state.manualY;$('yControls').hidden=!state.manualY;
  if(state.manualY){$('yMinRange').value=state.yMin;$('yMaxRange').value=state.yMax;$('yMinText').textContent=fmtNumber(state.yMin,3);$('yMaxText').textContent=fmtNumber(state.yMax,3);}
  $('simModeSelect').value=state.simMode;$('simControls').hidden=!sim;$('testSamplesBtn').hidden=!sim;
  $('headerSub').textContent=`${RATE_HZ} Hz sensor stream · calibrated mass · local-only session`;
  $('sourceNote').textContent=sim?'Test signal: bounded marching randomness':`Server sensor · ${activeSensor.sseUrl||'no SSE URL'}`;
  $('measRateText').textContent=String(RATE_HZ);syncMeasurementInputs('samples');
  setSelectMode(false);
  if(state.selection)updateSelectionReadout();else $('selectionSummary').innerHTML=SELECTION_DEFAULT_HTML;
  renderLog();updateCalibrationInfo();updateStatusUI();renderSensorSelect();updateViewLabel();updateMeasurementUI();
}
function setNavPanelVisible(on){$('navPanel').hidden=!on;$('sidePanels').classList.toggle('nav-hidden',!on);$('navPanelToggle').checked=on;}

// ---- pause, links, status -----------------------------------------------------------------------
function sensorLink(s){
  if(s.state.paused)return{key:'paused',text:'Paused'};
  if(s.kind==='test')return{key:'live',text:'Streaming'};
  if(s.unlisted)return{key:'unlisted',text:'Not in the server list (no data)'};
  if(!s.sseUrl)return{key:'idle',text:'No SSE URL'};
  const c=sseConnections.get(s.sseUrl);
  if(!c)return{key:'idle',text:'Not connected'};
  return c.status==='live'?{key:'live',text:'Streaming'}:c.status==='error'?{key:'error',text:'Connection failed'}:{key:'connecting',text:'Connecting…'};
}
const LINK_ICON={live:'●',connecting:'◌',paused:'Ⅱ',error:'⚠',idle:'○',unlisted:'⊘'};
function updateStatusUI(){
  const s=activeSensor,link=sensorLink(s),all=[...sensors.values()],running=all.filter(x=>!x.state.paused&&!x.unlisted).length;
  $('statusText').textContent=link.text+(chartsPending?' · loading chart':'')+(all.length>1?` · ${running} of ${all.length} sensors recording`:'');
  $('statusDot').classList.toggle('paused',link.key!=='live');
  $('pauseBtn').textContent=s.state.paused?'▶ Resume':'Ⅱ Pause';
  $('pauseAllBtn').textContent=running?'Ⅱ Pause all':'▶ Resume all';
}
function renderSensorSelect(){
  const sel=$('sensorSelect');sel.innerHTML='';
  for(const s of sensors.values()){const o=document.createElement('option');o.value=s.id;o.textContent=`${LINK_ICON[sensorLink(s).key]||'○'} ${s.name}${s.unlisted?' (not in list)':''}`;sel.appendChild(o);}
  sel.value=activeSensor.id;
}
function setSensorPaused(s,paused,quiet=false){
  s.state.paused=paused;s.state.simBase=null;
  if(!quiet){syncConnections();renderSensorSelect();updateStatusUI();}
}
// Pause all / resume all. If anything is recording, everything is paused; otherwise everything resumes.
function pauseAllToggle(){
  const anyRunning=[...sensors.values()].some(s=>!s.state.paused);
  for(const s of sensors.values())setSensorPaused(s,anyRunning,true);
  syncConnections();renderSensorSelect();updateStatusUI();
}

// ---- SSE ----------------------------------------------------------------------------------------
// One EventSource per distinct URL. Sensors that share a URL share the connection (the server sends the
// samples of all of them through it). A connection exists only while at least one sensor that uses it is
// listed and not paused; pausing the last such sensor closes it, resuming reopens it.
// ASSUMED message format (nothing is specified yet - adapt here): every 'message' event carries JSON,
// either one sample, an array of samples, or {"samples":[...]}; a sample is {"id":"<sensor id>","t":<device
// time in ms>,"raw":<integer counts>}. Timestamps are authoritative; the first accepted timestamp of a
// sensor becomes its time origin (so the chart starts at 0 s).
const sseConnections=new Map();
const sseStats={unknown:0,bad:0};
function wantedConnections(){
  const want=new Map();
  for(const s of sensors.values()){if(s.kind!=='server'||s.unlisted||s.state.paused||!s.sseUrl)continue;if(!want.has(s.sseUrl))want.set(s.sseUrl,new Set());want.get(s.sseUrl).add(s.id);}
  return want;
}
function syncConnections(){
  const want=wantedConnections();
  for(const [url,c] of [...sseConnections]){if(!want.has(url)){try{c.es&&c.es.close();}catch(_){}sseConnections.delete(url);}}
  for(const [url,ids] of want){
    let c=sseConnections.get(url);
    if(c){c.ids=ids;continue;}
    c={es:null,ids,status:'connecting'};sseConnections.set(url,c);
    if(typeof EventSource==='undefined'){c.status='error';continue;}
    try{
      c.es=new EventSource(url);
      c.es.onopen=()=>{c.status='live';renderSensorSelect();updateStatusUI();};
      c.es.onerror=()=>{c.status=c.es.readyState===2?'error':'connecting';renderSensorSelect();updateStatusUI();};
      c.es.onmessage=e=>handleSseMessage(url,e.data);
    }catch(_){c.status='error';}
  }
}
function handleSseMessage(url,data){
  let msg;try{msg=JSON.parse(data);}catch(_){sseStats.bad++;return;}
  const items=Array.isArray(msg)?msg:(msg&&Array.isArray(msg.samples)?msg.samples:[msg]);
  let touched=false;
  for(const it of items){
    const s=it&&sensors.get(String(it.id));
    if(!s||s.kind!=='server'||s.sseUrl!==url){sseStats.unknown++;continue;}
    const raw=Math.round(Number(it.raw)),t=Number(it.t);
    if(!Number.isFinite(raw)||!Number.isFinite(t)){s.state.rejected++;continue;}
    if(s.state.paused){s.state.dropped++;continue;}
    if(s.state.timeOrigin==null)s.state.timeOrigin=t;
    if(ingestSample(s,raw,t-s.state.timeOrigin)&&s===activeSensor)touched=true;
  }
  if(touched)scheduleRender();
}

// ---- sensor list from the server ------------------------------------------------------------------
// Reloadable at any time. Known sensors (same id) keep their data, logs, tares and calibrations; only name,
// SSE URL and details are updated. New ids are added. Sensors missing from the new list are NOT deleted:
// they are marked 'not in list', stop receiving data and keep what was collected.
function applySensorList(list){
  const result={added:[],updated:[],unlisted:[],errors:[]};
  const entries=Array.isArray(list)?list:(list&&Array.isArray(list.sensors)?list.sensors:null);
  if(!entries){result.errors.push('The sensor list must be a JSON array (or an object with a "sensors" array).');return result;}
  const seen=new Set();
  for(const e of entries){
    const id=typeof e?.id==='string'?e.id.trim():(Number.isFinite(e?.id)?String(e.id):'');
    if(!id){result.errors.push('An entry without an id was skipped.');continue;}
    if(id===TEST_SENSOR_ID){result.errors.push(`The id "${id}" is reserved for the test signal.`);continue;}
    if(seen.has(id)){result.errors.push(`Duplicate id "${id}" skipped.`);continue;}
    const url=String(e.sseUrl??e.sse_url??'').trim();
    if(url){try{const u=new URL(url,typeof location!=='undefined'?location.href:'http://localhost/');if(!/^https?:$/.test(u.protocol))throw new Error();}catch(_){result.errors.push(`Sensor "${id}": invalid SSE URL, skipped.`);continue;}}
    seen.add(id);
    const name=typeof e.name==='string'&&e.name.trim()?e.name.trim():id;
    const known=sensors.get(id);
    if(known){known.name=name;known.sseUrl=url||null;known.details={...known.details,...(e.details||{})};known.unlisted=false;result.updated.push(id);}
    else{const s=makeSensor({id,name,kind:'server',sseUrl:url||null,details:e.details,rateHz:Number(e.rateHz)});if(embeddedFp)initSensorCalibration(s.state,embeddedFp);result.added.push(id);}
  }
  for(const s of sensors.values())if(s.kind==='server'&&!seen.has(s.id)&&!s.unlisted){s.unlisted=true;result.unlisted.push(s.id);}
  syncConnections();renderSensorSelect();updateStatusUI();
  if(activeSensor.kind==='server')$('sourceNote').textContent=`Server sensor · ${activeSensor.sseUrl||'no SSE URL'}`;
  return result;
}
function setSensorListInfo(text){$('sensorListInfo').textContent=text;}
async function loadSensorList(){
  if(!SENSOR_LIST_URL){setSensorListInfo('No sensor server configured (SENSOR_LIST_URL is empty). Only the test signal is available.');return null;}
  try{
    const r=await fetch(SENSOR_LIST_URL,{cache:'no-store'});if(!r.ok)throw new Error(`HTTP ${r.status}`);
    const res=applySensorList(await r.json());
    setSensorListInfo(`Sensor list loaded: ${res.added.length} added, ${res.updated.length} updated, ${res.unlisted.length} no longer listed${res.errors.length?'; '+res.errors.join(' '):''}.`);
    return res;
  }catch(error){setSensorListInfo(`Could not load the sensor list: ${error.message}`);return null;}
}
function initSensorCalibration(st,fp){
  st.calConfig=EMBEDDED_CALIBRATION;st.calPrepared=EMBEDDED_PREPARED;st.revisionId=fp.id;st.hashType=fp.type;st.fullHash=fp.full;
  st.calibrations=[{effectiveFromTime:-Infinity,revisionId:fp.id,profileId:EMBEDDED_CALIBRATION.profileId,hashType:fp.type,config:EMBEDDED_PREPARED,source:'embedded demo'}];
}

// ===== v12: SETTINGS (UI settings + sensor settings) ====================================================
// ASSUMED server API (no server exists yet; both URLs are null, which disables the server buttons):
//   UI_SETTINGS_URL      GET -> 200 + ui-settings.json | 404 = no default stored; PUT = store the body as the
//                        server default; DELETE = remove the server default.
//   SENSOR_SETTINGS_URL  PUT sensor_settings.json (all server sensors in one document).
// Order of precedence for the UI settings: this browser's own copy (localStorage) > server default > built-in.
// Applying a setting never writes it anywhere; only a user change writes the browser copy.
const UI_SETTINGS_URL = null;
const SENSOR_SETTINGS_URL = null;
const UI_LOCAL_KEY = 'massTelemetryWorkbench.uiSettings.v1';
const UI_DEFAULTS = Object.freeze({ schemaVersion: 1, theme: 'dark', navPanelVisible: false, yResponsePercent: 5, downsample: false, zeroFill: false, zeroRawFill: false, zeroLine: false });
const UI_CONTROL_IDS = new Set(['navPanelToggle', 'yResponseRange', 'downsampleToggle', 'zeroFillToggle', 'zeroRawFillToggle', 'zeroLineToggle']);
let uiTheme = 'dark', uiServerDefault = null, uiSaveTimer = null, uiServerState = UI_SETTINGS_URL ? 'not loaded yet' : 'not configured';
const wq = id => document.getElementById(id);   // dynamic (script-generated) elements; $() is for elements that exist in the HTML

// Missing keys fall back to the built-in default, unknown keys are ignored, wrong types are reported.
function sanitizeUiSettings(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { value: null, errors: ['The top level must be a JSON object.'] };
  const out = { ...UI_DEFAULTS }, errors = [];
  if (o.schemaVersion !== 1) errors.push('schemaVersion must be 1.');
  if (o.theme !== undefined) { if (o.theme === 'dark' || o.theme === 'light') out.theme = o.theme; else errors.push('theme must be "dark" or "light".'); }
  for (const k of ['navPanelVisible', 'downsample', 'zeroFill', 'zeroRawFill', 'zeroLine'])
    if (o[k] !== undefined) { if (typeof o[k] === 'boolean') out[k] = o[k]; else errors.push(`${k} must be true or false.`); }
  if (o.yResponsePercent !== undefined) { if (Number.isFinite(o.yResponsePercent)) out.yResponsePercent = clamp(Math.round(o.yResponsePercent), 1, 100); else errors.push('yResponsePercent must be a number.'); }
  return { value: errors.length ? null : out, errors };
}
function collectUiSettings() {
  return { schemaVersion: 1, theme: uiTheme, navPanelVisible: !$('navPanel').hidden, yResponsePercent: clamp(Math.round(Number($('yResponseRange').value) || 5), 1, 100),
    downsample: !!$('downsampleToggle').checked, zeroFill: !!$('zeroFillToggle').checked, zeroRawFill: !!$('zeroRawFillToggle').checked, zeroLine: !!$('zeroLineToggle').checked };
}
function setTheme(light) {
  uiTheme = light ? 'light' : 'dark';
  document.documentElement.classList.toggle('light', !!light);
  $('themeBtn').textContent = light ? '☾ Dark mode' : '☼ Light mode';
  if (state.mainPlot) { destroyCharts(); createCharts(); scheduleRender(); }
}
function applyUiSettings(s) {
  setTheme(s.theme === 'light');
  setNavPanelVisible(!!s.navPanelVisible);
  $('yResponseRange').value = s.yResponsePercent; $('yResponseText').textContent = `${s.yResponsePercent}%`;
  $('downsampleToggle').checked = !!s.downsample; $('zeroFillToggle').checked = !!s.zeroFill; $('zeroRawFillToggle').checked = !!s.zeroRawFill; $('zeroLineToggle').checked = !!s.zeroLine;
  if (state) { state.autoYMin = null; state.autoYMax = null; }
  scheduleRender();
}
function uiLocalRead() { try { if (typeof localStorage === 'undefined') return null; const t = localStorage.getItem(UI_LOCAL_KEY); return t ? sanitizeUiSettings(JSON.parse(t)).value : null; } catch (_) { return null; } }
function uiLocalWrite(o) { try { localStorage.setItem(UI_LOCAL_KEY, JSON.stringify(o)); return true; } catch (_) { return false; } }
function uiLocalClear() { try { localStorage.removeItem(UI_LOCAL_KEY); } catch (_) {} }
function uiSaveSoon() { clearTimeout(uiSaveTimer); uiSaveTimer = setTimeout(() => { uiSaveTimer = null; uiLocalWrite(collectUiSettings()); updateUiSettingsInfo(); }, 250); }
function uiMsg(t) { $('uiMessages').textContent = t; }
function updateUiSettingsInfo() {
  const local = uiLocalRead();
  $('uiSettingsInfo').innerHTML = `This browser: <strong>${local ? 'own settings stored' : 'nothing stored (server default or built-in values apply)'}</strong><br>Server default: <strong>${esc(uiServerState)}</strong><br><span class="small">Stored items: theme, navigation panel, Y-axis response, downsampling, zero fills, zero line.</span>`;
  $('uiSaveServerBtn').disabled = !UI_SETTINGS_URL; $('uiResetServerBtn').disabled = !UI_SETTINGS_URL;
}
async function uiFetchServerDefault() {
  if (!UI_SETTINGS_URL) { uiServerState = 'not configured'; return null; }
  try {
    const r = await fetch(UI_SETTINGS_URL, { cache: 'no-store' });
    if (r.status === 404) { uiServerDefault = null; uiServerState = 'no default stored'; return null; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const s = sanitizeUiSettings(await r.json()); if (!s.value) throw new Error(s.errors.join(' '));
    uiServerDefault = s.value; uiServerState = 'default available'; return s.value;
  } catch (e) { uiServerState = `unavailable (${e.message})`; return null; }
}
async function uiSaveAsServerDefault() {
  if (!UI_SETTINGS_URL) { uiMsg('No settings server is configured (UI_SETTINGS_URL is empty).'); return; }
  try {
    const body = collectUiSettings(), r = await fetch(UI_SETTINGS_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body, null, 2) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    uiServerDefault = body; uiServerState = 'default available'; uiMsg('The current UI settings are now the server default.');
  } catch (e) { uiMsg(`Could not save the server default: ${e.message}`); }
  updateUiSettingsInfo();
}
async function uiResetServerDefault() {
  if (!UI_SETTINGS_URL) { uiMsg('No settings server is configured (UI_SETTINGS_URL is empty).'); return; }
  try {
    const r = await fetch(UI_SETTINGS_URL, { method: 'DELETE' });
    if (!r.ok && r.status !== 404) throw new Error(`HTTP ${r.status}`);
    uiServerDefault = null; uiServerState = 'no default stored'; uiMsg('The server default was removed. Browsers without their own settings use the built-in values.');
  } catch (e) { uiMsg(`Could not reset the server default: ${e.message}`); }
  updateUiSettingsInfo();
}
// "Reset": forget this browser's own copy and fall back to the server default (re-read now) or the built-in values.
async function uiResetLocal() {
  uiLocalClear(); clearTimeout(uiSaveTimer);
  await uiFetchServerDefault();
  applyUiSettings(uiServerDefault || UI_DEFAULTS);
  uiMsg(uiServerDefault ? 'This browser’s UI settings were reset to the server default.' : 'This browser’s UI settings were reset to the built-in values.');
  updateUiSettingsInfo();
}
function initUiSettings() {
  const local = uiLocalRead(); if (local) applyUiSettings(local);
  for (const type of ['change', 'input']) document.addEventListener(type, e => { if (e.target && UI_CONTROL_IDS.has(e.target.id)) uiSaveSoon(); });
  $('uiResetBtn').addEventListener('click', uiResetLocal);
  $('uiSaveServerBtn').addEventListener('click', uiSaveAsServerDefault);
  $('uiResetServerBtn').addEventListener('click', uiResetServerDefault);
  $('uiExportBtn').addEventListener('click', () => downloadBlob(new Blob([JSON.stringify(collectUiSettings(), null, 2)], { type: 'application/json' }), 'ui-settings.json'));
  if (UI_SETTINGS_URL) uiFetchServerDefault().then(d => { if (!local && d) applyUiSettings(d); updateUiSettingsInfo(); });
  updateUiSettingsInfo();
}

// ---- sensor settings -------------------------------------------------------------------------------------
// One document for all server sensors (the test signal has no settings). The nominal rate can be changed
// locally only while the sensor has no samples: every statistic of the stored samples assumes it.
let ssSelectedId = null;
function sensorSettingsDoc() {
  return { schemaVersion: 1, generatedAt: new Date().toISOString(),
    sensors: [...sensors.values()].filter(s => s.kind === 'server').map(s => ({ id: s.id, name: s.name, nominalRateHz: s.state.rateHz, notes: s.settings.notes || '' })) };
}
function sensorSettingsRender() {
  const server = [...sensors.values()].filter(s => s.kind === 'server');
  if (!ssSelectedId || !sensors.has(ssSelectedId) || sensors.get(ssSelectedId).kind !== 'server') ssSelectedId = server.length ? (activeSensor.kind === 'server' ? activeSensor.id : server[0].id) : null;
  const sel = $('ssSensor'); sel.innerHTML = '';
  for (const s of server) { const o = document.createElement('option'); o.value = s.id; o.textContent = s.name + (s.unlisted ? ' (not in list)' : ''); sel.appendChild(o); }
  if (ssSelectedId) sel.value = ssSelectedId;
  const s = ssSelectedId && sensors.get(ssSelectedId), none = !s;
  $('ssForm').hidden = none; $('ssNone').hidden = !none;
  if (none) return;
  $('ssName').value = s.name; $('ssRate').value = s.state.rateHz; $('ssNotes').value = s.settings.notes || '';
  $('ssRate').disabled = s.state.count > 0; $('ssRateNote').textContent = s.state.count > 0 ? 'Fixed: this sensor already holds samples.' : 'Can still be changed: no samples yet.';
}
function ssMsg(t) { $('ssMessages').textContent = t; }
async function sensorSettingsApply() {
  const s = ssSelectedId && sensors.get(ssSelectedId); if (!s) return;
  const rate = Number($('ssRate').value);
  if (s.state.count === 0 && !(rate > 0 && rate <= 10000)) { ssMsg('The nominal rate must be between 0 and 10,000 Hz.'); return; }
  s.name = ($('ssName').value || '').trim() || s.id; s.settings.notes = $('ssNotes').value || '';
  if (s.state.count === 0 && rate !== s.state.rateHz) {
    s.state.rateHz = rate;
    if (s === activeSensor) { RATE_HZ = rate; PERIOD_MS = 1000 / rate; syncUIFromState(); }
  }
  renderSensorSelect(); sensorSettingsRender();
  if (!SENSOR_SETTINGS_URL) { ssMsg('Applied in this session. Nothing was sent: no sensor server is configured (SENSOR_SETTINGS_URL is empty). “Download” saves sensor_settings.json.'); return; }
  try {
    const r = await fetch(SENSOR_SETTINGS_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sensorSettingsDoc(), null, 2) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    ssMsg('Applied and sent sensor_settings.json to the server.');
  } catch (e) { ssMsg(`Applied locally, but the server did not accept sensor_settings.json: ${e.message}`); }
}
function openSettingsMenu(tab) {
  openSettings(false); $('settingsModal').hidden = false; settingsMenuTab(tab || 'ui');
  updateUiSettingsInfo(); sensorSettingsRender();
}
function settingsMenuTab(tab) {
  for (const t of ['ui', 'sensor']) { $('smPane_' + t).hidden = t !== tab; $('smTab_' + t).setAttribute('aria-selected', String(t === tab)); }
}
function initSettingsMenu() {
  $('openSettingsMenuBtn').addEventListener('click', () => openSettingsMenu('ui'));
  $('smClose').addEventListener('click', () => { $('settingsModal').hidden = true; });
  $('settingsModal').addEventListener('pointerdown', e => { if (e.target === $('settingsModal')) $('settingsModal').hidden = true; });
  $('smTab_ui').addEventListener('click', () => settingsMenuTab('ui')); $('smTab_sensor').addEventListener('click', () => settingsMenuTab('sensor'));
  $('ssSensor').addEventListener('change', e => { ssSelectedId = e.target.value; sensorSettingsRender(); ssMsg(''); });
  $('ssApplyBtn').addEventListener('click', sensorSettingsApply);
  $('ssDownloadBtn').addEventListener('click', () => downloadBlob(new Blob([JSON.stringify(sensorSettingsDoc(), null, 2)], { type: 'application/json' }), 'sensor_settings.json'));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (!$('wizModal').hidden) wizClose(); else if (!$('settingsModal').hidden) $('settingsModal').hidden = true; } });
}

// ===== v12: CALIBRATION FITTING (pure functions: no DOM, no state) ===========================================
// Model. A reading is raw = g(m) + noise, m = reference mass. The noise sits in the COUNTS (the reference masses are
// known far better than one reading), so g is fitted as raw on mass by ordinary least squares, i.e. in the variable that
// carries the noise. Regressing mass on raw would bias the slope low (regression dilution) whenever the counts are noisy.
// The engine needs the inverse f(raw) = mass and it is piecewise linear, so f is written as anchors SAMPLED ON THE
// FITTED CURVE: m_k uniform over the reference range, raw_k = g(m_k). The piecewise-linear interpolant through points of a
// monotone curve needs no inversion. Its deviation from the exact inverse is measured at the segment mid-counts
// (bisection inside one segment) and the number of segments is doubled until that error is < 1e-5 of the mass span
// (at most 256 segments); the final value is reported. Outside the range the engine extrapolates linearly and flags it.
// Weights: all observations count equally (each placement is one independent observation). Residual SD is s = sqrt(SSE/(n-p)),
// observed scatter around the model, NOT an uncertainty. The polynomial is fitted in u = (m - c)/h, u in [-1,1], so the
// normal equations stay well conditioned up to degree 3.
const FIT_MODELS = {
  anchors: { label: 'Piecewise-linear through the mean of each reference mass', degree: null },
  linear: { label: 'Straight line (least squares)', degree: 1 },
  poly2: { label: 'Quadratic (least squares)', degree: 2 },
  poly3: { label: 'Cubic (least squares)', degree: 3 }
};
function rawStats(a) {
  const n = a.length; if (!n) return { n: 0, mean: NaN, sd: NaN, median: NaN, mad: NaN };
  let s = 0; for (const v of a) s += v; const mean = s / n; let q = 0; for (const v of a) q += (v - mean) * (v - mean);
  const med = anMedian(a);
  return { n, mean, sd: Math.sqrt(q / n), median: med, mad: anMedian(Array.from(a, v => Math.abs(v - med))) };
}
function fitSolve(A, b) {   // Gaussian elimination with partial pivoting; null if (numerically) singular
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (!(Math.abs(M[p][c]) > 1e-12)) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = M[i][n]; for (let k = i + 1; k < n; k++) s -= M[i][k] * x[k]; x[i] = s / M[i][i]; }
  return x;
}
function fitPolynomial(xs, ys, degree) {
  const n = xs.length, p = degree + 1, lo = Math.min(...xs), hi = Math.max(...xs), c = (lo + hi) / 2, h = (hi - lo) / 2 || 1;
  const A = Array.from({ length: p }, () => new Array(p).fill(0)), b = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const u = (xs[i] - c) / h, pw = [1]; for (let k = 1; k <= 2 * p - 2; k++) pw.push(pw[k - 1] * u);
    for (let r = 0; r < p; r++) { b[r] += ys[i] * pw[r]; for (let k = 0; k < p; k++) A[r][k] += pw[r + k]; }
  }
  const coef = fitSolve(A, b); if (!coef) return null;
  return { coef, center: c, half: h, degree,
    g: m => { const u = (m - c) / h; let s = 0; for (let k = p - 1; k >= 0; k--) s = s * u + coef[k]; return s; },
    dg: m => { const u = (m - c) / h; let s = 0; for (let k = p - 1; k >= 1; k--) s = s * u + k * coef[k]; return s / h; } };
}
const fitKey = m => Number(m.toPrecision(12));   // equal reference masses (up to rounding) form one group
function fitGroups(points) {
  const map = new Map();
  for (const p of points) { const k = fitKey(p.massMg); let g = map.get(k); if (!g) { g = { massMg: p.massMg, raws: [], ids: [] }; map.set(k, g); } g.raws.push(p.raw); g.ids.push(p.id); }
  const gs = [...map.values()].sort((a, b) => a.massMg - b.massMg);
  for (const g of gs) { const st = rawStats(g.raws); g.rawMean = st.mean; g.rawSD = g.raws.length > 1 ? st.sd * Math.sqrt(g.raws.length / (g.raws.length - 1)) : NaN; }   // between-placement SD (n-1)
  return gs;
}
function fitInterpError(nodes) {   // max |piecewise-linear inverse - exact inverse| at the mid-counts of the segments (mg)
  let worst = 0;
  for (let k = 0; k + 1 < nodes.length; k++) {
    const a = nodes[k], b = nodes[k + 1], rm = (a.raw + b.raw) / 2, g = nodes.g;
    let lo = a.massMg, hi = b.massMg; const up = g(hi) > g(lo);
    for (let it = 0; it < 60; it++) { const mid = (lo + hi) / 2; if ((g(mid) < rm) === up) lo = mid; else hi = mid; }
    const exact = (lo + hi) / 2, lin = a.massMg + (rm - a.raw) / (b.raw - a.raw) * (b.massMg - a.massMg);
    worst = Math.max(worst, Math.abs(lin - exact));
  }
  return worst;
}
// points: [{id, massMg, raw}] (one per included observation). Never throws; problems are in .errors.
function fitCalibration(points, model) {
  const out = { ok: false, errors: [], model, n: points.length, groups: [], anchors: [], residuals: [], g: null };
  const spec = FIT_MODELS[model]; if (!spec) { out.errors.push(`Unknown fit model "${model}".`); return out; }
  const groups = fitGroups(points); out.groups = groups; out.distinct = groups.length;
  if (groups.length < 2) { out.errors.push('At least two different reference masses are needed.'); return out; }
  const mLo = groups[0].massMg, mHi = groups[groups.length - 1].massMg; out.mRange = [mLo, mHi];
  const stats = () => {
    let sse = 0; for (const r of out.residuals) sse += r.resRaw * r.resRaw;
    out.sdRawRes = out.dof > 0 ? Math.sqrt(sse / out.dof) : NaN;
    const fin = out.residuals.map(r => r.resMassMg).filter(Number.isFinite);
    out.rmsMassMg = fin.length ? Math.sqrt(fin.reduce((s, v) => s + v * v, 0) / fin.length) : NaN;
    out.maxAbsMassMg = fin.length ? Math.max(...fin.map(Math.abs)) : NaN;
  };
  if (model === 'anchors') {
    out.params = groups.length; out.dof = points.length - groups.length;
    out.anchors = groups.map(g => ({ massMg: g.massMg, raw: g.rawMean, sourceIds: g.ids, count: g.raws.length }));
    out.g = m => { let i = 0; while (i < groups.length - 2 && m > groups[i + 1].massMg) i++; const a = groups[i], b = groups[i + 1]; return a.rawMean + (m - a.massMg) / (b.massMg - a.massMg) * (b.rawMean - a.rawMean); };
    const index = new Map(groups.map((g, i) => [fitKey(g.massMg), i]));
    out.residuals = points.map(p => {
      const gi = index.get(fitKey(p.massMg)), s = Math.min(gi, groups.length - 2), a = groups[s], b = groups[s + 1], slope = (b.rawMean - a.rawMean) / (b.massMg - a.massMg), res = p.raw - groups[gi].rawMean;
      return { id: p.id, massMg: p.massMg, raw: p.raw, fitRaw: groups[gi].rawMean, resRaw: res, resMassMg: res / slope };
    });
    stats(); out.ok = true; return out;
  }
  const need = spec.degree + 1;
  if (groups.length < need) { out.errors.push(`${spec.label} needs at least ${need} different reference masses; there are ${groups.length}.`); return out; }
  const fit = fitPolynomial(points.map(p => p.massMg), points.map(p => p.raw), spec.degree);
  if (!fit) { out.errors.push('The fit is numerically singular (too few distinct masses for this degree).'); return out; }
  Object.assign(out, { g: fit.g, dg: fit.dg, coef: fit.coef, center: fit.center, half: fit.half, params: need, dof: points.length - need });
  out.residuals = points.map(p => { const f = fit.g(p.massMg), d = fit.dg(p.massMg); return { id: p.id, massMg: p.massMg, raw: p.raw, fitRaw: f, resRaw: p.raw - f, resMassMg: (p.raw - f) / d }; });
  stats();
  let sign = 0; out.monotone = true;
  for (let k = 0; k <= 400; k++) { const s = Math.sign(fit.dg(mLo + (mHi - mLo) * k / 400)); if (s === 0 || (sign && s !== sign)) { out.monotone = false; break; } sign = s; }
  if (!out.monotone) { out.errors.push('The fitted curve is not monotonic over the range of the reference masses. Use a lower degree or exclude an observation.'); return out; }
  let N = spec.degree > 1 ? 17 : 2, nodes;
  const build = () => { nodes = Array.from({ length: N }, (_, k) => { const m = mLo + (mHi - mLo) * k / (N - 1); return { massMg: m, raw: fit.g(m) }; }); nodes.g = fit.g; return fitInterpError(nodes); };
  let err = build();
  while (spec.degree > 1 && err > 1e-5 * (mHi - mLo) && N < 257) { N = 2 * N - 1; err = build(); }
  out.nodes = N; out.maxInterpErrMg = err;
  out.anchors = nodes.map(n => ({ massMg: n.massMg, raw: n.raw, sourceIds: [], count: 0 }));
  out.ok = true; return out;
}

// ---- calibration document from wizard data (pure: W is passed in) ------------------------------------------
function wizLoadMassMg(W, load) {
  let s = 0;
  for (const c of load.components) {
    const w = W.weights.find(x => x.weightId === c.weightId);
    if (!w) throw new Error(`Load "${load.name}" refers to a missing weight.`);
    s += Number(c.quantity) * massToMg(Number(w.assignedMass != null ? w.assignedMass : w.nominalMass), w.unit);
  }
  return s;
}
function wizPoints(W) {
  const points = [], errors = [];
  for (const o of W.observations) {
    if (!o.include) continue;
    const load = W.loads.find(l => l.loadId === o.loadId);
    if (!load) { errors.push(`Observation ${o.observationId} refers to a missing load.`); continue; }
    if (!Number.isFinite(o.rawMean)) { errors.push(`Observation ${o.observationId} has no valid raw mean.`); continue; }
    try { points.push({ id: o.observationId, massMg: wizLoadMassMg(W, load), raw: o.rawMean }); } catch (e) { errors.push(e.message); }
  }
  return { points, errors };
}
function wizObsWeightId(load) { return load.weightRef || (load.components.length === 1 && Number(load.components[0].quantity) === 1 ? load.components[0].weightId : null); }
function buildCalibrationConfig(W, fit, nowIso) {
  const unit = W.profile.unit, pad = (n, w) => String(n).padStart(w, '0');
  const included = W.observations.filter(o => o.include);
  const anchors = fit.anchors.map((a, i) => {
    const base = { anchorId: `anchor-${pad(i, 3)}`, referenceValue: mgToUnit(a.massMg, unit), referenceUnit: unit, rawMean: a.raw };
    if (fit.model === 'anchors') return { ...base, sourceObservationIds: a.sourceIds, aggregationMethod: a.count > 1 ? 'arithmetic-mean-of-observation-raw-means' : 'single-observation', replicateCount: a.count };
    return { ...base, sourceObservationIds: [], aggregationMethod: `fit-sampled:${fit.model}` };
  });
  return {
    schemaVersion: 1, profileId: W.profile.profileId, profileName: W.profile.profileName, createdAt: nowIso, modifiedAt: nowIso, applicationVersion: '12.0-wizard',
    calibrationUnit: unit, calibrationMethod: 'piecewise-linear',
    sensor: { model: W.profile.sensorModel || '', hardwareId: W.sensorId || '', adcResolutionBits: null, samplingRateHz: W.rateHz || null },
    environment: { temperatureC: null, relativeHumidityPercent: null, notes: W.profile.notes || '' },
    referenceWeights: W.weights.map(w => ({ weightId: w.weightId, name: w.name, nominalMass: Number(w.nominalMass), assignedMass: w.assignedMass == null ? null : Number(w.assignedMass), unit: w.unit, referenceUncertainty: w.referenceUncertainty == null ? null : w.referenceUncertainty })),
    referenceLoads: W.loads.map(l => ({ loadId: l.loadId, name: l.name, components: l.components.map(c => ({ weightId: c.weightId, quantity: Number(c.quantity) })) })),
    observations: W.observations.map(o => {
      const r = { observationId: o.observationId, weightId: wizObsWeightId(W.loads.find(l => l.loadId === o.loadId) || { components: [] }), loadId: o.loadId, recordedAt: o.recordedAt, placementRunId: o.placementRunId, placementIndex: o.placementIndex, removedAndReplaced: !!o.removedAndReplaced,
        rawMean: o.rawMean, rawStdDev: o.rawStdDev, rawMedian: o.rawMedian, rawMAD: o.rawMAD, sampleCount: o.sampleCount, durationMs: o.durationMs, outlierMethod: null,
        validityStatus: (o.validity && o.validity.status) || 'n/a', validityFlags: (o.validity && o.validity.flagged) || [] };
      if (!o.include) { r.excluded = true; r.exclusionReason = o.exclusionReason || 'excluded in the fitting editor'; }
      return r;
    }),
    calibrationAnchors: anchors,
    fit: { model: fit.model, label: FIT_MODELS[fit.model].label, direction: fit.model === 'anchors' ? 'interpolation through group means' : 'counts on mass (least squares), inverted by sampling the fitted curve',
      parameters: fit.params, observationsUsed: included.length, distinctMasses: fit.distinct, degreesOfFreedom: fit.dof, residualSdCounts: Number.isFinite(fit.sdRawRes) ? fit.sdRawRes : null,
      rmsResidualMassMg: Number.isFinite(fit.rmsMassMg) ? fit.rmsMassMg : null, maxAbsResidualMassMg: Number.isFinite(fit.maxAbsMassMg) ? fit.maxAbsMassMg : null,
      sampledSegments: fit.model === 'anchors' ? null : fit.nodes - 1, maxInterpolationErrorMg: fit.model === 'anchors' ? null : fit.maxInterpErrMg,
      polynomial: fit.coef ? { variable: 'u = (mass_mg - center)/half', center: fit.center, half: fit.half, coefficients: fit.coef } : null },
    validation: { status: 'not-characterized', method: null, checks: [{ id: 'fit-residuals', status: 'informational', note: 'observed scatter of the observations around the model; not an uncertainty' }], modelUncertainty: null },
    reserved: { warmUpDurationSeconds: null, loadApproach: 'not-recorded', loadingDirection: 'not-determined', hysteresisAnalysis: null, temperatureCompensation: null, humidityCompensation: null }
  };
}

// ===== v12: CALIBRATION WIZARD + FITTING EDITOR (UI) ===================================================
// Four free-order tabs: 1 Weights (profile, reference weights, combination loads), 2 Observations (record
// raw counts of a load from the shown sensor, reuse a selected interval, or type a value), 3 Fit (model choice,
// plots, residuals, include/exclude observations), 4 Review (checks, activate on the shown sensor, export).
// A capture reuses the Measurement machinery (beginMeasurement), so it is highlighted, logged, analysed with
// analyzeSeries and cancelled by a tare / calibration change / gap exactly like a measurement. Observations store
// RAW counts, so the wizard result does not depend on any tare or on the calibration that is active meanwhile.
// An observation whose validity check is 'invalid' starts excluded (it can be included again, knowingly).
const wiz = { open: false, tab: 'weights', minimised: false, sensorId: null, rateHz: null, profile: null, weights: [], loads: [], observations: [], runId: null,
  captureSeconds: 10, capture: null, fitModel: 'anchors', message: '', newQty: {}, selLoad: null, replaced: true, nextNum: 1 };
function wizId(prefix, list, key) { let n = wiz.nextNum++; while (list.some(x => x[key] === `${prefix}${n}`)) n = wiz.nextNum++; return `${prefix}${n}`; }
function wizStamp() { return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12); }
function wizNew() {
  Object.assign(wiz, { tab: 'weights', profile: { profileId: `scale-profile-${wizStamp()}`, profileName: 'New calibration', unit: 'g', notes: '', sensorModel: '' }, nextNum: 1, observations: [], capture: null, fitModel: 'anchors', message: '',
    weights: [{ weightId: 'ref-empty', name: 'Empty platform / zero reference', nominalMass: 0, assignedMass: null, unit: 'g', referenceUncertainty: null }], loads: [], newQty: {}, runId: `run-${wizStamp()}`, selLoad: null });
  wizSyncLoads(); wiz.selLoad = wiz.loads[0].loadId;
}
// Every weight has an automatic single-weight load; the empty platform has none (components: []).
function wizSyncLoads() {
  for (const w of wiz.weights) if (!wiz.loads.some(l => l.auto && l.weightRef === w.weightId))
    wiz.loads.push({ loadId: `load-${w.weightId.replace(/^ref-/, '')}`, name: w.weightId === 'ref-empty' ? 'Empty platform' : (w.name || w.weightId), weightRef: w.weightId, auto: true, components: w.weightId === 'ref-empty' ? [] : [{ weightId: w.weightId, quantity: 1 }] });
  wiz.loads = wiz.loads.filter(l => (l.auto ? wiz.weights.some(w => w.weightId === l.weightRef) : l.components.every(c => wiz.weights.some(w => w.weightId === c.weightId))));
  for (const l of wiz.loads) if (l.auto) { const w = wiz.weights.find(x => x.weightId === l.weightRef); if (w && w.weightId !== 'ref-empty') l.name = w.name || w.weightId; }
  if (!wiz.loads.some(l => l.loadId === wiz.selLoad)) wiz.selLoad = wiz.loads.length ? wiz.loads[0].loadId : null;
}
function wizLoadFromConfig(cfg) {
  const num = v => (v == null ? null : Number(v));
  wiz.profile = { profileId: cfg.profileId, profileName: cfg.profileName, unit: cfg.calibrationUnit, notes: (cfg.environment && cfg.environment.notes) || '', sensorModel: (cfg.sensor && cfg.sensor.model) || '' };
  wiz.weights = (cfg.referenceWeights || []).map(w => ({ weightId: w.weightId, name: w.name || w.weightId, nominalMass: Number(w.nominalMass), assignedMass: num(w.assignedMass), unit: w.unit || cfg.calibrationUnit, referenceUncertainty: w.referenceUncertainty == null ? null : w.referenceUncertainty }));
  const zero = wiz.weights.find(w => w.weightId === 'ref-empty') || wiz.weights.find(w => Number(w.nominalMass) === 0);
  wiz.loads = (cfg.referenceLoads || []).map(l => {
    const comps = (l.components || []).map(c => ({ weightId: c.weightId, quantity: Number(c.quantity) || 1 }));
    const single = comps.length === 1 && comps[0].quantity === 1, empty = comps.length === 0 && zero;
    return { loadId: l.loadId, name: l.name || l.loadId, components: comps, auto: !!(single || empty), weightRef: single ? comps[0].weightId : (empty ? zero.weightId : null) };
  });
  wiz.observations = (cfg.observations || []).map(o => ({ observationId: o.observationId, loadId: o.loadId, recordedAt: o.recordedAt, placementRunId: o.placementRunId || 'imported', placementIndex: o.placementIndex || 0, removedAndReplaced: !!o.removedAndReplaced,
    rawMean: Number(o.rawMean), rawStdDev: num(o.rawStdDev), rawMedian: num(o.rawMedian), rawMAD: num(o.rawMAD), sampleCount: num(o.sampleCount), durationMs: num(o.durationMs),
    validity: { status: o.validityStatus || 'n/a', flagged: o.validityFlags || [] }, include: !o.excluded, exclusionReason: o.exclusionReason, source: 'imported' }));
  wiz.fitModel = (cfg.fit && FIT_MODELS[cfg.fit.model]) ? cfg.fit.model : 'anchors';
  wiz.newQty = {}; wiz.runId = `run-${wizStamp()}`; wiz.nextNum = wiz.weights.length + 1; wiz.capture = null; wiz.tab = 'fit';
  wizSyncLoads();
}
function wizWeightUse(weightId) { const loads = wiz.loads.filter(l => l.components.some(c => c.weightId === weightId) || l.weightRef === weightId).map(l => l.loadId); return wiz.observations.filter(o => loads.includes(o.loadId)).length; }
function wizMassText(mg, unit) { return Number.isFinite(mg) ? `${fmtNumber(mgToUnit(mg, unit), Math.max(3, unitById(unit).decimals))} ${unitById(unit).symbol}` : '—'; }
function wizLoadMassSafe(load) { try { return wizLoadMassMg(wiz, load); } catch (_) { return NaN; } }
function wizBlock() {
  if (wiz.sensorId !== activeSensor.id) return 'The wizard belongs to another sensor than the one shown. Select that sensor or use “Use the shown sensor”.';
  if (state.measurement) return 'A measurement is running; wait for it to finish or cancel it.';
  return '';
}
// ---- observations ----------------------------------------------------------------------------------------------------
function wizNextObsId() { let n = wiz.observations.length + 1, id; do { id = `obs-${String(n++).padStart(3, '0')}`; } while (wiz.observations.some(o => o.observationId === id)); return id; }
function wizObservationFromRange(first, end, loadId, source) {
  const raws = new Array(end - first); for (let i = first; i < end; i++) raws[i - first] = getRaw(i);
  const st = rawStats(raws), an = analyzeInterval(first, end);
  const flagged = (an.checks || []).filter(c => c.verdict === 'suspect' || c.verdict === 'invalid').map(c => c.label.split(' / ')[0]);
  return { observationId: wizNextObsId(), loadId, recordedAt: new Date().toISOString(), placementRunId: wiz.runId, placementIndex: wiz.observations.length + 1, removedAndReplaced: wiz.replaced,
    rawMean: st.mean, rawStdDev: st.sd, rawMedian: st.median, rawMAD: st.mad, sampleCount: st.n, durationMs: getTime(end - 1) - getTime(first) + PERIOD_MS,
    validity: { status: an.status, flagged }, include: an.status !== 'invalid', exclusionReason: an.status === 'invalid' ? 'validity check: invalid' : undefined, source };
}
function wizRecord() {
  const why = wizBlock(); if (why) { wiz.message = why; wizRender(); return; }
  const load = wiz.loads.find(l => l.loadId === wiz.selLoad); if (!load) { wiz.message = 'Choose a load first.'; wizRender(); return; }
  const n = clamp(Math.round(wiz.captureSeconds * RATE_HZ), 2, MEASUREMENT_MAX_SAMPLES);
  wiz.capture = { loadId: load.loadId, target: n };
  const ok = beginMeasurement(n, { tag: 'calibration wizard', onDone: wizCaptureDone, onCancel: r => { wiz.capture = null; wiz.message = `Capture cancelled: ${r}`; if (wiz.open) wizRender(); } });
  if (!ok) { wiz.capture = null; wiz.message = $('measProgress').textContent; }
  else wiz.message = `Recording ${n.toLocaleString()} samples (${(n / RATE_HZ).toFixed(1)} s). Do not touch the platform.`;
  wizRender();
}
function wizCaptureDone(entry, first, end) {
  const cap = wiz.capture; wiz.capture = null; if (!cap) return;
  const o = wizObservationFromRange(first, end, cap.loadId, 'capture'); wiz.observations.push(o);
  wiz.message = `Observation ${o.observationId} recorded: mean ${fmtNumber(o.rawMean, 2)} counts, SD ${fmtNumber(o.rawStdDev, 2)}, validity ${STATUS_TEXT[o.validity.status] || o.validity.status}${o.include ? '' : ' (excluded by default)'}.`;
  wiz.replaced = true; if (wiz.open) wizRender();
}
function wizUseSelection() {
  const why = wizBlock(); const s = state.selection;
  if (why && !/measurement is running/.test(why)) { wiz.message = why; wizRender(); return; }
  if (!s) { wiz.message = 'There is no selected interval on the chart.'; wizRender(); return; }
  if (s.t0 < oldestTime() || s.t1 > newestTime()) { wiz.message = 'The selected samples are no longer in the buffer.'; wizRender(); return; }
  const first = lowerBoundTime(s.t0), end = lowerBoundTime(s.t1 + 0.0001);
  if (end - first < 2) { wiz.message = 'Select at least two samples.'; wizRender(); return; }
  const o = wizObservationFromRange(first, end, wiz.selLoad, 'selection'); wiz.observations.push(o);
  wiz.message = `Observation ${o.observationId} taken from the selected interval (${o.sampleCount.toLocaleString()} samples).`; wizRender();
}
function wizAddManual() {
  const raw = Number(wq('wizManualRaw').value), sd = wq('wizManualSd').value === '' ? null : Number(wq('wizManualSd').value), n = wq('wizManualN').value === '' ? null : Math.round(Number(wq('wizManualN').value));
  if (!Number.isFinite(raw)) { wiz.message = 'Enter the mean raw counts.'; wizRender(); return; }
  wiz.observations.push({ observationId: wizNextObsId(), loadId: wiz.selLoad, recordedAt: new Date().toISOString(), placementRunId: wiz.runId, placementIndex: wiz.observations.length + 1, removedAndReplaced: wiz.replaced,
    rawMean: raw, rawStdDev: sd, rawMedian: null, rawMAD: null, sampleCount: n, durationMs: null, validity: { status: 'n/a', flagged: [] }, include: true, source: 'manual' });
  wiz.message = 'Manual observation added (no validity analysis available).'; wizRender();
}
// ---- rendering -------------------------------------------------------------------------------------------------------
const WIZ_TABS = [['weights', '1 Weights'], ['observations', '2 Observations'], ['fit', '3 Fit'], ['review', '4 Review']];
function wizInput(a, i, f, v, type = 'text', extra = '') { return `<input type="${type}" ${type === 'number' ? 'step="any" ' : ''}data-w="${a}" data-i="${i}" data-f="${f}" value="${esc(v == null ? '' : v)}" ${extra}>`; }
function wizUnitSelect(a, i, f, cur) { return `<select data-w="${a}" data-i="${i}" data-f="${f}">${UNIT_CONFIG.units.filter(u => u.id !== 'raw').map(u => `<option value="${u.id}"${u.id === cur ? ' selected' : ''}>${esc(u.symbol)}</option>`).join('')}</select>`; }
function wizValidityBadge(v) { const st = (v && v.status) || 'n/a'; return `<span class="vbadge ${st === 'n/a' ? 'na' : st}">${VERDICT_ICON[st] || '–'} ${esc(STATUS_TEXT[st] || st)}${v && v.flagged && v.flagged.length ? ' (' + esc(v.flagged.join(', ')) + ')' : ''}</span>`; }
function wizPaneWeights() {
  const w = wiz, p = w.profile;
  const rows = w.weights.map((x, i) => `<tr><td>${wizInput('weight', i, 'name', x.name)}</td><td>${wizInput('weight', i, 'nominalMass', x.nominalMass, 'number', 'min="0"')}</td><td>${wizInput('weight', i, 'assignedMass', x.assignedMass, 'number', 'min="0" placeholder="= nominal"')}</td><td>${wizUnitSelect('weight', i, 'unit', x.unit)}</td><td>${wizInput('newqty', i, 'qty', w.newQty[x.weightId] || 0, 'number', 'min="0" step="1"')}</td><td>${x.weightId === 'ref-empty' ? '' : `<button data-wa="delWeight" data-i="${i}" title="Remove this weight">✕</button>`}</td></tr>`).join('');
  const combos = w.loads.filter(l => !l.auto).map(l => `<tr><td>${esc(l.name)}</td><td>${l.components.map(c => `${c.quantity} × ${esc((w.weights.find(x => x.weightId === c.weightId) || {}).name || '?')}`).join(' + ')}</td><td>${wizMassText(wizLoadMassSafe(l), p.unit)}</td><td><button data-wa="delLoad" data-id="${esc(l.loadId)}">✕</button></td></tr>`).join('');
  return `<div class="button-row" style="margin-top:0"><button data-wa="restart">Start empty</button><button data-wa="fromActive">Load the active calibration of the shown sensor (refit / edit)</button></div>
  <div class="control-grid" style="margin-top:10px"><div class="field span2"><label>Profile name</label>${wizInput('profile', 0, 'profileName', p.profileName)}</div>
  <div class="field"><label>Profile ID</label>${wizInput('profile', 0, 'profileId', p.profileId)}</div>
  <div class="field"><label>Calibration unit (masses in the file)</label>${wizUnitSelect('profile', 0, 'unit', p.unit)}</div>
  <div class="field span2"><label>Notes (stored in environment.notes)</label>${wizInput('profile', 0, 'notes', p.notes)}</div></div>
  <h3 style="margin:12px 0 4px">Reference weights</h3>
  <div class="small">Enter the certificate (assigned) mass if you have one; otherwise the nominal mass is used. Weights of equal nominal mass are not merged unless their masses are equal.</div>
  <div class="tablewrap"><table class="wiz-table"><thead><tr><th>Name</th><th>Nominal</th><th>Assigned</th><th>Unit</th><th title="Quantity in the combination that “Add combination” creates">Qty</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
  <div class="button-row"><button data-wa="addWeight">＋ Add weight</button><button data-wa="addLoad" title="Creates a load of all weights with Qty &gt; 0 (e.g. 100 g A + 100 g B placed together)">＋ Add combination from Qty</button></div>
  ${combos ? `<h3 style="margin:12px 0 4px">Combination loads</h3><div class="tablewrap"><table class="wiz-table"><tbody>${combos}</tbody></table></div>` : ''}`;
}
function wizPaneObs() {
  const w = wiz, p = w.profile, why = wizBlock(), busy = !!w.capture;
  const opts = w.loads.map(l => `<option value="${esc(l.loadId)}"${l.loadId === w.selLoad ? ' selected' : ''}>${esc(l.name)} · ${wizMassText(wizLoadMassSafe(l), p.unit)}</option>`).join('');
  const rows = w.observations.map((o, i) => { const l = w.loads.find(x => x.loadId === o.loadId);
    return `<tr class="${o.include ? '' : 'excl'}"><td>${esc(o.observationId)}</td><td>${esc(l ? l.name : '?')}</td><td>${l ? wizMassText(wizLoadMassSafe(l), p.unit) : '—'}</td><td>${fmtNumber(o.rawMean, 3)}</td><td>${o.rawStdDev == null ? '—' : fmtNumber(o.rawStdDev, 3)}</td><td>${o.sampleCount == null ? '—' : o.sampleCount.toLocaleString()}</td><td>${wizValidityBadge(o.validity)}</td><td><input type="checkbox" data-w="obsInclude" data-i="${i}" ${o.include ? 'checked' : ''} aria-label="Include in the fit"></td><td><button data-wa="delObs" data-i="${i}">✕</button></td></tr>`; }).join('');
  return `<div class="small">Put the load on the platform, wait until the reading has settled, then record. Observations store raw counts of the shown sensor (<strong>${esc(activeSensor.name)}</strong>). Place and remove a weight repeatedly for replicates: the scatter between placements is what the fit can resolve.</div>
  <div class="control-grid" style="margin-top:8px"><div class="field span2"><label>Load on the platform</label><select data-w="selLoad">${opts}</select></div>
  <div class="field"><label>Recording length (s) → <span id="wizSamplesNote">${Math.round(w.captureSeconds * RATE_HZ).toLocaleString()} samples at ${RATE_HZ} Hz</span></label><input type="number" min="0.1" step="any" data-w="capSeconds" value="${w.captureSeconds}"></div>
  <div class="field"><label class="check" style="margin-top:18px"><input type="checkbox" data-w="replaced" ${w.replaced ? 'checked' : ''}> removed and replaced since the last placement</label></div></div>
  <div class="button-row"><button class="primary" data-wa="record" ${why || busy ? 'disabled' : ''}>● Record from the shown sensor</button><button data-wa="useSel" ${why && !/measurement is running/.test(why) ? 'disabled' : ''}>Use the selected interval</button>${busy ? '<button data-wa="cancelRec">Cancel recording</button>' : ''}</div>
  <progress id="wizRecBar" max="1" value="0" ${busy ? '' : 'hidden'}></progress><div class="small" id="wizRecProgress">${why ? esc(why) : ''}</div>
  <div class="control-grid" style="margin-top:8px"><div class="field"><label>Manual: mean counts</label><input type="number" step="any" id="wizManualRaw"></div><div class="field"><label>SD (optional)</label><input type="number" step="any" id="wizManualSd"></div><div class="field"><label>Samples (optional)</label><input type="number" step="1" id="wizManualN"></div><div class="field"><label>&nbsp;</label><button data-wa="addManual">＋ Add manual observation</button></div></div>
  <div class="tablewrap"><table class="wiz-table"><thead><tr><th>ID</th><th>Load</th><th>Mass</th><th>Mean (counts)</th><th>SD</th><th>n</th><th>Validity</th><th title="Include in the fit">Use</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="9" class="small">No observations yet.</td></tr>'}</tbody></table></div>`;
}
function wizNiceTicks(min, max, n = 5) {
  const span = max - min || 1, raw = span / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p, step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p, t = [];
  for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + 1e-9 * step; v += step) t.push(Math.abs(v) < 1e-12 * step ? 0 : v);
  return t;
}
// o: {w,h,xMin,xMax,yMin,yMax,xFmt,yFmt,curve:[[x,y]],points:[{x,y,on}],zero,xTitle,yTitle}
function wizPlotSVG(o) {
  const W = o.w, H = o.h, L = 66, R = 10, T = 8, B = 36, pw = W - L - R, ph = H - T - B;
  const sx = x => L + (x - o.xMin) / ((o.xMax - o.xMin) || 1) * pw, sy = y => T + ph - (y - o.yMin) / ((o.yMax - o.yMin) || 1) * ph;
  let s = `<svg viewBox="0 0 ${W} ${H}" class="wizplot" role="img" aria-label="${esc(o.yTitle)} versus ${esc(o.xTitle)}"><rect x="${L}" y="${T}" width="${pw}" height="${ph}" fill="none" stroke="var(--line)"/>`;
  for (const t of wizNiceTicks(o.xMin, o.xMax)) s += `<line x1="${sx(t)}" x2="${sx(t)}" y1="${T}" y2="${T + ph}" stroke="var(--line)" stroke-opacity=".5"/><text x="${sx(t)}" y="${T + ph + 14}" text-anchor="middle" font-size="10" fill="var(--muted)">${esc(o.xFmt(t))}</text>`;
  for (const t of wizNiceTicks(o.yMin, o.yMax, 4)) s += `<line y1="${sy(t)}" y2="${sy(t)}" x1="${L}" x2="${L + pw}" stroke="var(--line)" stroke-opacity=".5"/><text x="${L - 5}" y="${sy(t) + 3}" text-anchor="end" font-size="10" fill="var(--muted)">${esc(o.yFmt(t))}</text>`;
  if (o.zero && o.yMin < 0 && o.yMax > 0) s += `<line x1="${L}" x2="${L + pw}" y1="${sy(0)}" y2="${sy(0)}" stroke="var(--zero)" stroke-width="1.5"/>`;
  if (o.curve && o.curve.length) s += `<polyline fill="none" stroke="var(--ma)" stroke-width="2" points="${o.curve.map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(' ')}"/>`;
  for (const p of o.points) s += p.on ? `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="4" fill="var(--raw)"/>` : `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="4" fill="none" stroke="var(--danger)" stroke-width="1.5"/>`;
  return s + `<text x="${L + pw / 2}" y="${H - 4}" text-anchor="middle" font-size="10" fill="var(--muted)">${esc(o.xTitle)}</text><text x="12" y="${T + ph / 2}" font-size="10" fill="var(--muted)" transform="rotate(-90 12 ${T + ph / 2})" text-anchor="middle">${esc(o.yTitle)}</text></svg>`;
}
function wizFits() {
  const pts = wizPoints(wiz), fits = {};
  for (const m of Object.keys(FIT_MODELS)) fits[m] = fitCalibration(pts.points, m);
  return { pts, fits };
}
function wizPaneFit() {
  const p = wiz.profile, u = p.unit, { pts, fits } = wizFits(), fit = fits[wiz.fitModel], uf = mg => mgToUnit(mg, u);
  const sel = Object.entries(FIT_MODELS).map(([id, m]) => `<option value="${id}"${id === wiz.fitModel ? ' selected' : ''}>${esc(m.label)}</option>`).join('');
  const cmp = Object.entries(FIT_MODELS).map(([id, m]) => { const f = fits[id]; return `<tr class="${id === wiz.fitModel ? 'sel' : ''}"><td>${esc(m.label)}</td>${f.ok ? `<td>${f.params}</td><td>${f.dof}</td><td>${Number.isFinite(f.sdRawRes) ? fmtNumber(f.sdRawRes, 3) : '—'}</td><td>${wizMassText(f.rmsMassMg, u)}</td><td>${wizMassText(f.maxAbsMassMg, u)}</td>` : `<td colspan="5" class="warning">${esc(f.errors[0] || 'not possible')}</td>`}</tr>`; }).join('');
  let plots = '';
  const all = wiz.observations.map(o => { const l = wiz.loads.find(x => x.loadId === o.loadId); return l ? { o, m: wizLoadMassSafe(l) } : null; }).filter(x => x && Number.isFinite(x.m));
  if (all.length >= 2 && fit.g) {
    const xs = all.map(a => uf(a.m)), lo = Math.min(...xs), hi = Math.max(...xs), cur = [];
    for (let k = 0; k <= 60; k++) { const m = fit.mRange[0] + (fit.mRange[1] - fit.mRange[0]) * k / 60; cur.push([uf(m), fit.g(m)]); }
    const ys = all.map(a => a.o.rawMean).concat(cur.map(c => c[1])), yl = Math.min(...ys), yh = Math.max(...ys), py = (yh - yl) * 0.08 || 1, px = (hi - lo) * 0.04 || 1;
    plots += wizPlotSVG({ w: 560, h: 250, xMin: lo - px, xMax: hi + px, yMin: yl - py, yMax: yh + py, xFmt: v => fmtNumber(v, 1), yFmt: v => fmtNumber(v, 0), curve: cur, points: all.map(a => ({ x: uf(a.m), y: a.o.rawMean, on: a.o.include })), xTitle: `reference mass (${unitById(u).symbol})`, yTitle: 'mean raw counts' });
    const rp = all.map(a => { const g = fit.g(a.m), d = fit.dg ? fit.dg(a.m) : null; return { x: uf(a.m), y: d ? uf((a.o.rawMean - g) / d) : NaN, on: a.o.include }; }).filter(q => Number.isFinite(q.y));
    if (rp.length && fit.dg) { const r = Math.max(...rp.map(q => Math.abs(q.y)), 1e-9) * 1.15; plots += wizPlotSVG({ w: 560, h: 170, xMin: lo - px, xMax: hi + px, yMin: -r, yMax: r, xFmt: v => fmtNumber(v, 1), yFmt: v => fmtNumber(v, 3), curve: [], points: rp, zero: true, xTitle: `reference mass (${unitById(u).symbol})`, yTitle: `residual (${unitById(u).symbol})` }); }
  }
  const rrows = fit.ok ? fit.residuals.map(r => { const o = wiz.observations.find(x => x.observationId === r.id); return `<tr><td>${esc(r.id)}</td><td>${wizMassText(r.massMg, u)}</td><td>${fmtNumber(r.raw, 3)}</td><td>${fmtNumber(r.fitRaw, 3)}</td><td>${fmtNumber(r.resRaw, 3)}</td><td>${Number.isFinite(r.resMassMg) ? fmtNumber(uf(r.resMassMg), 4) : '—'}</td></tr>`; }).join('') : '';
  const groups = fit.groups.map(g => `<tr><td>${wizMassText(g.massMg, u)}</td><td>${g.raws.length}</td><td>${fmtNumber(g.rawMean, 3)}</td><td>${Number.isFinite(g.rawSD) ? fmtNumber(g.rawSD, 3) : '—'}</td></tr>`).join('');
  return `${pts.errors.length ? `<div class="warning small">${pts.errors.map(esc).join('<br>')}</div>` : ''}
  <div class="field"><label>Model</label><select data-w="fitModel">${sel}</select></div>
  <div class="small" style="margin:6px 0">The curve is fitted as counts on mass (the noise is in the counts) and then written to the file as anchors sampled on the fitted curve. Switch observations on or off in step 2 (or here, via the checkboxes of step 2); excluded ones stay in the file, marked.</div>
  ${fit.ok ? `<div class="readout">Observations used: <strong>${fit.n}</strong> · different masses: <strong>${fit.distinct}</strong> · parameters: <strong>${fit.params}</strong> · degrees of freedom: <strong>${fit.dof}</strong><br>Residual SD: <strong>${Number.isFinite(fit.sdRawRes) ? fmtNumber(fit.sdRawRes, 3) + ' counts' : 'not defined (no degrees of freedom)'}</strong> · RMS residual: <strong>${wizMassText(fit.rmsMassMg, u)}</strong> · largest: <strong>${wizMassText(fit.maxAbsMassMg, u)}</strong>${fit.nodes ? `<br>Written as <strong>${fit.nodes - 1}</strong> linear segments; largest deviation from the exact inverse: <strong>${wizMassText(fit.maxInterpErrMg, u)}</strong>` : ''}</div>` : `<div class="warning">${fit.errors.map(esc).join('<br>')}</div>`}
  <div class="plots">${plots}</div>
  <h3 style="margin:12px 0 4px">Model comparison (same observations)</h3><div class="tablewrap"><table class="wiz-table"><thead><tr><th>Model</th><th>p</th><th>dof</th><th>SD (counts)</th><th>RMS</th><th>largest</th></tr></thead><tbody>${cmp}</tbody></table></div>
  <div class="small">A lower residual SD with fewer degrees of freedom is not better evidence: a model with dof = 0 passes through every point and says nothing about scatter. Prefer the simplest model whose residuals show no pattern.</div>
  ${groups ? `<h3 style="margin:12px 0 4px">Replicates per reference mass</h3><div class="tablewrap"><table class="wiz-table"><thead><tr><th>Mass</th><th>Placements</th><th>Mean (counts)</th><th>SD between placements</th></tr></thead><tbody>${groups}</tbody></table></div>` : ''}
  ${rrows ? `<h3 style="margin:12px 0 4px">Residuals (observed scatter, not uncertainty)</h3><div class="tablewrap"><table class="wiz-table"><thead><tr><th>Observation</th><th>Mass</th><th>Counts</th><th>Fit</th><th>Residual (counts)</th><th>Residual (${esc(unitById(u).symbol)})</th></tr></thead><tbody>${rrows}</tbody></table></div>` : ''}`;
}
function wizBuild() {
  const { pts, fits } = wizFits(), fit = fits[wiz.fitModel], errors = [...pts.errors], warnings = [];
  if (!wiz.profile.profileName.trim()) errors.push('The profile needs a name.');
  if (!fit.ok) errors.push(...fit.errors);
  let cfg = null, checked = null;
  if (!errors.length) {
    cfg = buildCalibrationConfig(Object.assign({}, wiz, { sensorId: wiz.sensorId, rateHz: wiz.rateHz }), fit, new Date().toISOString());
    checked = validateCalibrationConfig(cfg); errors.push(...checked.errors); warnings.push(...checked.warnings);
    if (fit.dof <= 0) warnings.push('No degrees of freedom: the model passes through every observation, so its residuals say nothing about the scatter. Record replicates.');
    if (fit.distinct < 3) warnings.push('Only two different reference masses: linearity cannot be checked.');
    const odd = wiz.observations.filter(o => o.include && o.validity && (o.validity.status === 'invalid' || o.validity.status === 'suspect')).length;
    if (odd) warnings.push(`${odd} included observation(s) have a validity flag (suspect or invalid).`);
    if (!wiz.observations.some(o => o.removedAndReplaced && o.placementIndex > 1)) warnings.push('No placement is marked as removed and replaced: placement repeatability was not sampled.');
  }
  return { cfg, fit, errors, warnings };
}
function wizPaneReview() {
  const b = wizBuild(), u = wiz.profile.unit;
  const anchors = b.fit.ok ? b.fit.anchors.slice(0, 40).map(a => `<tr><td>${wizMassText(a.massMg, u)}</td><td>${fmtNumber(a.raw, 3)}</td></tr>`).join('') + (b.fit.anchors.length > 40 ? `<tr><td colspan="2" class="small">… ${b.fit.anchors.length - 40} more</td></tr>` : '') : '';
  const block = wiz.sensorId !== activeSensor.id ? 'The wizard belongs to another sensor than the one shown.' : '';
  return `<div class="readout"><strong>${esc(wiz.profile.profileName)}</strong> · ${esc(FIT_MODELS[wiz.fitModel].label)} · unit ${esc(unitById(u).symbol)} · ${b.fit.anchors.length} anchors for sensor <strong>${esc(wiz.sensorId)}</strong></div>
  ${b.errors.map(e => `<div class="warning small">✖ ${esc(e)}</div>`).join('')}${b.warnings.map(e => `<div class="small">⚠ ${esc(e)}</div>`).join('')}
  <div class="small" style="margin:6px 0">Activating starts a new calibration epoch on the shown sensor: the tare is reset, a running measurement is aborted, and earlier samples keep the calibration they were recorded with. The file claims no uncertainty (validation status “not-characterized”); only its structure and monotonicity are checked.</div>
  <div class="button-row"><button class="primary" data-wa="activate" ${b.errors.length || block ? 'disabled' : ''}>Activate on the shown sensor</button><button data-wa="exportCal" ${b.cfg ? '' : 'disabled'}>Export calibration JSON</button></div>
  ${block ? `<div class="warning small">${esc(block)}</div>` : ''}
  ${anchors ? `<h3 style="margin:12px 0 4px">Anchors that will be written</h3><div class="tablewrap"><table class="wiz-table"><thead><tr><th>Mass</th><th>Counts</th></tr></thead><tbody>${anchors}</tbody></table></div>` : ''}`;
}
function wizRender() {
  const body = wq('wizBody'); if (!body || !wiz.profile) return;
  const keep = body.scrollTop;
  const tabs = `<div class="tabs" role="tablist">${WIZ_TABS.map(([id, t]) => `<button role="tab" data-wa="tab" data-id="${id}" aria-selected="${wiz.tab === id}">${t}</button>`).join('')}</div>`;
  const banner = (wiz.sensorId !== activeSensor.id ? `<div class="warning small">This wizard was started for sensor “${esc(wiz.sensorId)}”, but “${esc(activeSensor.id)}” is shown. <button data-wa="useShown">Use the shown sensor</button></div>` : '') + (wiz.message ? `<div class="status-note" style="margin:6px 0">${esc(wiz.message)}</div>` : '');
  const pane = wiz.tab === 'weights' ? wizPaneWeights() : wiz.tab === 'observations' ? wizPaneObs() : wiz.tab === 'fit' ? wizPaneFit() : wizPaneReview();
  body.innerHTML = tabs + banner + `<div class="wiz-pane">${pane}</div>`; body.scrollTop = keep;
}
function wizTick() {   // called every rendered frame while the wizard is open: only the progress readouts change
  const m = state.measurement, on = !!(wiz.capture && m && m.tag === 'calibration wizard');
  const bar = wq('wizRecBar'), txt = wq('wizRecProgress'), badge = wq('wizRecBadge');
  if (bar && on) { bar.hidden = false; bar.value = m.collected / m.target; }
  if (txt && on) txt.textContent = `Recording ${m.collected.toLocaleString()} / ${m.target.toLocaleString()} samples`;
  if (badge) badge.textContent = on ? `● ${Math.round(100 * m.collected / m.target)} %` : '';
}
function wizOpen(fresh) {
  if (!wiz.profile || fresh) { wizNew(); wiz.sensorId = activeSensor.id; wiz.rateHz = RATE_HZ; }
  wiz.open = true; $('wizModal').hidden = false; $('wizModal').classList.toggle('min', wiz.minimised = false); openSettings(false); wizRender();
}
function wizClose() { wiz.open = false; $('wizModal').hidden = true; }
function wizFromActive() {
  wizLoadFromConfig(JSON.parse(JSON.stringify(CALIBRATION))); wiz.sensorId = activeSensor.id; wiz.rateHz = RATE_HZ;
  wiz.message = 'Loaded the observations of the active calibration. A calibration file without observations cannot be refitted.'; wizRender();
}
function wizOnChange(e) {
  const t = e.target, a = t.dataset && t.dataset.w; if (!a) return;
  const i = Number(t.dataset.i), f = t.dataset.f, v = t.type === 'checkbox' ? t.checked : t.value;
  let render = false;
  if (a === 'profile') { wiz.profile[f] = v; render = f === 'unit'; }
  else if (a === 'weight') {
    const w = wiz.weights[i]; if (!w) return;
    if (f === 'name') { w.name = v; wizSyncLoads(); }
    else if (f === 'unit') { w.unit = v; render = true; }
    else { w[f] = v === '' ? (f === 'assignedMass' ? null : 0) : Number(v); render = true; }
  }
  else if (a === 'newqty') { const w = wiz.weights[i]; if (w) wiz.newQty[w.weightId] = Math.max(0, Math.floor(Number(v) || 0)); }
  else if (a === 'capSeconds') { wiz.captureSeconds = clamp(Number(v) || 10, 0.1, 1200); const n = wq('wizSamplesNote'); if (n) n.textContent = `${Math.round(wiz.captureSeconds * RATE_HZ).toLocaleString()} samples at ${RATE_HZ} Hz`; }
  else if (a === 'selLoad') wiz.selLoad = v;
  else if (a === 'replaced') wiz.replaced = v;
  else if (a === 'obsInclude') { const o = wiz.observations[i]; if (o) { o.include = v; if (v) delete o.exclusionReason; else o.exclusionReason = 'excluded in the fitting editor'; } render = true; }
  else if (a === 'fitModel') { wiz.fitModel = v; render = true; }
  if (render) wizRender();
}
function wizOnClick(e) {
  const b = e.target.closest && e.target.closest('[data-wa]'); if (!b) return;
  const a = b.dataset.wa, i = Number(b.dataset.i);
  switch (a) {
    case 'tab': wiz.tab = b.dataset.id; wiz.message = ''; break;
    case 'restart': wizNew(); wiz.sensorId = activeSensor.id; wiz.rateHz = RATE_HZ; break;
    case 'fromActive': return wizFromActive();
    case 'useShown': wiz.sensorId = activeSensor.id; wiz.rateHz = RATE_HZ; break;
    case 'addWeight': { const id = wizId('ref-', wiz.weights, 'weightId'); wiz.weights.push({ weightId: id, name: `Weight ${wiz.weights.length}`, nominalMass: 100, assignedMass: null, unit: wiz.profile.unit, referenceUncertainty: null }); wizSyncLoads(); break; }
    case 'delWeight': { const w = wiz.weights[i]; if (!w) return; const n = wizWeightUse(w.weightId); if (n) { wiz.message = `“${w.name}” is used by ${n} observation(s); delete those first.`; break; } wiz.weights.splice(i, 1); wizSyncLoads(); break; }
    case 'addLoad': {
      const comps = wiz.weights.filter(w => (wiz.newQty[w.weightId] || 0) > 0).map(w => ({ weightId: w.weightId, quantity: wiz.newQty[w.weightId] }));
      if (comps.length < 1 || (comps.length === 1 && comps[0].quantity === 1)) { wiz.message = 'Set Qty > 0 for at least two weights (or Qty ≥ 2 for one) to describe a combination.'; break; }
      wiz.loads.push({ loadId: wizId('load-combo-', wiz.loads, 'loadId'), name: comps.map(c => `${c.quantity > 1 ? c.quantity + '×' : ''}${(wiz.weights.find(w => w.weightId === c.weightId) || {}).name}`).join(' + '), components: comps, auto: false, weightRef: null });
      wiz.newQty = {}; break; }
    case 'delLoad': { const id = b.dataset.id; if (wiz.observations.some(o => o.loadId === id)) { wiz.message = 'This load is used by observations; delete those first.'; break; } wiz.loads = wiz.loads.filter(l => l.loadId !== id); wizSyncLoads(); break; }
    case 'record': return wizRecord();
    case 'cancelRec': cancelMeasurement('cancelled by user'); return;
    case 'useSel': return wizUseSelection();
    case 'addManual': return wizAddManual();
    case 'delObs': wiz.observations.splice(i, 1); break;
    case 'exportCal': { const r = wizBuild(); if (r.cfg) downloadBlob(new Blob([JSON.stringify(r.cfg, null, 2)], { type: 'application/json' }), `calibration-${String(r.cfg.profileId).replace(/[^\w.-]+/g, '_')}.json`); return; }
    case 'activate': return wizActivate();
  }
  wizRender();
}
async function wizActivate() {
  const r = wizBuild(); if (!r.cfg || r.errors.length) { wiz.message = 'Fix the listed errors first.'; wizRender(); return; }
  if (wiz.sensorId !== activeSensor.id) { wiz.message = 'The shown sensor is not the wizard’s sensor.'; wizRender(); return; }
  const res = await activateCalibration(r.cfg, 'calibration wizard');
  wiz.message = res.errors.length ? `Not activated: ${res.errors.join(' ')}` : (res.unchanged ? 'This calibration is already active; nothing changed.' : 'Calibration activated on the shown sensor (new epoch, tare reset). Check it with a known weight; it is not a metrological validation.');
  wizRender();
}
function initWizard() {
  $('calWizardBtn').addEventListener('click', () => wizOpen(false));
  $('wizClose').addEventListener('click', wizClose);
  $('wizMin').addEventListener('click', () => { wiz.minimised = !wiz.minimised; $('wizModal').classList.toggle('min', wiz.minimised); $('wizMin').textContent = wiz.minimised ? 'Expand' : 'Minimise'; });
  $('wizModal').addEventListener('click', wizOnClick); $('wizModal').addEventListener('change', wizOnChange);
}

// uPlot is pinned to one exact version (reproducible builds; no surprise breaking changes). To
// upgrade, change only this constant. 1.6.32 is the newest release verified at build time.
const UPLOT_VERSION='1.6.32';
function loadUPlotAsync(){return new Promise((resolve,reject)=>{
  if(window.uPlot){resolve();return;}
  const base=`https://cdn.jsdelivr.net/npm/uplot@${UPLOT_VERSION}/dist/`;
  const css=document.createElement('link');css.rel='stylesheet';css.href=base+'uPlot.min.css';document.head.appendChild(css);
  const script=document.createElement('script');script.src=base+'uPlot.iife.min.js';script.async=true;
  script.onload=()=>resolve();script.onerror=()=>reject(new Error('Unable to load uPlot from jsDelivr.'));document.head.appendChild(script);
});}
async function boot(){
  populateSettings();initEvents();setNavPanelVisible(false);syncUIFromState();initSettingsMenu();initWizard();initUiSettings();$('sensorReloadBtn').disabled=!SENSOR_LIST_URL;setSensorListInfo(SENSOR_LIST_URL?'Sensor list not loaded yet.':'No sensor server configured (SENSOR_LIST_URL is empty). Only the test signal is available.');
  // The revision id is computed BEFORE acquisition starts, so no sample or tare event can be stamped
  // with the placeholder revision id.
  embeddedFp=await fingerprintConfig(EMBEDDED_CALIBRATION);
  initSensorCalibration(testSensor.state,embeddedFp);
  updateCalibrationInfo();updateEstimatorFields();syncMeasurementInputs('samples');updateMeasurementUI();updateStatusUI();
  tickTimer=setInterval(tick,PERIOD_MS);
  if(SENSOR_LIST_URL)loadSensorList();
  // Display the shell and start acquisition before the chart library download completes.
  requestAnimationFrame(()=>requestAnimationFrame(()=>loadUPlotAsync().then(()=>{chartsPending=false;createCharts();updateStatusUI();scheduleRender();}).catch(error=>{$('statusText').textContent='Chart library unavailable';$('mainChart').innerHTML='<p class="warning">uPlot could not be loaded. Check the internet connection and reload the file.</p>';console.error(error);})));
}
boot();
