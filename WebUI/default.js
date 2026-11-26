"use strict";

// v11: RATE_HZ / PERIOD_MS mirror the nominal sampling rate of the sensor that is SHOWN (they are
// re-assigned by activateSensor()); every sensor keeps its own rate in state.rateHz.
const RATE_HZ_DEFAULT = 80;
let RATE_HZ = RATE_HZ_DEFAULT;
let PERIOD_MS = 1000 / RATE_HZ;
// ---- device connection (OpenScale API protocol v0.5, same origin as this page) ----
const STREAM_URL='/stream',STATUS_URL='/api/status',DEVICE_URL='/api/device',DEVICE_LOG_URL='/api/device-log',FILES_URL='/api/files',RESTART_URL='/api/restart',HISTORY_URL='/api/history';
const SENSORS_URL='/data/settings/sensors.json',UNITS_URL='/data/settings/units.json',WEBUI_SETTINGS_URL='/data/settings/webui-settings.json',CALIBRATION_DIR='/data/calibration';
const PROTOCOL_VERSION=1;
const FLAG_OVERLOAD=1,FLAG_UNDERLOAD=2,FLAG_DISCONNECT=4,FLAG_ERROR=8,FLAG_INVALID=16,FLAG_ANY_BAD=FLAG_DISCONNECT|FLAG_ERROR|FLAG_INVALID;   // per-sample flags (bit numbers as in the protocol)
const TEST_SENSOR_ID = 'test';
// Server sensors start without a calibration of their own. Until one is imported they are shown as RAW
// counts rather than as masses computed with the illustrative demo calibration (conservative choice).
const SERVER_SENSOR_DEFAULT_UNIT = 'raw';
const $ = id => document.getElementById(id);
let UNIT_CONFIG = JSON.parse($('unitConfig').textContent);
const UNIT_EMBEDDED = UNIT_CONFIG;   // fallback when the device has no (valid) units.json
const EMBEDDED_CALIBRATION = JSON.parse($('calibrationConfig').textContent);
// ===== v17: WIRE LAYER (protocol v0.5): lossless JSON, raw decoding, flags =====================================
// 64-bit values (n, t, raw, logEntryId, ...) are integer tokens on the wire. JSON.parse would round everything above 2^53-1, so text that
// contains a run of 16 or more digits goes through parseWire(): integer tokens beyond the safe range become BigInt, everything else is parsed normally.
function parseWire(text) {
  if (!/\d{16,}/.test(text)) return JSON.parse(text);
  let i = 0; const n = text.length, numRe = /-?\d+(\.\d+)?([eE][+-]?\d+)?/y;
  const ws = () => { while (i < n) { const c = text.charCodeAt(i); if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break; } };
  const str = () => { const s = i; i++; while (i < n) { const ch = text[i]; if (ch === '\\') i += 2; else if (ch === '"') { i++; return JSON.parse(text.slice(s, i)); } else i++; } throw new SyntaxError('unterminated string'); };
  const num = () => {
    numRe.lastIndex = i; const r = numRe.exec(text); if (!r) throw new SyntaxError('unexpected character at ' + i);
    i = numRe.lastIndex; const tok = r[0];
    if (r[1] === undefined && r[2] === undefined) { const v = Number(tok); return Number.isSafeInteger(v) ? v : BigInt(tok); }
    return Number(tok);
  };
  const val = () => {
    ws(); const c = text[i];
    if (c === '{') { i++; const o = {}; ws(); if (text[i] === '}') { i++; return o; } for (;;) { ws(); const k = str(); ws(); if (text[i++] !== ':') throw new SyntaxError('expected :'); o[k] = val(); ws(); const d = text[i++]; if (d === '}') return o; if (d !== ',') throw new SyntaxError('expected ,'); } }
    if (c === '[') { i++; const a = []; ws(); if (text[i] === ']') { i++; return a; } for (;;) { a.push(val()); ws(); const d = text[i++]; if (d === ']') return a; if (d !== ',') throw new SyntaxError('expected ,'); } }
    if (c === '"') return str();
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('null', i)) { i += 4; return null; }
    return num();
  };
  const v = val(); ws(); if (i < n) throw new SyntaxError('trailing characters'); return v;
}
const toNum = v => (typeof v === 'bigint' ? Number(v) : v);
// raw is a uint64 bit pattern; rawFormat says how to read it. Returns the native value as a JS number (int64 / uint64 above 2^53 lose low bits: documented limit).
const RAW_FORMATS = new Set(['uint32', 'uint64', 'int24', 'int32', 'int64', 'float32', 'float64']);
const _rawDv = new DataView(new ArrayBuffer(8));
function decodeRaw(v, fmt) {
  if (!RAW_FORMATS.has(fmt)) return NaN;
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0) return NaN;
    if (v <= 0xFFFFFFFF) {   // fast path: the value fits in 32 bits
      switch (fmt) { case 'uint32': case 'uint64': return v; case 'int24': return (v << 8) >> 8; case 'int32': return v | 0; case 'int64': return v; case 'float32': _rawDv.setUint32(0, v); return _rawDv.getFloat32(0); case 'float64': _rawDv.setBigUint64(0, BigInt(v)); return _rawDv.getFloat64(0); }
    }
    if (!Number.isSafeInteger(v)) return NaN;
    v = BigInt(v);
  }
  if (typeof v !== 'bigint' || v < 0n || v > 0xFFFFFFFFFFFFFFFFn) return NaN;
  switch (fmt) {
    case 'uint32': return Number(v & 0xFFFFFFFFn); case 'uint64': return Number(v);
    case 'int24': return Number(BigInt.asIntN(24, v)); case 'int32': return Number(BigInt.asIntN(32, v)); case 'int64': return Number(BigInt.asIntN(64, v));
    case 'float32': _rawDv.setUint32(0, Number(v & 0xFFFFFFFFn)); return _rawDv.getFloat32(0);
    case 'float64': _rawDv.setBigUint64(0, v); return _rawDv.getFloat64(0);
  }
  return NaN;
}
function numericSensorId(id) { return /^\d+$/.test(String(id)) ? Number(id) : null; }
function fmtBytes(n) { return !Number.isFinite(n) ? '—' : n >= 1048576 ? `${(n / 1048576).toFixed(2)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`; }
async function gzipText(text) {
  if (typeof CompressionStream === 'undefined') throw new Error('This browser cannot compress (CompressionStream is missing).');
  const cs = new CompressionStream('gzip'), w = cs.writable.getWriter(); w.write(new TextEncoder().encode(text)); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
function cloneJson(v) { return JSON.parse(JSON.stringify(v)); }

let CALIBRATION = EMBEDDED_CALIBRATION;   // the ACTIVE calibration (switchable since v8)
const MAX_ROBUST_WINDOW = 4096;
const OVL_DEFAULTS = Object.freeze({maxMg: null, minMg: null, averageS: 0.1, yellowPct: 10, orangePct: 20, redPct: 40, breakS: 0.5, holdS: 8});
function newOverloadState() { return {cfg: {...OVL_DEFAULTS}, q: [], active: null, events: [], current: null, lastEndWall: null, lastEnd: null}; }
let subPixel = false;   // v15 (testing): true = uPlot pxAlign 0, sub-pixel rendering
let bandMode = 'symmetric';   // v14 display option: see BAND_MODES

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
  times: new Float64Array(N0), raw: new Float64Array(N0), massMg: new Float64Array(D0), ids: new Float64Array(N0).fill(NaN),   // v14: ids = device sample counter (NaN if unknown)
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
  simMode: 'wander', simOffset: 0, simN: 0,
  auxHidden: new Set(), auxSig: '', auxHasData: false, auxColsAny: [], auxSeriesShown: [], charRec: null   // v16
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
const auxChannels = new Map(), deviceOrigins = new Map();   // v16: auxiliary channels; shared time origin per device
let activeSensor = null;
let state = null;
function makeSensor(def) {
  const kind = def.kind || 'server';
  const rateHz = Number.isFinite(def.rateHz) && def.rateHz > 0 ? def.rateHz : RATE_HZ_DEFAULT;
  const sensor = {hasOwnCal: kind === 'test', id: String(def.id), name: String(def.name || def.id), kind, sseUrl: def.sseUrl || null, rawFormat: null, def: null, sensorType: null, disabled: false, epochNo: 1, err: null, fw: {overload: null, underload: null}, configRev: null, warnRev: null, status: null, details: {}, settings: {notes: ''}, unlisted: false,
    ovl: newOverloadState(), firstLiveId: null, skipNextGap: false, gaps: [], gapCount: 0, history: {status: 'idle', loaded: 0, running: false, error: null, minId: null, autoStarted: false},
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
function getId(i) { return state.ids[physicalIndex(i)]; }
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
function appendSample(rawValue, timeMs, sampleId) {
  if (state.unlimited && state.count === state.capacity) resizeBuffers(state.capacity + 100000);
  const sampleTime = timeMs == null ? state.nextTime : timeMs;
  if (state.measurement && timeStepIsGap(sampleTime, sampleId)) cancelMeasurement('sampling gap');
  if (state.charRec && timeStepIsGap(sampleTime, sampleId)) cancelCharRec('sampling gap');

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
  state.ids[writeIndex] = Number.isFinite(sampleId) ? sampleId : NaN;
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
  if (state.charRec) charRecSample(sampleTime, rawValue, sampleId);
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
  const times = new Float64Array(capacity), raw = new Float64Array(capacity), mass = new Float64Array(dn), ids = new Float64Array(capacity).fill(NaN);
  const rawMA = new Float64Array(dn), rawSD = new Float64Array(dn), massMA = new Float64Array(dn), massSD = new Float64Array(dn);
  for (let i = 0; i < keep; i++) {
    const oldIndex = start + i;
    times[i] = getTime(oldIndex); raw[i] = getRaw(oldIndex); ids[i] = getId(oldIndex);
    if (D) {
      mass[i] = getMassMg(oldIndex);
      rawMA[i] = getRawMA(oldIndex); rawSD[i] = getRawSD(oldIndex);
      massMA[i] = getMassMA(oldIndex); massSD[i] = getMassSD(oldIndex);
    }
  }
  state.capacity = capacity; state.times = times; state.raw = raw; state.massMg = mass; state.ids = ids;
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
  if (hi < lo) return emptyMainData();
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
    const value = chartValueAt(i, diagnostic), ma = curve.center(i), up = curve.upper(i), lw = curve.lower(i);
    buf.x[out] = getTime(i) / 1000;
    buf.value[out] = diagnostic ? value : mgToUnit(value, state.unitId);
    buf.ma[out] = diagnostic ? ma : mgToUnit(ma, state.unitId);
    buf.upper[out] = diagnostic ? up : mgToUnit(up, state.unitId);
    buf.lower[out] = diagnostic ? lw : mgToUnit(lw, state.unitId);
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
  const xs=buf.x.subarray(0,out),cols=auxShownChannels().map(ch=>auxColumn(ch,xs,out));state.auxColsAny=cols.map(c=>c.any);state.auxHasData=cols.some(c=>c.any);
  return [xs,buf.value.subarray(0,out),buf.ma.subarray(0,out),buf.upper.subarray(0,out),buf.lower.subarray(0,out),...cols.map(c=>c.col)];
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
    // v13 fix: a cached bucket is only valid while ALL of its samples are still retained. Once the ring buffer is
    // full, the oldest bucket loses samples one by one; its cached min/max indices would then point at evicted slots.
    if (b && (id * B < base || (id + 1) * B > base + n)) b = null;
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
  drawOverloads(u);
}
function drawOverloads(u){
  drawOverloadsBase(u);
  const ctx=u.ctx,dpr=window.devicePixelRatio||1;ctx.save();ctx.strokeStyle='rgba(229,56,74,.9)';ctx.lineWidth=2*dpr;
  for(const l of state.logs){if(l.type!=='fwwarning'||!Number.isFinite(l.effectiveFromTime))continue;const x=u.valToPos(l.effectiveFromTime/1000,'x',true);ctx.setLineDash(l.active?[]:[3*dpr,3*dpr]);ctx.beginPath();ctx.moveTo(x,u.bbox.top);ctx.lineTo(x,u.bbox.top+u.bbox.height);ctx.stroke();}
  ctx.restore();
}
function drawOverloadsBase(u){
  const ctx=u.ctx,dpr=window.devicePixelRatio||1,top=u.bbox.top,h=u.bbox.height,list=state.logs.filter(l=>l.type==='overload');
  const a=activeSensor&&activeSensor.ovl&&activeSensor.ovl.active;if(a)list.push({t0:a.t0,t1:a.lastOverT,peakLevel:a.peakLevel});
  ctx.save();
  for(const l of list){
    const x0=u.valToPos(l.t0/1000,'x',true),x1=u.valToPos(l.t1/1000,'x',true),col=OVL_COLORS[l.peakLevel]||OVL_COLORS.red,w=Math.max(3*dpr,Math.abs(x1-x0));
    ctx.globalAlpha=.16;ctx.fillStyle=col;ctx.fillRect(Math.min(x0,x1),top,w,h);ctx.globalAlpha=.95;ctx.fillRect(Math.min(x0,x1),top,w,8*dpr);
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
  if(e.type==='tare'||e.type==='calibration'||e.type==='fwwarning')return{t0:e.effectiveFromTime,t1:e.effectiveFromTime,marker:true};
  if(e.type==='selection'||e.type==='measurement'||e.type==='overload')return{t0:e.t0,t1:e.t1};
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
  if(e.type==='fwwarning')return fwWarningLineHTML(e);
  if(e.type==='overload')return overloadLineHTML(e);
  const val=raw?`${fmtNumber(e.rawEstimatorValue,0)} counts`:formatMass(e.originalValueMg),sig=raw?`${fmtNumber(e.rawSpread,2)} counts`:formatMass(e.spreadMg);
  return `<strong>${e.type==='measurement'?'Measurement':'Selection'} · ${e.totalSamples.toLocaleString()} samples</strong><br>${tt(e.t0)} – ${tt(e.t1)} (${((e.t1-e.t0)/1000).toFixed(2)} s)<br>Result ${val} · σ ${sig}${e.uncertainty&&e.uncertainty.status==='ok'&&!raw?'<br>'+uncertaintyLineText(e.uncertainty):''}<br>${esc(estimatorLabel(e.estimator))}`+analysisBadgeHTML(e.analysis,'<br>')+(e.crossesTare?'<br><span class="warning">spans a tare event</span>':'')+(e.crossesCalibration?'<br><span class="warning">spans a calibration change</span>':'');
}
function ovlMass(mg){return formatMass(mg,state.unitId==='raw'?'g':state.unitId);}
function overloadLineHTML(e){return `<strong>${e.side==='under'?'Underload':'Overload'} · ${esc(e.peakLevel)}</strong><br>Peak ${esc(ovlMass(e.peakMg))} (limit ${esc(ovlMass(e.limitMg))}, ${e.side==='under'?'−':'+'}${(e.peakExcess*100).toFixed(0)} %) · ${fmtSpan(e.durationMs/1000)}`;}
function hitTestEvents(u,x,y){
  const t=u.posToVal(x,'x')*1000,tol=6*Math.abs(u.posToVal(1,'x')-u.posToVal(0,'x'))*1000,lane=(u===state.miniPlot?10:14),hits=[],seen=new Set();
  const add=(prio,entry,range)=>{if(seen.has(entry))return;seen.add(entry);hits.push({prio,entry,range});};
  for(const e of state.tareEvents)if(Math.abs(e.effectiveFromTime-t)<=tol)add(0,e,logEntryRange({type:'tare',effectiveFromTime:e.effectiveFromTime}));
  for(const l of state.logs)if((l.type==='calibration'||l.type==='fwwarning')&&Math.abs(l.effectiveFromTime-t)<=tol)add(0,l,logEntryRange(l));
  if(y<=lane)for(const l of state.logs)if((l.type==='selection'||l.type==='measurement'||l.type==='overload')&&t>=l.t0-tol&&t<=l.t1+tol)add(1+(l.t1-l.t0)/1e12,l,logEntryRange(l));
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
// v13: the Y axis is as wide as its widest tick label (uPlot's documented auto-size recipe), so large numbers with a
// thousands separator are never cut off. cycleNum > 1 re-uses the size from the first pass (uPlot calls this twice).
function axisWidthFit(self,values,axisIdx,cycleNum){
  const axis=self.axes[axisIdx];if(cycleNum>1&&axis._size)return axis._size;
  let size=((axis.ticks&&axis.ticks.size)||10)+(axis.gap||5);
  const longest=(values||[]).reduce((a,b)=>b.length>a.length?b:a,'');
  if(longest&&axis.font&&axis.font[0]){self.ctx.font=axis.font[0];size+=self.ctx.measureText(longest).width/(window.devicePixelRatio||1);}
  return Math.ceil(Math.max(size,30));
}
function bandLabels(){const s=spreadShort(state.estimator),on=!isEmaMethod(state.estimator);if(bandMode==='asymmetric'&&on)return['Upper (mean of samples above)','Lower (mean of samples below)'];const t=bandMode==='stepaware'&&on?`${s}, step-aware`:s;return[`Upper +1σ (${t})`,`Lower −1σ (${t})`];}
function makeMainOptions() {
  const c=colors(),auxList=auxShownChannels();
  const auxSeries=auxList.map((ch,k)=>({label:`${ch.name} (${ch.unit||'—'})`,scale:'aux',stroke:AUX_COLORS[k%AUX_COLORS.length],width:1.5,dash:[5,3],points:{show:false},value:(u,v)=>v==null?'—':`${fmtNumber(v,2)} ${ch.unit}`}));
  const auxAxes=auxList.length?[{scale:'aux',side:1,stroke:AUX_COLORS[0],grid:{show:false},ticks:{stroke:c.line},size:(self,values,i,cyc)=>state.auxHasData?axisWidthFit(self,values,i,cyc):0,values:(u,vals)=>state.auxHasData?vals.map(v=>`${fmtNumber(v,1)} ${auxList[0].unit}`):vals.map(()=>'')}]:[];
  return {
    width:$('mainChart').clientWidth||800,height:mainChartHeight(),title:'',pxAlign:subPixel?0:1,legend:{show:true},
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
    }},...(auxList.length?{aux:{auto:true}}:{})},
    axes:[
      {stroke:c.muted,grid:{stroke:'rgba(130,150,180,.12)'},ticks:{stroke:c.line},values:(u,vals)=>vals.map(v=>`${v.toFixed(1)}s`)},
      {stroke:c.muted,size:axisWidthFit,grid:{stroke:'rgba(130,150,180,.12)',filter:(u,splits)=>splits.map(v=>(state.unitId!=='raw'&&!$('zeroLineToggle').checked&&Math.abs(v)<1e-12)?null:v)},ticks:{stroke:c.line},values:(u,vals)=>vals.map(v=>state.unitId==='raw'?fmtNumber(v,0):fmtNumber(v,displayDigits()))}
    ,...auxAxes],
    series:[
      {label:'Time',value:(u,v)=>v==null?'—':`${v.toFixed(2)} s`},
      {label:state.unitId==='raw'?'Raw sensor counts':'Measured mass',stroke:c.raw,width:1.25,points:{show:false},value:(u,v)=>v==null?'—':(state.unitId==='raw'?`${fmtNumber(v,0)} counts`:`${fmtNumber(v,displayDigits())} ${displayUnitSymbol()}`)},
      {label:centerLabel(),stroke:c.ma,width:2.1,points:{show:false},value:(u,v)=>v==null?'—':(state.unitId==='raw'?`${fmtNumber(v,0)} counts`:`${fmtNumber(v,displayDigits())} ${displayUnitSymbol()}`)},
      {label:bandLabels()[0],stroke:'rgba(0,0,0,0)',width:0,points:{show:false},value:(u,v)=>v==null?'—':fmtNumber(v,displayDigits())},
      {label:bandLabels()[1],stroke:'rgba(0,0,0,0)',width:0,points:{show:false},value:(u,v)=>v==null?'—':fmtNumber(v,displayDigits())}
    ,...auxSeries],
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
    width:$('miniChart').clientWidth||800,height:125,pxAlign:subPixel?0:1,legend:{show:true},
    cursor:{show:true,x:true,y:false,drag:{x:false,y:false}},
    select:{show:true,left:0,top:0,width:0,height:0},
    scales:{x:{time:false,auto:false},y:{auto:true}},
    axes:[
      {show:true,stroke:c.muted,size:30,grid:{show:true,stroke:'rgba(130,150,180,.15)',width:1},ticks:{show:true,stroke:c.line},values:(u,vals)=>vals.map(v=>`${v.toFixed(0)}s`)},
      {show:true,stroke:c.muted,size:axisWidthFit,grid:{show:true,stroke:'rgba(130,150,180,.15)',width:1},ticks:{show:true,stroke:c.line},values:(u,vals)=>vals.map(v=>state.unitId==='raw'?fmtNumber(v,0):fmtNumber(v,displayDigits()))}
    ],
    series:[{label:'Time'},{label:state.unitId==='raw'?'Raw history':'Mass history',stroke:c.raw,width:1.1,points:{show:false}}],
    plugins:[miniOverlayPlugin()]
  };
}
// The main chart and the navigator are created and destroyed independently (v10): changing the
// estimator only relabels the main chart's series, so only that chart is rebuilt.
function createMainChart(){
  state.auxSig=auxSigNow();state.auxSeriesShown=[];state.mainPlot=new uPlot(makeMainOptions(),emptyMainData(),$('mainChart'));
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
function updateViewLabel(){const s=Math.max(0,state.viewMax-state.viewMin)/1000;$('viewLabel').textContent=(state.curveStride>1?`Curve every ${state.curveStride}th sample · `:'')+(state.live?`Live · ${(state.liveWindowSpan/1000).toFixed(2)} s window`:`Historical · ${s.toFixed(2)} s span`);$('trackBtn').classList.toggle('primary',state.live);$('trackBtn').setAttribute('aria-pressed',String(state.live));$('trackBtn').textContent=state.live?'Pause Tracking':'Track Live';}
function scheduleRender(){if(renderPending)return;renderPending=true;requestAnimationFrame(()=>{renderPending=false;renderFrame();});}
// v11: a historical view that has been moved to the far right edge switches Track Live back on. Not while an
// interval is selected / pinned, so that selecting something near the newest data does not move the view.
function autoTrackIfAtEnd(){
  if(state.live||state.trackPaused||!state.count||state.selection||state.logPinned)return;
  const span=Math.max(PERIOD_MS,state.viewMax-state.viewMin);
  if(state.viewMax>=newestTime()-Math.max(2*PERIOD_MS,0.005*span))setLive(true);
}
// A sensor without samples (just added from the server list, or paused from the start) has nothing to show.
function renderEmpty(){
  $('currentValue').textContent='—';$('currentSpread').textContent='—';$('tareValue').textContent='—';
  $('currentValueDetail').textContent='Waiting for data…';$('spreadDetail').textContent='—';$('tareDetail').textContent='—';$('rangeStatus').hidden=true;
  $('sampleCount').textContent='0 samples';updateViewLabel();updateMeasurementUI();
  if(state.mainPlot)state.mainPlot.setData(emptyMainData());if(state.miniPlot)state.miniPlot.setData([[],[]]);
}
function renderFrame(){
  if(wiz.open)wizTick();
  if(state.mainPlot&&auxSigNow()!==state.auxSig)recreateMainChart();   // an auxiliary channel was attached, detached or switched
  if(!state.count){renderEmpty();return;}
  if(!state.live)autoTrackIfAtEnd();
  if(state.live)fitLiveWindow();
  updateMetrics();updateAuxReadout();updateMeasurementUI();$('sampleCount').textContent=`${state.count.toLocaleString()} samples`;updateViewLabel();
  const ts=performance.now();
  if(state.lastFrameTs&&ts-state.lastFrameTs>2000)state.snapY=true;   // rendering was suspended (background tab): do not damp
  state.lastFrameTs=ts;
  if(!state.mainPlot)return;
  const data=buildVisibleData(),minX=state.viewMin/1000,maxX=Math.max(minX+PERIOD_MS/1000,state.viewMax/1000);
  state.mainPlot.batch(()=>{state.mainPlot.setData(data,true);state.mainPlot.setScale('x',{min:minX,max:maxX});if(state.manualY)state.mainPlot.setScale('y',{min:state.yMin,max:state.yMax});});
  auxApplySeriesVisibility();
  state.snapY=false;   // damping resumes immediately after the one undamped frame
  // v11 fix: the Y damping advances once per RENDERED frame. While streaming that is every 12.5 ms, but a
  // paused chart renders only on interaction, so the axis stopped part-way to its target. As long as an
  // edge is still easing (latched), keep rendering until both edges have settled.
  if(state.yBusy&&!state.manualY)scheduleRender();
  const now=performance.now();if(now-miniLastRender>=miniRefreshMs()){updateMini();miniLastRender=now;}else updateMiniSelection();
  if(state.selection)updateSelectionReadout();
}
// v13: the navigator redraws more often while the retained history is short (cheap, and the curve visibly grows);
// the interval rises to the old 250 ms as the buffer fills. Cost is bounded either way (cached buckets).
function miniRefreshMs(){const n=state.count;return n<5000?50:n<20000?100:n<60000?160:250;}
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
  if(method==='mean'&&bandMode==='symmetric')return{stride:1,center:i=>chartMAAt(i,diagnostic),sigma:i=>chartSDAt(i,diagnostic),upper:i=>chartMAAt(i,diagnostic)+chartSDAt(i,diagnostic),lower:i=>chartMAAt(i,diagnostic)-chartSDAt(i,diagnostic)};
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
    return{stride:1,center:i=>C[i-lo],sigma:i=>S[i-lo],upper:i=>C[i-lo]+S[i-lo],lower:i=>C[i-lo]-S[i-lo]};
  }
  const w=Math.max(2,Math.min(state.window,MAX_ROBUST_WINDOW)),count=hi-lo+1;
  let costW=method==='hampelLocal'?w*(2*state.hampelHalf+2):w;if(bandMode==='stepaware')costW=Math.max(costW,w*40);   // the step test runs an autocorrelation per node   // the local Hampel test costs ~(2k+1) small sorts per sample
  const stride=Math.max(1,Math.ceil(count/Math.max(64,Math.floor(CURVE_BUDGET/Math.max(16,costW)))));
  const nodes=[];
  if(stride===1){for(let i=lo;i<=hi;i++)nodes.push(i);}
  else{nodes.push(lo);const a0=absIndex(lo);for(let i=lo+((stride-(a0%stride))%stride);i<hi;i+=stride)if(i>lo)nodes.push(i);if(nodes[nodes.length-1]!==hi)nodes.push(hi);}
  const key=`${diagnostic?'r':'m'}|${method}|${w}|${state.trimPercent}|${state.hampelHalf}|${state.hampelSigma}|${bandMode}`;
  if(state.curveCache.key!==key||state.curveCache.map.size>60000)state.curveCache={key,map:new Map()};
  const cache=state.curveCache.map,NC=new Float64Array(nodes.length),NS=new Float64Array(nodes.length),NU=new Float64Array(nodes.length),NL=new Float64Array(nodes.length);
  for(let k=0;k<nodes.length;k++){
    const i=nodes[k],id=absIndex(i);let hit=cache.get(id);
    if(!hit){const a=Math.max(i-w+1,epochStartFor(i,bounds)),vals=new Array(i-a+1);for(let j=a;j<=i;j++)vals[j-a]=get(j);const r=bandStats(vals,method,bandMode,estimatorOptions());hit=[r.value,r.sigma,r.upper,r.lower];cache.set(id,hit);}
    NC[k]=hit[0];NS[k]=hit[1];NU[k]=hit[2];NL[k]=hit[3];
  }
  const at=(i,arr)=>{
    if(stride===1)return arr[i-lo];
    let l=0,r=nodes.length-1;while(l<r){const mid=(l+r+1)>>1;if(nodes[mid]<=i)l=mid;else r=mid-1;}
    if(nodes[l]>=i||l===nodes.length-1)return arr[l];
    return arr[l]+(i-nodes[l])/(nodes[l+1]-nodes[l])*(arr[l+1]-arr[l]);
  };
  return{stride,center:i=>at(i,NC),sigma:i=>at(i,NS),upper:i=>at(i,NU),lower:i=>at(i,NL)};
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
function fmtSpan(s){if(!Number.isFinite(s))return'—';return s>=60?`${(s/60).toFixed(1)} min`:s>=10?`${s.toFixed(1)} s`:`${s.toFixed(2)} s`;}
// two significant digits, for small "±" values (the unit's normal decimals would show 0.000 g)
function formatMassSig(valueMg,unitId=state.unitId){
  const unit=unitById(unitId);if(unit.id==='raw')return`${fmtNumber(valueMg,Math.abs(valueMg)<10?2:1)} counts`;
  const v=mgToUnit(valueMg,unit.id);if(!Number.isFinite(v))return'—';const a=Math.abs(v);
  return`${fmtNumber(v,a===0?unit.decimals:clamp(1-Math.floor(Math.log10(a)),0,8))} ${unit.symbol}`;
}
// ---- the "±" lines under the current value (v14) -------------------------------------------------------------------------------
// 1 spread σ of the estimator window, 2 σ / sqrt(n_eff) of the window average, 3 stability = how much the displayed value itself moved
// (max - min of the estimator curve) during the last T = estimator window. All three are cached for a short time (the n_eff needs an
// autocorrelation; the stability a pass over the curve).
const PM_NEFF_MS=400,PM_STAB_MS=250,PM_NEFF_MAX=4096;
function windowNeff(diagnostic,n){
  const k=Math.min(n,PM_NEFF_MAX),now=performance.now(),c=state.pmNeff;
  if(c&&c.k===k&&c.diag===diagnostic&&now-c.t<PM_NEFF_MS)return c.v;
  let v=null;
  if(k>=ANALYSIS_THRESHOLDS.minSamples){const x=new Float64Array(k),last=state.count-1;for(let j=0;j<k;j++)x[j]=diagnostic?getRaw(last-k+1+j):getNetMg(last-k+1+j);const a=analysisAutocorr(x,Math.min(100,Math.floor(k/4)));v={neff:a.neff,n:k};}
  state.pmNeff={k,diag:diagnostic,t:now,v};return v;
}
function stabilityOver(centerFn,lo,hi){let mn=Infinity,mx=-Infinity;for(let i=lo;i<=hi;i++){const v=centerFn(i);if(v<mn)mn=v;if(v>mx)mx=v;}return{min:mn,max:mx,range:mx-mn};}
function windowStability(diagnostic,epochStart){
  const last=state.count-1,T=Math.min(state.window,state.count),lo=Math.max(last-T+1,diagnostic?0:epochStart);if(lo>=last)return null;
  const now=performance.now(),c=state.pmStab,key=`${state.estimator}|${bandMode}|${state.window}|${diagnostic}`;
  if(c&&c.key===key&&state.estimator!=='mean'&&now-c.t<PM_STAB_MS)return c.v;
  const cur=buildEstimatorCurve(lo,last,diagnostic),r=stabilityOver(cur.center,lo,last),v={range:r.range,spanS:(getTime(last)-getTime(lo))/1000,samples:last-lo+1};
  state.pmStab={key,t:now,v};return v;
}
function updatePlusMinus(diagnostic,n,spread,epochStart){
  const f=v=>diagnostic?`${fmtNumber(v,Math.abs(v)<10?2:1)} counts`:formatMassSig(v);
  $('pmSigma').textContent=`σ ${f(spread)}`;
  const ne=windowNeff(diagnostic,n);
  $('pmMean').textContent=ne?`±avg ${f(spread/Math.sqrt(ne.neff))} (n_eff ≈ ${ne.neff.toFixed(1)} of ${ne.n})`:`±avg needs ≥ ${ANALYSIS_THRESHOLDS.minSamples} samples`;
  const st=windowStability(diagnostic,epochStart);
  $('pmStab').textContent=st?`moved ${f(st.range)} in ${fmtSpan(st.spanS)}`:'moved —';
}
function uncertaintyLineText(u){
  if(!u||state.unitId==='raw')return'';
  if(u.status!=='ok')return`<span class="small">Uncertainty: not estimated (${esc(u.reason)})</span>`;
  return`<strong>± ${esc(formatMassSig(u.expandedMg))}</strong> <span class="small">(${esc(u.label)}; 95 %)</span>`;
}
function uncertaintyHTML(u,key){
  if(!u||state.unitId==='raw')return'';if(u.status!=='ok')return uncertaintyLineText(u);
  const stored=state.detailsOpen&&Object.prototype.hasOwnProperty.call(state.detailsOpen,key),open=stored?state.detailsOpen[key]:false;
  const rows=u.components.map(c=>`<div class="an-row ok"><strong>${esc(c.label)}</strong>: ${esc(formatMassSig(c.uMg))} <span class="small">(dof ${Number.isFinite(c.dof)?c.dof.toFixed(1):'∞'})${c.note?' · '+esc(c.note):''}</span></div>`).join('');
  return`<details class="an" data-key="${esc(key)}"${open?' open':''}><summary>${uncertaintyLineText(u)}</summary>${rows}<div class="small">Combined u<sub>c</sub> = ${esc(formatMassSig(u.combinedMg))} (root-sum-of-squares) · effective degrees of freedom ${Number.isFinite(u.dof)?u.dof.toFixed(1):'∞'} · k = ${u.k.toFixed(2)} (t-distribution, 95 %) · U = k · u<sub>c</sub></div><div class="small">Not included: ${esc((u.notIncluded||[]).join(', '))}. A bias shared by all reference weights is not reduced by averaging and cannot be seen by this tool. This is an estimate for an enthusiast, not a traceable uncertainty.</div></details>`;
}
// absolute mass and local slope of the result, then the stage-2 components (computeUncertainty)
function intervalUncertainty(cal,o){
  if(!cal||!cal.config||!Number.isFinite(o.rawEstimatorValue))return null;
  const conf=cal.config,m=calibrateAbsolute(o.rawEstimatorValue,conf).valueMg,slope=Math.abs(calibrateAbsolute(o.rawEstimatorValue+.5,conf).valueMg-calibrateAbsolute(o.rawEstimatorValue-.5,conf).valueMg);
  const tch=activeSensor?primaryTempChannel(activeSensor):null,ts=tch&&Number.isFinite(o.t0)?auxStatsRange(tch,o.t0,o.t1):null;
  return computeUncertainty(conf.uncertainty,{massMg:m,sigmaMg:o.spreadMg,neff:o.neff,sigmaCounts:o.rawSpread,slopeMgPerCount:slope,char:conf.characterization,uc:useConditionsOf(activeSensor),tempStats:ts,calibrationProfileId:conf.profileId});
}
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
  $('currentValueDetail').textContent=isEmaMethod(method)?`${method==='emaNorm'?'EMA (seed-normalised)':'EMA (seeded)'} · τ ${state.emaTau.toFixed(3)} s${diagnostic?' · counts':''}`:`${estimatorLabel(method)}${method==='hampelLocal'?` (k=${state.hampelHalf}, ${state.hampelSigma}σ)`:''} · ${used} samples · ${fmtSpan((getTime(last)-getTime(Math.max(0,last-used+1))+PERIOD_MS)/1000)}${robust&&n>MAX_ROBUST_WINDOW?' (newest 4,096 of window)':''}${rejected?` · ${rejected} excluded`:''}${diagnostic?' · counts':''}`;
  $('currentValue').title=`Raw latest: ${raw} counts\nAbsolute calibrated mass: ${fmtNumber(getMassMg(last),3)} mg\nNet calibrated mass: ${fmtNumber(getNetMg(last),3)} mg\nCalibration: ${state.revisionId}`;
  const outside=calibrateAbsolute(raw).outOfRange&&!diagnostic;
  $('rangeStatus').hidden=!outside;if(outside)$('rangeStatus').textContent='Latest sample is outside the calibrated range (extrapolated).';
  updatePlusMinus(diagnostic,n,spread,epochStart);
  $('spreadLabel').textContent=diagnostic?'Raw sensor spread (σ)':'Sensor spread (σ)';
  $('currentSpread').textContent=diagnostic?`${fmtNumber(spread,2)} counts`:formatMass(spread);
  $('spreadDetail').textContent=`${spreadDescription(method)} · repeatability only, not an uncertainty`;
  $('tareValue').textContent=diagnostic?(tare?(tare.tareRaw==null?'Manual mass tare':fmtNumber(tare.tareRaw,0)):'None'):(tare?formatMass(tare.tareMassMg):'None');
  $('tareDetail').textContent=tare?`${tare.method} · ${new Date(tare.createdAt).toLocaleTimeString()}${tare.outOfRangeCount?` · ${tare.outOfRangeCount} out-of-range samples`:''}`:'No tare event recorded';
  $('tareDetail').classList.toggle('warning',!!(tare&&tare.outOfRangeCount));
  $('tareUnitLabel').textContent=displayUnitSymbol();
  $('manualTareBtn').disabled=diagnostic;
  $('manualTareInput').disabled=diagnostic;
  { const up=calibration.uncertainty;
    $('uncertaintyStatus').textContent=up&&up.status==='estimated'?`Measurement uncertainty: estimated from this calibration (${up.basis}) and shown as ± U (95 %) with measurements. Not traceable, not validated. Characterization: ${charSummaryText(calibration.characterization)}. Not included: ${charNotIncluded(up.notIncluded,calibration.characterization).join(', ')}.`
      :up&&up.status==='not-estimable'?`Measurement uncertainty: not estimated. ${up.reason||''}`
      :calibration.validation?.status==='validated'?'Measurement uncertainty: see calibration validation metadata.':'Measurement uncertainty: not characterized by the embedded demonstration calibration. Sensor spread is repeatability information, not a complete uncertainty statement.'; }
}
function estimatorLabel(method){return({mean:'Arithmetic mean',median:'Median',trimmed:'Trimmed mean',hampel:'Global MAD filter + mean',hampelLocal:'Sliding Hampel filter + mean',ema:'Exponential moving average (EMA, seeded)',emaNorm:'EMA, seed-normalised'})[method]||'Arithmetic mean';}

function setLive(on){state.live=on;if(on)state.trackPaused=false;if(on)fitLiveWindow();updateViewLabel();}
function pauseTracking(){state.live=false;state.trackPaused=true;updateViewLabel();scheduleRender();}
function trackToggle(){if(state.live)pauseTracking();else trackLive();}
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
  const analysis=analyzeInterval(first,end),acf=(analysis.checks||[]).find(c=>c.id==='autocorrelation');
  const uncertainty=intervalUncertainty(calLast,{rawEstimatorValue,spreadMg,rawSpread,neff:acf&&Number.isFinite(acf.neff)?acf.neff:null,t0:getTime(first),t1:getTime(end-1)});
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
    analysis,uncertainty
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
  setHTML($('selectionSummary'),`<strong>${s.totalSamples.toLocaleString()} selected samples</strong> · ${fmtSpan((s.t1-s.t0+PERIOD_MS)/1000)}<br>`+
    `Time: <strong>${(s.t0/1000).toFixed(2)}–${(s.t1/1000).toFixed(2)} s</strong><br>`+
    `Estimator: <strong>${estimatorLabel(s.estimator)}</strong>`+
    // The selection EMA is seeded with the first selected sample, which keeps weight exp(-T/tau)
    // (product of the (1-alpha) factors). When T is not >> tau the result is mostly that seed,
    // so it is an end-of-selection filtered value, not an interval statistic.
    (s.estimator==='emaNorm'?` · no seed weight (normalised)${s.emaNeff?` · effective samples ≈ ${s.emaNeff.toFixed(1)}`:''}`:'')+(s.estimator==='hampelLocal'?` · k=${s.hampelHalf}, ${s.hampelSigma}σ`:'')+(s.estimator==='ema'?` · seed weight ${(100*Math.exp(-Math.max(0,s.t1-s.t0)/1000/Math.max(.025,s.emaTau))).toFixed(1)}%`:'')+`<br>`+
    (state.unitId==='raw'?`Raw estimator result: <strong>${fmtNumber(s.rawEstimatorValue,0)} counts</strong><br>`:`Original result: <strong>${formatMass(s.originalValueMg)}</strong><br>`+
    `Current calibration + latest tare: <strong>${formatMass(s.currentValueMg)}</strong><br>`)+
    `Current spread (σ, ${spreadDescription(s.estimator)}): <strong>${state.unitId==='raw'?fmtNumber(s.rawSpread,2)+' counts':formatMass(s.spreadMg)}</strong><br>`+
    (s.uncertainty?uncertaintyHTML(s.uncertainty,'sel-unc')+'<br>':'')+`Raw average: <strong>${fmtNumber(s.rawMean,2)} counts</strong><br>`+
    (s.rejectedSamples?`Excluded by estimator: <strong>${s.rejectedSamples}</strong><br>`:'')+`Out-of-range samples in analysis: <strong>${s.outOfRangeCount}</strong>${subsampled}${changed}${calibrationChanged}`);
}
function appendLogEntry(entry){state.logs.unshift(entry);renderLog();}
function appendSelectionLog(s){const entry={type:'selection',entryId:`selection-${Date.now()}-${state.logs.length}`,createdAt:new Date().toISOString(),...s};appendLogEntry(entry);}
function addTareEvent(tareMassMg,{method='manual',tareRaw=null,tareRawSamples=null,sourceCount=0,outOfRangeCount=0}={}){
  const previous=currentTareEvent();
  const event={type:'tare',eventId:`tare-${String(state.tareEvents.length+1).padStart(4,'0')}`,createdAt:new Date().toISOString(),effectiveFromTime:state.nextTime,tareMassMg,tareRaw,method,sourceCount,outOfRangeCount,previousTareMassMg:previous?previous.tareMassMg:0,calibrationRevisionId:state.revisionId,tareRawSamples:tareRawSamples?Float64Array.from(tareRawSamples):null};
  // A new tare affects only future samples. Previously stored calibrated masses and
  // their tare-adjusted display values remain unchanged and can be reproduced from events.
  cancelMeasurement('tare event'); cancelCharRec('tare event');   // a tare changes the zero reference, so a running measurement would mix epochs
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
  let massSum=0,rawSum=0,outOfRangeCount=0;const rawSamples=new Float64Array(n);
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
function analysisSegments(times, nominalMs, gapFactor = ANALYSIS_THRESHOLDS.gapFactor, counters = null) {
  const n = times.length, segs = []; if (!n) return segs;
  let start = 0;
  for (let i = 1; i < n; i++) {
    const dt = times[i] - times[i - 1];
    if (!(dt > 0) || (dt > gapFactor * nominalMs && !(counters && counters[i] - counters[i - 1] === 1))) { segs.push([start, i]); start = i; }
  }
  segs.push([start, n]); return segs;
}
function analysisGaps(times, nominalMs, counters = null) {
  const n = times.length, T = ANALYSIS_THRESHOLDS;
  let gaps = 0, missing = 0, duplicates = 0, backwards = 0, counterGaps = 0, counterMissing = 0, counterDup = 0, jitter = 0;
  for (let i = 1; i < n; i++) {
    const dt = times[i] - times[i - 1];
    if (dt === 0) duplicates++;
    else if (dt < 0) backwards++;
    else if (dt > T.gapFactor * nominalMs) { if (counters && counters[i] - counters[i - 1] === 1) jitter++; else { gaps++; missing += Math.max(1, Math.round(dt / nominalMs) - 1); } }
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
  return { id: 'gaps', label: 'Gaps and duplicates', value: fraction, valueText: `${(100 * fraction).toFixed(2)} % missing`, threshold: { warn: 'any gap', fail: T.gapFailFraction, failText: 'duplicate/backwards time, or > ' + (100 * T.gapFailFraction) + ' % missing' }, verdict, detail: parts.join('; ') + (jitter ? '; ' + jitter + ' irregular interval(s), counter contiguous: no samples lost' : ''), jitter, gaps, missing, duplicates, backwards };
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
  const segs = analysisSegments(times, nominalMs, undefined, opts.counters || null);
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
  const raws=new Float64Array(n),times=new Float64Array(n),ids=new Float64Array(n);let oor=0,haveIds=true;
  for(let j=0;j<n;j++){const i=first+j,t=getTime(i),r=getRaw(i),id=getId(i);raws[j]=r;times[j]=t;ids[j]=id;if(!Number.isFinite(id))haveIds=false;if(activeSensor.hasOwnCal&&calibrateAbsolute(r,calibrationAt(t).config).outOfRange)oor++;}
  return analyzeSeries(raws,times,{nominalMs:PERIOD_MS,counters:haveIds?ids:null,outOfRangeCount:activeSensor.hasOwnCal?oor:undefined});   // the device counter is a second witness for dropped / repeated frames
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
  if(m){$('measValue').textContent='…';$('measDetail').textContent=`Measuring: ${m.collected.toLocaleString()} / ${m.target.toLocaleString()} samples`;$('measNote').textContent='';$('measUnc').textContent='';return;}
  if(!last){$('measValue').textContent='—';$('measDetail').textContent='No measurement yet';$('measNote').textContent='';$('measUnc').textContent='';return;}
  $('measValue').textContent=raw?`${fmtNumber(last.rawEstimatorValue,0)} counts`:formatMass(last.originalValueMg);
  $('measDetail').textContent=`σ ${raw?fmtNumber(last.rawSpread,2)+' counts':formatMass(last.spreadMg)} · ${last.totalSamples.toLocaleString()} samples (${fmtSpan((last.t1-last.t0+PERIOD_MS)/1000)}) · ${estimatorLabel(last.estimator)}`;
  setHTML($('measUnc'),uncertaintyHTML(last.uncertainty,'meas-unc'));
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
    if(entry.type==='fwwarning')return row('overload','fwwarning',fwWarningLineHTML(entry)+`<br><span class="small">${(entry.effectiveFromTime/1000).toFixed(2)} s</span>`);
    if(entry.type==='overload')return row('overload','overload',overloadLineHTML(entry)+`<br><span class="small">${(entry.t0/1000).toFixed(2)}–${(entry.t1/1000).toFixed(2)} s</span>`);
    if(entry.type==='note')return row('note','note',esc(entry.text));
    const result=state.unitId==='raw'?`Raw estimator: ${fmtNumber(entry.rawEstimatorValue,0)} counts`:(entry.type==='measurement'?`Result: <strong>${formatMass(entry.originalValueMg)}</strong> · σ ${formatMass(entry.spreadMg)}`:`Original: ${formatMass(entry.originalValueMg)} · Current: ${formatMass(entry.currentValueMg)}`);
    const title=entry.type==='measurement'?`Measurement · ${entry.totalSamples.toLocaleString()} samples (${entry.nominalDurationS.toFixed(2)} s nominal${Math.abs((entry.t1-entry.t0+PERIOD_MS)/1000-entry.nominalDurationS)>.02*entry.nominalDurationS?`, ${fmtSpan((entry.t1-entry.t0+PERIOD_MS)/1000)} actual`:''})${entry.tag?' · '+esc(entry.tag):''}`:`Selection · ${entry.totalSamples.toLocaleString()} samples (${fmtSpan((entry.t1-entry.t0+PERIOD_MS)/1000)})`;
    return row(entry.type,entry.type,`<strong>${title}</strong><br>${result}${entry.uncertainty&&entry.uncertainty.status==='ok'&&state.unitId!=='raw'?'<br>'+uncertaintyLineText(entry.uncertainty):''}${entry.analysis?'<br>'+analysisHTML(entry.analysis,false,'log:'+entry.entryId):''}<br><span class="small">${detail(entry)}</span>`);
  }).join('');
}
function jumpToLogEntry(id,type){
  if(type==='note')return;
  if(type==='fwwarning'){const e=logEntryOf(id);if(!e)return;{const r=logEntryRange(e);state.logPinned=r?{...r,id}:null;}if(e.effectiveFromTime>=oldestTime()&&e.effectiveFromTime<=newestTime()){const half=state.liveWindowSpan/2;state.live=false;state.viewMin=clamp(e.effectiveFromTime-half,oldestTime(),Math.max(oldestTime(),newestTime()-state.liveWindowSpan));state.viewMax=Math.min(newestTime(),state.viewMin+state.liveWindowSpan);state.selection=null;}$('selectionSummary').innerHTML=fwWarningLineHTML(e);scheduleRender();return;}
  if(type==='overload'){const e=logEntryOf(id);if(!e)return;{const r=logEntryRange(e);state.logPinned=r?{...r,id}:null;}if(e.t0<oldestTime()||e.t1>newestTime()){$('selectionSummary').innerHTML='<span class="warning">The samples of this event are no longer retained. The log record remains.</span>';return;}const sp=Math.max(e.t1-e.t0,PERIOD_MS),vs=Math.max(sp*3,state.liveWindowSpan);state.live=false;state.liveWindowSpan=vs;state.viewMin=clamp((e.t0+e.t1)/2-vs/2,oldestTime(),Math.max(oldestTime(),newestTime()-vs));state.viewMax=Math.min(newestTime(),state.viewMin+vs);state.selection=null;$('selectionSummary').innerHTML=overloadLineHTML(e);scheduleRender();return;}
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
  const auxCh=attachedAux(activeSensor);
  const parts=['runtime_ms,raw_sensor_counts,absolute_mass_mg,historical_tare_mass_mg,net_mass_mg,moving_average_net_mg,spread_sigma_mg,tare_event_id,calibration_profile_id,calibration_revision_id,calibration_out_of_range'+auxCh.map(c=>',aux_'+csvField(c.id)).join('')+'\n'];
  let rows=[];
  for(let i=0;i<state.count;i++){
    const time=getTime(i),event=tareEventAt(time),cal=calibrationAt(time),raw=getRaw(i);   // per-row: the calibration the sample was RECORDED with
    rows.push([time,raw,getMassMg(i),event?event.tareMassMg:0,getNetMg(i),getMassMA(i),getMassSD(i),event?event.eventId:'',csvField(cal.profileId),csvField(cal.revisionId),calibrateAbsolute(raw,cal.config).outOfRange?1:0].concat(auxCh.map(c=>{const v=auxValueAt(c,time);return Number.isFinite(v)?v:'';})).join(','));
    if(rows.length>=20000){parts.push(rows.join('\n')+'\n');rows=[];}
  }
  if(rows.length)parts.push(rows.join('\n')+'\n');
  downloadBlob(new Blob(parts,{type:'text/csv;charset=utf-8'}),`mass-telemetry-${String(activeSensor.id).replace(/[^\w.-]+/g,'_')}-${new Date().toISOString().replace(/[:.]/g,'-')}.csv`);
}

const WINDOW_MIN=2,WINDOW_MAX=10000;
function sliderToWindow(p){return clamp(Math.round(WINDOW_MIN*Math.pow(WINDOW_MAX/WINDOW_MIN,clamp(Number(p)||0,0,1000)/1000)),WINDOW_MIN,WINDOW_MAX);}
function windowToSlider(n){return clamp(Math.round(1000*Math.log(Math.max(WINDOW_MIN,n)/WINDOW_MIN)/Math.log(WINDOW_MAX/WINDOW_MIN)),0,1000);}
function syncWindowSeconds(){const e=$('windowSeconds');if(e)e.value=Number((state.window/RATE_HZ).toFixed(3));const r=$('windowRateText');if(r)r.textContent=String(RATE_HZ);}
function setMovingAverageWindow(rawValue,immediate=false,preserveInput=false,preserveSeconds=false){
  if(rawValue===''||!Number.isFinite(Number(rawValue)))return;
  const value=clamp(Math.floor(Number(rawValue)),2,10000);state.window=Math.min(value,state.capacity);
  if(!preserveInput)$('windowInput').value=state.window;$('windowRange').value=windowToSlider(state.window);if(!preserveSeconds)syncWindowSeconds();
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
  for(const c of attachedAux(activeSensor)){c.unlimited=state.unlimited;if(!state.unlimited){const cap=Math.max(1000,Math.min(state.capacity,2000000));if(cap!==c.buf.cap){const nb=auxNewBuffer(cap),n=Math.min(c.buf.count,cap),sk=c.buf.count-n;for(let i=0;i<n;i++){const q=auxP(c.buf,sk+i);nb.t[i]=c.buf.t[q];nb.raw[i]=c.buf.raw[q];nb.id[i]=c.buf.id[q];nb.val[i]=c.buf.val[q];}nb.count=n;c.buf=nb;}}}
  $('windowInput').value=state.window;$('windowRange').value=windowToSlider(state.window);syncWindowSeconds();
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
  populateUnitSelect();
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
  if(config.sensorId!=null&&!(Number.isInteger(config.sensorId)&&config.sensorId>=0))errors.push('"sensorId" must be a whole number (the numeric sensor id of the device).');
  for(const key of['profileId','profileName'])if(typeof config[key]!=='string'||!config[key].trim())errors.push(`"${key}" must be a non-empty text.`);
  if(typeof config.profileId==='string'&&config.profileId.trim()&&!/^[A-Za-z0-9._-]+$/.test(config.profileId))errors.push('"profileId" may only contain letters, digits, dot, underscore and hyphen (it is part of the file name).');
  if(!UNIT_CONFIG.units.some(u=>u.id===config.calibrationUnit&&u.id!=='raw'))errors.push('"calibrationUnit" must be one of the supported mass units.');
  if(config.calibrationMethod!=='piecewise-linear')errors.push('Only calibrationMethod "piecewise-linear" is supported.');
  for(const o of (Array.isArray(config.observations)?config.observations:[]))if(o&&o.purpose!=null&&!['calibration','eccentricity','creep','zero-drift'].includes(o.purpose))errors.push(`Observation "${o.observationId}": unknown purpose "${o.purpose}".`);
  if(config.characterization!=null){
    const c=config.characterization,fin=(v,l)=>{if(v!=null&&!Number.isFinite(v))errors.push(`characterization.${l} must be a number.`);};
    if(typeof c!=='object'||Array.isArray(c))errors.push('"characterization" must be an object.');
    else{
      if(!['measured','partly measured','user-estimate','none'].includes(c.status))errors.push('characterization.status must be measured, partly measured, user-estimate or none.');
      const srcOk=(t,l)=>{if(t&&t.source!=='measured'&&t.source!=='user-estimate')errors.push(`characterization.${l}.source must be "measured" or "user-estimate".`);};
      const e=c.eccentricity;if(e){fin(e.fractionOfLoad,'eccentricity.fractionOfLoad');if(Number.isFinite(e.fractionOfLoad)&&e.fractionOfLoad<0)errors.push('characterization.eccentricity.fractionOfLoad must not be negative.');srcOk(e,'eccentricity');}
      const k=c.creep;if(k){if(!Array.isArray(k.samples))errors.push('characterization.creep.samples must be a list.');else for(const q of k.samples){if(!q||!Number.isFinite(q.tS)||!Number.isFinite(q.fraction))errors.push('characterization.creep.samples: every entry needs tS and fraction as numbers.');}srcOk(k,'creep');}
      const z=c.zeroDrift;if(z){fin(z.rateMgPerH,'zeroDrift.rateMgPerH');fin(z.seMgPerH,'zeroDrift.seMgPerH');srcOk(z,'zeroDrift');}
      const t=c.temperature;if(t){for(const f of['referenceC','zeroMgPerK','zeroSe','spanPpmPerK','spanSe'])fin(t[f],'temperature.'+f);srcOk(t,'temperature');}
    }
  }
  const list=v=>Array.isArray(v)?v:[];
  const ids=(items,key,label)=>{const seen=new Set();for(const item of list(items)){const id=item&&item[key];if(seen.has(id))errors.push(`Duplicate ${label} "${id}".`);seen.add(id);}return seen;};
  const weightIds=ids(config.referenceWeights,'weightId','weightId');ids(config.referenceLoads,'loadId','loadId');
  const obsIds=ids(config.observations,'observationId','observationId');ids(config.calibrationAnchors,'anchorId','anchorId');
  const groupIds=ids(config.referenceWeightGroups,'groupId','groupId');   // v13 (optional): weight groups
  for(const w of list(config.referenceWeights))if(w&&w.groupId!=null&&!groupIds.has(w.groupId))errors.push(`Weight "${w.weightId}" refers to unknown group "${w.groupId}".`);
  for(const g of list(config.referenceWeightGroups)){if(g?.massBasis!=='nominal'&&g?.massBasis!=='assigned')errors.push(`Group "${g?.groupId}": massBasis must be "nominal" or "assigned".`);for(const id of list(g?.memberWeightIds))if(!weightIds.has(id))errors.push(`Group "${g.groupId}" refers to unknown weight "${id}".`);}
  for(const load of list(config.referenceLoads))for(const part of list(load?.components))if(!weightIds.has(part?.weightId))errors.push(`Load "${load.loadId}" refers to unknown weight "${part?.weightId}".`);
  if(obsIds.size)for(const anchor of list(config.calibrationAnchors))for(const o of list(anchor?.sourceObservationIds))if(!obsIds.has(o))errors.push(`Anchor "${anchor.anchorId}" refers to unknown observation "${o}".`);
  try{prepared=prepareCalibration(config);}catch(error){errors.push(error.message);}
  if(!errors.length&&config.validation?.status!=='validated')warnings.push('Not metrologically validated: no uncertainty is claimed.');
  return{errors,warnings,prepared};
}
// v15: a calibration file belongs to ONE sensor (top-level "sensorId"; older files have none and are bound to the sensor they are first used on).
// File name: calibration_<profileId>.json. calLibrary keeps the files known in this session (by file name); the file that is active for a
// sensor is stored in sensors.json ("calibrationFile").
const calLibrary = new Map();
function calFileName(config,sensorId){const sid=config.sensorId!=null?config.sensorId:(sensorId!=null?sensorId:activeSensor.id);return `calibration_${numericSensorId(sid)!=null?numericSensorId(sid):'test'}_${config.profileId}.json`;}   // calibration_<sensorId>_<profileId>.json
function calLibraryAdd(config,sensorId){const name=calFileName(config,sensorId),old=calLibrary.get(name);calLibrary.set(name,{name,config:JSON.parse(JSON.stringify(config)),sensorId:String(config.sensorId!=null?config.sensorId:sensorId),profileName:config.profileName,onDevice:old?old.onDevice:false,sizeBytes:old?old.sizeBytes:undefined});return name;}
async function activateCalibration(config,source){
  const checked=validateCalibrationConfig(config);
  if(checked.errors.length)return checked;
  if(config.sensorId!=null&&String(config.sensorId)!==activeSensor.id){checked.errors.push(`This calibration belongs to sensor “${config.sensorId}”, but “${activeSensor.id}” is shown. Show that sensor first.`);return checked;}
  const calName=calLibraryAdd(config,activeSensor.id);
  const target=state,fp=await fingerprintConfig(config);
  if(state!==target){checked.errors.push('The shown sensor changed while the calibration was being checked; nothing was applied. Select the sensor again and retry.');return checked;}
  if(fp.id===state.revisionId){checked.warnings.push('This calibration is already active; nothing changed.');checked.unchanged=true;activeSensor.settings.calibrationFile=calName;return checked;}
  if(config.contentHash&&fp.full&&config.contentHash!==fp.full)checked.warnings.push('The file’s contentHash does not match its content (edited after export?). The recalculated fingerprint is used.');
  CALIBRATION=config;calibration=checked.prepared;state.calConfig=config;state.calPrepared=checked.prepared;activeSensor.hasOwnCal=true;state.revisionId=fp.id;state.hashType=fp.type;state.fullHash=fp.full;
  state.calibrations.push({effectiveFromTime:state.nextTime,revisionId:fp.id,profileId:config.profileId,hashType:fp.type,config:calibration,source});
  cancelMeasurement('calibration changed'); cancelCharRec('calibration changed');
  addTareEvent(0,{method:'Tare reset · calibration changed'});
  appendLogEntry({type:'calibration',entryId:`calibration-${Date.now()}`,createdAt:new Date().toISOString(),effectiveFromTime:state.nextTime,revisionId:fp.id,profileId:config.profileId,profileName:config.profileName,source});
  activeSensor.settings.calibrationFile=calName;
  state.autoYMin=null;state.autoYMax=null;updateCalibrationInfo();updateSelectionForNewContext();scheduleRender();
  return checked;
}
function showCalibrationMessages(errors,warnings,okText){
  $('calMessages').innerHTML=errors.map(e=>`<div class="warning">${esc(e)}</div>`).join('')+warnings.map(w=>`<div>${esc(w)}</div>`).join('')+(okText?`<div>${esc(okText)}</div>`:'');
}
async function importCalibrationFile(file){
  try{
    if(file.size>2e6)throw new Error('File is larger than 2 MB.');
    const cfg=JSON.parse(await file.text());
    if(cfg&&cfg.sensorId!=null&&String(cfg.sensorId)!==activeSensor.id){
      if(!sensors.has(String(cfg.sensorId))){showCalibrationMessages([`This calibration belongs to sensor “${cfg.sensorId}”, which is not in the sensor list.`],[],'');return;}
      activateSensor(String(cfg.sensorId));
    }
    const result=await activateCalibration(cfg,`file: ${file.name}`);
    if(!result.errors.length&&cfg&&cfg.sensorId==null)result.warnings.push(`This file names no sensor. It is now used for “${activeSensor.name}”; exporting it again stores that link.`);
    showCalibrationMessages(result.errors,result.warnings,result.errors.length||result.unchanged?'':`Calibration imported and activated on “${activeSensor.name}”. Structure checked only; this is not a metrological validation.`);
  }catch(error){showCalibrationMessages([`Could not import the file: ${error.message}`],[],'');}
}
async function restoreDemoCalibration(){
  const result=await activateCalibration(JSON.parse(JSON.stringify(EMBEDDED_CALIBRATION)),'embedded demo');
  if(!result.errors.length){activeSensor.settings.calibrationFile=null;activeSensor.hasOwnCal=activeSensor.kind==='test';}
  showCalibrationMessages(result.errors,result.warnings,result.errors.length||result.unchanged?'':'Embedded illustrative demo calibration restored.');
}
async function exportCalibration(){
  // the file always names its sensor (numeric id of the device); a file without one is stamped with the shown sensor and fingerprinted again
  const out=await stampedCalibration();
  downloadBlob(new Blob([JSON.stringify(out,null,2)],{type:'application/json'}),calFileName(out,activeSensor.id));
}
// Makes the file `name` the active calibration of sensor `id` ('' = the embedded demo). Shows that sensor first (changes are only possible on the shown sensor).
async function selectCalibrationFile(id,name){
  const s=sensors.get(id);if(!s)return'Unknown sensor.';
  if(s!==activeSensor)activateSensor(id);
  if(!name){await restoreDemoCalibration();return'Embedded demo calibration is active.';}
  let e=calLibrary.get(name);
  if((!e||!e.config)&&deviceReachable){try{const cfg=await fetchWire(`${CALIBRATION_DIR}/${encodeURIComponent(name)}`);if(calFileName(cfg,id)!==name)throw new Error('the file name and the profile / sensor id inside the file disagree');calLibraryAdd(cfg,id);e=calLibrary.get(name);}catch(err){return`Could not load ${name} from the device: ${err.message}`;}}
  if(!e||!e.config){s.settings.calibrationFile=name;s.settings.calibrationPending=true;return`${name} is not loaded in this session. Import the file in Settings → Calibration (it is then used for “${s.name}”).`;}
  if(e.sensorId&&e.sensorId!==id)return`${name} belongs to sensor “${e.sensorId}”.`;
  const r=await activateCalibration(JSON.parse(JSON.stringify(e.config)),`file: ${name}`);
  if(!r.errors.length)delete s.settings.calibrationPending;
  return r.errors.length?r.errors.join(' '):`${name} is active for “${s.name}”.`;
}
function updateCalibrationInfo(){
  const weights=CALIBRATION.referenceWeights||[],count=state.calibrations.length;
  $('calibrationInfo').innerHTML=`Sensor: <strong>${esc(activeSensor.name)}</strong> · file ${esc(calFileName(CALIBRATION,activeSensor.id))}${CALIBRATION.sensorId?'':' (not bound to a sensor yet)'}<br><strong>${esc(CALIBRATION.profileName)}</strong><br>Profile: ${esc(CALIBRATION.profileId)}<br>Revision: <strong>${esc(state.revisionId)}</strong> <span class="small">(${esc(state.hashType)})</span><br>Unit: ${esc(CALIBRATION.calibrationUnit)} · Anchors: ${calibration.anchors.length} · Reference weights: ${weights.length} · Observations: ${(CALIBRATION.observations||[]).length}<br>Characterization: ${esc(charSummaryText(CALIBRATION.characterization))}<br>Validation: ${esc(CALIBRATION.validation?.status||'not characterized')}${count>1?`<br><span class="small">${count} calibration revisions used in this session.</span>`:''}`;
}

function initEvents(){
  $('overloadBanner').addEventListener('click',e=>{const it=e.target.closest&&e.target.closest('[data-sensor]');if(it)activateSensor(it.dataset.sensor);});
  $('pauseBtn').addEventListener('click',()=>setSensorPaused(activeSensor,!activeSensor.state.paused));
  $('pauseAllBtn').addEventListener('click',pauseAllToggle);
  $('clearChartsBtn').addEventListener('click',clearCharts);$('clearAllChartsBtn').addEventListener('click',clearAllCharts);$('clearAllBtn').addEventListener('click',clearAll);
  $('sensorSelect').addEventListener('change',e=>activateSensor(e.target.value));
  $('sensorReloadBtn').addEventListener('click',()=>loadSensorList());
  $('navPanelToggle').addEventListener('change',e=>setNavPanelVisible(e.target.checked));
  // remember which validity lists the user opened / closed ('toggle' does not bubble, hence capture)
  document.addEventListener('toggle',e=>{const d=e.target;if(d&&d.classList&&d.classList.contains('an')&&d.dataset&&d.dataset.key)state.detailsOpen[d.dataset.key]=!!d.open;},true);
  $('trackBtn').addEventListener('click',trackToggle);$('selectModeBtn').addEventListener('click',()=>setSelectMode(!state.selectMode));
  $('tareBtn').addEventListener('click',autoTare);$('manualTareBtn').addEventListener('click',manualTare);$('exportBtn').addEventListener('click',exportCSV);$('testSamplesBtn').addEventListener('click',addTestSamples);$('bufferInput').addEventListener('change',applyBufferSize);
  $('measureBtn').addEventListener('click',startMeasurement);$('measSlider').addEventListener('input',()=>syncMeasurementInputs('slider'));$('measDuration').addEventListener('input',()=>syncMeasurementInputs('duration'));$('measSamples').addEventListener('input',()=>syncMeasurementInputs('samples'));
  $('calImportBtn').addEventListener('click',()=>$('calFile').click());$('calFile').addEventListener('change',e=>{const f=e.target.files[0];e.target.value='';if(f)importCalibrationFile(f);});
  $('calExportBtn').addEventListener('click',exportCalibration);$('calDemoBtn').addEventListener('click',restoreDemoCalibration);
  $('windowRange').addEventListener('input',e=>setMovingAverageWindow(sliderToWindow(e.target.value),false,false));$('windowRange').addEventListener('change',e=>setMovingAverageWindow(sliderToWindow(e.target.value),true,false));$('windowInput').addEventListener('input',e=>setMovingAverageWindow(e.target.value,false,true));$('windowInput').addEventListener('change',e=>setMovingAverageWindow(e.target.value,true,false));
  $('windowSeconds').addEventListener('input',e=>{const s=Number(e.target.value);if(s>0)setMovingAverageWindow(Math.max(2,Math.round(s*RATE_HZ)),false,false,true);});$('windowSeconds').addEventListener('change',e=>{const s=Number(e.target.value);if(s>0)setMovingAverageWindow(Math.max(2,Math.round(s*RATE_HZ)),true,false,false);else syncWindowSeconds();});
  $('estimatorSelect').addEventListener('change',e=>{state.estimator=e.target.value;updateEstimatorFields();recreateMainChart();scheduleRender();});
  $('hampelHalf').addEventListener('change',e=>{state.hampelHalf=clamp(Math.round(Number(e.target.value)||HAMPEL_DEFAULT_HALF),2,50);e.target.value=state.hampelHalf;scheduleRender();});
  $('hampelSigma').addEventListener('change',e=>{state.hampelSigma=clamp(Number(e.target.value)||HAMPEL_DEFAULT_SIGMA,1,10);e.target.value=state.hampelSigma;scheduleRender();});
  $('simModeSelect').addEventListener('change',e=>{state.simMode=e.target.value;state.simOffset=0;});
  $('bandModeSelect').addEventListener('change',e=>setBandMode(e.target.value));
  $('trimPercent').addEventListener('input',e=>{state.trimPercent=Number(e.target.value);$('trimPercentText').textContent=`${state.trimPercent}%`;scheduleRender();});
  $('emaTau').addEventListener('change',e=>{state.emaTau=clamp(Number(e.target.value)||.5,.025,120);e.target.value=state.emaTau;rebuildEMA();scheduleRender();});
  $('unitSelect').addEventListener('change',e=>{state.unitId=e.target.value;state.autoYMin=null;state.autoYMax=null;const raw=state.unitId==='raw';$('rawModeToggle').checked=raw;$('mainChartTitle').textContent=raw?'Raw sensor diagnostics':'Measured mass';$('zeroFillToggle').disabled=raw;$('zeroRawFillToggle').disabled=raw;$('zeroLineToggle').disabled=raw;$('tareUnitLabel').textContent=displayUnitSymbol();$('manualTareInput').value='';if(state.mainPlot){destroyCharts();createCharts();}scheduleRender();});
  $('rawModeToggle').addEventListener('change',e=>{state.unitId=e.target.checked?'raw':UNIT_CONFIG.defaultUnit;$('unitSelect').value=state.unitId;$('unitSelect').dispatchEvent(new Event('change'));});
  $('precisionSelect').addEventListener('change',e=>{state.precision=e.target.value;scheduleRender();if(state.mainPlot){destroyCharts();createCharts();scheduleRender();}});
  $('settingsBtn').addEventListener('click',()=>openSettings($('settingsMenu').hidden));document.addEventListener('pointerdown',e=>{if(!$('settingsMenu').hidden&&!e.target.closest('.settings-wrap'))openSettings(false);});
  $('themeBtn').addEventListener('click',()=>{setTheme(uiTheme!=='light');uiSaveSoon();});
  $('yResponseRange').addEventListener('input',e=>{$('yResponseText').textContent=`${e.target.value}%`;scheduleRender();});
  $('subPixelToggle').addEventListener('change',e=>setSubPixel(e.target.checked));
  $('tempRateWindow').addEventListener('change',()=>scheduleRender());
  $('auxToggles').addEventListener('change',e=>{const id=e.target&&e.target.dataset&&e.target.dataset.aux;if(!id)return;if(e.target.checked)state.auxHidden.delete(id);else state.auxHidden.add(id);scheduleRender();});
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

// ===== v15: OVERLOAD / UNDERLOAD MONITOR ===============================================================================
// Per sensor. The load is the ABSOLUTE calibrated mass (gross, not tare-corrected: the cell does not know about the tare), averaged over the
// newest `averageS` seconds (default 0.1 s) of samples. Limits are weights (mg inside): max, and min (default -max). The EXCESS is
// (avg - max) / max above the maximum, or (min - avg) / |min| below the minimum. Level: yellow when the excess is above yellowPct, orange
// above orangePct, red above redPct (all adjustable; defaults 10 / 20 / 40 %). An EVENT starts at the first sample with a level and lasts
// until no level was seen for breakS seconds (default 0.5 s): shorter dips do not start a new event. Time is the sample time of the device.
const OVL_COLORS = {yellow: '#f6c85f', orange: '#ff9a3c', red: '#e5384a'}, OVL_RANK = {yellow: 1, orange: 2, red: 3};
function overloadLevel(avgMg, c) {
  if (!(c.maxMg > 0) || !Number.isFinite(avgMg)) return {level: null, excess: 0, side: null};
  const lo = c.minMg != null ? c.minMg : -c.maxMg;
  let ex = 0, side = null;
  if (avgMg > c.maxMg) { ex = (avgMg - c.maxMg) / c.maxMg; side = 'over'; }
  else if (avgMg < lo) { ex = (lo - avgMg) / (Math.abs(lo) || c.maxMg); side = 'under'; }
  const p = ex * 100;
  return {level: side && p > c.redPct ? 'red' : side && p > c.orangePct ? 'orange' : side && p > c.yellowPct ? 'yellow' : null, excess: ex, side};
}
function closeOverload(sensor) {
  const o = sensor.ovl, a = o.active; if (!a) return;
  const per = 1000 / sensor.state.rateHz, c = o.cfg;
  const entry = {type: 'overload', entryId: `overload-${Date.now()}-${o.events.length}`, createdAt: new Date().toISOString(), t0: a.t0, t1: a.lastOverT, durationMs: a.lastOverT - a.t0 + per,
    peakLevel: a.peakLevel, peakMg: a.peakMg, peakExcess: a.peakExcess, side: a.side, limitMg: a.side === 'under' ? (c.minMg != null ? c.minMg : -c.maxMg) : c.maxMg, samples: a.samples};
  o.events.push(entry); o.lastEnd = entry; o.lastEndWall = performance.now(); o.active = null;
  sensor.state.logs.unshift(entry); if (sensor === activeSensor) renderLog();
}
function overloadStep(sensor, t, massMg) {
  const o = sensor.ovl, c = o.cfg; if (!(c.maxMg > 0)) { o.current = null; return; }
  o.q.push(t, massMg);
  while (o.q.length > 2 && t - o.q[0] > c.averageS * 1000) o.q.splice(0, 2);
  let s = 0, n = o.q.length / 2; for (let i = 1; i < o.q.length; i += 2) s += o.q[i];
  const avg = s / n, r = overloadLevel(avg, c);
  o.current = {level: r.level, excess: r.excess, side: r.side, avgMg: avg, t};
  const a = o.active, brk = c.breakS * 1000;
  if (r.level) {
    if (a && t - a.lastOverT <= brk) {
      a.lastOverT = t; a.samples++;
      if (r.excess > a.peakExcess) { a.peakExcess = r.excess; a.peakMg = avg; a.peakLevel = r.level; a.side = r.side; }
      else if (OVL_RANK[r.level] > OVL_RANK[a.peakLevel]) a.peakLevel = r.level;
    } else {
      if (a) closeOverload(sensor);
      o.active = {t0: t, lastOverT: t, peakExcess: r.excess, peakMg: avg, peakLevel: r.level, side: r.side, samples: 1};
    }
  } else if (a && t - a.lastOverT > brk) closeOverload(sensor);
}
// Applies the typed settings of sensor.settings.overload ({maxLoad:{value,unit}, minLoad, averageS, yellowPercent, ...}) to sensor.ovl.cfg.
function overloadApplySettings(sensor, s) {
  const out = {errors: []}, o = sensor.ovl, c = {...OVL_DEFAULTS};
  const mass = (v, label) => { if (v == null || v.value === '' || v.value == null) return null; const x = Number(v.value); if (!Number.isFinite(x)) { out.errors.push(`${label}: not a number.`); return null; } try { return massToMg(x, v.unit || 'g'); } catch (_) { out.errors.push(`${label}: unknown unit.`); return null; } };
  s = s || {};
  c.maxMg = mass(s.maxLoad, 'Maximum load'); c.minMg = mass(s.minLoad, 'Minimum load');
  if (c.maxMg != null && !(c.maxMg > 0)) { out.errors.push('The maximum load must be greater than 0.'); c.maxMg = null; }
  if (c.minMg != null && c.maxMg != null && !(c.minMg < c.maxMg)) { out.errors.push('The minimum load must be below the maximum load.'); c.minMg = null; }
  const num = (k, d, lo, hi, label) => { const v = s[k] == null || s[k] === '' ? d : Number(s[k]); if (!Number.isFinite(v) || v < lo || v > hi) { out.errors.push(`${label} must be between ${lo} and ${hi}.`); return d; } return v; };
  c.averageS = num('averageS', OVL_DEFAULTS.averageS, 0.001, 5, 'Averaging time (s)');
  c.yellowPct = num('yellowPercent', OVL_DEFAULTS.yellowPct, 0, 1000, 'Yellow threshold (%)');
  c.orangePct = num('orangePercent', OVL_DEFAULTS.orangePct, 0, 1000, 'Orange threshold (%)');
  c.redPct = num('redPercent', OVL_DEFAULTS.redPct, 0, 1000, 'Red threshold (%)');
  if (!(c.yellowPct <= c.orangePct && c.orangePct <= c.redPct)) { out.errors.push('The thresholds must rise: yellow ≤ orange ≤ red.'); c.yellowPct = OVL_DEFAULTS.yellowPct; c.orangePct = OVL_DEFAULTS.orangePct; c.redPct = OVL_DEFAULTS.redPct; }
  c.breakS = num('breakS', OVL_DEFAULTS.breakS, 0, 60, 'Break time (s)');
  c.holdS = num('holdS', OVL_DEFAULTS.holdS, 1, 600, 'Show the warning for (s)');
  if (out.errors.length) return out;
  o.cfg = c; o.q = []; o.current = null; if (o.active && !(c.maxMg > 0)) o.active = null;
  sensor.settings.overload = s; return out;
}
function overloadDoc(sensor) { const s = sensor.settings.overload; return s ? JSON.parse(JSON.stringify(s)) : null; }
// What the banner shows for one sensor: null (nothing), or {level, side, now, ...}. nowWall = performance.now().
function overloadStatus(sensor, nowWall) {
  const o = sensor.ovl, c = o.cfg; if (!(c.maxMg > 0)) return null;
  const stale = sensorStaleMs(sensor, nowWall) > 0;
  if (o.active) { const a = o.active; return {sensor, level: a.peakLevel, side: a.side, peakMg: a.peakMg, peakExcess: a.peakExcess, durationMs: a.lastOverT - a.t0 + 1000 / sensor.state.rateHz, limitMg: a.side === 'under' ? (c.minMg != null ? c.minMg : -c.maxMg) : c.maxMg, now: !!(o.current && o.current.level) && !stale, stale}; }
  if (o.lastEnd && o.lastEndWall != null && nowWall - o.lastEndWall < c.holdS * 1000) { const e = o.lastEnd; return {sensor, level: e.peakLevel, side: e.side, peakMg: e.peakMg, peakExcess: e.peakExcess, durationMs: e.durationMs, limitMg: e.limitMg, now: false, stale, endedAgoS: (nowWall - o.lastEndWall) / 1000}; }
  return null;
}
function updateOverloadBanner() {
  const el = $('overloadBanner'); if (!el) return;
  const now = performance.now(), items = [];
  for (const s of sensors.values()) { const r = overloadStatus(s, now); if (r) items.push(r); }
  items.sort((a, b) => OVL_RANK[b.level] - OVL_RANK[a.level]);
  const fwHtml = fwBannerHTML(); el.hidden = !items.length && !fwHtml;
  const unit = x => { const u = x.sensor.state.unitId === 'raw' ? 'g' : x.sensor.state.unitId; return v => esc(formatMass(v, u)); };
  setHTML(el, fwHtml + items.map(r => { const f = unit(r);
    return `<div class="ovl-item ovl-${r.level}${r.now ? ' ovl-now' : ''}" data-sensor="${esc(r.sensor.id)}" title="Click to show this sensor"><strong>⚠ ${esc(r.sensor.name)}: ${r.side === 'under' ? 'UNDERLOAD' : 'OVERLOAD'}</strong> peak ${f(r.peakMg)} (limit ${f(r.limitMg)}, ${r.side === 'under' ? '−' : '+'}${(r.peakExcess * 100).toFixed(0)} %) · ${fmtSpan(r.durationMs / 1000)} · <strong>${r.stale ? 'no data (status unknown)' : r.now ? 'STILL OVERLOADED' : `ended ${r.endedAgoS == null ? 'just now' : r.endedAgoS.toFixed(0) + ' s ago'}`}</strong></div>`; }).join(''));
}
// ===== v15: CONNECTION TIMEOUT ===========================================================================================
// A sensor that should be streaming (not paused, listed, connection open or test signal) but delivered no sample for
// max(STREAM_TIMEOUT_MIN_MS, STREAM_TIMEOUT_PERIODS x nominal period) is shown as "no data for N s".
const STREAM_TIMEOUT_MIN_MS = 2000, STREAM_TIMEOUT_PERIODS = 20;
function sensorStaleMs(s, nowWall) {
  if (s.state.paused || s.unlisted || s.disabled || s.kind === 'archive') return 0;
  let base = s.state.lastWall;
  if (s.kind === 'server') { const c = s.sseUrl && sseConnections.get(s.sseUrl); if (!c) return 0; if (base == null || (c.since != null && c.since > base)) base = c.since; }
  if (base == null) return 0;
  const limit = Math.max(STREAM_TIMEOUT_MIN_MS, STREAM_TIMEOUT_PERIODS * 1000 / s.state.rateHz), age = nowWall - base;
  return age > limit ? age : 0;
}
let housekeepingSig = '';
function housekeeping() {
  const now = performance.now(), sig = [...sensors.values()].map(s => sensorLink(s).key).join(',') + '|' + [...auxChannels.values()].map(c => auxLink(c).key).join(',');
  if (sig !== housekeepingSig) { housekeepingSig = sig; renderSensorSelect(); renderAuxToggles(); }
  updateStatusUI(); updateOverloadBanner();
}
// ===== v17: epochs follow below the multi-sensor layer
// ===== MULTI-SENSOR LAYER (v11) ======================================================================
// Ingest. All data of all sensors enters here. A sensor that is paused THROWS AWAY what arrives for it
// (counted in state.dropped). Only the shown sensor is processed; the others just store time + raw counts.
// timeMs: device time relative to the sensor's origin (undefined for the simulator). Non-monotonic or
// duplicate times are rejected (state.rejected) because the binary searches assume sorted time.
function timeStepIsGap(t, id){ if(!state.count)return false; if(!(t-newestTime()>ANALYSIS_THRESHOLDS.gapFactor*PERIOD_MS))return false; return !(Number.isFinite(id)&&id===lastStoredId(state)+1); }
function lastStoredId(st){return st.count?st.ids[(st.head+st.count-1)%st.capacity]:NaN;}
function ingestSample(sensor,raw,timeMs,force=false,sampleId){
  const st=sensor.state;
  if(st.paused&&!force){st.dropped++;return false;}
  st.lastWall=performance.now();
  if(timeMs!=null&&st.count&&timeMs<=st.times[(st.head+st.count-1)%st.capacity]){st.rejected++;return false;}
  if(Number.isFinite(sampleId)){
    // v14: the device's monotonic sample id. A repeat is rejected; a jump is a gap (filled from the history server if there is one).
    const last=lastStoredId(st);
    if(Number.isFinite(last)){if(sampleId<=last){st.rejected++;return false;}if(sampleId>last+1&&!sensor.skipNextGap)noteGap(sensor,last+1,sampleId-1);}
    sensor.skipNextGap=false;if(sensor.firstLiveId==null){sensor.firstLiveId=sampleId;historyScheduleInitial(sensor);}
  }
  const tt=timeMs==null?st.nextTime:timeMs;
  if(sensor===activeSensor)appendSample(raw,timeMs,sampleId);else appendRawOnly(st,raw,timeMs,sampleId);
  if(sensor.ovl.cfg.maxMg>0&&sensor.hasOwnCal)overloadStep(sensor,tt,calibrateAbsolute(raw,st.calPrepared).valueMg);
  return true;
}
function appendRawOnly(st,raw,timeMs,sampleId){
  withState(st,()=>{
    if(state.unlimited&&state.count===state.capacity)resizeBuffers(state.capacity+100000);
    const t=timeMs==null?state.nextTime:timeMs;
    let w;if(state.count<state.capacity){w=physicalIndex(state.count);state.count++;}else{state.head=(state.head+1)%state.capacity;w=physicalIndex(state.count-1);}
    state.times[w]=t;state.raw[w]=raw;state.ids[w]=Number.isFinite(sampleId)?sampleId:NaN;state.nextTime=t+1000/state.rateHz;state.appended++;
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
    withState(old,()=>{if(old.maRebuildTimer){clearTimeout(old.maRebuildTimer);old.maRebuildTimer=null;if(old.derivedReady)rebuildDerived();}cancelMeasurement('another sensor was selected');cancelCharRec('another sensor was selected');});
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
  $('windowRange').value=windowToSlider(state.window);$('windowInput').value=state.window;syncWindowSeconds();$('bufferInput').value=state.unlimited?'unlimited':String(state.capacity);
  $('yControlsToggle').checked=state.manualY;$('yControls').hidden=!state.manualY;
  if(state.manualY){$('yMinRange').value=state.yMin;$('yMaxRange').value=state.yMax;$('yMinText').textContent=fmtNumber(state.yMin,3);$('yMaxText').textContent=fmtNumber(state.yMax,3);}
  $('bandModeSelect').value=bandMode;$('simModeSelect').value=state.simMode;$('simControls').hidden=!sim;$('testSamplesBtn').hidden=!sim;
  $('headerSub').textContent=`${RATE_HZ} Hz sensor stream · calibrated mass · local-only session`;
  if(sim)$('sourceNote').textContent='Test signal: bounded marching randomness';else if(activeSensor.kind==='archive')$('sourceNote').textContent='Earlier epoch: a read-only copy of a sample buffer that ended at a restart or configuration change';else updateSourceNote();
  $('measRateText').textContent=String(RATE_HZ);syncMeasurementInputs('samples');
  setSelectMode(false);
  if(state.selection)updateSelectionReadout();else $('selectionSummary').innerHTML=SELECTION_DEFAULT_HTML;
  renderLog();updateCalibrationInfo();updateStatusUI();renderSensorSelect();updateViewLabel();updateMeasurementUI();renderAuxToggles();
}
// ===== v17: SAMPLE EPOCHS (restart / configuration change) ====================================================================================
// A device restart (new bootId) restarts the monotonic clock and the sample ids; a changed configRevision of a sensor changes what a raw value means.
// In both cases the samples collected so far are NEVER deleted: the old buffer becomes a read-only "archive" entry in the sensor list (id "<sensor>@<epoch>"),
// and the live sensor continues with a fresh buffer. The break is written to the logs of both.
const EPOCH_COPY_KEYS=['unitId','precision','estimator','trimPercent','emaTau','hampelHalf','hampelSigma','window','activeWindow','manualY','yMin','yMax','liveWindowSpan'];
function resetSensorLinkState(sensor,opts){
  sensor.firstLiveId=null;sensor.skipNextGap=true;sensor.gaps=[];sensor.gapCount=0;sensor.err=null;sensor.fw={overload:null,underload:null};
  sensor.history={status:'idle',loaded:0,running:false,error:null,minId:null,autoStarted:!!opts.configChange,noOlder:!!opts.configChange};   // after a configuration change older history has another meaning: not loaded
}
function repointActive(){
  state=activeSensor.state;CALIBRATION=state.calConfig;calibration=state.calPrepared;RATE_HZ=state.rateHz;PERIOD_MS=1000/RATE_HZ;
  prepareStateForDisplay();state.snapY=true;state.autoYMin=null;state.autoYMax=null;state.lastFrameTs=0;
  if(state.live)fitLiveWindow();else clampHistoricalView();
  syncUIFromState();if(window.uPlot)createCharts();if(wiz.open)wizRender();scheduleRender();
}
function startNewEpoch(sensor,reason,opts={}){
  const old=sensor.state,wasActive=sensor===activeSensor,out={archived:null},rate=Number.isFinite(opts.rateHz)&&opts.rateHz>0?opts.rateHz:old.rateHz;
  if(!old.count){
    old.timeOrigin=opts.keepOrigin?old.timeOrigin:null;old.nextTime=0;old.rateHz=rate;resetSensorLinkState(sensor,opts);
    if(wasActive&&rate!==RATE_HZ)setSensorRate(sensor,rate);
    return out;
  }
  if(wasActive){withState(old,()=>{cancelMeasurement('a new sample epoch started');cancelCharRec('a new sample epoch started');});old.hoverRange=null;hideEventTip();destroyCharts();}
  const wasPaused=old.paused,archId=`${sensor.id}@${sensor.epochNo}`;
  const arch={id:archId,name:`${sensor.name} · earlier epoch ${sensor.epochNo} (${reason})`,kind:'archive',parentId:sensor.id,sseUrl:null,rawFormat:sensor.rawFormat,details:{},settings:{notes:'',calibrationFile:sensor.settings.calibrationFile||null,primaryTemperatureSensorId:sensor.settings.primaryTemperatureSensorId||null},unlisted:false,disabled:false,
    ovl:newOverloadState(),firstLiveId:null,skipNextGap:false,gaps:[],gapCount:0,history:{status:'archived',loaded:0,running:false,error:null,minId:null,autoStarted:true},fw:{overload:null,underload:null},err:null,epochNo:0,state:old};
  old.paused=true;sensors.set(archId,arch);sensor.epochNo++;out.archived=archId;
  const fresh=createSensorState({rateHz:rate,lazy:!wasActive,unitId:old.unitId});
  for(const k of EPOCH_COPY_KEYS)fresh[k]=old[k];
  fresh.window=Math.min(old.window,fresh.capacity);fresh.auxHidden=new Set(old.auxHidden);
  fresh.calConfig=old.calConfig;fresh.calPrepared=old.calPrepared;fresh.revisionId=old.revisionId;fresh.hashType=old.hashType;fresh.fullHash=old.fullHash;
  fresh.calibrations=[{effectiveFromTime:-Infinity,revisionId:old.revisionId,profileId:old.calConfig.profileId,hashType:old.hashType,config:old.calPrepared,source:'carried over to the new epoch'}];
  fresh.paused=wasPaused;fresh.timeOrigin=opts.keepOrigin?old.timeOrigin:null;fresh.lastWall=old.lastWall;
  const stamp=new Date().toISOString();
  fresh.logs=[{type:'note',entryId:`note-${Date.now()}-e`,createdAt:stamp,text:`New sample epoch: ${reason}. The earlier samples were kept as “${arch.name}” (select it in the sensor list).`}];
  old.logs.unshift({type:'note',entryId:`note-${Date.now()}-x`,createdAt:stamp,text:`This epoch ended: ${reason}.`});
  sensor.state=fresh;resetSensorLinkState(sensor,opts);
  sensor.ovl.q=[];sensor.ovl.active=null;sensor.ovl.current=null;
  for(const ch of auxChannels.values())if(!ch.archived&&ch.attachedTo.includes(sensor.id))ch.archiveAttach.add(archId);   // same clock: the live channel also explains the old epoch
  if(wasActive)repointActive();
  renderSensorSelect();updateStatusUI();
  return out;
}
// an auxiliary channel whose own configuration changed: its buffer is kept as an archived (unattached) channel
function archiveAuxChannel(ch,reason,attachedMap){
  if(ch.buf.count){
    const id=`${ch.id}@${ch.epochNo||1}`;
    auxChannels.set(id,Object.assign({},ch,{id,name:`${ch.name} · earlier epoch (${reason})`,archived:true,paused:true,unlisted:false,sseUrl:null,attachedTo:attachedMap?ch.attachedTo.map(x=>attachedMap.get(x)).filter(Boolean):[],archiveAttach:new Set(),gaps:[],gapCount:0,history:{...ch.history,status:'archived',running:false,autoStarted:true}}));
    ch.epochNo=(ch.epochNo||1)+1;
  }
  ch.buf=auxNewBuffer(ch.buf.cap);ch.archiveAttach=new Set();ch.gaps=[];ch.gapCount=0;ch.skipNextGap=true;ch.firstLiveId=null;ch.err=null;
  ch.history={status:'idle',loaded:0,running:false,error:null,minId:null,autoStarted:false};
}
function onBootChanged(prev,cur,via){
  deviceLogLocal('webui_boot',`Device restarted (boot ${prev} → ${cur}, noticed via ${via}). Samples collected so far are kept as earlier epochs; the clock and the sample ids start again.`,{previous:prev,current:cur});
  deviceOrigins.clear();if(via!=='status')csrfToken=null;deviceState=null;
  const map=new Map();
  for(const s of [...sensors.values()])if(s.kind==='server'){const r=startNewEpoch(s,`device restarted (boot ${prev} → ${cur})`);if(r.archived)map.set(s.id,r.archived);s.configRev=null;s.warnRev=null;s.status=null;}
  for(const c of [...auxChannels.values()])if(!c.archived){archiveAuxChannel(c,`device restarted (boot ${prev} → ${cur})`,map);c.configRev=null;}
  if(typeof fetch!=='undefined'){pollStatus();loadDeviceLog();}
  renderSensorSelect();updateStatusUI();
}
function setSubPixel(on){subPixel=!!on;const t=$('subPixelToggle');if(t)t.checked=subPixel;if(state&&state.mainPlot){destroyCharts();createCharts();}scheduleRender();}
function setBandMode(m){bandMode=BAND_MODES[m]?m:'symmetric';if(state){state.curveCache={key:'',map:new Map()};recreateMainChart();}const s=$('bandModeSelect');if(s)s.value=bandMode;scheduleRender();}
// ---- clearing (v15) -------------------------------------------------------------------------------------------------------
// scope 'data': the sample buffer of one sensor is emptied (tares, calibrations, logs, settings stay; time keeps running).
// scope 'all' : additionally tares, log, measurements, overload events, gaps. Calibrations are never touched.
function clearSensorData(sensor,scope){
  const st=sensor.state;
  if(sensor===activeSensor){cancelMeasurement('charts cleared');cancelCharRec('charts cleared');}
  withState(st,()=>{
    state.count=0;state.head=0;state.appended=0;state.unprocessed=0;
    state.rawSum=state.rawSumSq=state.rawCount=0;state.rawRef=null;state.massSum=state.massSumSq=state.massCount=0;state.massRef=null;
    state.rawEma=state.rawEmaTime=state.massEma=state.massEmaTime=null;state.rollingTareId=null;
    state.curveCache={key:'',map:new Map()};state.miniCache={key:'',map:new Map()};state.pmNeff=null;state.pmStab=null;
    state.selection=null;state.pendingSelection=null;state.highlight=null;state.logPinned=null;state.hoverRange=null;state.measurement=null;
    state.autoYMin=null;state.autoYMax=null;state.snapY=true;state.viewMin=0;state.viewMax=1000/state.rateHz;state.live=true;state.trackPaused=false;
    sensor.gaps=[];sensor.gapCount=0;sensor.skipNextGap=true;
    if(scope==='all'){state.tareEvents=[];state.logs=[];state.lastMeasurement=null;state.detailsOpen={};sensor.ovl.events=[];}
    sensor.ovl.active=null;sensor.ovl.q=[];sensor.ovl.current=null;
  });
  if(sensor===activeSensor){renderLog();$('selectionSummary').innerHTML=SELECTION_DEFAULT_HTML;updateMeasurementUI();updateViewLabel();updateOverloadBanner();scheduleRender();}
}
function uiConfirm(text){return typeof confirm==='function'?confirm(text):true;}
function clearCharts(){if(uiConfirm('Clear the chart data of the shown sensor? Calibration, tares and the log stay.'))clearSensorData(activeSensor,'data');}
function clearAllCharts(){if(uiConfirm('Clear the chart data of ALL sensors and auxiliary channels? Calibrations, tares and logs stay.')){for(const s of sensors.values())clearSensorData(s,'data');for(const c of auxChannels.values())auxClear(c);}}
function clearAll(){if(uiConfirm('Clear EVERYTHING of ALL sensors: chart data, tares, logs, measurements and overload events? Calibrations stay.')){for(const s of sensors.values())clearSensorData(s,'all');for(const c of auxChannels.values())auxClear(c);}}
function setNavPanelVisible(on){$('navPanel').hidden=!on;$('sidePanels').classList.toggle('nav-hidden',!on);$('navPanelToggle').checked=on;}

// ---- pause, links, status -----------------------------------------------------------------------
function sensorLink(s){
  if(s.kind==='archive')return{key:'archived',text:'Earlier epoch (read-only copy)'};
  if(s.disabled)return{key:'disabled',text:'Disabled on the device'};
  if(s.err&&s.err.state!=='ok')return{key:'sensorerr',text:`Sensor ${s.err.state}: ${s.err.message||s.err.code||''}`};
  if(s.state.paused)return{key:'paused',text:'Paused'};
  if(s.kind==='test'){const age=sensorStaleMs(s,performance.now());return age>0?{key:'timeout',text:`No data for ${(age/1000).toFixed(0)} s`}:{key:'live',text:'Streaming'};}
  if(s.unlisted)return{key:'unlisted',text:'Not in the server list (no data)'};
  if(!s.sseUrl)return{key:'idle',text:'No SSE URL'};
  const c=sseConnections.get(s.sseUrl);
  if(!c)return{key:'idle',text:'Not connected'};
  if(c.status==='live'){const age=sensorStaleMs(s,performance.now());if(age>0)return{key:'timeout',text:`No data for ${(age/1000).toFixed(0)} s`};}
  return c.status==='live'?{key:'live',text:'Streaming'}:c.status==='error'?{key:'error',text:'Connection failed'}:{key:'connecting',text:'Connecting…'};
}
const LINK_ICON={archived:'▣',disabled:'⊘',sensorerr:'⚠',timeout:'⏱',live:'●',connecting:'◌',paused:'Ⅱ',error:'⚠',idle:'○',unlisted:'⊘'};
function updateStatusUI(){
  // v13: "streaming" counts only sensors whose link is really live (test signal running, or a server connection that
  // is open). Before, every listed, un-paused sensor counted as recording even when its URL could not be reached.
  const s=activeSensor,link=sensorLink(s),all=[...sensors.values()].filter(x=>x.kind!=='archive'),live=all.filter(x=>sensorLink(x).key==='live').length;
  $('statusText').textContent=link.text+(chartsPending?' · loading chart':'')+(all.length>1?` · ${live} of ${all.length} sensors streaming`:'')+(pendingChanges&&pendingChanges.length?` · pending: ${pendingChanges.join(', ')}`:'')+(deviceState&&deviceState.state&&deviceState.state!=='running'&&deviceState.state!=='ok'?` · device: ${deviceState.state}`:'');
  $('statusDot').classList.toggle('paused',link.key!=='live');
  const anyOn=all.some(x=>!x.state.paused&&!x.unlisted)||[...auxChannels.values()].some(c=>!c.paused&&!c.unlisted);
  $('pauseBtn').textContent=s.state.paused?'▶ Resume':'Ⅱ Pause';
  $('pauseAllBtn').textContent=anyOn?'Ⅱ Pause all':'▶ Resume all';
}
function renderSensorSelect(){
  const sel=$('sensorSelect');sel.innerHTML='';
  for(const s of [...sensors.values()].sort((a,b)=>(a.kind==='test')-(b.kind==='test'))){const o=document.createElement('option');o.value=s.id;o.textContent=`${LINK_ICON[sensorLink(s).key]||'○'} ${s.name}${s.unlisted?' (not in list)':''}`;sel.appendChild(o);}
  sel.value=activeSensor.id;
}
function setSensorPaused(s,paused,quiet=false){
  s.state.paused=paused;s.state.simBase=null;if(!paused){s.skipNextGap=true;s.state.lastWall=performance.now();}   // data thrown away while paused is not a gap to be refilled
  if(!quiet){syncConnections();renderSensorSelect();updateStatusUI();}
}
// Pause all / resume all. If anything is recording, everything is paused; otherwise everything resumes.
function pauseAllToggle(){
  const live=[...sensors.values()].filter(s=>s.kind!=='archive'),liveAux=[...auxChannels.values()].filter(c=>!c.archived),anyRunning=live.some(s=>!s.state.paused)||liveAux.some(c=>!c.paused);
  for(const s of live)setSensorPaused(s,anyRunning,true);
  for(const c of liveAux)setAuxPaused(c,anyRunning,true);
  syncConnections();renderSensorSelect();updateStatusUI();
}

// ---- SSE ----------------------------------------------------------------------------------------
// One EventSource per distinct URL. Sensors that share a URL share the connection (the server sends the
// samples of all of them through it). A connection exists only while at least one sensor that uses it is
// listed and not paused; pausing the last such sensor closes it, resuming reopens it.
// ASSUMED message format (nothing is specified yet - adapt here): every 'message' event carries JSON,
// either one sample, an array of samples, or {"samples":[...]}; a sample is {"id":"<sensor id>","t":<device
// time in ms>,"raw":<integer counts>,"n":<monotonic sample id, optional but needed for history and gap filling>}. The server should also put
// the id of the LAST sample of an event into the SSE 'id:' field, so that EventSource reconnects with Last-Event-ID. Timestamps are authoritative; the first accepted timestamp of a
// sensor becomes its time origin (so the chart starts at 0 s).
const sseConnections=new Map();
const sseStats={unknown:0,bad:0};
// ===== v17: DEVICE LAYER: status, boot detection, CSRF, device log, units, startup =============================================
// Startup (protocol §3): status + device -> units / files / webui-settings -> sensors.json (+ the calibration each sensor names) -> status again -> device log
// -> only then the ONE multiplexed /stream is opened (startupHold), so no sample arrives before the sensor list and calibrations exist.
let deviceSeen = false, statusFails = 0, startupHold = false, deviceReachable = false, deviceBootId = null, deviceStatus = null, deviceInfo = null, deviceInfoError = null, csrfToken = null, pendingChanges = [], deviceFiles = null, deviceState = null, sensorsDocRaw = null, statusPromise = null, statusError = '', startupNotes = [];
const deviceLog = [], deviceLogKeys = new Set(), DEVICE_LOG_MAX = 1000;
function deviceOnline() { return deviceReachable; }
async function httpErrorText(r) {
  let body = ''; try { body = await r.text(); } catch (_) {}
  let msg = ''; try { const j = JSON.parse(body); if (j && j.error) msg = `${j.error.message || j.error.code || ''}${j.error.code && j.error.message ? ` [${j.error.code}]` : ''}${j.error.details ? ' ' + JSON.stringify(j.error.details) : ''}`; else msg = body.trim().slice(0, 300); } catch (_) { msg = body.trim().slice(0, 300); }
  const hint = r.status === 401 ? 'password needed or not accepted' : r.status === 403 ? 'CSRF token rejected' : r.status === 413 ? `request larger than the device limit${deviceInfo && deviceInfo.maxUploadBytes ? ` (${deviceInfo.maxUploadBytes} bytes)` : ''}` : r.status === 507 ? 'not enough flash space on the device' : '';
  return `HTTP ${r.status}${hint ? ' (' + hint + ')' : ''}${msg ? ': ' + msg : ''}`;
}
async function fetchWire(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(await httpErrorText(r));
  return parseWire(await r.text());
}
// PUT / DELETE answer {status, saved, errors, warnings, pendingChanges} (also calibration and asset uploads)
async function writeResult(r) {
  let j = null; try { j = parseWire(await r.text()); } catch (_) {}
  if (j && Array.isArray(j.pendingChanges)) { pendingChanges = j.pendingChanges; updateStatusUI(); }
  return j || {};
}
function writeResultText(j) {
  if (!j || !j.status) return 'saved';
  const p = [`status: ${j.status}`], f = a => (a || []).map(w => typeof w === 'string' ? w : JSON.stringify(w)).join('; ');
  if (j.warnings && j.warnings.length) p.push('warnings: ' + f(j.warnings)); if (j.errors && j.errors.length) p.push('errors: ' + f(j.errors));
  if (j.status === 'needs-sensor-reconfig') p.push('saved, but the device must reconfigure the sensor driver before it is active');
  if (j.status === 'needs-restart') p.push('saved, but a device restart is needed (Settings Menu → Device)');
  return p.join(' · ');
}
function pollStatus() {
  if (typeof fetch === 'undefined') return Promise.resolve(null);
  if (statusPromise) return statusPromise;
  statusPromise = (async () => {
    try { const st = await fetchWire(STATUS_URL); deviceReachable = true; deviceSeen = true; statusFails = 0; statusError = ''; handleStatus(st); return st; }
    catch (e) { statusFails++; statusError = e.message; if (statusFails >= 3 || !deviceSeen) deviceReachable = false; updateStatusUI(); updateDeviceInfoUI(); return null; }
    finally { statusPromise = null; }
  })();
  return statusPromise;
}
let statusTick = 0;
function statusTimer() { statusTick++; if (!deviceReachable && statusTick % 10 !== 0) return; pollStatus(); }
function noteBootId(id, via) {
  if (!id || id === deviceBootId) return;
  const prev = deviceBootId; deviceBootId = id;
  if (prev == null) return;
  onBootChanged(prev, id, via);
}
function handleStatus(st) {
  deviceStatus = st; if (typeof st.csrfToken === 'string') csrfToken = st.csrfToken;
  if (typeof st.bootId === 'string') noteBootId(st.bootId, 'status');
  pendingChanges = Array.isArray(st.pendingChanges) ? st.pendingChanges : [];
  for (const e of st.sensors || []) {
    const key = String(toNum(e.sensorId)), s = sensors.get(key), ac = auxChannels.get(key);
    if (s && s.kind === 'server') {
      s.status = e;
      if (Number.isFinite(e.oldestId)) s.history.minId = Math.max(s.history.minId == null ? 0 : s.history.minId, e.oldestId);   // ids the ring buffer already evicted are not requested
      if (Number.isFinite(e.rate_hz) && e.rate_hz > 0 && s.state.count === 0 && s.state.rateHz !== e.rate_hz) setSensorRate(s, e.rate_hz);   // the effective rate wins over the requested one
      // a changed configRevision (type, rawFormat, effective rate, driver measurement config, buffer clear) starts a new sample epoch; warningRevision is ignored on purpose
      if (s.configRev != null && e.configRevision !== s.configRev) { startNewEpoch(s, `sensor configuration changed (revision ${s.configRev} → ${e.configRevision})`, { keepOrigin: true, configChange: true, rateHz: e.rate_hz }); deviceLogLocal('webui_epoch', `${s.name}: configuration revision ${s.configRev} → ${e.configRevision}; a new sample epoch started and the earlier samples were kept.`, { sensorId: s.id }); setTimeout(() => loadSensorList(), 0); }
      s.configRev = e.configRevision; s.warnRev = e.warningRevision;
    } else if (ac && !ac.archived) {
      if (ac.configRev != null && e.configRevision !== ac.configRev) { archiveAuxChannel(ac, `configuration changed (revision ${ac.configRev} → ${e.configRevision})`); deviceLogLocal('webui_epoch', `${ac.name}: configuration revision ${ac.configRev} → ${e.configRevision}; the earlier samples of this channel were kept as an archived channel.`, { sensorId: ac.id }); setTimeout(() => loadSensorList(), 0); }
      ac.configRev = e.configRevision; ac.status = e;
    }
  }
  updateStatusUI(); updateDeviceInfoUI();
}
function checkDeviceVersions() {
  startupNotes = []; const d = deviceInfo; if (!d) return;
  if (d.protocolVersion !== PROTOCOL_VERSION) startupNotes.push(`The device speaks protocol version ${d.protocolVersion}; this WebUI is written for ${PROTOCOL_VERSION}.`);
  const f = d.fileFormatVersions || {}; for (const k of ['sensors', 'units', 'webuiSettings', 'calibration', 'historyBinary']) if (f[k] != null && f[k] !== 1) startupNotes.push(`File format “${k}” has version ${f[k]}; this WebUI understands version 1.`);
}
// ---- device log (entries from /api/device-log and the SSE event device_log; WebUI-side notes are added as local entries) ----
function addDeviceLogEntry(e, via) {
  if (!e || typeof e !== 'object') return;
  const id = e.logEntryId == null ? null : toNum(e.logEntryId), key = id == null ? null : `${deviceBootId}:${id}`;
  if (key && deviceLogKeys.has(key)) return;
  if (key) deviceLogKeys.add(key);
  deviceLog.push({ logEntryId: id, t: e.t == null ? null : toNum(e.t), type: String(e.type || 'unknown'), message: String(e.message || ''), details: e.details || null, bootId: deviceBootId, via, local: false });
  if (deviceLog.length > DEVICE_LOG_MAX) deviceLog.splice(0, deviceLog.length - DEVICE_LOG_MAX);
  renderDeviceLog();
}
function deviceLogLocal(type, message, details) {
  deviceLog.push({ logEntryId: null, t: null, type, message, details: details || null, bootId: deviceBootId, via: 'webui', local: true, wall: Date.now() });
  if (deviceLog.length > DEVICE_LOG_MAX) deviceLog.splice(0, deviceLog.length - DEVICE_LOG_MAX);
  renderDeviceLog();
}
function renderDeviceLog() {
  const list = $('deviceLogList'); if (!list) return; const c = $('deviceLogCount'); if (c) c.textContent = `(${deviceLog.length} entries)`;
  if (!deviceLog.length) { setHTML(list, '<div class="small" style="padding:10px 0">No device log entries.</div>'); return; }
  setHTML(list, deviceLog.slice(-200).reverse().map(e => `<div class="log-row ${e.local ? 'calibration' : 'note'}"><time>${e.t != null ? (e.t / 1e6).toFixed(1) + ' s' : new Date(e.wall || Date.now()).toLocaleTimeString()}</time><div><strong>${esc(e.type)}</strong> ${esc(e.message)}${e.details ? `<br><span class="small">${esc(JSON.stringify(e.details))}</span>` : ''}<br><span class="small">boot ${esc(e.bootId || '?')}${e.logEntryId != null ? ' · entry ' + e.logEntryId : ''}${e.local ? ' · WebUI note' : ''}</span></div></div>`).join(''));
}
async function loadDeviceLog() {
  if (typeof fetch === 'undefined' || !deviceReachable) return;
  try { const doc = await fetchWire(DEVICE_LOG_URL); for (const e of (doc && doc.entries) || []) addDeviceLogEntry(e, 'fetch'); } catch (e) { deviceLogLocal('webui_error', `Could not read ${DEVICE_LOG_URL}: ${e.message}`); }
}
// ---- units.json (WebUI-owned table; the embedded one is the fallback) ----
function validateUnitsDoc(d) {
  const er = [];
  if (!d || typeof d !== 'object' || Array.isArray(d)) return ['The top level must be a JSON object.'];
  if (d.schemaVersion !== 1) er.push('schemaVersion must be 1.');
  if (d.baseUnit !== 'mg') er.push('baseUnit must be "mg" (all masses are stored in milligrams).');
  if (typeof d.defaultUnit !== 'string') er.push('defaultUnit must be a text.');
  if (!Array.isArray(d.units) || !d.units.length) { er.push('units must be a non-empty list.'); return er; }
  const ids = new Set();
  for (const u of d.units) { if (!u || typeof u.id !== 'string' || typeof u.symbol !== 'string') { er.push('Every unit needs an id and a symbol.'); continue; } if (ids.has(u.id)) er.push(`Duplicate unit id “${u.id}”.`); ids.add(u.id); if (u.factor !== null && !(typeof u.factor === 'number' && u.factor > 0)) er.push(`Unit “${u.id}”: factor must be a number greater than 0 (or null for raw counts).`); if (u.id === 'raw' && u.factor !== null) er.push('The raw entry must have factor null.'); if (u.id !== 'raw' && u.factor === null) er.push(`Unit “${u.id}”: only raw may have factor null.`); }
  if (typeof d.defaultUnit === 'string' && !ids.has(d.defaultUnit)) er.push('defaultUnit is not in the units list.');
  if (d.defaultUnit === 'raw') er.push('defaultUnit must be a mass unit.');
  return er;
}
function populateUnitSelect() {
  const select = $('unitSelect'); select.innerHTML = '';
  for (const group of [...new Set(UNIT_CONFIG.units.map(u => u.group))]) { const og = document.createElement('optgroup'); og.label = group || 'Other'; for (const unit of UNIT_CONFIG.units.filter(u => u.group === group)) { const o = document.createElement('option'); o.value = unit.id; o.textContent = `${unit.name || unit.id}${unit.id === 'raw' ? '' : ' (' + unit.symbol + ')'}`; og.appendChild(o); } select.appendChild(og); }
  select.value = state.unitId;
  const u = $('ssLoadUnit'); if (u) { u.innerHTML = ''; for (const x of UNIT_CONFIG.units.filter(x => x.id !== 'raw')) { const o = document.createElement('option'); o.value = x.id; o.textContent = x.symbol; u.appendChild(o); } }
}
function applyUnitsDoc(doc) {
  const er = validateUnitsDoc(doc); if (er.length) return er;
  const next = cloneJson(doc); if (!next.units.some(u => u.id === 'raw')) next.units.push(UNIT_EMBEDDED.units.find(u => u.id === 'raw'));
  UNIT_CONFIG = next;
  for (const s of sensors.values()) { const st = s.state; if (!UNIT_CONFIG.units.some(u => u.id === st.unitId)) st.unitId = st === state ? UNIT_CONFIG.defaultUnit : SERVER_SENSOR_DEFAULT_UNIT; }
  populateUnitSelect(); scheduleRender(); return [];
}
// ---- calibration files known to the device (from /api/files) ----
function indexCalibrationFiles(files) {
  for (const f of (files && files.files) || []) {
    if (f.kind !== 'calibration') continue;
    const name = String(f.path || '').split('/').pop(), m = /^calibration_(\d+)_([A-Za-z0-9._-]+)\.json$/.exec(name); if (!m) continue;
    const e = calLibrary.get(name); if (e) { e.sizeBytes = f.sizeBytes; e.onDevice = true; } else calLibrary.set(name, { name, config: null, sensorId: m[1], profileName: m[2], sizeBytes: f.sizeBytes, onDevice: true });
  }
}
async function deviceStartup() {
  if (typeof fetch === 'undefined') { startupHold = false; return false; }
  startupHold = true;
  try {
    const st = await pollStatus();
    if (!st) { setSensorListInfo('No device reachable (GET /api/status failed). Only the test signal is available.'); return false; }
    try { deviceInfo = await fetchWire(DEVICE_URL); checkDeviceVersions(); } catch (e) { deviceInfoError = e.message; }
    const jobs = await Promise.allSettled([fetchWire(UNITS_URL), fetchWire(FILES_URL), uiFetchServerDefault()]);
    if (jobs[0].status === 'fulfilled') { const er = applyUnitsDoc(jobs[0].value); if (er.length) startupNotes.push('units.json not used (the embedded table stays): ' + er.join(' ')); } else startupNotes.push('units.json not available (embedded table used): ' + jobs[0].reason.message);
    if (jobs[1].status === 'fulfilled') { deviceFiles = jobs[1].value; indexCalibrationFiles(deviceFiles); }
    if (jobs[2].status === 'fulfilled' && jobs[2].value && !uiLocalRead()) applyUiSettings(jobs[2].value);
    updateUiSettingsInfo(); startUPlot();
    await loadSensorList(); await pollStatus(); await loadDeviceLog(); selectDefaultSensor();
    return true;
  } finally { startupHold = false; syncConnections(); updateDeviceInfoUI(); updateSettingsAvailability(); }
}
function deviceMsg(t) { const el = $('deviceMessages'); if (el) el.textContent = t; }
function updateSettingsAvailability() {
  const on = deviceReachable;
  for (const id of ['calUploadBtn', 'deviceRestartBtn', 'deviceResetBtn']) { const b = $(id); if (b) b.disabled = !on; }
  const r = $('sensorReloadBtn'); if (r) r.disabled = !on;
}
function updateDeviceInfoUI() {
  const el = $('deviceInfo'); if (!el) return; updateSettingsAvailability();
  if (!deviceReachable) { setHTML(el, `No device connection (local test signal only).${statusError ? ' <span class="small">Last error: ' + esc(statusError) + '</span>' : ''}`); return; }
  const d = deviceInfo || {}, s = deviceStatus || {}, fl = s.flash || {}, mem = s.memory || {}, w = s.wifi || {}, chip = d.chip || {};
  setHTML(el, `<strong>${esc(d.product || d.productName || 'OpenScale device')}</strong> · firmware ${esc(d.firmwareVersion || (d.firmware && d.firmware.version) || '?')}${chip.model ? ' · ' + esc(chip.model) : ''}<br>Boot <strong>${esc(s.bootId || '?')}</strong> · uptime ${s.uptimeUs != null ? fmtSpan(Number(s.uptimeUs) / 1e6) : '—'} · SSE clients ${s.openSseConnections ?? '—'}<br>Flash: ${fmtBytes(fl.filesystemFree)} free of ${fmtBytes(fl.filesystemTotal)} · upload limit ${fmtBytes(d.maxUploadBytes)} · history chunk ${d.maxHistoryChunk ?? '—'} samples<br>Heap free ${fmtBytes(mem.heapFree)} · Wi-Fi ${w.connected ? 'connected ' + esc(w.ip || '') + ' (' + w.rssi + ' dBm)' : 'not connected'}${pendingChanges.length ? `<br><span class="warning">Saved but not active yet: ${esc(pendingChanges.join(', '))}</span>` : ''}${deviceState && deviceState.state ? `<br>Device state: <strong>${esc(deviceState.state)}</strong> ${esc(deviceState.message || '')}` : ''}${startupNotes.map(n => `<br><span class="warning">${esc(n)}</span>`).join('')}`);
}
async function deviceRestart() {
  if (!deviceReachable) { deviceMsg('No device connection.'); return; }
  if (!uiConfirm('Restart the device now? Streaming stops for a moment. The chart data already collected stays in this browser as an earlier epoch.')) return;
  try { const r = await serverWrite(RESTART_URL, { method: 'POST' }); if (!r.ok) throw new Error(await httpErrorText(r)); deviceMsg('Restart requested.'); } catch (e) { deviceMsg(`Restart failed: ${e.message}`); }
}
const RESETTABLE_FILES = ['sensors.json', 'units.json', 'webui-settings.json', 'settings.json', 'wifi.json'];
async function deviceResetFile(name) {
  if (!RESETTABLE_FILES.includes(name)) return;
  let text = `Reset ${name} on the device to its factory default?`;
  if (name === 'settings.json') text += '\n\nWARNING: this also REMOVES THE ADMINISTRATOR PASSWORD and resets hostname, buffer and HTTPS settings.';
  if (name === 'wifi.json') text += '\n\nWARNING: all saved Wi-Fi networks are removed. The device may only be reachable through its fallback access point afterwards.';
  if (name === 'sensors.json') text += '\n\nAll sensor definitions (GPIOs, rates, calibration links, limits, conversions) are removed.';
  if (!uiConfirm(text)) return;
  try {
    const r = await serverWrite(`/data/settings/${name}`, { method: 'DELETE' }); if (!r.ok) throw new Error(await httpErrorText(r));
    const j = await writeResult(r); deviceMsg(`${name} reset (${writeResultText(j)}).`);
    if (name === 'units.json') { try { applyUnitsDoc(await fetchWire(UNITS_URL)); } catch (_) {} } else if (name === 'sensors.json') loadSensorList(); else if (name === 'webui-settings.json') { uiServerDefault = null; await uiFetchServerDefault(); updateUiSettingsInfo(); }
  } catch (e) { deviceMsg(`Could not reset ${name}: ${e.message}`); }
}

function wantedConnections(){
  const want=new Map();if(startupHold)return want;
  const ids=new Set();
  for(const s of sensors.values()){if(s.kind!=='server'||s.unlisted||s.disabled||s.state.paused)continue;ids.add(s.id);}
  for(const c of auxChannels.values()){if(c.archived||c.unlisted||c.disabled||c.paused)continue;ids.add(c.id);}
  if(ids.size)want.set(STREAM_URL,ids);   // protocol v0.5: ONE multiplexed stream for all sensors and device events
  return want;
}
const SSE_EVENTS=['sample','warning','device','sensor_error','device_log'];
function syncConnections(){
  const want=wantedConnections();
  for(const [url,c] of [...sseConnections]){if(!want.has(url)){try{c.es&&c.es.close();}catch(_){}sseConnections.delete(url);}}
  for(const [url,ids] of want){
    let c=sseConnections.get(url);
    if(c){c.ids=ids;continue;}
    c={es:null,ids,status:'connecting',since:performance.now()};sseConnections.set(url,c);
    if(typeof EventSource==='undefined'){c.status='error';continue;}
    try{
      c.es=new EventSource(url);
      c.es.onopen=()=>{c.status='live';renderSensorSelect();updateStatusUI();pollStatus();};   // compare the boot id after every (re)connection
      c.es.onerror=()=>{c.status=c.es.readyState===2?'error':'connecting';renderSensorSelect();updateStatusUI();};
      if(c.es.addEventListener)for(const name of SSE_EVENTS)c.es.addEventListener(name,e=>handleSseEvent(name,e.data,e.lastEventId));
    }catch(_){c.status='error';}
  }
}
// One application event = one SSE message. The SSE id is "<bootId>-<counter>": its boot part is a second witness of a restart (the JSON payloads carry no bootId).
function handleSseEvent(name,data,eventId){
  if(eventId){const m=/^(.+)-\d+$/.exec(eventId);if(m)noteBootId(m[1],'sse');}
  let msg;try{msg=parseWire(data);}catch(_){sseStats.bad++;return;}
  if(name==='sample'){handleSampleMessage(msg);return;}
  if(name==='warning'){handleWarningEvent(msg);return;}
  if(name==='device'){handleDeviceEvent(msg);return;}
  if(name==='sensor_error'){handleSensorErrorEvent(msg);return;}
  if(name==='device_log'){addDeviceLogEntry(msg,'sse');return;}
  sseStats.unknown++;
}
function handleSampleMessage(msg){
  const items=Array.isArray(msg)?msg:(msg&&Array.isArray(msg.samples)?msg.samples:[msg]);   // the protocol sends one sample per event; arrays are tolerated
  let touched=false;
  for(const it of items){
    if(!it||typeof it!=='object'){sseStats.bad++;continue;}
    const key=String(toNum(it.sensorId)),s=sensors.get(key);
    if(s&&s.kind==='server'){if(ingestWire(s,it)&&s===activeSensor)touched=true;continue;}
    const ac=auxChannels.get(key);if(ac&&!ac.archived){handleAuxSample(ac,it);continue;}
    sseStats.unknown++;
  }
  if(touched)scheduleRender();
}
function ingestWire(s,it){
  const t=toNum(it.t),raw=decodeRaw(it.raw,s.rawFormat);
  if(!Number.isFinite(raw)||!Number.isFinite(t)){s.state.rejected++;return false;}
  if(s.state.paused){s.state.dropped++;return false;}
  const tms=t/1000;   // t is microseconds since boot (one clock for all sensors)
  if(s.state.timeOrigin==null)s.state.timeOrigin=claimDeviceOrigin(deviceIdOf(s),tms);
  const flags=Number(toNum(it.flags))||0;if(flags&FLAG_ANY_BAD)s.state.flagged=(s.state.flagged||0)+1;   // flags are counted, not stored per sample
  const sid=it.n==null?undefined:toNum(it.n),lastN=lastStoredId(s.state);
  if(Number.isFinite(sid)&&Number.isFinite(lastN)&&sid<lastN&&tms-s.state.timeOrigin<newestOf(s)-1000)backwardsSignal();   // n AND t went backwards: a defensive second hint of a restart (bootId stays authoritative)
  return ingestSample(s,raw,tms-s.state.timeOrigin,false,sid);
}
let lastBackSignal=-1e9;
function backwardsSignal(){const now=performance.now();if(now-lastBackSignal<2000)return;lastBackSignal=now;pollStatus();}
function newestOf(s){const st=s.state;return st.count?st.times[(st.head+st.count-1)%st.capacity]:0;}
// Firmware overload / underload warning (raw thresholds, on state change only). Shown in the banner and written to the sensor's log; the
// WebUI's own calibrated-weight monitor (loadLimits) is independent of it.
function handleWarningEvent(m){
  if(!m||m.type!=='sensor'||!m.sensor)return;
  const s=sensors.get(String(toNum(m.sensor.sensorId)));if(!s||s.kind!=='server')return;
  const code=m.code==='underload'?'underload':'overload',smp=m.sensor.sample||{},raw=smp.raw!=null?decodeRaw(smp.raw,s.rawFormat):NaN,thr=toNum(m.sensor.threshold),n=smp.n!=null?toNum(smp.n):null;
  const rel=smp.t!=null&&s.state.timeOrigin!=null?toNum(smp.t)/1000-s.state.timeOrigin:newestOf(s);
  s.fw[code]=m.active?{active:true,threshold:thr,raw,n}:null;
  s.state.logs.unshift({type:'fwwarning',entryId:`fwwarning-${Date.now()}-${s.state.logs.length}`,createdAt:new Date().toISOString(),code,active:!!m.active,threshold:thr,raw,n,effectiveFromTime:rel});
  if(s===activeSensor){renderLog();scheduleRender();}
  updateOverloadBanner();
}
function handleDeviceEvent(m){
  if(!m||typeof m!=='object')return;deviceState=m;
  deviceLogLocal('device_event',`${m.state||''}${m.message?': '+m.message:''}`,m.details||null);
  updateStatusUI();updateDeviceInfoUI();
}
function handleSensorErrorEvent(m){
  if(!m)return;const key=String(toNum(m.sensorId)),o=sensors.get(key)||auxChannels.get(key);if(!o)return;
  o.err=m.state==='ok'?null:{state:m.state,code:m.code,message:m.message,fromN:m.fromN!=null?toNum(m.fromN):null,toN:m.toN!=null?toNum(m.toN):null};
  renderSensorSelect();updateStatusUI();
}
function fwWarningLineHTML(e){return `<strong>Firmware ${esc(e.code)} warning · ${e.active?'active':'cleared'}</strong><br>raw ${fmtNumber(e.raw,0)} · threshold ${fmtNumber(e.threshold,0)} (raw units)${e.n!=null?' · sample '+e.n:''}`;}
function fwBannerHTML(){
  let h='';
  for(const s of sensors.values()){if(s.kind!=='server'||!s.fw)continue;for(const code of['overload','underload']){const w=s.fw[code];if(w&&w.active)h+=`<div class="ovl-item ovl-red ovl-now" data-sensor="${esc(s.id)}" title="Click to show this sensor"><strong>⚠ ${esc(s.name)}: FIRMWARE ${code.toUpperCase()} WARNING</strong> raw ${fmtNumber(w.raw,0)} (threshold ${fmtNumber(w.threshold,0)}) · reported by the device</div>`;}}
  return h;
}

// ---- sensor list from the server ------------------------------------------------------------------
// Reloadable at any time. Known sensors (same id) keep their data, logs, tares and calibrations; only name,
// SSE URL and details are updated. New ids are added. Sensors missing from the new list are NOT deleted:
// they are marked 'not in list', stop receiving data and keep what was collected.
function applyDefToSettings(s,e,result){
  s.settings.notes=typeof e.notes==='string'?e.notes:'';
  if(s.settings.calibrationFile===undefined)s.settings.calibrationFile=typeof e.calibrationFile==='string'&&e.calibrationFile?e.calibrationFile:null;   // later changes in this session win until the list is loaded again after a restart
  s.settings.primaryTemperatureSensorId=e.primaryTemperatureSensorId==null?null:String(e.primaryTemperatureSensorId);
  if(e.loadLimits&&typeof e.loadLimits==='object'){const r=overloadApplySettings(s,e.loadLimits);if(r.errors.length)result.errors.push(`Sensor ${s.id}: loadLimits not applied (${r.errors.join(' ')})`);}
}
function setSensorRate(s,rate){s.state.rateHz=rate;if(s===activeSensor){RATE_HZ=rate;PERIOD_MS=1000/rate;syncUIFromState();}}
// sensors.json (protocol v0.5): {schemaVersion:1, sensors:[{id (number), name, notes, kind, type, enabled, unit, rawFormat, rate_hz, ringbuffer_size_samples, <driver>, warnings,
// calibrationFile, primaryTemperatureSensorId, loadLimits, attachedTo, conversion}]}. ESP-owned keys are read, WebUI-owned keys are applied. Reloadable at any time:
// known ids keep their data; missing ids are marked "not in list" and keep what was collected.
function applySensorList(list){
  const result={added:[],updated:[],unlisted:[],errors:[],auxAdded:[],auxUpdated:[],auxUnlisted:[]};
  const entries=list&&typeof list==='object'&&!Array.isArray(list)&&Array.isArray(list.sensors)?list.sensors:null;
  if(!entries){result.errors.push('The sensor document must be an object with a "sensors" array.');return result;}
  if(list.schemaVersion!==1){result.errors.push('schemaVersion must be 1.');return result;}
  sensorsDocRaw=cloneJson(list);
  const seen=new Set();
  for(const e of entries){
    if(!e||typeof e!=='object'||!Number.isInteger(e.id)||e.id<0){result.errors.push('An entry without a valid numeric id was skipped.');continue;}
    const id=String(e.id);
    if(seen.has(id)){result.errors.push(`Duplicate id ${id} skipped.`);continue;}
    const kind=e.kind==null?'loadcell':e.kind;
    if(!['loadcell','temperature','generic'].includes(kind)){result.errors.push(`Sensor ${id}: unknown kind “${e.kind}”. Use loadcell, temperature or generic.`);continue;}
    if(!RAW_FORMATS.has(e.rawFormat)){result.errors.push(`Sensor ${id}: rawFormat “${e.rawFormat}” is missing or unknown.`);continue;}
    const rate=Number(e.rate_hz);if(!(rate>0)){result.errors.push(`Sensor ${id}: rate_hz is missing or not a positive number.`);continue;}
    if(kind!=='loadcell'){if(applyAuxEntry(e,id,result,{kind,rf:e.rawFormat,rate}))seen.add(id);continue;}
    if(auxChannels.has(id)){result.errors.push(`The id ${id} is already an auxiliary channel.`);continue;}
    seen.add(id);
    const name=typeof e.name==='string'&&e.name.trim()?e.name.trim():`Sensor ${id}`,known=sensors.get(id);
    if(known&&known.kind==='server'){
      Object.assign(known,{name,sseUrl:STREAM_URL,rawFormat:e.rawFormat,def:cloneJson(e),unlisted:false,disabled:e.enabled===false,sensorType:e.type||null});
      if(!known.state.count&&known.state.rateHz!==rate)setSensorRate(known,rate);
      applyDefToSettings(known,e,result);result.updated.push(id);
    }else{
      const s=makeSensor({id,name,kind:'server',sseUrl:STREAM_URL,rateHz:rate});
      Object.assign(s,{rawFormat:e.rawFormat,def:cloneJson(e),disabled:e.enabled===false,sensorType:e.type||null});
      if(embeddedFp)initSensorCalibration(s.state,embeddedFp);
      applyDefToSettings(s,e,result);result.added.push(id);
    }
  }
  for(const s of sensors.values())if(s.kind==='server'&&!seen.has(s.id)&&!s.unlisted){s.unlisted=true;result.unlisted.push(s.id);}
  for(const c of auxChannels.values())if(!c.archived&&!seen.has(c.id)&&!c.unlisted){c.unlisted=true;result.auxUnlisted.push(c.id);}
  syncConnections();renderSensorSelect();updateStatusUI();renderAuxToggles();
  updateSourceNote();
  return result;
}
function setSensorListInfo(text){const el=$('sensorListInfo');if(el)el.textContent=text;}
// The calibration a sensor names in sensors.json becomes its active one at startup. Only for a sensor that holds no samples yet (every stored sample
// must keep the calibration it was recorded with), so no new epoch or tare reset is needed.
async function adoptCalibrationFile(s){
  const name=s.settings.calibrationFile;if(!name||s.state.count>0||s.settings.calibrationAdopted===name)return;
  try{
    let e=calLibrary.get(name);
    if(!e||!e.config){const cfg=await fetchWire(`${CALIBRATION_DIR}/${encodeURIComponent(name)}`);if(calFileName(cfg,s.id)!==name)throw new Error('the file name and the profile / sensor id inside the file disagree');calLibraryAdd(cfg,s.id);e=calLibrary.get(name);}
    const checked=validateCalibrationConfig(e.config);if(checked.errors.length)throw new Error(checked.errors.join(' '));
    if(e.config.sensorId!=null&&String(e.config.sensorId)!==s.id)throw new Error(`it belongs to sensor ${e.config.sensorId}`);
    const fp=await fingerprintConfig(e.config);if(s.state.count>0)return;
    const st=s.state;st.calConfig=e.config;st.calPrepared=checked.prepared;st.revisionId=fp.id;st.hashType=fp.type;st.fullHash=fp.full;
    st.calibrations=[{effectiveFromTime:-Infinity,revisionId:fp.id,profileId:e.config.profileId,hashType:fp.type,config:checked.prepared,source:`file: ${name}`}];
    if(st.unitId==='raw')st.unitId=UNIT_CONFIG.defaultUnit;
    if(s===activeSensor){CALIBRATION=e.config;calibration=checked.prepared;updateCalibrationInfo();syncUIFromState();}
    s.settings.calibrationAdopted=name;s.settings.calibrationError=null;s.hasOwnCal=true;
  }catch(err){s.settings.calibrationError=`${name}: ${err.message}`;deviceLogLocal('webui_error',`Calibration ${name} of sensor ${s.id} could not be used: ${err.message}`);}
}
async function loadSensorList(){
  if(typeof fetch==='undefined'||!deviceReachable){setSensorListInfo('No device connection. Only the test signal is available.');return null;}
  try{
    const res=applySensorList(await fetchWire(SENSORS_URL));
    setSensorListInfo(`sensors.json loaded: ${res.added.length+res.auxAdded.length} added, ${res.updated.length+res.auxUpdated.length} updated, ${res.unlisted.length+res.auxUnlisted.length} no longer listed${res.errors.length?'; '+res.errors.join(' '):''}.`);
    for(const s of sensors.values())if(s.kind==='server')await adoptCalibrationFile(s);
    return res;
  }catch(error){setSensorListInfo(`Could not load sensors.json: ${error.message}`);return null;}
}

function selectDefaultSensor(){const first=[...sensors.values()].find(s=>s.kind==='server'&&!s.unlisted&&!s.disabled);if(first&&activeSensor===testSensor)activateSensor(first.id);}
function initSensorCalibration(st,fp){
  st.calConfig=EMBEDDED_CALIBRATION;st.calPrepared=EMBEDDED_PREPARED;st.revisionId=fp.id;st.hashType=fp.type;st.fullHash=fp.full;
  st.calibrations=[{effectiveFromTime:-Infinity,revisionId:fp.id,profileId:EMBEDDED_CALIBRATION.profileId,hashType:fp.type,config:EMBEDDED_PREPARED,source:'embedded demo'}];
}

// ===== v12: SETTINGS (UI settings + sensor settings) ====================================================
// Device API (protocol v0.5): GET /data/settings/webui-settings.json (a factory default is {"schemaVersion":1}, HTTP 200); PUT stores the current settings as the
// default; DELETE resets it. The sensors.json document is described at sensorsDoc().
// Order of precedence for the UI settings: this browser's own copy (localStorage) > server default > built-in.
// Applying a setting never writes it anywhere; only a user change writes the browser copy.
const UI_LOCAL_KEY = 'massTelemetryWorkbench.uiSettings.v1';
const UI_DEFAULTS = Object.freeze({ schemaVersion: 1, theme: 'dark', navPanelVisible: false, yResponsePercent: 5, downsample: false, zeroFill: false, zeroRawFill: false, zeroLine: false, wizardMode: 'simple', bandMode: 'symmetric', subPixel: false, tempRateWindowS: 60 });
const UI_CONTROL_IDS = new Set(['wizMode', 'tempRateWindow', 'subPixelToggle', 'bandModeSelect', 'navPanelToggle', 'yResponseRange', 'downsampleToggle', 'zeroFillToggle', 'zeroRawFillToggle', 'zeroLineToggle']);
let uiTheme = 'dark', uiServerDefault = null, uiSaveTimer = null, uiServerState = 'not configured (no device)';
const wq = id => document.getElementById(id);   // dynamic (script-generated) elements; $() is for elements that exist in the HTML

// Missing keys fall back to the built-in default, unknown keys are ignored, wrong types are reported.
function sanitizeUiSettings(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { value: null, errors: ['The top level must be a JSON object.'] };
  const out = { ...UI_DEFAULTS }, errors = [];
  if (o.schemaVersion !== 1) errors.push('schemaVersion must be 1.');
  if (o.theme !== undefined) { if (o.theme === 'dark' || o.theme === 'light') out.theme = o.theme; else errors.push('theme must be "dark" or "light".'); }
  for (const k of ['navPanelVisible', 'downsample', 'zeroFill', 'zeroRawFill', 'zeroLine', 'subPixel'])
    if (o[k] !== undefined) { if (typeof o[k] === 'boolean') out[k] = o[k]; else errors.push(`${k} must be true or false.`); }
  if (o.wizardMode !== undefined) { if (o.wizardMode === 'simple' || o.wizardMode === 'advanced') out.wizardMode = o.wizardMode; else errors.push('wizardMode must be "simple" or "advanced".'); }
  if (o.bandMode !== undefined) { if (BAND_MODES[o.bandMode]) out.bandMode = o.bandMode; else errors.push('bandMode must be "symmetric", "asymmetric" or "stepaware".'); }
  if (o.tempRateWindowS !== undefined) { if (Number.isFinite(o.tempRateWindowS)) out.tempRateWindowS = clamp(Math.round(o.tempRateWindowS), 5, 3600); else errors.push('tempRateWindowS must be a number.'); }
  if (o.yResponsePercent !== undefined) { if (Number.isFinite(o.yResponsePercent)) out.yResponsePercent = clamp(Math.round(o.yResponsePercent), 1, 100); else errors.push('yResponsePercent must be a number.'); }
  return { value: errors.length ? null : out, errors };
}
function collectUiSettings() {
  return { schemaVersion: 1, theme: uiTheme, navPanelVisible: !$('navPanel').hidden, yResponsePercent: clamp(Math.round(Number($('yResponseRange').value) || 5), 1, 100),
    downsample: !!$('downsampleToggle').checked, zeroFill: !!$('zeroFillToggle').checked, zeroRawFill: !!$('zeroRawFillToggle').checked, zeroLine: !!$('zeroLineToggle').checked, wizardMode: wizMode, bandMode, subPixel, tempRateWindowS: auxRateWindowS() };
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
  wizMode = s.wizardMode === 'advanced' ? 'advanced' : 'simple'; if (wiz.open) wizRender(); else { const m = wq('wizMode'); if (m) m.value = wizMode; }
  if (state) { state.autoYMin = null; state.autoYMax = null; }
  subPixel = !!s.subPixel; { const t = $('subPixelToggle'); if (t) t.checked = subPixel; }
  setBandMode(s.bandMode || 'symmetric');
  $('tempRateWindow').value = s.tempRateWindowS || AUX_RATE_WINDOW_DEFAULT_S;
  scheduleRender();
}
function uiLocalRead() { try { if (typeof localStorage === 'undefined') return null; const t = localStorage.getItem(UI_LOCAL_KEY); return t ? sanitizeUiSettings(JSON.parse(t)).value : null; } catch (_) { return null; } }
function uiLocalWrite(o) { try { localStorage.setItem(UI_LOCAL_KEY, JSON.stringify(o)); return true; } catch (_) { return false; } }
function uiLocalClear() { try { localStorage.removeItem(UI_LOCAL_KEY); } catch (_) {} }
function uiSaveSoon() { clearTimeout(uiSaveTimer); uiSaveTimer = setTimeout(() => { uiSaveTimer = null; uiLocalWrite(collectUiSettings()); updateUiSettingsInfo(); }, 250); }
function uiMsg(t) { $('uiMessages').textContent = t; }
function updateUiSettingsInfo() {
  const local = uiLocalRead();
  $('uiSettingsInfo').innerHTML = `This browser: <strong>${local ? 'own settings stored' : 'nothing stored (server default or built-in values apply)'}</strong><br>Server default: <strong>${esc(uiServerState)}</strong><br><span class="small">Stored items: theme, navigation panel, Y-axis response, downsampling, zero fills, zero line, spread band mode, wizard mode (simple / advanced).</span>`;
  $('uiSaveServerBtn').disabled = !deviceReachable; $('uiResetServerBtn').disabled = !deviceReachable;
}
async function uiFetchServerDefault() {
  if (!deviceReachable) { uiServerState = 'not configured (no device)'; return null; }
  try {
    const r = await fetch(WEBUI_SETTINGS_URL, { cache: 'no-store' });
    if (r.status === 404) { uiServerDefault = null; uiServerState = 'no default stored'; return null; }
    if (!r.ok) throw new Error(await httpErrorText(r));
    const s = sanitizeUiSettings(JSON.parse(await r.text())); if (!s.value) throw new Error(s.errors.join(' '));   // {"schemaVersion":1} alone = the factory default: every missing key takes its built-in value
    uiServerDefault = s.value; uiServerState = 'default available'; return s.value;
  } catch (e) { uiServerState = `unavailable (${e.message})`; return null; }
}
async function uiSaveAsServerDefault() {
  if (!deviceReachable) { uiMsg('No settings server is reachable (no device connection).'); return; }
  try {
    const body = collectUiSettings(), r = await serverWrite(WEBUI_SETTINGS_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body, null, 2) });
    if (!r.ok) throw new Error(await httpErrorText(r));
    uiServerDefault = body; uiServerState = 'default available'; uiMsg(`The current UI settings are now the server default (${writeResultText(await writeResult(r))}).`);
  } catch (e) { uiMsg(`Could not save the server default: ${e.message}`); }
  updateUiSettingsInfo();
}
async function uiResetServerDefault() {
  if (!deviceReachable) { uiMsg('No settings server is reachable (no device connection).'); return; }
  try {
    const r = await serverWrite(WEBUI_SETTINGS_URL, { method: 'DELETE' });
    if (!r.ok && r.status !== 404) throw new Error(await httpErrorText(r));
    uiServerDefault = null; uiServerState = 'factory default'; uiMsg('The server default was reset (DELETE). Browsers without their own settings use the built-in values.');
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
  $('uiExportBtn').addEventListener('click', () => downloadBlob(new Blob([JSON.stringify(collectUiSettings(), null, 2)], { type: 'application/json' }), 'webui-settings.json'));
  updateUiSettingsInfo();
}

// ---- sensor settings -------------------------------------------------------------------------------------
// One document for all server sensors (the test signal has no settings). The nominal rate can be changed
// locally only while the sensor has no samples: every statistic of the stored samples assumes it.
let ssSelectedId = null, ssAuxId = null;
// sensors.json is ONE document owned by both sides. The WebUI changes only its own keys (name, notes, calibrationFile, primaryTemperatureSensorId,
// loadLimits; conversion of auxiliary channels) inside the document it last received; every other key (driver settings, GPIOs, warnings, ...) is sent back untouched.
function sensorsDoc() {
  const doc = sensorsDocRaw ? cloneJson(sensorsDocRaw) : { schemaVersion: 1, sensors: [] }, by = new Map((doc.sensors || []).map(e => [String(e.id), e]));
  const put = (e, k, v) => { if ((v == null || v === '') && !(k in e)) return; e[k] = v; };
  for (const s of sensors.values()) {
    if (s.kind !== 'server') continue; const e = by.get(s.id); if (!e) continue;
    e.name = s.name; put(e, 'notes', s.settings.notes || ''); put(e, 'calibrationFile', s.settings.calibrationFile || null);
    put(e, 'primaryTemperatureSensorId', s.settings.primaryTemperatureSensorId == null ? null : Number(s.settings.primaryTemperatureSensorId));
    if (s.settings.overload) e.loadLimits = overloadDoc(s);
  }
  for (const c of auxChannels.values()) { if (c.archived) continue; const e = by.get(c.id); if (!e) continue; e.name = c.name; e.conversion = cloneJson(auxConversion(c)); }
  return doc;
}
function sensorSettingsRender() {
  const server = [...sensors.values()].filter(x => x.kind !== 'archive');   // the test signal is listed too; archived epochs are not settings subjects
  if (!ssSelectedId || !sensors.has(ssSelectedId)) ssSelectedId = activeSensor.id;
  const sel = $('ssSensor'); sel.innerHTML = '';
  for (const s of server) { const o = document.createElement('option'); o.value = s.id; o.textContent = s.name + (s.unlisted ? ' (not in list)' : ''); sel.appendChild(o); }
  if (ssSelectedId) sel.value = ssSelectedId;
  const s = ssSelectedId && sensors.get(ssSelectedId), none = !s;
  $('ssForm').hidden = none; $('ssNone').hidden = !none;
  if (none) return;
  $('ssName').value = s.name; $('ssRate').value = s.state.rateHz; $('ssNotes').value = s.settings.notes || '';
  $('ssHistoryInfo').textContent = historyStatusText(s); $('ssHistoryBtn').disabled = !historyUrlFor(s);
  $('ssRate').disabled = true; $('ssRateNote').textContent = s.kind !== 'server' ? 'Fixed for the test signal.' : 'Effective rate reported by the device; it is changed in sensors.json (rate_hz), not here.';
  $('ssDeviceInfo').textContent = s.kind !== 'server' ? '' : `${s.sensorType ? 'type ' + s.sensorType + ' · ' : ''}raw format ${s.rawFormat || '?'} · ${s.disabled ? 'DISABLED on the device · ' : ''}config revision ${s.configRev ?? '—'}, warning revision ${s.warnRev ?? '—'}${s.status ? ` · state ${s.status.state || 'ok'} · queue drops ${s.status.queueDrops ?? 0} · read errors ${s.status.readErrors ?? 0}` : ''}${s.def && s.def.warnings ? ' · firmware warnings (raw): ' + JSON.stringify(s.def.warnings) : ''}${s.settings.calibrationError ? ' · calibration problem: ' + s.settings.calibrationError : ''}${s.state.flagged ? ' · samples with error flags: ' + s.state.flagged : ''}`;
  const ov = s.settings.overload || {}, ml = ov.maxLoad, nl = ov.minLoad;
  $('ssMaxLoad').value = ml ? ml.value : ''; $('ssLoadUnit').value = (ml && ml.unit) || 'g'; $('ssMinLoad').value = nl ? nl.value : '';
  $('ssAvgS').value = ov.averageS ?? OVL_DEFAULTS.averageS; $('ssYellow').value = ov.yellowPercent ?? OVL_DEFAULTS.yellowPct; $('ssOrange').value = ov.orangePercent ?? OVL_DEFAULTS.orangePct; $('ssRed').value = ov.redPercent ?? OVL_DEFAULTS.redPct;
  $('ssBreak').value = ov.breakS ?? OVL_DEFAULTS.breakS; $('ssHold').value = ov.holdS ?? OVL_DEFAULTS.holdS;
  const cs = $('ssCalFile'); cs.innerHTML = ''; const addOpt = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; cs.appendChild(o); };
  addOpt('', 'Embedded demo calibration');
  for (const e of calLibrary.values()) if (e.sensorId === s.id) addOpt(e.name, `${e.name} (${e.profileName})`);
  const want = s.settings.calibrationFile || ''; if (want && !calLibrary.has(want)) addOpt(want, `${want} (file not loaded)`);
  cs.value = want;
  const uc = useConditionsOf(s); $('ssReadDelay').value = uc.readingDelayS; $('ssSessionS').value = uc.sessionSinceTareS; $('ssTempDelta').value = uc.temperatureDeltaK;
  const pt = $('ssPrimaryTemp'); pt.innerHTML = ''; { const o0 = document.createElement('option'); o0.value = ''; o0.textContent = 'first attached channel'; pt.appendChild(o0); for (const c of attachedAux(s, 'temperature')) { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; pt.appendChild(o); } pt.value = s.settings.primaryTemperatureSensorId || ''; }
  $('ssUseNote').textContent = useConditionsNote(s);
  const alist = [...auxChannels.values()]; $('ssAuxBox').hidden = !alist.length;
  if (alist.length) { if (!ssAuxId || !auxChannels.has(ssAuxId)) ssAuxId = alist[0].id; const as = $('ssAuxSelect'); as.innerHTML = ''; for (const c of alist) { const o = document.createElement('option'); o.value = c.id; o.textContent = `${c.name} (${c.kind})`; as.appendChild(o); } as.value = ssAuxId; const ac = auxChannels.get(ssAuxId); $('ssAuxConv').value = JSON.stringify(auxConversion(ac)); $('ssAuxInfo').textContent = `conversion from sensors.json (editable) · unit ${ac.unit || '—'} · attached to ${ac.attachedTo.join(', ') || 'no sensor'} · ${ac.buf.count.toLocaleString()} samples${ac.invalid ? ` · ${ac.invalid} invalid` : ''} · ${historyStatusText(ac)}`; }
}
function ssReadOverload() {
  const v = id => $(id).value, nn = id => (v(id) === '' ? null : Number(v(id))), u = v('ssLoadUnit') || 'g';
  return { maxLoad: v('ssMaxLoad') === '' ? null : { value: Number(v('ssMaxLoad')), unit: u }, minLoad: v('ssMinLoad') === '' ? null : { value: Number(v('ssMinLoad')), unit: u },
    averageS: nn('ssAvgS'), yellowPercent: nn('ssYellow'), orangePercent: nn('ssOrange'), redPercent: nn('ssRed'), breakS: nn('ssBreak'), holdS: nn('ssHold') };
}
function ssMsg(t) { $('ssMessages').textContent = t; }
async function sensorSettingsApply() {
  const s = ssSelectedId && sensors.get(ssSelectedId); if (!s) return;
  { const ovr = overloadApplySettings(s, ssReadOverload()); if (ovr.errors.length) { ssMsg('Not applied: ' + ovr.errors.join(' ')); return; } }
  { const r = applyUseConditions(s, { readingDelayS: $('ssReadDelay').value, sessionSinceTareS: $('ssSessionS').value, temperatureDeltaK: $('ssTempDelta').value }); if (r.errors.length) { ssMsg('Not applied: ' + r.errors.join(' ')); return; } }
  s.settings.primaryTemperatureSensorId = $('ssPrimaryTemp').value || null;
  s.name = ($('ssName').value || '').trim() || `Sensor ${s.id}`; s.settings.notes = $('ssNotes').value || '';
  renderSensorSelect(); sensorSettingsRender();
  if (s.kind !== 'server') { ssMsg('Applied in this session (the test signal has no device).'); return; }
  if (!deviceReachable) { ssMsg('Applied in this session. Nothing was sent: no device connection. “Download” saves sensors.json.'); return; }
  try {
    const r = await serverWrite(SENSORS_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sensorsDoc(), null, 2) });
    if (!r.ok) throw new Error(await httpErrorText(r));
    const j = await writeResult(r); if (j.saved !== false) sensorsDocRaw = sensorsDoc();
    ssMsg(`Applied and sent sensors.json: ${writeResultText(j)}. The use conditions above stay in this browser session only.`);
  } catch (e) { ssMsg(`Applied locally, but the device did not accept sensors.json: ${e.message}`); }
}
// "Load sensors.json…": reads a file into the sensor list of this session (like a reload); nothing is sent until "Apply & send".
function applySensorsFile(doc) { const r = applySensorList(doc); return [`File read: ${r.added.length + r.auxAdded.length} added, ${r.updated.length + r.auxUpdated.length} updated.${r.errors.length ? ' ' + r.errors.join(' ') : ''} Nothing was sent to the device; use “Apply & send sensors.json” for that.`]; }
function openSettingsMenu(tab) {
  openSettings(false); $('settingsModal').hidden = false; settingsMenuTab(tab || 'ui');
  updateUiSettingsInfo(); sensorSettingsRender();
}
function settingsMenuTab(tab) {
  for (const t of ['ui', 'sensor']) { $('smPane_' + t).hidden = t !== tab; $('smTab_' + t).setAttribute('aria-selected', String(t === tab)); }
}
function initSettingsMenu() {
  authInit(); $('authForgetBtn').addEventListener('click', authForget); $('calUploadBtn').addEventListener('click', uploadCalibration); 
  $('ssHistoryBtn').addEventListener('click', () => { const s = ssSelectedId && sensors.get(ssSelectedId); if (s) historyLoadOlder(s).then(sensorSettingsRender); });
  $('openSettingsMenuBtn').addEventListener('click', () => openSettingsMenu('ui'));
  $('smClose').addEventListener('click', () => { $('settingsModal').hidden = true; });
  $('settingsModal').addEventListener('pointerdown', e => { if (e.target === $('settingsModal')) $('settingsModal').hidden = true; });
  $('smTab_ui').addEventListener('click', () => settingsMenuTab('ui')); $('smTab_sensor').addEventListener('click', () => settingsMenuTab('sensor'));
  $('ssSensor').addEventListener('change', e => { ssSelectedId = e.target.value; sensorSettingsRender(); ssMsg(''); });
  $('ssApplyBtn').addEventListener('click', sensorSettingsApply);
  $('ssAuxSelect').addEventListener('change', e => { ssAuxId = e.target.value; sensorSettingsRender(); });
  $('ssAuxApply').addEventListener('click', () => { const c = auxChannels.get(ssAuxId); if (!c) return; let conv; try { conv = JSON.parse($('ssAuxConv').value); } catch (err) { ssMsg(`The conversion is not valid JSON: ${err.message}`); return; } const er = auxSetConversion(c, conv); ssMsg(er.length ? 'Not applied: ' + er.join(' ') : 'Conversion applied to the stored samples of this channel. “Apply & send sensors.json” keeps it.'); sensorSettingsRender(); scheduleRender(); });
  $('ssAuxReset').addEventListener('click', () => { const c = auxChannels.get(ssAuxId); if (!c) return; auxSetConversion(c, (c.def && c.def.conversion) || null); ssMsg('The conversion stored on the device is used again.'); sensorSettingsRender(); scheduleRender(); });
  populateUnitSelect();
  $('deviceRestartBtn').addEventListener('click', deviceRestart); $('deviceResetBtn').addEventListener('click', () => deviceResetFile($('deviceResetSelect').value)); updateDeviceInfoUI(); renderDeviceLog();
  $('ssCalFile').addEventListener('change', async e => { ssMsg(await selectCalibrationFile(ssSelectedId, e.target.value)); sensorSettingsRender(); });
  $('ssLoadBtn').addEventListener('click', () => $('ssFile').click());
  $('ssFile').addEventListener('change', async e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { ssMsg(applySensorsFile(JSON.parse(await f.text())).join(' ')); } catch (err) { ssMsg(`Could not read the file: ${err.message}`); } });
  $('ssDownloadBtn').addEventListener('click', () => downloadBlob(new Blob([JSON.stringify(sensorsDoc(), null, 2)], { type: 'application/json' }), 'sensors.json'));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (!$('authModal').hidden) $('authCancel').click(); else if (!$('wizModal').hidden) wizClose(); else if (!$('settingsModal').hidden) $('settingsModal').hidden = true; } });
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
function fitPolynomial(xs, ys, degree, ws) {   // ws (optional): weights, normalised to mean 1 by the caller; absent = equal weights (identical to v12)
  const n = xs.length, p = degree + 1, lo = Math.min(...xs), hi = Math.max(...xs), c = (lo + hi) / 2, h = (hi - lo) / 2 || 1;
  const A = Array.from({ length: p }, () => new Array(p).fill(0)), b = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const w = ws ? ws[i] : 1, u = (xs[i] - c) / h, pw = [1]; for (let k = 1; k <= 2 * p - 2; k++) pw.push(pw[k - 1] * u);
    for (let r = 0; r < p; r++) { b[r] += w * ys[i] * pw[r]; for (let k = 0; k < p; k++) A[r][k] += w * pw[r + k]; }
  }
  const coef = fitSolve(A, b); if (!coef) return null;
  const inv = []; for (let j = 0; j < p; j++) { const e = new Array(p).fill(0); e[j] = 1; const col = fitSolve(A, e); if (!col) return null; inv.push(col); }   // columns of (Phi' W Phi)^-1
  return { coef, center: c, half: h, degree,
    varAt: m => { const u = (m - c) / h, phi = [1]; for (let k = 1; k < p; k++) phi.push(phi[k - 1] * u); let s = 0; for (let r = 0; r < p; r++) for (let k = 0; k < p; k++) s += phi[r] * phi[k] * inv[k][r]; return s; },
    g: m => { const u = (m - c) / h; let s = 0; for (let k = p - 1; k >= 0; k--) s = s * u + coef[k]; return s; },
    dg: m => { const u = (m - c) / h; let s = 0; for (let k = p - 1; k >= 1; k--) s = s * u + k * coef[k]; return s / h; } };
}
const fitKey = m => Number(m.toPrecision(12));   // equal reference masses (up to rounding) form one group
function fitGroups(points) {
  const map = new Map();
  for (const p of points) { const k = fitKey(p.massMg); let g = map.get(k); if (!g) { g = { massMg: p.massMg, raws: [], ids: [], ns: [], units: [] }; map.set(k, g); } g.raws.push(p.raw); g.ids.push(p.id); g.ns.push(p.n); g.units.push(p.aggUnit == null ? null : p.aggUnit); }
  const gs = [...map.values()].sort((a, b) => a.massMg - b.massMg);
  for (const g of gs) {
    const st = rawStats(g.raws); g.rawMean = st.mean; g.rawSD = g.raws.length > 1 ? st.sd * Math.sqrt(g.raws.length / (g.raws.length - 1)) : NaN;   // between-placement SD (n-1)
    // Weight groups with aggregation "variance-components": every physical weight counts once (mean of the weight means),
    // not every placement. Identical to the plain mean when all weights were placed equally often.
    if (g.units.every(u => u != null)) { const by = new Map(); g.raws.forEach((r, i) => { const a = by.get(g.units[i]) || []; a.push(r); by.set(g.units[i], a); }); if (by.size > 1) { let s = 0; for (const a of by.values()) s += a.reduce((x, y) => x + y, 0) / a.length; g.rawMean = s / by.size; g.aggregated = 'mean-of-weight-means'; } }
  }
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
// ---- weighting (v13) ---------------------------------------------------------------------------------------------------------
// v12 used equal weights. Placement scatter often grows with the load, so the heavy loads (which also have the most leverage on the slope)
// can dominate a plain least-squares fit. Weighted least squares minimises sum w_i (raw_i - g(m_i))^2 with w_i = 1 / sigma_i^2, where sigma_i
// is the BETWEEN-PLACEMENT scatter at the reference mass of observation i (not the within-recording SD: consecutive samples are correlated,
// and what limits an observation is how well the weight can be put back in the same spot).
// A single replicate variance from 3 placements has only 2 degrees of freedom, so it is never used raw:
//   shrinkage      sigma~_k^2 = (nu_k s_k^2 + NU0 s_p^2) / (nu_k + NU0), nu_k = n_k - 1, s_p^2 = pooled variance of all replicate groups.
//                  A mass with a single placement (nu_k = 0) simply receives the pooled variance.
//   variance-model sigma(m) = c0 + c1 m, fitted to the group SDs (weights nu_k, needs >= 3 masses with >= 2 placements), evaluated at EVERY mass.
// Fallbacks, announced in the result (weighting.reason): variance-model -> shrinkage -> equal weights (fewer than 3 different masses, or no
// replicate anywhere). A floor keeps every sigma above the quantisation noise of the mean of n samples, (1/sqrt 12)/sqrt(n_median), and the
// variance model above 5 % of the pooled SD, so a lucky triple of identical placements cannot get an (almost) infinite weight.
const FIT_NU0 = 3, FIT_MODEL_MIN_REL = 0.05;
const WEIGHTINGS = { equal: 'Equal weights (v12 behaviour)', shrinkage: 'Weighted: replicate variance shrunk towards the pooled variance', 'variance-model': 'Weighted: variance model sigma(m) = c0 + c1 m' };
function fitWeights(points, groups, requested) {
  const info = { requested: requested || 'equal', scheme: 'equal', reason: '', nu0: FIT_NU0, floorSigma: null, sigmaPerMass: [], w: null };
  if (info.requested === 'equal') return info;
  if (info.requested !== 'shrinkage' && info.requested !== 'variance-model') { info.reason = `Unknown weighting "${requested}": equal weights are used.`; return info; }
  const rep = groups.filter(g => g.raws.length >= 2);
  if (groups.length < 3) { info.reason = 'Fewer than 3 different reference masses: equal weights are used.'; return info; }
  if (!rep.length) { info.reason = 'No reference mass has 2 or more placements: equal weights are used.'; return info; }
  let ss = 0, nu = 0; for (const g of rep) { ss += (g.raws.length - 1) * g.rawSD * g.rawSD; nu += g.raws.length - 1; }
  const sp2 = ss / nu, ns = points.map(p => p.n).filter(v => Number.isFinite(v) && v >= 1), medN = ns.length ? anMedian(ns) : 1;
  const floorSigma = Math.max(1 / Math.sqrt(12) / Math.sqrt(medN), 1e-9); info.floorSigma = floorSigma;
  let sig = null, scheme = 'shrinkage';
  if (info.requested === 'variance-model') {
    if (rep.length >= 3) {
      const sc = Math.max(...groups.map(g => Math.abs(g.massMg))) || 1; let S0 = 0, S1 = 0, S2 = 0, T0 = 0, T1 = 0;
      for (const g of rep) { const v = g.raws.length - 1, x = g.massMg / sc; S0 += v; S1 += v * x; S2 += v * x * x; T0 += v * g.rawSD; T1 += v * x * g.rawSD; }
      const det = S0 * S2 - S1 * S1;
      if (det > 1e-12) { const c1 = (S0 * T1 - S1 * T0) / det, c0 = (T0 - c1 * S1) / S0; sig = groups.map(g => Math.max(c0 + c1 * g.massMg / sc, floorSigma, FIT_MODEL_MIN_REL * Math.sqrt(sp2))); scheme = 'variance-model'; info.model = { c0, c1PerMg: c1 / sc }; }
    }
    if (!sig) info.reason = 'The variance model needs at least 3 reference masses with 2 or more placements each: shrinkage is used instead.';
  }
  if (!sig) sig = groups.map(g => { const v = g.raws.length - 1, s2 = v > 0 ? g.rawSD * g.rawSD : 0; return Math.sqrt(Math.max((v * s2 + FIT_NU0 * sp2) / (v + FIT_NU0), floorSigma * floorSigma)); });
  info.scheme = scheme; info.pooledSd = Math.sqrt(sp2);
  info.sigmaPerMass = groups.map((g, i) => ({ massMg: g.massMg, n: g.raws.length, sd: g.raws.length > 1 ? g.rawSD : null, sigma: sig[i], weight: 1 / (sig[i] * sig[i]) }));
  const idx = new Map(groups.map((g, i) => [fitKey(g.massMg), i])); info.w = points.map(p => 1 / (sig[idx.get(fitKey(p.massMg))] ** 2));
  return info;
}
// Replicate scatter per reference mass for the uncertainty tables (same shrinkage rule as the weighting). null if no mass has 2 or more placements.
function replicateSigmas(points, groups) {
  let ss = 0, nu = 0; for (const g of groups) if (g.raws.length >= 2) { ss += (g.raws.length - 1) * g.rawSD * g.rawSD; nu += g.raws.length - 1; }
  if (!nu) return null;
  const sp2 = ss / nu, ns = points.map(p => p.n).filter(v => Number.isFinite(v) && v >= 1), medN = ns.length ? anMedian(ns) : 1, fl = Math.max(1 / Math.sqrt(12) / Math.sqrt(medN), 1e-9);
  return { pooled: Math.sqrt(sp2), dof: nu, sigma: groups.map(g => { const v = g.raws.length - 1, s2 = v > 0 ? g.rawSD * g.rawSD : 0; return Math.sqrt(Math.max((v * s2 + FIT_NU0 * sp2) / (v + FIT_NU0), fl * fl)); }) };
}
// Leave-one-out residuals: every observation is predicted by the fit WITHOUT it (brute force, so it is right for every model and weighting).
function looResiduals(points, model, opts = {}) {
  return points.map((p, i) => {
    const f = fitCalibration(points.filter((_, j) => j !== i), model, { ...opts, skipNodes: true });
    if (!f.ok) return { id: p.id, looRaw: null, looMassMg: null };
    const r = p.raw - f.g(p.massMg), sl = f.slopeAt ? f.slopeAt(p.massMg) : NaN;
    return { id: p.id, looRaw: r, looMassMg: Number.isFinite(sl) && sl ? r / sl : null };
  });
}
// points: [{id, massMg, raw, n?, aggUnit?}] (one per included observation). Never throws; problems are in .errors, cautions in .warnings.
// opts.weighting: 'equal' (default, exactly the v12 result) | 'shrinkage' | 'variance-model'. Weights apply to the polynomial / line fits only:
// the piecewise-linear model passes through the replicate means, so there is nothing to weight.
function fitCalibration(points, model, opts = {}) {
  const out = { ok: false, errors: [], warnings: [], model, n: points.length, groups: [], anchors: [], residuals: [], g: null, chi2: null, reducedChi2: null,
    weighting: { requested: opts.weighting || 'equal', scheme: 'equal', reason: '', sigmaPerMass: [] } };
  const spec = FIT_MODELS[model]; if (!spec) { out.errors.push(`Unknown fit model "${model}".`); return out; }
  const groups = fitGroups(points); out.groups = groups; out.distinct = groups.length;
  if (groups.length < 2) { out.errors.push('At least two different reference masses are needed.'); return out; }
  const mLo = groups[0].massMg, mHi = groups[groups.length - 1].massMg; out.mRange = [mLo, mHi];
  const stats = wts => {
    let sse = 0; for (const r of out.residuals) sse += r.resRaw * r.resRaw;
    out.sdRawRes = out.dof > 0 ? Math.sqrt(sse / out.dof) : NaN;
    const fin = out.residuals.map(r => r.resMassMg).filter(Number.isFinite);
    out.rmsMassMg = fin.length ? Math.sqrt(fin.reduce((s, v) => s + v * v, 0) / fin.length) : NaN;
    out.maxAbsMassMg = fin.length ? Math.max(...fin.map(Math.abs)) : NaN;
    // w = weight, std = standardised residual: r * sqrt(w) for weighted fits, r / s for equal weights (s = residual SD, needs dof > 0)
    if (wts) { let chi = 0; out.residuals.forEach((r, i) => { r.w = wts[i]; r.std = r.resRaw * Math.sqrt(r.w); chi += r.w * r.resRaw * r.resRaw; }); out.chi2 = chi; out.reducedChi2 = out.dof > 0 ? chi / out.dof : null; }
    else for (const r of out.residuals) { r.w = 1; r.std = out.sdRawRes > 0 ? r.resRaw / out.sdRawRes : NaN; }
  };
  const warn = () => {
    if (out.dof <= 0) out.warnings.push('No degrees of freedom: the model passes through every observation, so its residuals say nothing about the scatter. Record replicates.');
    if (out.distinct < 3) out.warnings.push('Only two different reference masses: linearity cannot be checked.');
    if (out.weighting.reason) out.warnings.push(out.weighting.reason);
  };
  if (model === 'anchors') {
    if (out.weighting.requested !== 'equal') out.weighting.reason = 'The piecewise-linear model averages the replicates; weights do not apply to it.';
    out.params = groups.length; out.dof = points.length - groups.length;
    out.anchors = groups.map(g => ({ massMg: g.massMg, raw: g.rawMean, sourceIds: g.ids, count: g.raws.length }));
    out.g = m => { let i = 0; while (i < groups.length - 2 && m > groups[i + 1].massMg) i++; const a = groups[i], b = groups[i + 1]; return a.rawMean + (m - a.massMg) / (b.massMg - a.massMg) * (b.rawMean - a.rawMean); };
    const index = new Map(groups.map((g, i) => [fitKey(g.massMg), i]));
    out.residuals = points.map(p => {
      const gi = index.get(fitKey(p.massMg)), s = Math.min(gi, groups.length - 2), a = groups[s], b = groups[s + 1], slope = (b.rawMean - a.rawMean) / (b.massMg - a.massMg), res = p.raw - groups[gi].rawMean;
      return { id: p.id, massMg: p.massMg, raw: p.raw, fitRaw: groups[gi].rawMean, resRaw: res, resMassMg: res / slope };
    });
    stats(null); out.slopeAt = m => { const h = 0.01 * (mHi - mLo); return (out.g(m + h) - out.g(m - h)) / (2 * h); }; warn();
    const rs = replicateSigmas(points, groups);   // v14: placement scatter for the uncertainty tables
    if (rs) {
      const seg = m => { let i = 0; while (i < groups.length - 2 && m > groups[i + 1].massMg) i++; const a = groups[i], b = groups[i + 1]; return { i, t: clamp((m - a.massMg) / (b.massMg - a.massMg), 0, 1) }; };
      out.seRawAt = m => { const { i, t } = seg(m), a = rs.sigma[i] / Math.sqrt(groups[i].raws.length), b = rs.sigma[i + 1] / Math.sqrt(groups[i + 1].raws.length); return Math.sqrt(((1 - t) * a) ** 2 + (t * b) ** 2); };
      out.sdRawAt = m => { const { i, t } = seg(m); return (1 - t) * rs.sigma[i] + t * rs.sigma[i + 1]; };
    }
    out.ok = true; return out;
  }
  const need = spec.degree + 1;
  if (groups.length < need) { out.errors.push(`${spec.label} needs at least ${need} different reference masses; there are ${groups.length}.`); return out; }
  const wt = fitWeights(points, groups, opts.weighting), mean1 = wt.w ? wt.w.reduce((a, b) => a + b, 0) / wt.w.length : 1;
  const fit = fitPolynomial(points.map(p => p.massMg), points.map(p => p.raw), spec.degree, wt.w ? wt.w.map(v => v / mean1) : null);
  if (!fit) { out.errors.push('The fit is numerically singular (too few distinct masses for this degree).'); return out; }
  out.weighting = { requested: wt.requested, scheme: wt.scheme, reason: wt.reason, nu0: wt.nu0, floorSigma: wt.floorSigma, pooledSd: wt.pooledSd, model: wt.model, sigmaPerMass: wt.sigmaPerMass };
  Object.assign(out, { g: fit.g, dg: fit.dg, coef: fit.coef, center: fit.center, half: fit.half, params: need, dof: points.length - need });
  out.residuals = points.map(p => { const f = fit.g(p.massMg), d = fit.dg(p.massMg); return { id: p.id, massMg: p.massMg, raw: p.raw, fitRaw: f, resRaw: p.raw - f, resMassMg: (p.raw - f) / d }; });
  stats(wt.w); out.slopeAt = fit.dg; warn();
  let sign = 0; out.monotone = true;
  for (let k = 0; k <= 400; k++) { const s = Math.sign(fit.dg(mLo + (mHi - mLo) * k / 400)); if (s === 0 || (sign && s !== sign)) { out.monotone = false; break; } sign = s; }
  if (!out.monotone) { out.errors.push('The fitted curve is not monotonic over the range of the reference masses. Use a lower degree or exclude an observation.'); return out; }
  { // v14: standard error of the fitted curve (residual scatter x leverage) and the placement scatter at a mass, for the uncertainty tables
    const wn = wt.w ? wt.w.map(v => v / mean1) : null; let ssn = 0; out.residuals.forEach((r, i) => { ssn += (wn ? wn[i] : 1) * r.resRaw * r.resRaw; });
    const s2n = out.dof > 0 ? ssn / out.dof : NaN, sg = (wt.sigmaPerMass || []).map(s => ({ massMg: s.massMg, uMg: s.sigma }));
    out.seRawAt = m => Math.sqrt(Math.max(0, s2n * fit.varAt(m)));
    out.sdRawAt = m => (wt.scheme === 'equal' || !sg.length) ? Math.sqrt(s2n) : interpTable(sg, m);
  }
  if (opts.skipNodes) { out.nodes = 0; out.maxInterpErrMg = 0; out.ok = true; return out; }
  let N = spec.degree > 1 ? 17 : 2, nodes;
  const build = () => { nodes = Array.from({ length: N }, (_, k) => { const m = mLo + (mHi - mLo) * k / (N - 1); return { massMg: m, raw: fit.g(m) }; }); nodes.g = fit.g; return fitInterpError(nodes); };
  let err = build();
  while (spec.degree > 1 && err > 1e-5 * (mHi - mLo) && N < 257) { N = 2 * N - 1; err = build(); }
  out.nodes = N; out.maxInterpErrMg = err;
  out.anchors = nodes.map(n => ({ massMg: n.massMg, raw: n.raw, sourceIds: [], count: 0 }));
  out.ok = true; return out;
}

// ---- calibration document from wizard data (pure: W is passed in) ------------------------------------------
// WEIGHT GROUPS (v13). Several physical weights of the same claimed mass (e.g. 3 x 100 g, uncertified) are stored INDEPENDENTLY
// (own weightId, own observations) and may be pooled in a group: {groupId, name, nominalMass, unit, memberWeightIds, massBasis, aggregation}.
//   massBasis "nominal":  every member is taken to have exactly the group's nominal mass (the uncertified case). The members then share one
//                         effective mass and form ONE anchor; the file says the mass scale rests on nominal values (not traceable).
//   massBasis "assigned": every member keeps its own assigned (certificate) mass, falling back to its own nominal mass. Members with
//                         different masses stay separate masses: they are never forced into one anchor.
//   aggregation "mean-of-placements" (default): the anchor is the mean over all placements.   "variance-components": the mean of the
//                         per-weight means (every physical weight counts once); the two differ only when the weights were placed unequally often.
// The fit still pools by EFFECTIVE MASS (equal mass = one anchor), which is the v12 rule; a group is the explicit way to say "these are the
// same mass", and it feeds the variance-component report and the relative masses below.
function wizGroupOf(W, w) { return w && w.groupId ? (W.groups || []).find(x => x.groupId === w.groupId) || null : null; }
function wizWeightMassMg(W, w) {
  const g = wizGroupOf(W, w);
  if (g && g.massBasis === 'nominal') return massToMg(Number(g.nominalMass), g.unit);
  return massToMg(Number(w.assignedMass != null ? w.assignedMass : w.nominalMass), w.unit);
}
function wizLoadMassMg(W, load) {
  let s = 0;
  for (const c of load.components) {
    const w = W.weights.find(x => x.weightId === c.weightId);
    if (!w) throw new Error(`Load "${load.name}" refers to a missing weight.`);
    s += Number(c.quantity) * wizWeightMassMg(W, w);
  }
  return s;
}
function wizObsWeightId(load) { return load.weightRef || (load.components.length === 1 && Number(load.components[0].quantity) === 1 ? load.components[0].weightId : null); }
// opts.all: every included observation whatever its loading direction (used by the hysteresis analysis). Otherwise W.hysteresisUse decides:
// 'both' (default: the fit follows the mean path of up and down), or 'up' / 'down' only. An observation without a direction counts as 'up'.
function wizPoints(W, opts = {}) {
  const points = [], errors = [], use = opts.all ? 'both' : (W.hysteresisUse || 'both');
  for (const o of W.observations) {
    if (!o.include || !isCalObs(o)) continue;
    if (use !== 'both' && (o.loadingDirection || 'up') !== use) continue;
    const load = W.loads.find(l => l.loadId === o.loadId);
    if (!load) { errors.push(`Observation ${o.observationId} refers to a missing load.`); continue; }
    if (!Number.isFinite(o.rawMean)) { errors.push(`Observation ${o.observationId} has no valid raw mean.`); continue; }
    try {
      const wid = wizObsWeightId(load), w = wid && W.weights.find(x => x.weightId === wid), g = wizGroupOf(W, w);
      points.push({ id: o.observationId, massMg: wizLoadMassMg(W, load), raw: o.rawMean, n: o.sampleCount, aggUnit: g && g.aggregation === 'variance-components' ? wid : null, direction: o.loadingDirection || null });
    } catch (e) { errors.push(e.message); }
  }
  return { points, errors };
}
// One-way random-effects ANOVA per weight group, from the included observations of its member weights (unbalanced designs allowed):
//   within-weight (placement) variance  s_w^2 = MS_within,    between-weight variance  s_b^2 = max(0, (MS_between - MS_within) / n0),
//   n0 = (N - sum n_i^2 / N) / (a - 1)   (a weights, n_i placements each, N total).
// Needs a >= 2 weights and at least one repeated placement (N > a). The verdict is informal (s_b versus s_w, no significance test).
// Relative masses: the sensor compares the weights far more precisely than their nominal values are known:
//   delta_i = (mean raw_i - mean of the weight means) / slope(g at the group mass)   [mg, signed]; the standard error uses s_w / sqrt(n_i) / |slope|.
// They describe differences BETWEEN the weights; a common bias of all of them cannot be seen this way.
function weightGroupStats(W, fit) {
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length, out = [];
  for (const g of W.groups || []) {
    const members = W.weights.filter(w => w.groupId === g.groupId), res = { groupId: g.groupId, name: g.name, a: 0, N: 0, reason: '', members: [] };
    const per = members.map(w => {
      const raws = [];
      for (const o of W.observations) { if (!o.include || !isCalObs(o) || !Number.isFinite(o.rawMean)) continue; const l = W.loads.find(x => x.loadId === o.loadId); if (l && wizObsWeightId(l) === w.weightId) raws.push(o.rawMean); }
      return { w, raws };
    });
    res.members = per.map(p => ({ weightId: p.w.weightId, name: p.w.name, n: p.raws.length, meanRaw: p.raws.length ? mean(p.raws) : null, relMassMg: null, relMassSeMg: null }));
    const used = per.filter(p => p.raws.length > 0), a = used.length, N = used.reduce((s, p) => s + p.raws.length, 0); res.a = a; res.N = N;
    if (a < 2) { res.reason = 'Observations of at least 2 weights of the group are needed.'; out.push(res); continue; }
    const means = used.map(p => mean(p.raws)), grand = used.reduce((s, p, i) => s + p.raws.length * means[i], 0) / N, mom = mean(means);
    let ssw = 0, ssb = 0; used.forEach((p, i) => { for (const r of p.raws) ssw += (r - means[i]) ** 2; ssb += p.raws.length * (means[i] - grand) ** 2; });
    const dfw = N - a, dfb = a - 1; res.dfW = dfw; res.dfB = dfb; res.meanRaw = grand;
    if (dfw >= 1) {
      const msw = ssw / dfw, msb = ssb / dfb, n0 = (N - used.reduce((s, p) => s + p.raws.length ** 2, 0) / N) / dfb;
      res.sW = Math.sqrt(msw); res.sB = Math.sqrt(Math.max(0, (msb - msw) / n0)); res.F = msw > 0 ? msb / msw : (msb > 0 ? Infinity : null);
      res.verdict = res.sB > res.sW ? 'differ' : 'same';
    } else res.reason = 'No weight was placed more than once: placement scatter and weight-to-weight differences cannot be separated.';
    const mass = mean(members.map(w => wizWeightMassMg(W, w))), slope = fit && fit.ok && fit.slopeAt ? fit.slopeAt(mass) : NaN;
    if (Number.isFinite(slope) && slope !== 0) used.forEach((p, i) => { const m = res.members.find(x => x.weightId === p.w.weightId); m.relMassMg = (means[i] - mom) / slope; m.relMassSeMg = res.sW != null ? res.sW / Math.sqrt(p.raws.length) / Math.abs(slope) : null; });
    out.push(res);
  }
  return out;
}
// Weight list typed in Simple mode, e.g. "3 x 100 g, 1 x 200 g" -> [{qty, value, unit}]
const SIMPLE_UNIT_ALIASES = { ug: 'ug', 'µg': 'ug', mg: 'mg', g: 'g', kg: 'kg', oz: 'oz_av', lb: 'lb_av', lbs: 'lb_av', st: 'st' };
function parseWeightSpec(text) {
  const raw = [], errors = [];
  for (const part of String(text == null ? '' : text).split(/[;,\n]+/)) {
    const t = part.trim(); if (!t) continue;
    const m = t.match(/^(?:(\d+)\s*(?:x|×|\*)\s*)?(\d+(?:[.,]\d+)?)\s*([a-zA-Zµ]*)(?:\s*(?:±|\+-|\+\/-)\s*(\d+(?:[.,]\d+)?)\s*([a-zA-Zµ]*))?$/i);
    if (!m) { errors.push(`Cannot read “${t}”. Write it like 3 x 100 g, or with a tolerance: 3 x 100 g ±0.5 mg.`); continue; }
    const qty = m[1] ? parseInt(m[1], 10) : 1, value = Number(m[2].replace(',', '.')), unit = SIMPLE_UNIT_ALIASES[(m[3] || 'g').toLowerCase()];
    if (!unit) { errors.push(`Unknown unit “${m[3]}” in “${t}”. Use mg, g, kg, oz or lb.`); continue; }
    if (!(value > 0)) { errors.push(`The mass in “${t}” must be greater than 0.`); continue; }
    if (qty < 1 || qty > 10) { errors.push(`The number of pieces in “${t}” must be between 1 and 10.`); continue; }
    const it = { qty, value, unit };
    if (m[4] != null) {
      const tu = m[5] ? SIMPLE_UNIT_ALIASES[m[5].toLowerCase()] : unit, tv = Number(m[4].replace(',', '.'));
      if (!tu) { errors.push(`Unknown unit “${m[5]}” for the tolerance in “${t}”.`); continue; }
      it.tol = { value: tv, unit: tu };
    }
    raw.push(it);
  }
  const items = [];
  const sameTol = (a, b) => (!a && !b) || (a && b && a.value === b.value && a.unit === b.unit);
  for (const it of raw) { const e = items.find(x => x.value === it.value && x.unit === it.unit && sameTol(x.tol, it.tol)); if (e) e.qty += it.qty; else items.push({ ...it }); }
  if (!items.length && !errors.length) errors.push('Enter at least one weight, e.g. 3 x 100 g, 1 x 200 g.');
  if (items.reduce((s, x) => s + x.qty, 0) > 30) errors.push('At most 30 weights in total.');
  return { items, errors };
}
const numOrNull = v => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
function buildCalibrationConfig(W, fit, nowIso, extra = {}) {
  const unit = W.profile.unit, pad = (n, w) => String(n).padStart(w, '0'), stats = extra.groupStats || [];
  const included = wizCalObs(W).filter(o => o.include), groups = W.groups || [];
  const anchors = fit.anchors.map((a, i) => {
    const base = { anchorId: `anchor-${pad(i, 3)}`, referenceValue: mgToUnit(a.massMg, unit), referenceUnit: unit, rawMean: a.raw };
    if (fit.model === 'anchors') return { ...base, sourceObservationIds: a.sourceIds, aggregationMethod: a.count > 1 ? 'arithmetic-mean-of-observation-raw-means' : 'single-observation', replicateCount: a.count };
    return { ...base, sourceObservationIds: [], aggregationMethod: `fit-sampled:${fit.model}` };
  });
  const rel = id => { for (const s of stats) { const m = s.members.find(x => x.weightId === id); if (m && m.relMassMg != null) return { valueMg: m.relMassMg, standardErrorMg: m.relMassSeMg, basis: 'sensor comparison within the weight group; approximate' }; } return null; };
  const w5 = v => (Number.isFinite(v) ? v : null);
  return {
    schemaVersion: 1, sensorId: numericSensorId(W.sensorId), profileId: W.profile.profileId, profileName: W.profile.profileName, createdAt: nowIso, modifiedAt: nowIso, applicationVersion: '17.0-wizard',
    calibrationUnit: unit, calibrationMethod: 'piecewise-linear',
    sensor: { model: W.profile.sensorModel || '', hardwareId: W.sensorId || '', adcResolutionBits: null, samplingRateHz: W.rateHz || null },
    environment: { temperatureC: numOrNull(W.profile.temperatureC), relativeHumidityPercent: numOrNull(W.profile.humidityPercent), notes: W.profile.notes || '' },
    referenceWeights: W.weights.map(w => ({ weightId: w.weightId, name: w.name, nominalMass: Number(w.nominalMass), assignedMass: w.assignedMass == null ? null : Number(w.assignedMass), unit: w.unit, referenceUncertainty: w.referenceUncertainty == null ? null : w.referenceUncertainty, groupId: w.groupId || null, relativeMassToGroupMean: rel(w.weightId),
      massUncertainty: weightStdUncertaintyMg(w) == null ? null : { value: Number(w.massUncertainty.value), unit: w.massUncertainty.unit || w.unit, basis: w.massUncertainty.basis, coverageFactor: w.massUncertainty.basis === 'certificate' ? (Number(w.massUncertainty.coverageFactor) > 0 ? Number(w.massUncertainty.coverageFactor) : 2) : null, distribution: w.massUncertainty.distribution || (w.massUncertainty.basis === 'certificate' ? 'normal' : 'rectangular'), standardUncertaintyMg: weightStdUncertaintyMg(w) } })),
    referenceWeightGroups: groups.map(g => { const s = stats.find(x => x.groupId === g.groupId);
      return { groupId: g.groupId, name: g.name, nominalMass: Number(g.nominalMass), unit: g.unit, memberWeightIds: W.weights.filter(w => w.groupId === g.groupId).map(w => w.weightId), massBasis: g.massBasis, aggregation: g.aggregation,
        traceable: g.massBasis === 'nominal' ? false : null, massBasisNote: g.massBasis === 'nominal' ? 'nominal, uncertified: the mass scale rests on the nominal value; the accuracy cannot be better than the weights\' class tolerance' : 'individual assigned masses',
        statistics: s ? { weightsWithObservations: s.a, placements: s.N, withinWeightSdCounts: w5(s.sW), betweenWeightSdCounts: w5(s.sB), fRatio: w5(s.F), verdict: s.verdict || null, note: s.reason || null } : null }; }),
    referenceLoads: W.loads.map(l => ({ loadId: l.loadId, name: l.name, components: l.components.map(c => ({ weightId: c.weightId, quantity: Number(c.quantity) })) })),
    observations: W.observations.map(o => {
      const v = o.validity || {};
      const r = { observationId: o.observationId, weightId: wizObsWeightId(W.loads.find(l => l.loadId === o.loadId) || { components: [] }), loadId: o.loadId, recordedAt: o.recordedAt, placementRunId: o.placementRunId, placementIndex: o.placementIndex, removedAndReplaced: !!o.removedAndReplaced, loadingDirection: o.loadingDirection || null,
        rawMean: o.rawMean, rawStdDev: o.rawStdDev, rawMedian: o.rawMedian, rawMAD: o.rawMAD, sampleCount: o.sampleCount, durationMs: o.durationMs, outlierMethod: null,
        validityStatus: v.status || 'n/a', validityFlags: v.flagged || [], included: !!o.include, purpose: o.purpose || 'calibration' };
      if (o.position) r.position = o.position; if (o.series) r.series = o.series; if (o.settleS != null) r.settleS = o.settleS; if (o.temperatures) r.temperatures = o.temperatures; if (o.recordedUnderRevision) r.recordedUnderRevision = o.recordedUnderRevision;
      if (v.analysis && v.analysis.checks) r.validityChecks = v.analysis.checks;
      if (!o.include) { r.excluded = true; r.exclusionReason = o.exclusionReason || 'excluded in the fitting editor'; }
      else if (o.override) { r.overrideReason = o.override.reason; r.overrideAt = o.override.at; }
      return r;
    }),
    calibrationAnchors: anchors,
    fit: { model: fit.model, label: FIT_MODELS[fit.model].label, direction: fit.model === 'anchors' ? 'interpolation through group means' : 'counts on mass (least squares), inverted by sampling the fitted curve',
      parameters: fit.params, observationsUsed: included.length, distinctMasses: fit.distinct, degreesOfFreedom: fit.dof, residualSdCounts: w5(fit.sdRawRes),
      rmsResidualMassMg: w5(fit.rmsMassMg), maxAbsResidualMassMg: w5(fit.maxAbsMassMg),
      sampledSegments: fit.model === 'anchors' ? null : fit.nodes - 1, maxInterpolationErrorMg: fit.model === 'anchors' ? null : fit.maxInterpErrMg,
      polynomial: fit.coef ? { variable: 'u = (mass_mg - center)/half', center: fit.center, half: fit.half, coefficients: fit.coef } : null,
      weighting: { scheme: fit.weighting.scheme, requested: fit.weighting.requested, nu0: fit.weighting.nu0 == null ? null : fit.weighting.nu0, floorSigmaCounts: w5(fit.weighting.floorSigma), pooledSdCounts: w5(fit.weighting.pooledSd), reason: fit.weighting.reason || null,
        sigmaPerMass: (fit.weighting.sigmaPerMass || []).map(s => ({ massMg: s.massMg, placements: s.n, sampleSdCounts: w5(s.sd), sigmaUsedCounts: w5(s.sigma) })) },
      chiSquare: w5(fit.chi2), reducedChiSquare: w5(fit.reducedChi2),
      warnings: extra.warnings || [],
      hysteresisUse: W.hysteresisUse || 'both',
      overriddenObservations: included.filter(o => o.override).map(o => o.observationId) },
    ...(extra.uncertainty ? { uncertainty: extra.uncertainty } : {}),
    ...(extra.characterization ? { characterization: extra.characterization } : {}),
    validation: { status: 'not-characterized', method: null, checks: [{ id: 'fit-residuals', status: 'informational', note: 'observed scatter of the observations around the model; not an uncertainty' }], modelUncertainty: null },
    reserved: { warmUpDurationSeconds: numOrNull(W.profile.warmUpMinutes) == null ? null : numOrNull(W.profile.warmUpMinutes) * 60, loadApproach: 'not-recorded',
      loadingDirection: W.observations.some(o => o.loadingDirection) ? (W.hysteresisUse || 'both') : 'not-determined', hysteresisAnalysis: extra.hysteresis || null, temperatureCompensation: null, humidityCompensation: null }
  };
}

// ===== v12/v13: CALIBRATION WIZARD + FITTING EDITOR (UI) ===============================================
// ONE data model and ONE file format; the mode (wizMode, stored in ui-settings.json as wizardMode) only changes what is shown and which defaults apply,
// so a file made in Simple mode opens in Advanced and vice versa.
//  Advanced: 1 Weights (profile, weights, weight groups, combination loads) · 2 Observations · 3 Fit (model, weighting, plots, residuals, group statistics) · 4 Review.
//  Simple:   1 Weights (typed list "3 x 100 g, 1 x 200 g") · 2 Measure (the wizard proposes the next placement; 3 placements per mass) · 3 Finish (model and weights chosen
//            by the wizard, plain-language warnings, activate). A failed validity check never blocks: the observation is left out until the user chooses "include anyway";
//            that choice is written into the JSON (overrideReason, overrideAt, fit.overriddenObservations).
// A capture reuses the Measurement machinery (beginMeasurement), so it is highlighted, logged, analysed with analyzeSeries and cancelled by a tare /
// calibration change / gap exactly like a measurement. Observations store RAW counts, so the wizard result does not depend on any tare or on the calibration
// that is active meanwhile.
let wizMode = 'simple';
const SIMPLE_CAPTURE_SECONDS = 10, SIMPLE_PLACEMENTS = 3, SIMPLE_PLACEMENTS_MIN = 2, SIMPLE_PLACEMENTS_MAX = 10, SIMPLE_LINEAR_TOL = 0.005;   // Simple mode: recording length; placements per mass; "straight line" if no residual exceeds 0.5 % of the mass span
const wiz = { open: false, tab: 'weights', minimised: false, sensorId: null, rateHz: null, profile: null, weights: [], groups: [], loads: [], observations: [], runId: null,
  captureSeconds: 10, capture: null, fitModel: 'anchors', weighting: 'equal', message: '', selLoad: null, replaced: true, nextNum: 1, comboOpen: false, comboPick: {}, manualOpen: false, simpleSpec: null, placements: 3, returnRun: false, hysteresisUse: 'both', direction: null, char: null };
const WIZ_EMPTY_WEIGHT = () => ({ weightId: 'ref-empty', name: 'Empty platform / zero reference', nominalMass: 0, assignedMass: null, unit: 'g', referenceUncertainty: null, groupId: null });
function wizNew() {
  Object.assign(wiz, { tab: 'weights', profile: { profileId: `scale-profile-${wizStamp()}`, profileName: 'New calibration', unit: 'g', notes: '', sensorModel: '', temperatureC: '', humidityPercent: '', warmUpMinutes: '' }, nextNum: 1, observations: [], capture: null, fitModel: 'anchors', weighting: 'equal', message: '',
    weights: [WIZ_EMPTY_WEIGHT()], groups: [], loads: [], comboOpen: false, comboPick: {}, runId: `run-${wizStamp()}`, selLoad: null, simpleSpec: null, returnRun: false, hysteresisUse: 'both', direction: null, char: wizCharNew() });
  wizSyncLoads(); wiz.selLoad = wiz.loads[0].loadId;
}
// Every weight has an automatic single-weight load; the empty platform has none (components: []). Also keeps the group membership consistent.
function wizSyncLoads() {
  for (const w of wiz.weights) if (w.groupId && !wiz.groups.some(g => g.groupId === w.groupId)) w.groupId = null;
  for (const g of wiz.groups) g.memberWeightIds = wiz.weights.filter(w => w.groupId === g.groupId).map(w => w.weightId);
  for (const w of wiz.weights) if (!wiz.loads.some(l => l.auto && l.weightRef === w.weightId))
    wiz.loads.push({ loadId: `load-${w.weightId.replace(/^ref-/, '')}`, name: w.weightId === 'ref-empty' ? 'Empty platform' : (w.name || w.weightId), weightRef: w.weightId, auto: true, components: w.weightId === 'ref-empty' ? [] : [{ weightId: w.weightId, quantity: 1 }] });
  wiz.loads = wiz.loads.filter(l => (l.auto ? wiz.weights.some(w => w.weightId === l.weightRef) : l.components.every(c => wiz.weights.some(w => w.weightId === c.weightId))));
  for (const l of wiz.loads) if (l.auto) { const w = wiz.weights.find(x => x.weightId === l.weightRef); if (w && w.weightId !== 'ref-empty') l.name = w.name || w.weightId; }
  if (!wiz.loads.some(l => l.loadId === wiz.selLoad)) wiz.selLoad = wiz.loads.length ? wiz.loads[0].loadId : null;
}
// Files written before v13 have no referenceWeightGroups: weights of equal effective mass (the v12 pooling rule) become one group.
function wizMigrateGroups() {
  const by = new Map();
  for (const w of wiz.weights) {
    if (w.weightId === 'ref-empty' || !(Number(w.nominalMass) > 0)) continue;
    const key = fitKey(massToMg(Number(w.assignedMass != null ? w.assignedMass : w.nominalMass), w.unit)); if (!by.has(key)) by.set(key, []); by.get(key).push(w);
  }
  for (const [key, ws] of by) {
    if (ws.length < 2) continue;
    const gid = `grp-${String(key).replace(/[^\w]/g, '_')}`;
    wiz.groups.push({ groupId: gid, name: `${ws.length} × ${ws[0].nominalMass} ${unitById(ws[0].unit).symbol}`, nominalMass: Number(ws[0].nominalMass), unit: ws[0].unit, massBasis: ws.some(w => w.assignedMass != null) ? 'assigned' : 'nominal', aggregation: 'mean-of-placements' });
    for (const w of ws) w.groupId = gid;
  }
}
function wizLoadFromConfig(cfg) {
  const num = v => (v == null ? null : Number(v));
  wiz.profile = { profileId: cfg.profileId, profileName: cfg.profileName, unit: cfg.calibrationUnit, notes: (cfg.environment && cfg.environment.notes) || '', sensorModel: (cfg.sensor && cfg.sensor.model) || '',
    temperatureC: cfg.environment && cfg.environment.temperatureC != null ? cfg.environment.temperatureC : '', humidityPercent: cfg.environment && cfg.environment.relativeHumidityPercent != null ? cfg.environment.relativeHumidityPercent : '', warmUpMinutes: cfg.reserved && cfg.reserved.warmUpDurationSeconds != null ? cfg.reserved.warmUpDurationSeconds / 60 : '' };
  wiz.weights = (cfg.referenceWeights || []).map(w => ({ weightId: w.weightId, name: w.name || w.weightId, nominalMass: Number(w.nominalMass), assignedMass: num(w.assignedMass), unit: w.unit || cfg.calibrationUnit, referenceUncertainty: w.referenceUncertainty == null ? null : w.referenceUncertainty, groupId: w.groupId || null,
    massUncertainty: w.massUncertainty && w.massUncertainty.basis && w.massUncertainty.basis !== 'none' ? { ...w.massUncertainty } : null }));
  const hasGroups = Array.isArray(cfg.referenceWeightGroups);
  wiz.groups = hasGroups ? cfg.referenceWeightGroups.map(g => ({ groupId: g.groupId, name: g.name || g.groupId, nominalMass: Number(g.nominalMass), unit: g.unit || cfg.calibrationUnit, massBasis: g.massBasis === 'assigned' ? 'assigned' : 'nominal', aggregation: g.aggregation === 'variance-components' ? 'variance-components' : 'mean-of-placements' })) : [];
  if (!hasGroups) wizMigrateGroups();
  const zero = wiz.weights.find(w => w.weightId === 'ref-empty') || wiz.weights.find(w => Number(w.nominalMass) === 0);
  wiz.loads = (cfg.referenceLoads || []).map(l => {
    const comps = (l.components || []).map(c => ({ weightId: c.weightId, quantity: Number(c.quantity) || 1 }));
    const single = comps.length === 1 && comps[0].quantity === 1, empty = comps.length === 0 && zero;
    return { loadId: l.loadId, name: l.name || l.loadId, components: comps, auto: !!(single || empty), weightRef: single ? comps[0].weightId : (empty ? zero.weightId : null) };
  });
  wiz.observations = (cfg.observations || []).map(o => {
    const include = o.included !== undefined ? !!o.included : !o.excluded, st = o.validityStatus || 'n/a';
    return { observationId: o.observationId, loadId: o.loadId, recordedAt: o.recordedAt, placementRunId: o.placementRunId || 'imported', placementIndex: o.placementIndex || 0, removedAndReplaced: !!o.removedAndReplaced,
      loadingDirection: o.loadingDirection === 'up' || o.loadingDirection === 'down' ? o.loadingDirection : null, rawMean: Number(o.rawMean), rawStdDev: num(o.rawStdDev), rawMedian: num(o.rawMedian), rawMAD: num(o.rawMAD), sampleCount: num(o.sampleCount), durationMs: num(o.durationMs),
      validity: { status: st, flagged: o.validityFlags || [], analysis: Array.isArray(o.validityChecks) ? { status: st, analyzedN: num(o.sampleCount) || 0, note: '', checks: o.validityChecks } : null },
      include, exclusionReason: o.exclusionReason, override: include && o.overrideReason ? { reason: o.overrideReason, at: o.overrideAt || null } : undefined, source: 'imported',
      purpose: ['eccentricity', 'creep', 'zero-drift'].includes(o.purpose) ? o.purpose : 'calibration', position: o.position || null, series: Array.isArray(o.series) ? o.series : null, settleS: num(o.settleS), temperatures: o.temperatures && typeof o.temperatures === 'object' ? o.temperatures : null, recordedUnderRevision: o.recordedUnderRevision || null };
  });
  wiz.fitModel = (cfg.fit && FIT_MODELS[cfg.fit.model]) ? cfg.fit.model : 'anchors';
  wiz.weighting = (cfg.fit && cfg.fit.weighting && WEIGHTINGS[cfg.fit.weighting.requested]) ? cfg.fit.weighting.requested : 'equal';
  wiz.hysteresisUse = cfg.fit && ['both', 'up', 'down'].includes(cfg.fit.hysteresisUse) ? cfg.fit.hysteresisUse : 'both'; wiz.direction = null; wiz.char = wizCharFromConfig(cfg);
  wiz.comboOpen = false; wiz.comboPick = {}; wiz.runId = `run-${wizStamp()}`; wiz.nextNum = wiz.weights.length + 1; wiz.capture = null; wiz.tab = wizMode === 'simple' ? 'review' : 'fit';
  wizSyncLoads();
}
function wizWeightUse(weightId) { const loads = wiz.loads.filter(l => l.components.some(c => c.weightId === weightId) || l.weightRef === weightId).map(l => l.loadId); return wiz.observations.filter(o => loads.includes(o.loadId)).length; }
function wizMassText(mg, unit) { return Number.isFinite(mg) ? `${fmtNumber(mgToUnit(mg, unit), Math.max(3, unitById(unit).decimals))} ${unitById(unit).symbol}` : '—'; }
function wizLoadMassSafe(load) { try { return wizLoadMassMg(wiz, load); } catch (_) { return NaN; } }
function wizBlock() {
  if (wiz.sensorId !== activeSensor.id) return 'The wizard belongs to another sensor than the one shown. Select that sensor or use “Use the shown sensor”.';
  if (state.measurement) return 'A measurement is running; wait for it to finish or cancel it.';
  if (state.charRec) return 'A recording is running; wait for it to finish or cancel it.';
  return '';
}
// ---- Simple mode: weights from a typed list, the placement plan, plain-language wording ------------------------------
const WIZ_LETTERS = 'ABCDEFGHIJ';
function wizSimpleSetWeights(items) {
  const num = v => String(v).replace('.', 'p');
  wiz.profile.unit = items[0].unit; wiz.weights = [WIZ_EMPTY_WEIGHT()]; wiz.groups = []; wiz.loads = [];
  for (const it of items) {
    const sym = unitById(it.unit).symbol, base = `${num(it.value)}${it.unit}${it.tol ? `-t${num(it.tol.value)}${it.tol.unit}` : ''}`, gid = it.qty > 1 ? `grp-${base}` : null;
    if (gid) wiz.groups.push({ groupId: gid, name: `${it.qty} × ${it.value} ${sym}`, nominalMass: it.value, unit: it.unit, massBasis: 'nominal', aggregation: 'mean-of-placements' });
    for (let q = 0; q < it.qty; q++) wiz.weights.push({ weightId: `ref-${base}${it.qty > 1 ? '-' + WIZ_LETTERS[q] : ''}`, name: `${it.value} ${sym} weight${it.qty > 1 ? ' ' + WIZ_LETTERS[q] : ''}`, nominalMass: it.value, assignedMass: null, unit: it.unit, referenceUncertainty: null, groupId: gid, massUncertainty: it.tol ? { value: it.tol.value, unit: it.tol.unit, basis: 'class-tolerance' } : null });
  }
  wizSyncLoads();
  const first = wizPlan().find(r => r.req > 0); wiz.selLoad = first ? first.load.loadId : wiz.loads[0].loadId;
}
// Required placements per single-weight load: 3 per mass level (the weights of a group take turns: 3 members -> 1 each, 2 -> 2 + 1, 1 -> 3).
function wizPlacements() { return clamp(Math.round(Number(wiz.placements) || SIMPLE_PLACEMENTS), SIMPLE_PLACEMENTS_MIN, SIMPLE_PLACEMENTS_MAX); }
function wizPlan() {
  const rows = [], P = wizPlacements();
  for (const l of wiz.loads) {
    if (!l.auto) continue;
    const w = wiz.weights.find(x => x.weightId === l.weightRef); if (!w) continue;
    let req = P;
    if (w.groupId) { const mem = wiz.weights.filter(x => x.groupId === w.groupId), k = mem.length, idx = mem.indexOf(w); req = Math.floor(P / k) + (idx < P % k ? 1 : 0); }
    rows.push({ load: l, req, done: wizCalObs(wiz).filter(o => o.loadId === l.loadId && o.loadingDirection !== 'down').length, mass: wizLoadMassSafe(l), direction: 'up' });
  }
  rows.sort((a, b) => a.mass - b.mass);
  return rows;
}
// Optional return run (Simple mode): after the way UP (empty, light ... heavy) one placement per mass level on the way DOWN (heavy ... empty).
function wizPlanDown() {
  if (!wiz.returnRun) return [];
  const by = new Map();
  for (const l of wiz.loads) { if (!l.auto) continue; const m = wizLoadMassSafe(l); if (!Number.isFinite(m)) continue; const k = fitKey(m); if (!by.has(k)) by.set(k, []); by.get(k).push(l); }
  const rows = [];
  for (const [k, ls] of by) {
    const cnt = l => wizCalObs(wiz).filter(o => o.loadId === l.loadId && o.loadingDirection === 'down').length, pick = ls.slice().sort((a, b) => cnt(a) - cnt(b))[0], done = ls.reduce((s, l) => s + cnt(l), 0);
    rows.push({ load: pick, req: 1, done, mass: wizLoadMassSafe(pick), direction: 'down' });
  }
  return rows.sort((a, b) => b.mass - a.mass);
}
function wizFullPlan() { return wizPlan().concat(wizPlanDown()); }
function wizPlainVerdict(v) {
  const st = v && v.status, f = ((v && v.flagged) || []).join(' ').toLowerCase();
  if (st === 'ok') return 'settled'; if (st === 'insufficient') return 'too short to judge'; if (!st || st === 'n/a') return 'not analysed';
  const why = [/level step|autocorrelation|allan/.test(f) ? 'still drifting' : null, /vibration/.test(f) ? 'vibration or interference' : null, /gaps/.test(f) ? 'data gaps' : null, /range/.test(f) ? 'outside the calibrated range' : null].filter(Boolean).join(', ') || 'unsteady';
  return (st === 'invalid' ? 'not usable: ' : 'not quite steady: ') + why;
}
// ---- observations ----------------------------------------------------------------------------------------------------
function wizNextObsId() { let n = wiz.observations.length + 1, id; do { id = `obs-${String(n++).padStart(3, '0')}`; } while (wiz.observations.some(o => o.observationId === id)); return id; }
// The full list of checks is kept (without the plot points) so the result stays expandable in the observation list and is saved in the file.
function compactAnalysis(an) {
  return { status: an.status, analyzedN: an.analyzedN || 0, note: an.note || '', checks: (an.checks || []).map(c => ({ id: c.id, label: c.label, verdict: c.verdict, valueText: c.valueText || '', detail: c.detail || '',
    threshold: { warn: c.threshold && c.threshold.warn != null ? c.threshold.warn : null, fail: c.threshold && c.threshold.fail != null ? c.threshold.fail : null, failText: c.threshold && c.threshold.failText || undefined, direction: c.threshold && c.threshold.direction || undefined } })) };
}
function wizObservationFromRange(first, end, loadId, source, direction = null, purpose = 'calibration', position = null) {
  const raws = new Array(end - first); for (let i = first; i < end; i++) raws[i - first] = getRaw(i);
  const st = rawStats(raws), an = analyzeInterval(first, end), status = charStatus(an, purpose);
  const flagged = charRelevantChecks(an, purpose).filter(c => c.verdict === 'suspect' || c.verdict === 'invalid').map(c => c.label.split(' / ')[0]);
  return { observationId: wizNextObsId(), loadId, recordedAt: new Date().toISOString(), placementRunId: wiz.runId, placementIndex: wiz.observations.length + 1, removedAndReplaced: wiz.replaced, loadingDirection: direction,
    rawMean: st.mean, rawStdDev: st.sd, rawMedian: st.median, rawMAD: st.mad, sampleCount: st.n, durationMs: getTime(end - 1) - getTime(first) + PERIOD_MS,
    validity: { status, flagged, analysis: compactAnalysis(an) }, include: status !== 'invalid', exclusionReason: status === 'invalid' ? 'validity check: invalid' : undefined, source,
    purpose, position, series: null, settleS: null, temperatures: auxTemperaturesFor(activeSensor, getTime(first), getTime(end - 1)), recordedUnderRevision: state.revisionId };
}
function wizRecord(opts = {}) {
  const why = wizBlock(); if (why) { wiz.message = why; wizRender(); return; }
  const purpose = opts.purpose || 'calibration';
  let load = wiz.loads.find(l => l.loadId === (opts.loadId || wiz.selLoad));
  if (purpose === 'calibration' && wizMode === 'simple') { const nx = wizFullPlan().find(r => r.done < r.req); if (nx) { load = nx.load; wiz.selLoad = load.loadId; } }   // Simple mode always records the placement it proposes
  if (!load) { wiz.message = 'Choose a load first.'; wizRender(); return; }
  if (wizMode === 'simple') wiz.captureSeconds = SIMPLE_CAPTURE_SECONDS;
  const n = clamp(Math.round(wiz.captureSeconds * RATE_HZ), 2, MEASUREMENT_MAX_SAMPLES);
  let dir = purpose === 'calibration' ? (wiz.direction || null) : null;
  if (purpose === 'calibration' && wizMode === 'simple') { dir = null; if (wiz.returnRun) { const nx = wizFullPlan().find(r => r.done < r.req); dir = nx ? nx.direction : 'up'; } }
  wiz.capture = { loadId: load.loadId, target: n, direction: dir, purpose, position: opts.position || null };
  const ok = beginMeasurement(n, { tag: 'calibration wizard', onDone: wizCaptureDone, onCancel: r => { wiz.capture = null; wiz.message = `Capture cancelled: ${r}`; if (wiz.open) wizRender(); } });
  if (!ok) { wiz.capture = null; wiz.message = $('measProgress').textContent; }
  else wiz.message = `Recording ${n.toLocaleString()} samples (${(n / RATE_HZ).toFixed(1)} s). Do not touch the platform.`;
  wizRender();
}
function wizCaptureDone(entry, first, end) {
  const cap = wiz.capture; wiz.capture = null; if (!cap) return;
  const o = wizObservationFromRange(first, end, cap.loadId, 'capture', cap.direction || null, cap.purpose || 'calibration', cap.position || null); wiz.observations.push(o);
  wiz.message = wizMode === 'simple' ? `Recorded: ${wizPlainVerdict(o.validity)}${o.include ? '' : ' (left out until you choose “include anyway”)'}.`
    : `Observation ${o.observationId} recorded: mean ${fmtNumber(o.rawMean, 2)} counts, SD ${fmtNumber(o.rawStdDev, 2)}, validity ${STATUS_TEXT[o.validity.status] || o.validity.status}${o.include ? '' : ' (excluded by default)'}.`;
  wiz.replaced = true; if (wiz.open) wizRender();
}
function wizUseSelection() {
  const why = wizBlock(); const s = state.selection;
  if (why && !/measurement is running/.test(why)) { wiz.message = why; wizRender(); return; }
  if (!s) { wiz.message = 'There is no selected interval on the chart.'; wizRender(); return; }
  if (s.t0 < oldestTime() || s.t1 > newestTime()) { wiz.message = 'The selected samples are no longer in the buffer.'; wizRender(); return; }
  const first = lowerBoundTime(s.t0), end = lowerBoundTime(s.t1 + 0.0001);
  if (end - first < 2) { wiz.message = 'Select at least two samples.'; wizRender(); return; }
  const o = wizObservationFromRange(first, end, wiz.selLoad, 'selection', wiz.direction || null); wiz.observations.push(o);
  wiz.message = `Observation ${o.observationId} taken from the selected interval (${o.sampleCount.toLocaleString()} samples).`; wizRender();
}
function wizAddManual() {
  const raw = Number(wq('wizManualRaw').value), sd = wq('wizManualSd').value === '' ? null : Number(wq('wizManualSd').value), n = wq('wizManualN').value === '' ? null : Math.round(Number(wq('wizManualN').value));
  if (!Number.isFinite(raw)) { wiz.message = 'Enter the mean raw counts.'; wizRender(); return; }
  wiz.observations.push({ observationId: wizNextObsId(), loadId: wiz.selLoad, recordedAt: new Date().toISOString(), placementRunId: wiz.runId, placementIndex: wiz.observations.length + 1, removedAndReplaced: wiz.replaced,
    loadingDirection: wiz.direction || null, rawMean: raw, rawStdDev: sd, rawMedian: null, rawMAD: null, sampleCount: n, durationMs: null, validity: { status: 'n/a', flagged: [], analysis: null }, include: true, source: 'manual' });
  wiz.message = 'Manual observation added (no validity analysis available).'; wizRender();
}
// Including an observation whose validity check failed is allowed, knowingly: the override is recorded (reason, time) and ends up in the JSON.
function wizSetInclude(o, on) {
  o.include = on;
  if (on) { delete o.exclusionReason; if (o.validity && o.validity.status === 'invalid') o.override = { reason: 'included anyway by user', at: new Date().toISOString() }; }
  else { o.exclusionReason = 'excluded in the fitting editor'; delete o.override; }
}
// ---- rendering -------------------------------------------------------------------------------------------------------
const WIZ_TABS = [['weights', '1 Weights'], ['observations', '2 Observations'], ['fit', '3 Fit'], ['review', '4 Review'], ['char', '5 Characterization']];
const WIZ_TABS_SIMPLE = [['weights', '1 Weights'], ['observations', '2 Measure'], ['review', '3 Finish'], ['extra', '4 Extra checks']];
function wizInput(a, i, f, v, type = 'text', extra = '') { return `<input type="${type}" ${type === 'number' ? 'step="any" ' : ''}data-w="${a}" data-i="${i}" data-f="${f}" value="${esc(v == null ? '' : v)}" ${extra}>`; }
function wizUnitSelect(a, i, f, cur) { return `<select data-w="${a}" data-i="${i}" data-f="${f}">${UNIT_CONFIG.units.filter(u => u.id !== 'raw').map(u => `<option value="${u.id}"${u.id === cur ? ' selected' : ''}>${esc(u.symbol)}</option>`).join('')}</select>`; }
function wizValidityBadge(v) { const st = (v && v.status) || 'n/a'; return `<span class="vbadge ${st === 'n/a' ? 'na' : st}">${VERDICT_ICON[st] || '–'} ${esc(STATUS_TEXT[st] || st)}${v && v.flagged && v.flagged.length ? ' (' + esc(v.flagged.join(', ')) + ')' : ''}</span>`; }
// The validity result of an observation is expandable (same list as for a measurement); its open/closed state survives re-rendering.
function wizValidityCell(o) { const v = o.validity || {}; return v.analysis && v.analysis.checks && v.analysis.checks.length ? analysisHTML(v.analysis, false, 'obs:' + o.observationId) : wizValidityBadge(v); }
function uncProfileLabel(unc) {
  if (!unc || unc.status !== 'estimated') return '';
  const w = unc.components.find(c => c.id === 'weight-tolerance'), h = unc.components.find(c => c.id === 'hysteresis');
  return w && w.included ? 'estimated, not traceable' : `estimated, ${h && h.included ? 'repeatability and hysteresis' : 'repeatability'} only, not traceable`;
}
function wizUncAt(unc, massMg) { return interpTable(unc.combined.table.map(t => ({ massMg: t.massMg, uMg: t.UMg })), massMg); }
function uncSummaryHTML(unc, unit) {
  if (!unc) return '';
  if (unc.status !== 'estimated') return `<div class="status-note">Uncertainty: not estimated. ${esc(unc.reason || '')}</div>`;
  const us = unitById(unit).symbol, lo = unc.combined.table[0].massMg, hi = unc.combined.table[unc.combined.table.length - 1].massMg;
  const rows = [0, .25, .5, .75, 1].map(f => { const m = lo + (hi - lo) * f, r = unc.combined.table.reduce((a, b) => Math.abs(b.massMg - m) < Math.abs(a.massMg - m) ? b : a); return `<tr><td>${wizMassText(r.massMg, unit)}</td><td>${esc(formatMassSig(r.uMg, unit))}</td><td>${r.dof.toFixed ? (Number.isFinite(r.dof) ? r.dof.toFixed(1) : '∞') : ''}</td><td>${r.k.toFixed(2)}</td><td><strong>± ${esc(formatMassSig(r.UMg, unit))}</strong></td></tr>`; }).join('');
  const comps = unc.components.map(c => `<li>${c.included ? '✓' : '✗'} ${esc(c.label)} <span class="small">· ${esc(c.note)}</span></li>`).join('');
  return `<div class="status-note"><strong>Estimated uncertainty (${esc(uncProfileLabel(unc))})</strong><ul class="small">${comps}</ul><div class="tablewrap"><table class="wiz-table"><thead><tr><th>Mass</th><th>u<sub>c</sub> (calibration side)</th><th>dof</th><th>k (95 %)</th><th>U = k u<sub>c</sub></th></tr></thead><tbody>${rows}</tbody></table></div><div class="small">A measurement adds its own reading noise and resolution. Not included: ${esc(unc.notIncluded.join(', '))}. A bias shared by all weights is not reduced by averaging and cannot be seen. This is an estimate, not a traceable uncertainty (symbol ${esc(us)}).</div></div>`;
}
function wizFitReport() {
  const b = wizBuild(), { pts, fits } = wizFits(), fit = b.fit, loo = fit.ok ? looResiduals(pts.points, b.model, { weighting: wizWeighting() }) : [], looBy = new Map(loo.map(l => [l.id, l]));
  return { generatedAt: new Date().toISOString(), applicationVersion: '14.0', mode: wizMode, sensorId: wiz.sensorId, samplingRateHz: wiz.rateHz,
    profile: { ...wiz.profile }, model: { id: b.model, label: FIT_MODELS[b.model].label }, weighting: fit.weighting, hysteresisUse: wiz.hysteresisUse || 'both',
    comparison: Object.entries(fits).map(([id, f]) => ({ model: id, ok: f.ok, errors: f.errors, parameters: f.params, dof: f.dof, residualSdCounts: Number.isFinite(f.sdRawRes) ? f.sdRawRes : null, reducedChiSquare: f.reducedChi2, rmsResidualMassMg: Number.isFinite(f.rmsMassMg) ? f.rmsMassMg : null, maxAbsResidualMassMg: Number.isFinite(f.maxAbsMassMg) ? f.maxAbsMassMg : null })),
    observations: wiz.observations.map(o => ({ observationId: o.observationId, loadId: o.loadId, loadingDirection: o.loadingDirection || null, rawMean: o.rawMean, rawStdDev: o.rawStdDev, sampleCount: o.sampleCount, durationMs: o.durationMs, validityStatus: (o.validity || {}).status, included: !!o.include, override: o.override || null })),
    residuals: fit.ok ? fit.residuals.map(r => ({ ...r, looResidualCounts: (looBy.get(r.id) || {}).looRaw ?? null, looResidualMg: (looBy.get(r.id) || {}).looMassMg ?? null })) : [],
    weightGroups: b.stats, hysteresis: b.hyst, uncertainty: b.unc, characterization: b.char, warnings: b.warnings.map(w => w.text), errors: b.errors };
}
function wizFitReportText(rep) {
  const L = [`# Fit report: ${rep.profile.profileName}`, '', `Generated ${rep.generatedAt} · sensor ${rep.sensorId} · mode ${rep.mode}`, '', `Model: ${rep.model.label}`, `Weighting: ${rep.weighting ? rep.weighting.scheme : ''}${rep.weighting && rep.weighting.reason ? ' (' + rep.weighting.reason + ')' : ''}`, `Loading directions used: ${rep.hysteresisUse}`, '', '## Model comparison', '', '| model | p | dof | SD (counts) | red. chi2 | RMS (mg) | largest (mg) |', '|---|---|---|---|---|---|---|'];
  for (const c of rep.comparison) L.push(c.ok ? `| ${c.model} | ${c.parameters} | ${c.dof} | ${c.residualSdCounts == null ? '-' : c.residualSdCounts.toFixed(3)} | ${c.reducedChiSquare == null ? '-' : c.reducedChiSquare.toFixed(2)} | ${c.rmsResidualMassMg == null ? '-' : c.rmsResidualMassMg.toFixed(2)} | ${c.maxAbsResidualMassMg == null ? '-' : c.maxAbsResidualMassMg.toFixed(2)} |` : `| ${c.model} | not possible: ${(c.errors || [])[0] || ''} |`);
  L.push('', '## Residuals (observed scatter, not uncertainty)', '', '| observation | mass (mg) | counts | residual (counts) | leave-one-out (counts) | standardised |', '|---|---|---|---|---|---|');
  for (const r of rep.residuals) L.push(`| ${r.id} | ${r.massMg} | ${r.raw} | ${r.resRaw.toFixed(3)} | ${r.looResidualCounts == null ? '-' : r.looResidualCounts.toFixed(3)} | ${Number.isFinite(r.std) ? r.std.toFixed(2) : '-'} |`);
  if (rep.hysteresis) { L.push('', '## Hysteresis (mean down - mean up)', '', '| mass (mg) | n up | n down | diff (counts) | diff (mg) |', '|---|---|---|---|---|'); for (const l of rep.hysteresis.levels) L.push(`| ${l.massMg} | ${l.nUp} | ${l.nDown} | ${l.diffCounts.toFixed(3)} | ${Number.isFinite(l.diffMg) ? l.diffMg.toFixed(2) : '-'} |`); }
  if (rep.uncertainty) { L.push('', `## Uncertainty (${rep.uncertainty.status}${rep.uncertainty.status === 'estimated' ? ', ' + uncProfileLabel(rep.uncertainty) : ''})`, ''); if (rep.uncertainty.reason) L.push(rep.uncertainty.reason); for (const c of rep.uncertainty.components || []) L.push(`- ${c.included ? 'included' : 'left out'}: ${c.label} - ${c.note}`); if (rep.uncertainty.notIncluded) L.push('', 'Not included: ' + rep.uncertainty.notIncluded.join(', ')); }
  if (rep.warnings.length) { L.push('', '## Warnings', ''); for (const w of rep.warnings) L.push('- ' + w); }
  if (rep.errors.length) { L.push('', '## Errors', ''); for (const w of rep.errors) L.push('- ' + w); }
  return L.join('\n') + '\n';
}
function wizPaneWeights() {
  const w = wiz, p = w.profile;
  const gopts = cur => `<option value="">— none —</option>` + w.groups.map(g => `<option value="${esc(g.groupId)}"${g.groupId === cur ? ' selected' : ''}>${esc(g.name)}</option>`).join('');
  const rows = w.weights.map((x, i) => `<tr><td>${wizInput('weight', i, 'name', x.name)}</td><td>${wizInput('weight', i, 'nominalMass', x.nominalMass, 'number', 'min="0"')}</td><td>${wizInput('weight', i, 'assignedMass', x.assignedMass, 'number', 'min="0" placeholder="= nominal"')}</td><td>${wizUnitSelect('weight', i, 'unit', x.unit)}</td><td>${x.weightId === 'ref-empty' ? '' : wizInput('weight', i, 'uncValue', x.massUncertainty ? x.massUncertainty.value : '', 'number', 'min="0" placeholder="none" title="Plus/minus value in the weight unit: the certificate uncertainty U, or the tolerance limit"')}</td><td>${x.weightId === 'ref-empty' ? '' : `<select data-w="weight" data-i="${i}" data-f="uncBasis">${Object.entries(WEIGHT_UNC_BASES).map(([id, t]) => `<option value="${id}"${(x.massUncertainty ? x.massUncertainty.basis : 'none') === id ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`}</td><td>${x.weightId === 'ref-empty' ? '' : `<select data-w="weight" data-i="${i}" data-f="groupId">${gopts(x.groupId)}</select>`}</td><td>${x.weightId === 'ref-empty' ? '' : `<button data-wa="delWeight" data-i="${i}" title="Remove this weight">✕</button>`}</td></tr>`).join('');
  const grows = w.groups.map((g, i) => { const mem = w.weights.filter(x => x.groupId === g.groupId), odd = g.massBasis === 'nominal' && mem.some(x => Math.abs(massToMg(Number(x.nominalMass), x.unit) - massToMg(Number(g.nominalMass), g.unit)) > 1e-9 * Math.max(1, massToMg(Number(g.nominalMass), g.unit)));
    return `<tr><td>${wizInput('group', i, 'name', g.name)}</td><td>${wizInput('group', i, 'nominalMass', g.nominalMass, 'number', 'min="0"')}</td><td>${wizUnitSelect('group', i, 'unit', g.unit)}</td>
      <td><select data-w="group" data-i="${i}" data-f="massBasis"><option value="nominal"${g.massBasis === 'nominal' ? ' selected' : ''}>nominal (uncertified)</option><option value="assigned"${g.massBasis === 'assigned' ? ' selected' : ''}>assigned (own masses)</option></select></td>
      <td><select data-w="group" data-i="${i}" data-f="aggregation"><option value="mean-of-placements"${g.aggregation === 'mean-of-placements' ? ' selected' : ''}>mean of placements</option><option value="variance-components"${g.aggregation === 'variance-components' ? ' selected' : ''}>mean of weight means</option></select></td>
      <td>${mem.length}${odd ? ' <span class="warning" title="Some members have a different nominal mass than the group; with basis “nominal” the group mass is used for all of them.">⚠</span>' : ''}</td><td><button data-wa="delGroup" data-i="${i}" title="Dissolve this group (the weights stay)">✕</button></td></tr>`; }).join('');
  const singles = w.weights.filter(x => x.weightId !== 'ref-empty');
  const combo = w.comboOpen ? `<div class="status-note" style="margin:8px 0"><strong>New combination:</strong> tick the weights that are placed on the platform together.<div>${singles.map((x, i) => `<label class="check"><input type="checkbox" data-w="comboPick" data-i="${w.weights.indexOf(x)}" ${w.comboPick[x.weightId] ? 'checked' : ''}> ${esc(x.name)} (${wizMassText(wizWeightMassMg(w, x), x.unit)})</label>`).join('') || '<span class="small">Add weights first.</span>'}</div><div class="button-row"><button class="primary" data-wa="comboCreate">Create combination</button><button data-wa="comboCancel">Cancel</button></div></div>` : '';
  const combos = w.loads.filter(l => !l.auto).map(l => `<tr><td>${esc(l.name)}</td><td>${l.components.map(c => esc((w.weights.find(x => x.weightId === c.weightId) || {}).name || '?')).join(' + ')}</td><td>${wizMassText(wizLoadMassSafe(l), p.unit)}</td><td><button data-wa="delLoad" data-id="${esc(l.loadId)}">✕</button></td></tr>`).join('');
  return `<div class="button-row" style="margin-top:0"><button data-wa="restart">Start empty</button><button data-wa="fromActive">Load the active calibration of the shown sensor (refit / edit)</button></div>
  <div class="control-grid" style="margin-top:10px"><div class="field span2"><label>Profile name</label>${wizInput('profile', 0, 'profileName', p.profileName)}</div>
  <div class="field"><label>Profile ID</label>${wizInput('profile', 0, 'profileId', p.profileId)}</div>
  <div class="field"><label>Calibration unit (masses in the file)</label>${wizUnitSelect('profile', 0, 'unit', p.unit)}</div>
  <div class="field span2"><label>Notes (stored in environment.notes)</label>${wizInput('profile', 0, 'notes', p.notes)}</div>
  <div class="field"><label>Temperature (°C)</label>${wizInput('profile', 0, 'temperatureC', p.temperatureC, 'number')}</div><div class="field"><label>Relative humidity (%)</label>${wizInput('profile', 0, 'humidityPercent', p.humidityPercent, 'number')}</div><div class="field"><label>Warm-up before measuring (min)</label>${wizInput('profile', 0, 'warmUpMinutes', p.warmUpMinutes, 'number', 'min="0"')}</div></div>
  <h3 style="margin:12px 0 4px">Reference weights</h3>
  <div class="small">Tolerance: if you know it, type the weight’s tolerance (class limit, e.g. ±0.5 mg) or certificate uncertainty U. Limits count as rectangular (÷√3), a certificate U is divided by k = 2. Weights without it make the estimated uncertainty “repeatability only”. Every physical weight is its own entry. Enter the certificate (assigned) mass if you have one; otherwise the nominal mass is used. Put weights of the same claimed mass into a <strong>weight group</strong> (below) to pool them into one anchor.</div>
  <div class="tablewrap"><table class="wiz-table"><thead><tr><th>Name</th><th>Nominal</th><th>Assigned</th><th>Unit</th><th title="Certificate uncertainty U, or tolerance limit, in the weight unit">± U / tolerance</th><th>Basis</th><th>Group</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
  <div class="button-row"><button data-wa="addWeight">＋ Add weight</button><button data-wa="comboOpen" title="A load of several weights placed together, e.g. 100 g A + 100 g B">＋ Add combination…</button></div>${combo}
  ${combos ? `<h3 style="margin:12px 0 4px">Combination loads</h3><div class="tablewrap"><table class="wiz-table"><tbody>${combos}</tbody></table></div>` : ''}
  <h3 style="margin:12px 0 4px">Weight groups</h3>
  <div class="small">Mass basis <strong>nominal</strong>: all members count as exactly the group's nominal mass (uncertified weights; the file records that the mass scale rests on nominal values). <strong>assigned</strong>: every member keeps its own certificate mass. Each weight stays stored independently in the file.</div>
  ${grows ? `<div class="tablewrap"><table class="wiz-table"><thead><tr><th>Group</th><th>Nominal</th><th>Unit</th><th>Mass basis</th><th>Anchor = </th><th>Members</th><th></th></tr></thead><tbody>${grows}</tbody></table></div>` : '<div class="small">No groups yet.</div>'}
  <div class="button-row"><button data-wa="addGroup">＋ Add group</button></div>`;
}
function wizPaneObs() {
  const w = wiz, p = w.profile, why = wizBlock(), busy = !!w.capture, li = w.loads.findIndex(l => l.loadId === w.selLoad);
  const opts = w.loads.map(l => `<option value="${esc(l.loadId)}"${l.loadId === w.selLoad ? ' selected' : ''}>${esc(l.name)} · ${wizMassText(wizLoadMassSafe(l), p.unit)}</option>`).join('');
  const rows = w.observations.map((o, i) => { if (!isCalObs(o)) return ''; const l = w.loads.find(x => x.loadId === o.loadId);
    return `<tr class="${o.include ? '' : 'excl'}"><td>${esc(o.observationId)}</td><td>${esc(l ? l.name : '?')}</td><td>${l ? wizMassText(wizLoadMassSafe(l), p.unit) : '—'}</td><td>${fmtNumber(o.rawMean, 3)}</td><td>${o.rawStdDev == null ? '—' : fmtNumber(o.rawStdDev, 3)}</td><td>${o.sampleCount == null ? '—' : o.sampleCount.toLocaleString()}${o.durationMs ? ' · ' + fmtSpan(o.durationMs / 1000) : ''}</td><td>${wizValidityCell(o)}</td><td><select data-w="obsDir" data-i="${i}" aria-label="Loading direction"><option value=""${!o.loadingDirection ? ' selected' : ''}>–</option><option value="up"${o.loadingDirection === 'up' ? ' selected' : ''}>up</option><option value="down"${o.loadingDirection === 'down' ? ' selected' : ''}>down</option></select></td><td><input type="checkbox" data-w="obsInclude" data-i="${i}" ${o.include ? 'checked' : ''} aria-label="Include in the fit">${o.override ? '<div class="small warning">included anyway</div>' : ''}</td><td><button data-wa="delObs" data-i="${i}">✕</button></td></tr>`; }).join('');
  return `<div class="small">Put the load on the platform, wait until the reading has settled, then record. Observations store raw counts of the shown sensor (<strong>${esc(activeSensor.name)}</strong>). Place and remove a weight repeatedly for replicates: the scatter between placements is what the fit can resolve.</div>
  <div class="control-grid" style="margin-top:8px"><div class="field span2"><label>Load on the platform</label><div class="inline" style="flex-wrap:nowrap"><button data-wa="loadPrev" title="Previous load" aria-label="Previous load" ${li <= 0 ? 'disabled' : ''}>◀</button><select data-w="selLoad">${opts}</select><button data-wa="loadNext" title="Next load" aria-label="Next load" ${li < 0 || li >= w.loads.length - 1 ? 'disabled' : ''}>▶</button></div></div>
  <div class="field"><label>Recording length (s) → <span id="wizSamplesNote">${Math.round(w.captureSeconds * RATE_HZ).toLocaleString()} samples at ${RATE_HZ} Hz</span></label><input type="number" min="0.1" step="any" data-w="capSeconds" value="${w.captureSeconds}"></div>
  <div class="field"><label class="check" style="margin-top:18px"><input type="checkbox" data-w="replaced" ${w.replaced ? 'checked' : ''}> removed and replaced since the last placement</label></div>
  <div class="field span2"><label>Loading direction of the next recording</label><select data-w="direction"><option value=""${!w.direction ? ' selected' : ''}>not recorded</option><option value="up"${w.direction === 'up' ? ' selected' : ''}>up (the load was increased to reach this mass)</option><option value="down"${w.direction === 'down' ? ' selected' : ''}>down (the load was decreased to reach this mass)</option></select></div></div>
  <div class="button-row"><button class="primary" data-wa="record" ${why || busy ? 'disabled' : ''}>● Record from the shown sensor</button><button data-wa="useSel" ${why && !/measurement is running/.test(why) ? 'disabled' : ''}>Use the selected interval</button>${busy ? '<button data-wa="cancelRec">Cancel recording</button>' : ''}</div>
  <progress id="wizRecBar" max="1" value="0" ${busy ? '' : 'hidden'}></progress><div class="small" id="wizRecProgress">${why ? esc(why) : ''}</div>
  <details id="wizManualBox" style="margin-top:8px"${w.manualOpen ? ' open' : ''}><summary>Enter an observation by hand</summary>
    <div class="control-grid" style="margin-top:8px"><div class="field"><label>Mean counts</label><input type="number" step="any" id="wizManualRaw"></div><div class="field"><label>SD (optional)</label><input type="number" step="any" id="wizManualSd"></div><div class="field"><label>Samples (optional)</label><input type="number" step="1" id="wizManualN"></div><div class="field"><label>&nbsp;</label><button data-wa="addManual">＋ Add for the load above</button></div></div>
    <div class="small">For the load chosen above. A manual observation has no validity analysis.</div></details>
  <div class="tablewrap"><table class="wiz-table"><thead><tr><th>ID</th><th>Load</th><th>Mass</th><th>Mean (counts)</th><th>SD</th><th>n · time</th><th>Validity (click to expand)</th><th title="Loading direction: up = load increased, down = decreased">Dir</th><th title="Include in the fit">Use</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="10" class="small">No observations yet.</td></tr>'}</tbody></table></div>`;
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
// ---- model and weighting: Advanced = the user's choice (default equal weights = v12); Simple = the wizard's choice ----------------
function wizWeighting() { return wizMode === 'simple' ? 'shrinkage' : (wiz.weighting || 'equal'); }
function wizFits() {
  const pts = wizPoints(wiz), fits = {};
  for (const m of Object.keys(FIT_MODELS)) fits[m] = fitCalibration(pts.points, m, { weighting: wizWeighting() });
  return { pts, fits };
}
// Simple: a straight line if there are >= 3 different masses, degrees of freedom are left and no observation is off the line by more than 0.5 % of the
// mass span; otherwise point-to-point lines through the averages.
function wizChooseModel(fits) {
  const l = fits.linear;
  if (l && l.ok && l.distinct >= 3 && l.dof > 0 && l.maxAbsMassMg <= SIMPLE_LINEAR_TOL * (l.mRange[1] - l.mRange[0])) return 'linear';
  return 'anchors';
}
function wizActiveModel(fits) { return wizMode === 'simple' ? wizChooseModel(fits) : wiz.fitModel; }
function wizBuild() {
  const { pts, fits } = wizFits(), model = wizActiveModel(fits), fit = fits[model], errors = [...pts.errors], warnings = [];
  const W = (text, plain, code) => warnings.push({ code, text, plain: plain || text });
  if (!wiz.profile.profileName.trim()) errors.push('The profile needs a name.');
  if (!/^[A-Za-z0-9._-]+$/.test(String(wiz.profile.profileId || ''))) errors.push('The profile ID may only contain letters, digits, dot, underscore and hyphen (it becomes part of the file name).');
  if (!fit.ok) errors.push(...fit.errors);
  let cfg = null, stats = [];
  if (!errors.length) {
    stats = weightGroupStats(wiz, fit);
    if (fit.dof <= 0) W(fit.warnings.find(x => /degrees of freedom/.test(x)) || 'No degrees of freedom.', 'Not enough repeats to judge the scatter. Record each weight 3 times if you can.', 'dof');
    if (fit.distinct < 3) W('Only two different reference masses: linearity cannot be checked.', 'Only two different masses: a bent response cannot be seen.', 'masses');
    if (fit.weighting.reason && fit.weighting.requested !== 'equal') W(fit.weighting.reason, 'Too few repeats to weight the points: all of them count the same.', 'weighting');
    const flagged = wizCalObs(wiz).filter(o => o.include && !o.override && o.validity && (o.validity.status === 'invalid' || o.validity.status === 'suspect')).length;
    if (flagged) W(`${flagged} included observation(s) have a validity flag (suspect or invalid).`, `${flagged} measurement(s) used were not quite steady.`, 'validity');
    const over = wizCalObs(wiz).filter(o => o.include && o.override).length;
    if (over) W(`${over} observation(s) whose validity check failed were included anyway by the user (recorded in the file).`, `${over} measurement(s) that looked unsteady were used anyway (you chose “include anyway”).`, 'override');
    if (!wizCalObs(wiz).some(o => o.removedAndReplaced && o.placementIndex > 1)) W('No placement is marked as removed and replaced: placement repeatability was not sampled.', 'The weights were not taken off and put back between recordings.', 'replace');
    if (!wiz.weights.some(x => x.assignedMass != null)) W('No certificate (assigned) masses were entered: the calibration rests on the nominal values of the weights and is not traceable; its accuracy cannot be better than the weights’ own tolerance.', 'The weights are not certified. The scale can only be as accurate as the weights themselves.', 'nominal');
    for (const s of stats) if (s.verdict === 'differ') W(`Weight group “${s.name}”: the weights differ from each other (between-weight SD ${fmtNumber(s.sB, 2)} counts) by more than the placement scatter (${fmtNumber(s.sW, 2)} counts).`, `The weights of “${s.name}” are not equal in practice.`, 'group');
    const allPts = wizPoints(wiz, { all: true }).points, hyst = fit.slopeAt ? hysteresisAnalysis(allPts, fit.slopeAt) : null, unc = buildUncertaintyProfile(wiz, fit, hyst, wiz.hysteresisUse || 'both');
    if (unc.status === 'not-estimable') W(unc.reason, 'The uncertainty cannot be estimated yet: record each weight several times (taking it off and putting it back).', 'uncertainty');
    else if (!unc.components.find(c => c.id === 'weight-tolerance').included) W('No (or not for every weight) typed tolerance or certificate uncertainty: the estimated uncertainty covers repeatability only and is not traceable.', 'The estimated uncertainty only reflects how repeatable your placements were, not how accurate the weights are. Type the weights’ tolerance if you know it.', 'noTolerance');
    if (hyst && hyst.levels.length && (wiz.hysteresisUse || 'both') !== 'both') W('The fit uses one loading direction only; hysteresis is reported but not included in the uncertainty.', 'Only one loading direction is used for the calibration.', 'hystOne');
    const chBlock = buildCharacterization(wiz, fit);
    cfg = buildCalibrationConfig(Object.assign({}, wiz, { sensorId: wiz.sensorId, rateHz: wiz.rateHz }), fit, new Date().toISOString(), { warnings: warnings.map(x => x.text), groupStats: stats, uncertainty: unc, hysteresis: hyst, characterization: chBlock });
    const checked = validateCalibrationConfig(cfg); errors.push(...checked.errors); for (const t of checked.warnings) W(t, 'This is not a certified calibration; no uncertainty is claimed.', 'validate');
  }
  return { cfg, fit, model, errors, warnings, stats, unc: cfg ? cfg.uncertainty : null, hyst: cfg ? cfg.reserved.hysteresisAnalysis : null, char: cfg ? cfg.characterization : null };
}
function wizId(prefix, list, key) { let n = wiz.nextNum++; while (list.some(x => x[key] === `${prefix}${n}`)) n = wiz.nextNum++; return `${prefix}${n}`; }
function wizStamp() { return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12); }
function wizPaneFit() {
  const p = wiz.profile, u = p.unit, { pts, fits } = wizFits(), fit = fits[wiz.fitModel], uf = mg => mgToUnit(mg, u), us = unitById(u).symbol;
  const hy = fit.ok && fit.slopeAt ? hysteresisAnalysis(wizPoints(wiz, { all: true }).points, fit.slopeAt) : null, unc = fit.ok ? buildUncertaintyProfile(wiz, fit, hy, wiz.hysteresisUse || 'both') : null;
  const looBy = new Map((fit.ok ? looResiduals(pts.points, wiz.fitModel, { weighting: wizWeighting() }) : []).map(l => [l.id, l]));
  const sel = Object.entries(FIT_MODELS).map(([id, m]) => `<option value="${id}"${id === wiz.fitModel ? ' selected' : ''}>${esc(m.label)}</option>`).join('');
  const wsel = Object.entries(WEIGHTINGS).map(([id, t]) => `<option value="${id}"${id === wiz.weighting ? ' selected' : ''}>${esc(t)}</option>`).join('');
  const cmp = Object.entries(FIT_MODELS).map(([id, m]) => { const f = fits[id]; return `<tr class="${id === wiz.fitModel ? 'sel' : ''}"><td>${esc(m.label)}</td>${f.ok ? `<td>${f.params}</td><td>${f.dof}</td><td>${Number.isFinite(f.sdRawRes) ? fmtNumber(f.sdRawRes, 3) : '—'}</td><td>${f.reducedChi2 == null ? '—' : fmtNumber(f.reducedChi2, 2)}</td><td>${wizMassText(f.rmsMassMg, u)}</td><td>${wizMassText(f.maxAbsMassMg, u)}</td>` : `<td colspan="6" class="warning">${esc(f.errors[0] || 'not possible')}</td>`}</tr>`; }).join('');
  let plots = '';
  const all = wizCalObs(wiz).map(o => { const l = wiz.loads.find(x => x.loadId === o.loadId); return l ? { o, m: wizLoadMassSafe(l) } : null; }).filter(x => x && Number.isFinite(x.m));
  if (all.length >= 2 && fit.g) {
    const xs = all.map(a => uf(a.m)), lo = Math.min(...xs), hi = Math.max(...xs), cur = [];
    for (let k = 0; k <= 60; k++) { const m = fit.mRange[0] + (fit.mRange[1] - fit.mRange[0]) * k / 60; cur.push([uf(m), fit.g(m)]); }
    const ys = all.map(a => a.o.rawMean).concat(cur.map(c => c[1])), yl = Math.min(...ys), yh = Math.max(...ys), py = (yh - yl) * 0.08 || 1, px = (hi - lo) * 0.04 || 1;
    plots += wizPlotSVG({ w: 560, h: 250, xMin: lo - px, xMax: hi + px, yMin: yl - py, yMax: yh + py, xFmt: v => fmtNumber(v, 1), yFmt: v => fmtNumber(v, 0), curve: cur, points: all.map(a => ({ x: uf(a.m), y: a.o.rawMean, on: a.o.include })), xTitle: `reference mass (${us})`, yTitle: 'mean raw counts' });
    const rp = all.map(a => { const g = fit.g(a.m), d = fit.dg ? fit.dg(a.m) : null; return { x: uf(a.m), y: d ? uf((a.o.rawMean - g) / d) : NaN, on: a.o.include }; }).filter(q => Number.isFinite(q.y));
    if (rp.length && fit.dg) { const r = Math.max(...rp.map(q => Math.abs(q.y)), 1e-9) * 1.15; plots += wizPlotSVG({ w: 560, h: 170, xMin: lo - px, xMax: hi + px, yMin: -r, yMax: r, xFmt: v => fmtNumber(v, 1), yFmt: v => fmtNumber(v, 3), curve: [], points: rp, zero: true, xTitle: `reference mass (${us})`, yTitle: `residual (${us})` }); }
    const sp = fit.ok ? fit.residuals.filter(r => Number.isFinite(r.std)).map(r => ({ x: uf(r.massMg), y: r.std, on: true })) : [];
    if (sp.length) { const r = Math.max(3, ...sp.map(q => Math.abs(q.y))) * 1.1; plots += wizPlotSVG({ w: 560, h: 170, xMin: lo - px, xMax: hi + px, yMin: -r, yMax: r, xFmt: v => fmtNumber(v, 1), yFmt: v => fmtNumber(v, 1), curve: [], points: sp, zero: true, xTitle: `reference mass (${us})`, yTitle: 'standardised residual' }); }
  }
  const rrows = fit.ok ? fit.residuals.map(r => `<tr><td>${esc(r.id)}</td><td>${wizMassText(r.massMg, u)}</td><td>${fmtNumber(r.raw, 3)}</td><td>${fmtNumber(r.fitRaw, 3)}</td><td>${fmtNumber(r.resRaw, 3)}</td><td>${Number.isFinite(r.resMassMg) ? fmtNumber(uf(r.resMassMg), 4) : '—'}</td><td>${fmtNumber(r.w, 4)}</td><td>${Number.isFinite(r.std) ? fmtNumber(r.std, 2) : '—'}</td><td>${(looBy.get(r.id) || {}).looRaw == null ? '—' : fmtNumber(looBy.get(r.id).looRaw, 3)}</td><td>${(looBy.get(r.id) || {}).looMassMg == null ? '—' : fmtNumber(uf(looBy.get(r.id).looMassMg), 4)}</td></tr>`).join('') : '';
  const wt = fit.weighting || {}, sig = new Map((wt.sigmaPerMass || []).map(s => [fitKey(s.massMg), s]));
  const groups = fit.groups.map(g => { const s = sig.get(fitKey(g.massMg)); return `<tr><td>${wizMassText(g.massMg, u)}</td><td>${g.raws.length}</td><td>${fmtNumber(g.rawMean, 3)}</td><td>${Number.isFinite(g.rawSD) ? fmtNumber(g.rawSD, 3) : '—'}</td><td>${s ? fmtNumber(s.sigma, 3) : '—'}</td></tr>`; }).join('');
  const gs = fit.ok ? weightGroupStats(wiz, fit) : [];
  const gstat = gs.map(s => `<tr><td>${esc(s.name)}</td><td>${s.a} weights · ${s.N} placements</td><td>${s.sW == null ? '—' : fmtNumber(s.sW, 3)}</td><td>${s.sB == null ? '—' : fmtNumber(s.sB, 3)}</td><td>${s.F == null ? '—' : (Number.isFinite(s.F) ? fmtNumber(s.F, 2) : '∞')}</td><td>${s.verdict === 'differ' ? '<span class="warning">weights differ</span>' : s.verdict === 'same' ? 'no difference beyond placement scatter' : esc(s.reason)}</td></tr>` + s.members.map(m => `<tr class="sub"><td></td><td>${esc(m.name)} · ${m.n} placement(s)</td><td colspan="2">${m.meanRaw == null ? '—' : fmtNumber(m.meanRaw, 3) + ' counts'}</td><td colspan="2">${m.relMassMg == null ? '—' : (m.relMassMg >= 0 ? '+' : '') + fmtNumber(uf(m.relMassMg), 4) + ' ' + esc(us) + (m.relMassSeMg != null ? ' ± ' + fmtNumber(uf(m.relMassSeMg), 4) : '')} relative to the group mean</td></tr>`).join('')).join('');
  return `${pts.errors.length ? `<div class="warning small">${pts.errors.map(esc).join('<br>')}</div>` : ''}
  <div class="control-grid"><div class="field"><label>Model</label><select data-w="fitModel">${sel}</select></div><div class="field"><label>Weighting (line / polynomial fits)</label><select data-w="weighting">${wsel}</select></div><div class="field"><label title="Observations without a direction count as up">Loading directions used in the fit</label><select data-w="hystUse"><option value="both"${(wiz.hysteresisUse || 'both') === 'both' ? ' selected' : ''}>both (mean path; hysteresis is a separate component)</option><option value="up"${wiz.hysteresisUse === 'up' ? ' selected' : ''}>up only</option><option value="down"${wiz.hysteresisUse === 'down' ? ' selected' : ''}>down only</option></select></div></div>
  <div class="small" style="margin:6px 0">The curve is fitted as counts on mass (the noise is in the counts) and then written to the file as anchors sampled on the fitted curve. Switch observations on or off in step 2; excluded ones stay in the file, marked. Weighting uses the scatter <em>between placements</em> at each mass (shrunk towards the pooled value, or a straight-line variance model); with fewer than 3 masses or no replicates it falls back to equal weights and says so. The piecewise-linear model already averages replicates, so weights do not apply to it.</div>
  ${fit.ok ? `<div class="readout">Observations used: <strong>${fit.n}</strong> · different masses: <strong>${fit.distinct}</strong> · parameters: <strong>${fit.params}</strong> · degrees of freedom: <strong>${fit.dof}</strong><br>Weighting used: <strong>${esc(WEIGHTINGS[wt.scheme] || wt.scheme)}</strong>${wt.reason ? ` <span class="warning">(${esc(wt.reason)})</span>` : ''}${fit.reducedChi2 != null ? `<br>Reduced χ² = Σ w r² / dof: <strong>${fmtNumber(fit.reducedChi2, 2)}</strong> (about 1: model and scatter estimate agree; much larger: the model is wrong or the scatter was underestimated; much smaller: scatter overestimated)` : ''}<br>Residual SD: <strong>${Number.isFinite(fit.sdRawRes) ? fmtNumber(fit.sdRawRes, 3) + ' counts' : 'not defined (no degrees of freedom)'}</strong> · RMS residual: <strong>${wizMassText(fit.rmsMassMg, u)}</strong> · largest: <strong>${wizMassText(fit.maxAbsMassMg, u)}</strong>${fit.nodes ? `<br>Written as <strong>${fit.nodes - 1}</strong> linear segments; largest deviation from the exact inverse: <strong>${wizMassText(fit.maxInterpErrMg, u)}</strong>` : ''}</div>` : `<div class="warning">${fit.errors.map(esc).join('<br>')}</div>`}
  <div class="plots">${plots}</div>
  ${hy ? `<h3 style="margin:12px 0 4px">Hysteresis: mean(down) − mean(up)</h3><div class="tablewrap"><table class="wiz-table"><thead><tr><th>Mass</th><th>n up</th><th>n down</th><th>Difference (counts)</th><th>Difference (${esc(us)})</th></tr></thead><tbody>${hy.levels.map(l => `<tr><td>${wizMassText(l.massMg, u)}</td><td>${l.nUp}</td><td>${l.nDown}</td><td>${fmtNumber(l.diffCounts, 3)}</td><td>${Number.isFinite(l.diffMg) ? (l.diffMg >= 0 ? '+' : '') + fmtNumber(uf(l.diffMg), 4) : '—'}${l.seMg != null ? ' ± ' + fmtNumber(uf(l.seMg), 4) : ''}</td></tr>`).join('')}</tbody></table></div><div class="small">Hysteresis: the reading at the same load differs depending on whether it was approached from below or from above. With “both” the curve is the mean path and half of this difference enters the uncertainty as its own component.</div>` : '<div class="small" style="margin-top:8px">No hysteresis analysis: no mass has observations in both loading directions (set “Loading direction” in step 2).</div>'}
  ${uncSummaryHTML(unc, u)}
  <div class="button-row"><button data-wa="exportReport" ${fit.ok ? '' : 'disabled'}>Export full fit report (JSON)</button><button data-wa="exportReportText" ${fit.ok ? '' : 'disabled'}>Export fit report (text)</button></div>
  <h3 style="margin:12px 0 4px">Model comparison (same observations, same weighting)</h3><div class="tablewrap"><table class="wiz-table"><thead><tr><th>Model</th><th>p</th><th>dof</th><th>SD (counts)</th><th>red. χ²</th><th>RMS</th><th>largest</th></tr></thead><tbody>${cmp}</tbody></table></div>
  <div class="small">A lower residual SD with fewer degrees of freedom is not better evidence: a model with dof = 0 passes through every point and says nothing about scatter. Prefer the simplest model whose residuals show no pattern.</div>
  ${groups ? `<h3 style="margin:12px 0 4px">Replicates per reference mass</h3><div class="tablewrap"><table class="wiz-table"><thead><tr><th>Mass</th><th>Placements</th><th>Mean (counts)</th><th>SD between placements</th><th>σ used for weighting</th></tr></thead><tbody>${groups}</tbody></table></div>` : ''}
  ${gstat ? `<h3 style="margin:12px 0 4px">Weight groups: are the weights equal?</h3><div class="tablewrap"><table class="wiz-table"><thead><tr><th>Group</th><th>Data</th><th>Within-weight SD (counts)</th><th>Between-weight SD (counts)</th><th>F</th><th>Verdict</th></tr></thead><tbody>${gstat}</tbody></table></div><div class="small">One-way variance components: within = scatter of repeated placements of the same weight, between = differences between the weights beyond that. “Weights differ” is an informal finding (between &gt; within), not an error. Relative masses show how the sensor ranks the weights; a bias shared by all of them cannot be seen this way.</div>` : ''}
  ${rrows ? `<h3 style="margin:12px 0 4px">Residuals (observed scatter, not uncertainty)</h3><div class="tablewrap"><table class="wiz-table"><thead><tr><th>Observation</th><th>Mass</th><th>Counts</th><th>Fit</th><th>Residual (counts)</th><th>Residual (${esc(us)})</th><th>Weight</th><th>Standardised</th><th title="Observed value minus the prediction of the fit WITHOUT this observation: a point that only the fit itself can explain stands out here">Leave-one-out (counts)</th><th>Leave-one-out (${esc(us)})</th></tr></thead><tbody>${rrows}</tbody></table></div>` : ''}`;
}
function wizSizeLine(cfg) {
  if (!cfg || typeof CompressionStream === 'undefined') return '';
  const text = JSON.stringify({ ...cfg, createdAt: 0, modifiedAt: 0 }); let h = 5381; for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  const key = text.length + ':' + h;
  if (!wiz.size || wiz.size.key !== key) { wiz.size = { key, bytes: null }; gzipText(JSON.stringify(cfg)).then(g => { if (wiz.size && wiz.size.key === key) { wiz.size.bytes = g.length; if (wiz.open && (wiz.tab === 'review' || wiz.tab === 'fit')) setTimeout(wizRender, 0); } }).catch(() => {}); }
  const fl = deviceStatus && deviceStatus.flash ? deviceStatus.flash.filesystemFree : null, max = deviceInfo && deviceInfo.maxUploadBytes;
  return `<div class="small" style="margin:6px 0">Compressed size on the device: <strong>${wiz.size.bytes == null ? 'calculating…' : fmtBytes(wiz.size.bytes)}</strong>${deviceReachable ? ` · free flash: ${fmtBytes(fl)} · limit per upload: ${fmtBytes(max)}` : ' · no device connected'}${wiz.size.bytes != null && max && wiz.size.bytes > max ? ' <span class="warning">(too large for the device)</span>' : ''}${wiz.size.bytes != null && fl != null && wiz.size.bytes > fl ? ' <span class="warning">(more than the free flash; only fits if it replaces a file)</span>' : ''}</div>`;
}
async function wizSend() {
  const r = wizBuild(); if (!r.cfg || r.errors.length) { wiz.message = 'Fix the listed errors first.'; wizRender(); return; }
  try { const out = await sendCalibrationToDevice(r.cfg, wiz.sensorId); wiz.message = `Sent ${out.name} (${fmtBytes(out.bytes)} compressed): ${writeResultText(out.result)}. To make it the sensor’s default, choose it in Settings Menu → Sensor and apply.`; }
  catch (e) { wiz.message = `Not sent: ${e.message}`; }
  wizRender();
}
function wizCanSend() { return deviceReachable && numericSensorId(wiz.sensorId) != null; }
function wizPaneReview() {
  const b = wizBuild(), u = wiz.profile.unit;
  const anchors = b.fit.ok ? b.fit.anchors.slice(0, 40).map(a => `<tr><td>${wizMassText(a.massMg, u)}</td><td>${fmtNumber(a.raw, 3)}</td></tr>`).join('') + (b.fit.anchors.length > 40 ? `<tr><td colspan="2" class="small">… ${b.fit.anchors.length - 40} more</td></tr>` : '') : '';
  const block = wiz.sensorId !== activeSensor.id ? 'The wizard belongs to another sensor than the one shown.' : '';
  const over = wiz.observations.filter(o => o.include && o.override).map(o => o.observationId);
  return `<div class="readout"><strong>${esc(wiz.profile.profileName)}</strong> · ${esc(FIT_MODELS[b.model].label)} · ${esc(WEIGHTINGS[b.fit.weighting.scheme] || '')} · unit ${esc(unitById(u).symbol)} · ${b.fit.anchors.length} anchors for sensor <strong>${esc(wiz.sensorId)}</strong></div>
  ${b.errors.map(e => `<div class="warning small">✖ ${esc(e)}</div>`).join('')}${b.warnings.map(e => `<div class="small">⚠ ${esc(e.text)}</div>`).join('')}
  ${uncSummaryHTML(b.unc, u)}
  <div class="readout" style="margin:6px 0">Characterization: <strong>${esc(charSummaryText(b.char))}</strong> <span class="small">(tab 5)</span></div>
  ${over.length ? `<div class="small warning">Overridden observations (included although the validity check failed): ${over.map(esc).join(', ')}</div>` : ''}
  <div class="small" style="margin:6px 0">Activating starts a new calibration epoch on the shown sensor: the tare is reset, a running measurement is aborted, and earlier samples keep the calibration they were recorded with. The file claims no uncertainty (validation status “not-characterized”); only its structure and monotonicity are checked.</div>
  ${wizSizeLine(b.cfg)}<div class="button-row"><button class="primary" data-wa="activate" ${b.errors.length || block ? 'disabled' : ''}>Activate on the shown sensor</button><button data-wa="exportCal" ${b.cfg ? '' : 'disabled'}>Export calibration JSON</button><button data-wa="sendCal" ${b.errors.length || !wizCanSend() ? 'disabled' : ''} title="Compress and upload to the device">Send to device</button></div>
  ${block ? `<div class="warning small">${esc(block)}</div>` : ''}
  ${anchors ? `<h3 style="margin:12px 0 4px">Anchors that will be written</h3><div class="tablewrap"><table class="wiz-table"><thead><tr><th>Mass</th><th>Counts</th></tr></thead><tbody>${anchors}</tbody></table></div>` : ''}`;
}
// ---- Simple mode panes -----------------------------------------------------------------------------------------------------
// Plain-language hint: more placements -> more degrees of freedom -> smaller t factor
function wizPlacementsHint() {
  const levels = Math.max(2, new Set(wizPlan().map(r => fitKey(r.mass))).size), k = P => tFactor(Math.max(1, levels * P - 2)).toFixed(2), P = wizPlacements();
  return `With ${levels} masses and ${P} placements each the 95 % factor is about k = ${k(P)} (2 placements: ${k(2)}, 5 placements: ${k(5)}, 10 placements: ${k(10)}). More placements narrow the estimated uncertainty, but each takes ${SIMPLE_CAPTURE_SECONDS} s plus the time to put the weight back.`;
}
function wizSimpleWeights() {
  const spec = wiz.simpleSpec != null ? wiz.simpleSpec : '3 x 100 g, 1 x 200 g';
  const list = wiz.weights.filter(w => w.weightId !== 'ref-empty').map(w => `<li>${esc(w.name)}${w.groupId ? ' <span class="small">(pooled with the others of its group)</span>' : ''}</li>`).join('');
  return `<div class="small">Step 1 of 3 · Which reference weights do you have? Write them as “number x mass”, separated by commas, for example <strong>3 x 100 g, 1 x 200 g</strong>. Use the printed (nominal) masses. Weights without a certificate are fine; the result will say that the scale then rests on their nominal values.</div>
  <div class="field" style="margin-top:8px"><label>Your weights</label><input type="text" id="wizSimpleSpec" data-w="simpleSpec" value="${esc(spec)}" placeholder="3 x 100 g, 1 x 200 g"></div>
  <div class="button-row"><button class="primary" data-wa="simpleSet" ${wiz.observations.length ? 'disabled' : ''}>Use these weights</button><button data-wa="restart">Start over</button></div>
  ${wiz.observations.length ? '<div class="small">Measurements exist already; use “Start over” to change the weights.</div>' : ''}
  ${list ? `<div class="small" style="margin-top:8px">Current weights (the empty platform is always included):</div><ul class="small">${list}</ul>` : ''}
  <div class="control-grid" style="margin-top:8px"><div class="field"><label>Placements per mass (2 to 10)</label><input type="number" min="2" max="10" step="1" data-w="placements" value="${wizPlacements()}"></div>
  <div class="field"><label class="check" style="margin-top:18px"><input type="checkbox" data-w="returnRun" ${wiz.returnRun ? 'checked' : ''}> also measure on the way down (shows hysteresis)</label></div></div>
  <div class="small">${wizPlacementsHint()}</div>
  <div class="small">Tolerance: add it after the mass to include it in the uncertainty, e.g. <strong>3 x 100 g ±0.5 mg</strong> (a limit, counted as ÷√3). Without it the estimated uncertainty covers repeatability only.</div>`;
}
function wizSimpleMeasure() {
  const plan = wizFullPlan(), total = plan.reduce((s, r) => s + r.req, 0), done = plan.reduce((s, r) => s + Math.min(r.done, r.req), 0), next = plan.find(r => r.done < r.req), why = wizBlock(), busy = !!wiz.capture;
  if (!total) return '<div class="small">Step 2 of 3 · Enter your weights in step 1 first.</div>';
  if (next && !busy) wiz.selLoad = next.load.loadId;
  const isEmpty = next && next.load.weightRef === 'ref-empty';
  const instr = next ? `<div class="status-note"><strong>Next${next.direction === 'down' ? ' (way down)' : ''}:</strong> ${isEmpty ? 'clear the platform completely (nothing on it)' : `put <strong>${esc(next.load.name)}</strong> on the platform`}. Take it off and put it back before each recording, and wait a few seconds until the reading has settled. Each recording takes ${SIMPLE_CAPTURE_SECONDS} s; do not touch the platform.</div>`
    : '<div class="status-note">All placements are recorded. Continue with step 3 (Finish) or record more.</div>';
  const rows = wiz.observations.map((o, i) => { if (!isCalObs(o)) return ''; const l = wiz.loads.find(x => x.loadId === o.loadId);
    const use = o.include ? (o.override ? '<span class="warning">used anyway</span>' : 'used') : (o.validity && o.validity.status === 'invalid' ? `<button data-wa="inclAnyway" data-i="${i}" title="Use it although the check failed. This is recorded in the file.">include anyway</button>` : 'not used');
    return `<tr class="${o.include ? '' : 'excl'}"><td>${esc(l ? l.name : '?')}</td><td>${esc(wizPlainVerdict(o.validity))}${o.validity && o.validity.analysis ? wizValidityCell(o) : ''}</td><td>${use}</td><td><button data-wa="delObs" data-i="${i}" aria-label="Delete this measurement">✕</button></td></tr>`; }).join('');
  return `<div class="small">Step 2 of 3 · ${done} of ${total} placements recorded</div><progress max="${total}" value="${done}"></progress>${instr}
  <div class="button-row"><button class="primary" data-wa="record" ${why || busy || !next && !total ? 'disabled' : ''}>● Record ${isEmpty ? 'the empty platform' : 'now'}</button>${busy ? '<button data-wa="cancelRec">Cancel recording</button>' : ''}</div>
  <progress id="wizRecBar" max="1" value="0" ${busy ? '' : 'hidden'}></progress><div class="small" id="wizRecProgress">${why ? esc(why) : ''}</div>
  <div class="tablewrap"><table class="wiz-table"><thead><tr><th>Load</th><th>Result</th><th>Use</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="small">Nothing recorded yet.</td></tr>'}</tbody></table></div>
  <div class="small">“Settled” means the checks found no drift, step, vibration or gap. A measurement that is not usable is left out; you can still use it with “include anyway”, and the file will say so.</div>`;
}
function wizSimpleFinish() {
  const plan = wizFullPlan(), total = plan.reduce((s, r) => s + r.req, 0), done = plan.reduce((s, r) => s + Math.min(r.done, r.req), 0), u = wiz.profile.unit;
  const b = wizBuild(), block = wiz.sensorId !== activeSensor.id ? 'The wizard belongs to another sensor than the one shown.' : '';
  const modelText = !b.fit.ok ? '' : b.model === 'linear' ? 'The scale responds like a straight line, so one straight line is fitted.' : 'Lines are drawn from one average to the next (the response is not clearly a straight line, or there are too few masses).';
  const scatter = b.fit.ok && Number.isFinite(b.fit.rmsMassMg) && b.fit.dof > 0 ? `Typical deviation of the measurements from the result: <strong>${wizMassText(b.fit.rmsMassMg, u)}</strong>. This is observed scatter, not an uncertainty.` : '';
  return `<div class="small">Step 3 of 3 · ${done} of ${total} placements recorded${done < total ? ' (more repeats make the result more trustworthy)' : ''}.</div>
  ${modelText ? `<div class="readout" style="margin:6px 0">${esc(modelText)}<br>${scatter}</div>` : ''}
  ${b.unc && b.unc.status === 'estimated' ? `<div class="status-note" style="margin:6px 0">Typical uncertainty of a weighing in the middle of the range: <strong>± ${esc(formatMassSig(wizUncAt(b.unc, (b.unc.combined.table[0].massMg + b.unc.combined.table[b.unc.combined.table.length - 1].massMg) / 2), u))}</strong> (${esc(uncProfileLabel(b.unc))}; 95 %). Each measurement adds its own reading noise. “Repeatability” is how well the scale repeats when you put the same weight back; it is not the same as being accurate.</div>` : (b.unc ? `<div class="status-note" style="margin:6px 0">${esc(b.unc.reason || '')}</div>` : '')}
  ${b.errors.map(e => `<div class="warning small">✖ ${esc(e)}</div>`).join('')}${b.warnings.map(e => `<div class="small">⚠ ${esc(e.plain)}</div>`).join('')}
  <div class="small" style="margin:6px 0">Characterization (optional, tab 4 Extra checks): <strong>${esc(charSummaryText(b.char))}</strong>.</div>
  <div class="small" style="margin:6px 0">After activating, put a weight you know on the scale and check that it reads right. Activating starts a new calibration period: the tare is reset and earlier readings keep the calibration they were recorded with.</div>
  ${wizSizeLine(b.cfg)}<div class="button-row"><button class="primary" data-wa="activate" ${b.errors.length || block ? 'disabled' : ''}>Activate on the shown sensor</button><button data-wa="exportCal" ${b.cfg ? '' : 'disabled'}>Export calibration file</button><button data-wa="sendCal" ${b.errors.length || !wizCanSend() ? 'disabled' : ''} title="Compress and upload to the device">Send to device</button></div>
  ${block ? `<div class="warning small">${esc(block)}</div>` : ''}`;
}
function wizRender() {
  const body = wq('wizBody'); if (!body || !wiz.profile) return;
  const keep = body.scrollTop, simple = wizMode === 'simple', tabsDef = simple ? WIZ_TABS_SIMPLE : WIZ_TABS, tab = simple ? (wiz.tab === 'fit' ? 'review' : wiz.tab === 'char' ? 'extra' : wiz.tab) : (wiz.tab === 'extra' ? 'char' : wiz.tab);
  const mode = wq('wizMode'); if (mode) mode.value = wizMode;
  const tabs = `<div class="tabs" role="tablist">${tabsDef.map(([id, t]) => `<button role="tab" data-wa="tab" data-id="${id}" aria-selected="${tab === id}">${t}</button>`).join('')}</div>`;
  const banner = (wiz.sensorId !== activeSensor.id ? `<div class="warning small">This wizard was started for sensor “${esc(wiz.sensorId)}”, but “${esc(activeSensor.id)}” is shown. <button data-wa="useShown">Use the shown sensor</button></div>` : '') + (wiz.message ? `<div class="status-note" style="margin:6px 0">${esc(wiz.message)}</div>` : '');
  const pane = tab === 'weights' ? (simple ? wizSimpleWeights() : wizPaneWeights()) : tab === 'observations' ? (simple ? wizSimpleMeasure() : wizPaneObs()) : tab === 'fit' ? wizPaneFit() : (tab === 'char' || tab === 'extra') ? wizPaneChar(simple) : (simple ? wizSimpleFinish() : wizPaneReview());
  body.innerHTML = tabs + banner + `<div class="wiz-pane">${pane}</div>`; body.scrollTop = keep;
}
function wizTick() {   // called every rendered frame while the wizard is open: only the progress readouts change
  const m = state.measurement, cr = state.charRec, on = !!(wiz.capture && ((m && m.tag === 'calibration wizard') || (cr && cr.tag === 'calibration wizard')));
  const bar = wq('wizRecBar'), txt = wq('wizRecProgress'), badge = wq('wizRecBadge');
  const done = cr && !m ? cr.count : (m ? m.collected : 0), tot = cr && !m ? Math.round(cr.durationS * RATE_HZ) : (m ? m.target : 1);
  if (bar && on) { bar.hidden = false; bar.value = Math.min(1, done / tot); }
  if (txt && on) txt.textContent = `Recording ${done.toLocaleString()} / ${tot.toLocaleString()} samples`;
  if (badge) badge.textContent = on ? `● ${Math.round(100 * Math.min(1, done / tot))} %` : '';
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
    else if (f === 'groupId') { w.groupId = v || null; wizSyncLoads(); render = true; }
    else if (f === 'uncValue') { const val = v === '' ? null : Number(v); if (val == null || !Number.isFinite(val)) w.massUncertainty = null; else w.massUncertainty = { ...(w.massUncertainty || {}), value: val, basis: (w.massUncertainty && w.massUncertainty.basis) || 'class-tolerance' }; render = true; }
    else if (f === 'uncBasis') { if (v === 'none') w.massUncertainty = null; else w.massUncertainty = { ...(w.massUncertainty || { value: null }), basis: v }; render = true; }
    else { w[f] = v === '' ? (f === 'assignedMass' ? null : 0) : Number(v); render = true; }
  }
  else if (a === 'group') {
    const g = wiz.groups[i]; if (!g) return;
    if (f === 'nominalMass') g.nominalMass = Number(v) || 0; else g[f] = v;
    wizSyncLoads(); render = f !== 'name';
  }
  else if (a === 'comboPick') { const w = wiz.weights[i]; if (w) wiz.comboPick[w.weightId] = v; }
  else if (a === 'capSeconds') { wiz.captureSeconds = clamp(Number(v) || 10, 0.1, 1200); const n = wq('wizSamplesNote'); if (n) n.textContent = `${Math.round(wiz.captureSeconds * RATE_HZ).toLocaleString()} samples at ${RATE_HZ} Hz`; }
  else if (a === 'simpleSpec') wiz.simpleSpec = v;
  else if (a === 'placements') { wiz.placements = clamp(Math.round(Number(v) || SIMPLE_PLACEMENTS), SIMPLE_PLACEMENTS_MIN, SIMPLE_PLACEMENTS_MAX); render = true; }
  else if (a === 'returnRun') { wiz.returnRun = !!v; render = true; }
  else if (a === 'direction') wiz.direction = v || null;
  else if (a === 'obsDir') { const o = wiz.observations[i]; if (o) o.loadingDirection = v || null; render = true; }
  else if (a === 'hystUse') { wiz.hysteresisUse = v; render = true; }
  else if (a === 'char') { const C = wizChar(); C[f] = v; if (wizMode === 'simple' && (f === 'tempZero10K' || f === 'tempSpanPpm')) C.tempMode = (C.tempZero10K !== '' || C.tempSpanPpm !== '') ? 'typed' : 'auto'; render = t.tagName === 'SELECT' || t.type === 'select-one' || f.startsWith('temp'); }
  else if (a === 'selLoad') wiz.selLoad = v;
  else if (a === 'replaced') wiz.replaced = v;
  else if (a === 'obsInclude') { const o = wiz.observations[i]; if (o) wizSetInclude(o, v); render = true; }
  else if (a === 'fitModel') { wiz.fitModel = v; render = true; }
  else if (a === 'weighting') { wiz.weighting = v; render = true; }
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
    case 'addWeight': { const id = wizId('ref-', wiz.weights, 'weightId'); wiz.weights.push({ weightId: id, name: `Weight ${wiz.weights.length}`, nominalMass: 100, assignedMass: null, unit: wiz.profile.unit, referenceUncertainty: null, groupId: null }); wizSyncLoads(); break; }
    case 'delWeight': { const w = wiz.weights[i]; if (!w) return; const n = wizWeightUse(w.weightId); if (n) { wiz.message = `“${w.name}” is used by ${n} observation(s); delete those first.`; break; } wiz.weights.splice(i, 1); wizSyncLoads(); break; }
    case 'addGroup': { const id = wizId('grp-', wiz.groups, 'groupId'); wiz.groups.push({ groupId: id, name: `Group ${wiz.groups.length + 1}`, nominalMass: 100, unit: wiz.profile.unit, massBasis: 'nominal', aggregation: 'mean-of-placements' }); wizSyncLoads(); break; }
    case 'delGroup': { const g = wiz.groups[i]; if (!g) return; for (const w of wiz.weights) if (w.groupId === g.groupId) w.groupId = null; wiz.groups.splice(i, 1); wizSyncLoads(); break; }
    case 'comboOpen': wiz.comboOpen = true; wiz.comboPick = {}; break;
    case 'comboCancel': wiz.comboOpen = false; wiz.comboPick = {}; break;
    case 'comboCreate': {
      const comps = wiz.weights.filter(w => wiz.comboPick[w.weightId]).map(w => ({ weightId: w.weightId, quantity: 1 }));
      if (comps.length < 2) { wiz.message = 'Tick at least two weights to describe a combination.'; break; }
      wiz.loads.push({ loadId: wizId('load-combo-', wiz.loads, 'loadId'), name: comps.map(c => (wiz.weights.find(w => w.weightId === c.weightId) || {}).name).join(' + '), components: comps, auto: false, weightRef: null });
      wiz.comboOpen = false; wiz.comboPick = {}; break; }
    case 'delLoad': { const id = b.dataset.id; if (wiz.observations.some(o => o.loadId === id)) { wiz.message = 'This load is used by observations; delete those first.'; break; } wiz.loads = wiz.loads.filter(l => l.loadId !== id); wizSyncLoads(); break; }
    case 'loadPrev': case 'loadNext': { const k = wiz.loads.findIndex(l => l.loadId === wiz.selLoad), n = k + (a === 'loadNext' ? 1 : -1); if (n >= 0 && n < wiz.loads.length) wiz.selLoad = wiz.loads[n].loadId; break; }
    case 'simpleSet': {
      const spec = wq('wizSimpleSpec') ? wq('wizSimpleSpec').value : wiz.simpleSpec; wiz.simpleSpec = spec;
      if (wiz.observations.length) { wiz.message = 'Measurements exist already; use “Start over” to change the weights.'; break; }
      const r = parseWeightSpec(spec); if (r.errors.length) { wiz.message = r.errors.join(' '); break; }
      wizSimpleSetWeights(r.items); wiz.message = `${r.items.reduce((s, x) => s + x.qty, 0)} weight(s) set. Continue with step 2.`; wiz.tab = 'observations'; break; }
    case 'inclAnyway': { const o = wiz.observations[i]; if (o) { wizSetInclude(o, true); wiz.message = 'Included anyway. This choice is recorded in the calibration file.'; } break; }
    case 'record': return wizRecord();
    case 'cancelRec': cancelCharRec('cancelled by user'); cancelMeasurement('cancelled by user'); return;
    case 'recordChar': return wizRecord({ purpose: b.dataset.purpose, position: b.dataset.pos, loadId: wizChar().eccLoadId });
    case 'recordLong': return wizRecordLong(b.dataset.purpose);
    case 'useSel': return wizUseSelection();
    case 'addManual': return wizAddManual();
    case 'delObs': wiz.observations.splice(i, 1); break;
    case 'exportCal': { const r = wizBuild(); if (r.cfg) downloadBlob(new Blob([JSON.stringify(r.cfg, null, 2)], { type: 'application/json' }), calFileName(r.cfg, wiz.sensorId)); return; }
    case 'exportReport': { const rep = wizFitReport(); downloadBlob(new Blob([JSON.stringify(rep, null, 2)], { type: 'application/json' }), `fit-report-${String(wiz.profile.profileId).replace(/[^\w.-]+/g, '_')}.json`); return; }
    case 'exportReportText': { const rep = wizFitReport(); downloadBlob(new Blob([wizFitReportText(rep)], { type: 'text/markdown' }), `fit-report-${String(wiz.profile.profileId).replace(/[^\w.-]+/g, '_')}.md`); return; }
    case 'activate': return wizActivate();
    case 'sendCal': return wizSend();
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
  // the collapsible "enter by hand" box keeps its state across re-renders
  $('wizModal').addEventListener('toggle', e => { if (e.target && e.target.id === 'wizManualBox') wiz.manualOpen = e.target.open; }, true);
  $('wizMode').addEventListener('change', e => { wizMode = e.target.value === 'advanced' ? 'advanced' : 'simple'; wizRender(); });   // no data is lost: one data model
}

// ===== v14: UNCERTAINTY, BAND MODES, HYSTERESIS, AUTH + HISTORY HELPERS (pure functions: no DOM, no state) =============
// ---- Student t factor ----------------------------------------------------------------------------------------------
// Two-sided 95 % factor for `dof` degrees of freedom (table up to 30, then interpolated in 1/dof between 30, 40, 60, 120, infinity).
// dof < 1 is treated as 1 (t = 12.7): with no information about the scatter the interval is simply very wide.
const UNC_COVERAGE = 0.95;                    // the only coverage level offered
const UNC_INCLUDE_OBJECT_PLACEMENT = true;    // see computeUncertainty: one weighing of an unknown object is one more placement
const UNC_DITHER_SIGMA_COUNTS = 1;            // reading noise (counts) from which quantisation is averaged out
const UNC_TABLE_POINTS = 21;                  // masses at which the calibration-side uncertainty tables are sampled
const T975 = [NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
const T975_TAIL = [[30, 2.042], [40, 2.021], [60, 2.000], [120, 1.980], [Infinity, 1.960]];
function tFactor(dof) {
  if (!(dof >= 1)) dof = 1;
  if (!Number.isFinite(dof)) return 1.96;
  if (dof <= 30) {
    const lo = Math.floor(dof), hi = Math.ceil(dof); if (lo === hi) return T975[lo];
    const a = 1 / lo, b = 1 / hi, x = 1 / dof; return T975[lo] + (T975[hi] - T975[lo]) * (a - x) / (a - b);
  }
  for (let k = 0; k + 1 < T975_TAIL.length; k++) {
    const [d0, t0] = T975_TAIL[k], [d1, t1] = T975_TAIL[k + 1];
    if (dof <= d1) { const a = 1 / d0, b = d1 === Infinity ? 0 : 1 / d1, x = 1 / dof; return t0 + (t1 - t0) * (a - x) / (a - b); }
  }
  return 1.96;
}
// ---- typed weight uncertainty (stage 1) ------------------------------------------------------------------------------
// weight.massUncertainty = {value, unit, basis: 'certificate' | 'class-tolerance' | 'user-estimate' | 'none', coverageFactor?, distribution?}
// certificate: expanded uncertainty U with coverage factor k (default 2): u = U / k.   limits only (class tolerance, "± x mg", own estimate):
// rectangular, u = limit / sqrt 3 (triangular: limit / sqrt 6 if asked for). Returns the STANDARD uncertainty in mg, or null if none was typed.
const WEIGHT_UNC_BASES = { none: 'none typed', certificate: 'certificate (± U, coverage factor k)', 'class-tolerance': 'class tolerance (limit ±)', 'user-estimate': 'my own estimate (limit ±)' };
function weightStdUncertaintyMg(w) {
  const mu = w && w.massUncertainty; if (!mu || !mu.basis || mu.basis === 'none') return null;
  const v = Number(mu.value); if (mu.value == null || mu.value === '' || !Number.isFinite(v) || v < 0) return null;
  let mg; try { mg = massToMg(v, mu.unit || w.unit); } catch (_) { return null; }
  const dist = mu.distribution || (mu.basis === 'certificate' ? 'normal' : 'rectangular'), k = Number(mu.coverageFactor) > 0 ? Number(mu.coverageFactor) : 2;
  return dist === 'normal' ? mg / k : dist === 'triangular' ? mg / Math.sqrt(6) : mg / Math.sqrt(3);
}
function interpTable(table, m) {   // linear interpolation in [{massMg, uMg}], clamped to the ends
  if (!table || !table.length) return NaN; if (m <= table[0].massMg) return table[0].uMg; const L = table.length - 1; if (m >= table[L].massMg) return table[L].uMg;
  let lo = 0, hi = L; while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (table[mid].massMg <= m) lo = mid; else hi = mid; }
  const a = table[lo], b = table[hi], t = (m - a.massMg) / (b.massMg - a.massMg); return a.uMg + t * (b.uMg - a.uMg);
}
function uncertaintyGrid(fit, n = UNC_TABLE_POINTS) {   // uniform grid over the reference range, plus the anchor masses of the piecewise model
  const [lo, hi] = fit.mRange, set = new Set(); for (let k = 0; k < n; k++) set.add(lo + (hi - lo) * k / (n - 1));
  if (fit.model === 'anchors') for (const g of fit.groups) set.add(g.massMg);
  return [...set].sort((a, b) => a - b);
}
// Weight tolerance per mass level. A level is a distinct load mass among the INCLUDED observations. Independent weights: a load of several
// different weights adds in quadrature; the several different loads at one level are averaged, so n independent weights give u / sqrt n
// (placements of the SAME weight do not reduce it). A bias shared by all weights (e.g. all too heavy by the class tolerance) is NOT reduced
// by averaging, and nothing here can estimate it: the result says so. If any weight used has no typed value the whole component is left out
// (a half-included weight uncertainty would look more complete than it is).
function weightToleranceTable(W) {
  const levels = new Map(), missing = new Set();
  for (const o of W.observations) {
    if (!o.include || !isCalObs(o)) continue;
    const load = W.loads.find(l => l.loadId === o.loadId); if (!load) continue;
    let m; try { m = wizLoadMassMg(W, load); } catch (_) { continue; }
    const key = fitKey(m); let lv = levels.get(key); if (!lv) { lv = { massMg: m, loads: new Map() }; levels.set(key, lv); }
    if (lv.loads.has(load.loadId)) continue;
    let s2 = 0, ok = true;
    for (const c of load.components) {
      const w = W.weights.find(x => x.weightId === c.weightId), u = w ? weightStdUncertaintyMg(w) : null;
      if (u == null) { ok = false; missing.add(c.weightId); continue; }
      s2 += (Number(c.quantity) * u) ** 2;
    }
    lv.loads.set(load.loadId, ok ? s2 : null);
  }
  const table = []; let anyTyped = false;
  for (const lv of [...levels.values()].sort((a, b) => a.massMg - b.massMg)) {
    const vals = [...lv.loads.values()]; if (vals.some(v => v == null)) continue;
    const u = Math.sqrt(vals.reduce((s, v) => s + v, 0)) / vals.length; if (u > 0) anyTyped = true;
    table.push({ massMg: lv.massMg, uMg: u, loads: vals.length });
  }
  return { table, complete: missing.size === 0 && table.length > 0 && anyTyped, missingWeightIds: [...missing] };
}
// ---- hysteresis (loading direction) ---------------------------------------------------------------------------------
// points: [{massMg, raw, direction}] of INCLUDED observations; direction 'up' | 'down' (anything else is ignored here). Per mass level that has
// both directions: diff = mean(down) - mean(up) in counts and, with the local slope, in mg.
function hysteresisAnalysis(points, slopeAt) {
  const by = new Map();
  for (const p of points) { if (p.direction !== 'up' && p.direction !== 'down') continue; const k = fitKey(p.massMg); let l = by.get(k); if (!l) { l = { massMg: p.massMg, up: [], down: [] }; by.set(k, l); } l[p.direction].push(p.raw); }
  const levels = [], mean = a => a.reduce((s, v) => s + v, 0) / a.length, sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
  for (const l of [...by.values()].sort((a, b) => a.massMg - b.massMg)) {
    if (!l.up.length || !l.down.length) continue;
    const diff = mean(l.down) - mean(l.up), slope = slopeAt ? slopeAt(l.massMg) : NaN, dMg = Number.isFinite(slope) && slope !== 0 ? diff / slope : NaN;
    const seC = l.up.length > 1 && l.down.length > 1 ? Math.sqrt(sd(l.up) ** 2 / l.up.length + sd(l.down) ** 2 / l.down.length) : null;
    levels.push({ massMg: l.massMg, nUp: l.up.length, nDown: l.down.length, meanUp: mean(l.up), meanDown: mean(l.down), diffCounts: diff, diffMg: dMg, seMg: seC != null && Number.isFinite(slope) && slope ? seC / Math.abs(slope) : null });
  }
  if (!levels.length) return null;
  const fin = levels.map(l => l.diffMg).filter(Number.isFinite);
  return { levels, maxAbsDiffMg: fin.length ? Math.max(...fin.map(Math.abs)) : NaN, meanDiffMg: fin.length ? fin.reduce((s, v) => s + v, 0) / fin.length : NaN };
}
// ---- calibration-side uncertainty block (written to the file) ----------------------------------------------------------
const UNC_NOT_INCLUDED = ['temperature', 'creep', 'off-centre loading', 'drift between calibration and use'];
function buildUncertaintyProfile(W, fit, hyst, hUse = 'both') {
  const base = { status: 'not-estimable', traceable: false, basis: 'none', coverageProbability: UNC_COVERAGE, components: [], notIncluded: UNC_NOT_INCLUDED.slice(), k: null, combined: null };
  if (!fit || !fit.ok || !fit.seRawAt || !(fit.dof > 0) || !Number.isFinite(fit.seRawAt(fit.mRange[0]))) {
    return { ...base, reason: 'The repeatability of the placements cannot be estimated: no reference mass was placed more than once (no degrees of freedom). Record replicates.' };
  }
  const grid = uncertaintyGrid(fit), slope = m => Math.abs(fit.slopeAt(m));
  const rep = grid.map(m => ({ massMg: m, uMg: fit.seRawAt(m) / slope(m) })), obj = grid.map(m => ({ massMg: m, uMg: fit.sdRawAt(m) / slope(m) }));
  const wtol = weightToleranceTable(W), wIncluded = wtol.complete;
  const hIncluded = !!(hyst && hyst.levels.length && Number.isFinite(hyst.maxAbsDiffMg) && hUse === 'both');
  const hTable = hIncluded ? hyst.levels.filter(l => Number.isFinite(l.diffMg)).map(l => ({ massMg: l.massMg, uMg: Math.abs(l.diffMg) / (2 * Math.sqrt(3)) })) : null;
  const comps = [
    { id: 'placement-repeatability', label: 'placement repeatability, propagated through the fit', included: true, dof: fit.dof, table: rep, note: fit.model === 'anchors' ? 'scatter of the replicate means (shrunk towards the pooled scatter)' : 'standard error of the fitted curve from the residual scatter and the leverage of the observations' },
    { id: 'object-placement', label: 'placement of the weighed object (one placement)', included: UNC_INCLUDE_OBJECT_PLACEMENT, dof: fit.dof, table: obj, note: 'a single weighing puts the object down once; this is the scatter between placements, not only the error of the curve' },
    { id: 'weight-tolerance', label: 'typed weight tolerance / certificate', included: wIncluded, dof: null, table: wIncluded ? wtol.table : null, note: wIncluded ? 'independent weights: n weights give u / sqrt n. A bias shared by ALL the weights (all too heavy by the class tolerance) is not reduced and cannot be seen by this tool' : (wtol.table.length ? `left out: no tolerance typed for ${wtol.missingWeightIds.length} weight(s)` : 'left out: no tolerance typed for the weights') },
    { id: 'hysteresis', label: 'hysteresis (up / down difference)', included: hIncluded, dof: null, table: hTable, note: hIncluded ? 'half-width |down - up| / 2, rectangular' : (hyst ? 'left out: the fit uses one loading direction only' : 'left out: no run in both directions') }
  ];
  const notIncluded = UNC_NOT_INCLUDED.slice();
  if (!hIncluded) notIncluded.unshift('hysteresis');
  if (!wIncluded) notIncluded.unshift('weight tolerance');
  const table = grid.map(m => {
    const parts = [{ u: interpTable(rep, m), dof: fit.dof }];
    if (UNC_INCLUDE_OBJECT_PLACEMENT) parts.push({ u: interpTable(obj, m), dof: fit.dof });
    if (wIncluded) parts.push({ u: interpTable(wtol.table, m), dof: Infinity });
    if (hIncluded && hTable.length) parts.push({ u: interpTable(hTable, m), dof: Infinity });
    const c = combineUncertainties(parts); return { massMg: m, uMg: c.u, dof: c.dof, k: c.k, UMg: c.U };
  });
  return { status: 'estimated', traceable: false, basis: wIncluded ? 'repeatability+weight-tolerances' + (hIncluded ? '+hysteresis' : '') : (hIncluded ? 'repeatability+hysteresis' : 'repeatability'), coverageProbability: UNC_COVERAGE, dof: fit.dof, k: { dof: fit.dof, value: tFactor(fit.dof) },
    components: comps, notIncluded, combined: { note: 'calibration-side components only (placement repeatability, object placement, weight tolerance, hysteresis); the reading noise and resolution of a measurement are added when it is made', table } };
}
// Root-sum-of-squares with the Welch-Satterthwaite effective degrees of freedom. parts: [{u, dof}] (dof Infinity = fully known, e.g. a typed limit).
function combineUncertainties(parts) {
  let s2 = 0; for (const p of parts) if (Number.isFinite(p.u)) s2 += p.u * p.u;
  const u = Math.sqrt(s2); let den = 0; for (const p of parts) if (Number.isFinite(p.u) && Number.isFinite(p.dof) && p.dof > 0) den += Math.pow(p.u, 4) / p.dof;
  const dof = den > 0 ? Math.pow(u, 4) / den : Infinity, k = tFactor(dof);
  return { u, dof, k, U: k * u };
}
function uncertaintyLabel(u) {
  if (!u || u.status !== 'ok') return '';
  const cp = u.charParts || {}, keys = ['offCentre', 'creep', 'zeroDrift', 'temperature'].filter(k => cp[k]);
  if (!keys.length) { if (u.includesWeights) return 'estimated, not traceable'; return `estimated, ${u.includesHysteresis ? 'repeatability and hysteresis' : 'repeatability'} only, not traceable`; }
  const names = { offCentre: 'off-centre loading', creep: 'creep', zeroDrift: 'zero drift', temperature: 'temperature' }, measured = ['repeatability'], est = [];
  if (u.includesHysteresis) measured.push('hysteresis');
  for (const k of keys) (cp[k] === 'measured' ? measured : est).push(names[k]);
  return `estimated, ${joinAnd(measured)} measured${u.includesWeights ? '; weight tolerance typed' : ''}${est.map(x => `; ${x} your estimate`).join('')}; not traceable`;
}
// ---- the uncertainty of ONE measurement result (stage 2 + 3) ------------------------------------------------------------
// profile: the calibration's `uncertainty` block. inp: {massMg: absolute mass of the result, sigmaMg: spread of the measured samples (mg),
// neff: effective number of independent samples (null if unknown), sigmaCounts: spread in counts, slopeMgPerCount: |d mass / d counts| at the result}.
function computeUncertainty(profile, inp) {
  if (!profile || typeof profile !== 'object') return { status: 'unavailable', reason: 'This calibration holds no repeatability data (it was made before v14, or without replicates).' };
  if (profile.status !== 'estimated') return { status: 'unavailable', reason: profile.reason || 'The calibration could not estimate the placement repeatability.' };
  const comp = id => (profile.components || []).find(c => c.id === id), m = inp.massMg, parts = [], list = [], addedNames = [];
  const add = (id, label, u, dof, note) => { list.push({ id, label, uMg: u, dof, note: note || '' }); parts.push({ u, dof }); };
  const a = comp('placement-repeatability'); add(a.id, a.label, interpTable(a.table, m), a.dof, a.note);
  const o = comp('object-placement'); if (o && o.included) add(o.id, o.label, interpTable(o.table, m), o.dof, o.note);
  const neffKnown = Number.isFinite(inp.neff) && inp.neff >= 1, neff = neffKnown ? Math.min(inp.neff, 1e12) : 1;
  add('reading-noise', 'reading noise of the measured samples (σ / √n_eff)', inp.sigmaMg / Math.sqrt(neff), Math.max(1, neff - 1), neffKnown ? `n_eff ≈ ${neff.toFixed(1)}` : 'n_eff unknown (too few samples): σ itself is used');
  const dith = Number.isFinite(inp.sigmaCounts) && inp.sigmaCounts >= UNC_DITHER_SIGMA_COUNTS;
  if (Number.isFinite(inp.slopeMgPerCount)) add('resolution', 'resolution (one count)', Math.abs(inp.slopeMgPerCount) / Math.sqrt(12) / (dith ? Math.sqrt(neff) : 1), Infinity, dith ? 'reading noise dithers the quantisation: averaged out' : 'the noise is below one count: quantisation is not averaged');
  const w = comp('weight-tolerance'); if (w && w.included) add(w.id, w.label, interpTable(w.table, m), Infinity, w.note);
  const h = comp('hysteresis'); if (h && h.included) add(h.id, h.label, interpTable(h.table, m), Infinity, h.note);
  // v16: components from the calibration's `characterization` block (measured or user estimate), the use conditions and, if there is one, the temperature channel
  const ch = inp.char, charParts = {}, uc = { ...USE_COND_DEFAULTS, ...(inp.uc || {}) }, mAbs = Math.abs(m), s3 = Math.sqrt(3);
  const src = s => (s === 'measured' ? 'measured' : 'your estimate'), kind = s => (s === 'measured' ? 'measured' : 'estimate');
  const other = t => (t && t.calibrationProfileId && inp.calibrationProfileId && t.calibrationProfileId !== inp.calibrationProfileId ? `; converted with another calibration (profile ${t.calibrationProfileId}) than the one in use` : '');
  const mg = x => `${Number(x).toPrecision(3)} mg`;
  if (ch && typeof ch === 'object' && ch.status && ch.status !== 'none') {
    const e = ch.eccentricity;
    if (e && Number.isFinite(e.fractionOfLoad)) { const hw = e.fractionOfLoad * mAbs; add('off-centre', `off-centre loading (${src(e.source)})`, hw / s3, Infinity, `half-width ${mg(hw)} = ${(e.fractionOfLoad * 100).toFixed(3)} % of the load, rectangular${other(e)}`); charParts.offCentre = kind(e.source); addedNames.push('off-centre loading'); }
    const c = ch.creep;
    if (c && Array.isArray(c.samples) && c.samples.length) { const f = creepFractionAt(c, uc.readingDelayS), hw = Math.abs(f.value) * mAbs; add('creep', `creep after ${uc.readingDelayS} s (${src(c.source)})`, hw / s3, Infinity, `half-width ${mg(hw)} (${(Math.abs(f.value) * 100).toFixed(3)} % of the load)${f.flagged ? '; the reading delay is beyond the recorded curve: its last value is used' : ''}${other(c)}`); charParts.creep = kind(c.source); addedNames.push('creep'); }
    const z = ch.zeroDrift;
    if (z && Number.isFinite(z.rateMgPerH)) { const tH = uc.sessionSinceTareS / 3600, hw = Math.hypot(Math.abs(z.rateMgPerH) * tH, (Number.isFinite(z.seMgPerH) ? z.seMgPerH : 0) * tH); add('zero-drift', `zero drift ${fmtSpan(uc.sessionSinceTareS)} after the tare (${src(z.source)})`, hw / s3, Infinity, `half-width ${mg(hw)} from ${fmtNumber(z.rateMgPerH, 3)} mg/h (standard error of the rate included)${other(z)}`); charParts.zeroDrift = kind(z.source); addedNames.push('drift between calibration and use'); }
    const T = ch.temperature;
    if (T && (Number.isFinite(T.zeroMgPerK) || Number.isFinite(T.spanPpmPerK))) {
      let dT, fromSensor = false;
      if (inp.tempStats && Number.isFinite(T.referenceC)) { dT = Math.max(Math.abs(inp.tempStats.min - T.referenceC), Math.abs(inp.tempStats.max - T.referenceC)); fromSensor = true; } else dT = uc.temperatureDeltaK;
      const hw = Math.hypot((T.zeroMgPerK || 0) * dT, (T.spanPpmPerK || 0) * 1e-6 * mAbs * dT), measuredAll = T.source === 'measured' && fromSensor;
      add('temperature', `temperature (${measuredAll ? 'measured' : 'your estimate'})`, hw / s3, Infinity, `ΔT = ${dT.toFixed(2)} K ${fromSensor ? 'from the temperature channel' : 'typed (use conditions)'}; sensitivity ${T.source === 'measured' ? 'measured' : 'your estimate'}; half-width ${mg(hw)}${other(T)}`);
      charParts.temperature = measuredAll ? 'measured' : 'estimate'; addedNames.push('temperature');
    }
  }
  const c = combineUncertainties(parts), res = { status: 'ok', components: list, combinedMg: c.u, dof: c.dof, k: c.k, expandedMg: c.U, includesWeights: !!(w && w.included), includesHysteresis: !!(h && h.included), charParts,
    notIncluded: (profile.notIncluded || UNC_NOT_INCLUDED).filter(x => !addedNames.includes(x)), traceable: false, basis: profile.basis, massMg: m, conditions: uc };
  res.label = uncertaintyLabel(res); return res;
}
// ---- spread band modes (v14, display option) ----------------------------------------------------------------------------
// A step of height H leaves a fraction f of NEW samples in the window; mean +/- SD then reaches H (1 - f + sqrt(f (1-f))) above the old level
// (at most 1.207 H, f = 0.146): not a bug, but a window that mixes two levels. Three bands: 'symmetric' (mean +/- SD, the default), 'asymmetric'
// (upper line = mean of the samples above the centre value, lower line = mean of those below; after a step it cannot cross the old level; in
// steady noise it is about 0.8 sigma), 'stepaware' (restart the window at a level step found by the CUSUM statistic of the validity checks).
const BAND_MODES = { symmetric: 'Symmetric ±σ (centre ± spread)', asymmetric: 'Asymmetric (mean of the samples above / below)', stepaware: 'Step-aware (window restarts at a detected level step)' };
function stepRestartIndex(vals) {
  const T = ANALYSIS_THRESHOLDS; if (vals.length < T.minSamples) return 0;
  const r = analysisStepCheck(vals);
  return (r.verdict === 'invalid' || r.verdict === 'suspect') && r.stepLike === true && r.sizeSigma >= T.stepMinSigma && Number.isFinite(r.changeIndex) ? r.changeIndex : 0;
}
function bandStats(vals, method, mode, options) {
  const ema = method === 'ema' || method === 'emaNorm';
  const start = mode === 'stepaware' && !ema ? stepRestartIndex(vals) : 0, v = start ? vals.slice(start) : vals, r = estimate(v, [], method, options);
  let upper = r.value + r.sigma, lower = r.value - r.sigma;
  if (mode === 'asymmetric' && !ema) {
    let su = 0, nu = 0, sl = 0, nl = 0; for (const x of v) { if (x > r.value) { su += x; nu++; } else if (x < r.value) { sl += x; nl++; } }
    upper = nu ? su / nu : r.value; lower = nl ? sl / nl : r.value;
  }
  return { value: r.value, sigma: r.sigma, upper, lower, start };
}
// ---- Authentication (HTTP Basic, writes only) -----------------------------------------------------------------------------
function b64encode(bytes) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = i + 1 < bytes.length ? bytes[i + 1] : NaN, c = i + 2 < bytes.length ? bytes[i + 2] : NaN, n = (a << 16) | ((b || 0) << 8) | (c || 0);
    s += A[(n >> 18) & 63] + A[(n >> 12) & 63] + (Number.isNaN(b) ? '=' : A[(n >> 6) & 63]) + (Number.isNaN(c) ? '=' : A[n & 63]);
  }
  return s;
}
function basicAuthHeader(user, password) { return 'Basic ' + b64encode(new TextEncoder().encode(`${user}:${password}`)); }
// ---- sample history: merge by time / id, binary layout ---------------------------------------------------------------------
// existing and incoming are {t:[], raw:[], id:[]} in ascending time; ids may be NaN (unknown). A sample of `incoming` is dropped if an existing
// sample has the same id (finite) or the same time. Returns the merged arrays (ascending time) plus counts.
function mergeSampleLists(existing, incoming) {
  const idSet = new Set(); for (const v of existing.id) if (Number.isFinite(v)) idSet.add(v);
  const tSet = new Set(existing.t), t = [], raw = [], id = []; let dup = 0, i = 0, j = 0;
  const inc = [];
  for (let k = 0; k < incoming.t.length; k++) { const iid = incoming.id[k]; if ((Number.isFinite(iid) && idSet.has(iid)) || tSet.has(incoming.t[k])) { dup++; continue; } inc.push(k); }
  inc.sort((a, b) => incoming.t[a] - incoming.t[b]);
  while (i < existing.t.length || j < inc.length) {
    const takeNew = j < inc.length && (i >= existing.t.length || incoming.t[inc[j]] < existing.t[i]);
    if (takeNew) { const k = inc[j++]; t.push(incoming.t[k]); raw.push(incoming.raw[k]); id.push(incoming.id[k]); }
    else { t.push(existing.t[i]); raw.push(existing.raw[i]); id.push(existing.id[i]); i++; }
  }
  return { t, raw, id, added: inc.length, duplicates: dup };
}
// Binary history chunk (protocol v0.5, layout version 1): little endian; 12-byte header {'HIST' magic u32, version u16 = 1, reserved u16, count u32}
// followed by count x 28 bytes {n u64, t u64 (microseconds), raw u64 (bit pattern, see rawFormat), flags u32}. Decoded here to {id, t (ms), raw (native value), flags}.
const HISTORY_MAGIC = 0x54534948, HISTORY_REC = 28;
function decodeHistoryBinary(buf, rawFormat) {
  const dv = new DataView(buf.buffer ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf);
  if (dv.byteLength < 12 || dv.getUint32(0, true) !== HISTORY_MAGIC) throw new Error('not a history chunk (bad magic)');
  if (dv.getUint16(4, true) !== 1) throw new Error('unknown history layout version');
  const n = dv.getUint32(8, true); if (dv.byteLength < 12 + HISTORY_REC * n) throw new Error('truncated history chunk');
  const id = new Array(n), t = new Array(n), raw = new Array(n), flags = new Array(n);
  for (let k = 0; k < n; k++) { const o = 12 + HISTORY_REC * k; id[k] = Number(dv.getBigUint64(o, true)); t[k] = Number(dv.getBigUint64(o + 8, true)) / 1000; raw[k] = decodeRaw(dv.getBigUint64(o + 16, true), rawFormat); flags[k] = dv.getUint32(o + 24, true); }
  return { id, t, raw, flags, meta: {} };
}
function encodeHistoryBinary(ids, ts, raws, flags) {   // ts in microseconds, raws as uint64 bit patterns (BigInt or number); used by the test harness
  const n = ids.length, buf = new ArrayBuffer(12 + HISTORY_REC * n), dv = new DataView(buf);
  dv.setUint32(0, HISTORY_MAGIC, true); dv.setUint16(4, 1, true); dv.setUint16(6, 0, true); dv.setUint32(8, n, true);
  for (let k = 0; k < n; k++) { const o = 12 + HISTORY_REC * k; dv.setBigUint64(o, BigInt(ids[k]), true); dv.setBigUint64(o + 8, BigInt(ts[k]), true); dv.setBigUint64(o + 16, BigInt(raws[k]), true); dv.setUint32(o + 24, flags ? flags[k] : 0, true); }
  return buf;
}
// JSON: {sensorId, samples:[{n, t (us), raw (uint64 bit pattern), flags}], returned, firstId, lastId, latestId, oldestId, truncated}
function decodeHistoryJson(msg, rawFormat) {
  const out = { id: [], t: [], raw: [], flags: [], meta: {} };
  const arr = Array.isArray(msg) ? msg : (msg && Array.isArray(msg.samples) ? msg.samples : []);
  for (const s of arr) { out.id.push(Number(toNum(s.n))); out.t.push(Number(toNum(s.t)) / 1000); out.raw.push(decodeRaw(s.raw, rawFormat)); out.flags.push(Number(toNum(s.flags)) || 0); }
  if (msg && !Array.isArray(msg)) for (const k of ['returned', 'firstId', 'lastId', 'latestId', 'oldestId']) if (msg[k] != null) out.meta[k] = Number(toNum(msg[k]));
  if (msg && msg.truncated != null) out.meta.truncated = !!msg.truncated;
  return out;
}
// ===== END v14 pure block ==============================================================================================

// ===== v14: SAMPLE HISTORY (range requests by the web UI) ==================================================================
// Design (handout section 7): the live stream and the history are independent. Every live sample carries a monotonic sample id `n` and a device
// timestamp. The web UI asks the history server for OLDER ids itself (GET /api/history?sensor_id=<id>&from_id=a&to_id=b&limit=n&format=bin; binary chunks preferred,
// JSON accepted) and MERGES them into the sensor's ring buffer by time, dropping duplicates by id. The server needs no notion of a "new user".
// Live samples are NOT held back: merging works while the stream continues (so the "buffer live samples, then prepend" order of the handout is
// replaced by a merge that is valid at any moment; the result is identical). The same merge fills gaps after a reconnect: a jump in the sample
// ids is requested as a range; ids the server no longer has simply stay what they are, an explicit gap in the timestamps (and in the id counter
// that the validity checks now compare against).
// ASSUMED server limits (to be confirmed with the firmware): how many samples it retains, the largest chunk, the binary layout (decodeHistoryBinary).
const HISTORY_MAX_CHUNKS = 400;
function historyUrlFor(sensor) { return deviceSeen && sensor.sseUrl ? HISTORY_URL : null; }   // v0.18: "a device was found", not "the last poll worked"
let historyMaxChunkSeen = null;   // X-History-Max-Chunk of the latest response
function historyChunkSize() { return Math.max(1, Math.min(5000, deviceInfo && deviceInfo.maxHistoryChunk > 0 ? deviceInfo.maxHistoryChunk : 5000, historyMaxChunkSeen > 0 ? historyMaxChunkSeen : 5000)); }
function historyRequestUrl(base, sensorId, fromId, toId, limit) { return `${base}${base.includes('?') ? '&' : '?'}sensor_id=${encodeURIComponent(sensorId)}&from_id=${fromId}&to_id=${toId}&limit=${limit}&format=bin`; }
function firstKnownId(st) { for (let i = 0; i < st.count; i++) { const v = st.ids[(st.head + i) % st.capacity]; if (Number.isFinite(v)) return v; } return NaN; }
// Merge a chunk {id:[], t:[] (device ms, absolute), raw:[]} into the sensor. Works on any sensor (shown or hidden). Returns counts.
function mergeHistory(sensor, chunk) {
  const st = sensor.state;
  return withState(st, () => {
    const n = chunk.t.length; if (!n) return { added: 0, duplicates: 0, dropped: 0, count: st.count };
    if (st.timeOrigin == null) { let mn = Infinity; for (const v of chunk.t) if (v < mn) mn = v; st.timeOrigin = claimDeviceOrigin(deviceIdOf(sensor), mn); }
    if (st.derivedReady && st.unprocessed > 0) {   // finish the samples that were stored while the sensor was hidden (they keep the sensor's current calibration)
      for (let i = st.count - Math.min(st.unprocessed, st.count); i < st.count; i++) st.massMg[physicalIndex(i)] = calibrateAbsolute(getRaw(i), st.calPrepared).valueMg;
      st.unprocessed = 0;
    }
    const ex = { t: new Array(st.count), raw: new Array(st.count), id: new Array(st.count) }, massOf = new Map();
    for (let i = 0; i < st.count; i++) { const p = physicalIndex(i); ex.t[i] = st.times[p]; ex.raw[i] = st.raw[p]; ex.id[i] = st.ids[p]; if (st.derivedReady) massOf.set(st.times[p], st.massMg[p]); }
    const inc = { t: chunk.t.map(v => v - st.timeOrigin), raw: chunk.raw, id: chunk.id }, m = mergeSampleLists(ex, inc);
    if (!m.added) return { added: 0, duplicates: m.duplicates, dropped: 0, count: st.count };
    if (st.measurement) { const t0 = st.measurement.t0; if (inc.t.some(v => v >= t0)) cancelMeasurement('history was inserted into the measured interval'); }
    let total = m.t.length, from = 0, dropped = 0;
    if (!st.unlimited && total > st.capacity) { dropped = total - st.capacity; from = dropped; total = st.capacity; }   // the newest `capacity` samples are kept
    const cap = st.unlimited ? Math.max(st.capacity, Math.ceil(total / 100000) * 100000) : st.capacity, D = st.derivedReady, dn = D ? cap : 0;
    const times = new Float64Array(cap), raw = new Float64Array(cap), ids = new Float64Array(cap).fill(NaN), mass = new Float64Array(dn);
    for (let i = 0; i < total; i++) {
      const k = from + i; times[i] = m.t[k]; raw[i] = m.raw[k]; ids[i] = m.id[k];
      if (D) { const known = massOf.get(m.t[k]); mass[i] = known !== undefined ? known : calibrateAbsolute(m.raw[k], (st.calibrations.length ? calibrationAt(m.t[k]).config : st.calPrepared)).valueMg; }
    }
    st.capacity = cap; st.times = times; st.raw = raw; st.ids = ids; st.massMg = mass; st.count = total; st.head = 0;
    if (D) { st.rawMA = new Float64Array(cap); st.rawSD = new Float64Array(cap); st.massMA = new Float64Array(cap); st.massSD = new Float64Array(cap); rebuildDerived(); rebuildEMA(); }
    else st.unprocessed = st.count;
    st.curveCache = { key: '', map: new Map() }; st.miniCache = { key: '', map: new Map() }; st.pmNeff = null; st.pmStab = null;
    if (st.live) fitLiveWindow(); else clampHistoricalView();
    return { added: m.added, duplicates: m.duplicates, dropped, count: st.count };
  });
}
function historyAfterMerge(sensor) {
  if (sensor !== activeSensor) return;
  if (state.selection) updateSelectionForNewContext();
  scheduleRender();
}
async function historyFetchChunk(sensor, fromId, toId) {
  const size = Math.min(toId - fromId + 1, historyChunkSize()), r = await fetch(historyRequestUrl(HISTORY_URL, sensor.id, fromId, toId, size), { cache: 'no-store' });   // a READ: no Authorization / CSRF header
  if (!r.ok) throw new Error(await httpErrorText(r));
  const type = (r.headers && r.headers.get && r.headers.get('content-type')) || '', hv = n => { const v = r.headers && r.headers.get ? r.headers.get(n) : null; return v == null || v === '' ? undefined : Number(v); };
  const chunk = /octet-stream|x-history/.test(type) ? decodeHistoryBinary(new Uint8Array(await r.arrayBuffer()), sensor.rawFormat) : decodeHistoryJson(parseWire(await r.text()), sensor.rawFormat);
  for (const [k, h] of [['returned', 'X-History-Returned'], ['firstId', 'X-History-First-Id'], ['lastId', 'X-History-Last-Id'], ['latestId', 'X-History-Latest-Id'], ['oldestId', 'X-History-Oldest-Id'], ['maxChunk', 'X-History-Max-Chunk']]) { const v = hv(h); if (v !== undefined && Number.isFinite(v)) chunk.meta[k] = v; }
  if (chunk.meta.maxChunk > 0) historyMaxChunkSeen = chunk.meta.maxChunk;
  { const tr = r.headers && r.headers.get ? r.headers.get('X-History-Truncated') : null; if (tr != null) chunk.meta.truncated = tr === 'true' || tr === '1'; }
  return chunk;
}
function historyStatusText(sensor) {
  const h = sensor.history; if (!historyUrlFor(sensor)) return 'no history server configured';
  return `history: ${h.running ? 'loading… ' : ''}${h.status}${h.loaded ? ` · ${h.loaded.toLocaleString()} older samples loaded` : ''}${h.error ? ` · ${h.error}` : ''}${sensor.gapCount ? ` · ${sensor.gapCount.toLocaleString()} missing ids noticed` : ''}`;
}
// Load OLDER history: from the oldest known id backwards, one chunk at a time, until the server has nothing older, the buffer is full or nothing new arrives.
async function historyLoadOlder(sensor) {
  const base = historyUrlFor(sensor), h = sensor.history;
  if (!base) { h.status = 'not configured'; return h; }
  if (h.running) return h;
  if (h.noOlder) { h.status = 'not loaded (a new configuration epoch started)'; return h; }
  h.running = true; h.error = null; h.status = 'loading'; updateSourceNote();
  try {
    for (let guard = 0; guard < HISTORY_MAX_CHUNKS; guard++) {
      const st = sensor.state, first = firstKnownId(st);
      if (!Number.isFinite(first)) { h.status = 'waiting for the first sample id'; break; }
      if (!st.unlimited && st.count >= st.capacity) { h.status = 'buffer full'; break; }
      const to = first - 1, floor = h.minId == null ? 0 : h.minId; if (to < floor) { h.status = 'complete (server start reached)'; break; }
      const room = st.unlimited ? Infinity : st.capacity - st.count, size = Math.min(historyChunkSize(), room), from = Math.max(floor, to - size + 1);
      const chunk = await historyFetchChunk(sensor, from, to);
      if (!chunk.id.length) { h.minId = to + 1; h.status = 'complete (server has nothing older)'; break; }
      const r = mergeHistory(sensor, chunk); h.loaded += r.added; historyAfterMerge(sensor);
      let lo = Infinity; for (const v of chunk.id) if (Number.isFinite(v) && v < lo) lo = v;
      if (lo > from) { h.minId = lo; }           // the server could not go back further
      if (chunk.meta && Number.isFinite(chunk.meta.oldestId)) h.minId = Math.max(h.minId == null ? 0 : h.minId, chunk.meta.oldestId);
      if (!r.added) { h.status = 'complete (no new samples)'; break; }
      h.status = 'loading';
    }
    if (h.status === 'loading') h.status = 'paused (chunk limit)';
  } catch (e) { h.error = e.message; h.status = 'error'; }
  h.running = false; updateSourceNote(); return h;
}
function noteGap(sensor, fromId, toId) {
  sensor.gapCount += toId - fromId + 1;
  const g = sensor.gaps[sensor.gaps.length - 1];
  if (g && g.status === 'pending' && fromId <= g.toId + 1) g.toId = Math.max(g.toId, toId); else sensor.gaps.push({ fromId, toId, status: 'pending' });
  if (historyUrlFor(sensor)) setTimeout(() => historyFillGaps(sensor), 0); else sensor.gaps[sensor.gaps.length - 1].status = 'no history server';
}
async function historyFillGaps(sensor) {
  if (sensor.history.fillingGaps || !historyUrlFor(sensor)) return;
  sensor.history.fillingGaps = true;
  try {
    for (const g of sensor.gaps) {
      if (g.status !== 'pending') continue;
      let got = 0;
      try { for (let a = g.fromId; a <= g.toId; a += historyChunkSize()) { const b = Math.min(g.toId, a + historyChunkSize() - 1), chunk = await historyFetchChunk(sensor, a, b); if (chunk.id.length) { got += mergeHistory(sensor, chunk).added; historyAfterMerge(sensor); } } g.status = got >= g.toId - g.fromId + 1 ? 'filled' : (got ? 'partly filled' : 'not available: stays a gap'); g.got = got; }
      catch (e) { g.status = 'failed: ' + e.message; }
    }
  } finally { sensor.history.fillingGaps = false; updateSourceNote(); }
}
function historyScheduleInitial(sensor) {
  const h = sensor.history; if (h.autoStarted || !historyUrlFor(sensor)) return; h.autoStarted = true;
  setTimeout(() => historyLoadOlder(sensor), 0);
}
function updateSourceNote() {
  if (!activeSensor || activeSensor.kind !== 'server') return;
  $('sourceNote').textContent = `Server sensor · ${activeSensor.sseUrl || 'no SSE URL'} · ${historyStatusText(activeSensor)}`;
}
// ===== v14: AUTHENTICATION (HTTP Basic, in our own code, WRITES ONLY) ====================================================
// The server asks for a password only when one is set, and only for writes (settings files, calibration files, other file changes).
// GET, SSE and history stay open (EventSource cannot send headers). We do not use the browser's own pop-up (it cannot be controlled or
// forgotten and behaves differently for streams): a write is sent with `Authorization: Basic base64(user:password)` when a password is
// known; on 401 our dialog asks ONCE and the write is retried once. The password lives in memory and in sessionStorage (this tab);
// "remember on this device" additionally uses localStorage (off by default). It is never logged, never put into a URL, never exported.
// CORS: if the UI is not served by the ESP32 itself, the server must answer the preflight and allow the Authorization header.
// SECURITY: Basic over plain HTTP sends the password readably. Trusted home network or HTTPS only.
const AUTH_SESSION_KEY = 'massTelemetryWorkbench.auth.session', AUTH_LOCAL_KEY = 'massTelemetryWorkbench.auth.remembered';
let authCred = null, authPending = null, authPromptImpl = null;
function authStorageGet(kind, key) { try { const s = kind === 'session' ? (typeof sessionStorage !== 'undefined' ? sessionStorage : null) : (typeof localStorage !== 'undefined' ? localStorage : null); const t = s && s.getItem(key); const o = t && JSON.parse(t); return o && typeof o.user === 'string' && typeof o.password === 'string' ? o : null; } catch (_) { return null; } }
function authStorageSet(kind, key, v) { try { const s = kind === 'session' ? sessionStorage : localStorage; if (v) s.setItem(key, JSON.stringify(v)); else s.removeItem(key); } catch (_) {} }
function authInit() { authCred = authStorageGet('session', AUTH_SESSION_KEY) || authStorageGet('local', AUTH_LOCAL_KEY); authUpdateInfo(); }
function authStore(cred, remember) { authCred = { user: cred.user, password: cred.password }; authStorageSet('session', AUTH_SESSION_KEY, authCred); authStorageSet('local', AUTH_LOCAL_KEY, remember ? authCred : null); authUpdateInfo(); }
function authForget() { authCred = null; authStorageSet('session', AUTH_SESSION_KEY, null); authStorageSet('local', AUTH_LOCAL_KEY, null); authUpdateInfo(); }
function authUpdateInfo() {
  const el = typeof document !== 'undefined' && document.getElementById('authInfo'); if (!el) return;
  el.textContent = !authCred ? 'Server password: none known in this tab.' : (authStorageGet('local', AUTH_LOCAL_KEY) ? `Server password: remembered on this device (user “${authCred.user}”).` : `Server password: kept for this tab only (user “${authCred.user}”).`);
  const b = document.getElementById('authForgetBtn'); if (b) b.disabled = !authCred;
}
function authDialogPrompt(message) {
  return new Promise(resolve => {
    const modal = $('authModal'); $('authMsg').textContent = message || ''; $('authUser').value = authCred ? authCred.user : ($('authUser').value || ''); $('authPass').value = ''; $('authRemember').checked = false; modal.hidden = false;
    const done = v => { modal.hidden = true; $('authPass').value = ''; $('authOk').onclick = null; $('authCancel').onclick = null; modal.onkeydown = null; resolve(v); };
    $('authOk').onclick = () => done({ user: $('authUser').value, password: $('authPass').value, remember: $('authRemember').checked });
    $('authCancel').onclick = () => done(null); modal.onkeydown = e => { if (e.key === 'Enter') $('authOk').onclick(); else if (e.key === 'Escape') done(null); };
    setTimeout(() => { try { $(authCred ? 'authPass' : 'authUser').focus(); } catch (_) {} }, 0);
  });
}
function authAsk(message) {
  if (!authPending) authPending = Promise.resolve((authPromptImpl || authDialogPrompt)(message)).then(r => { authPending = null; return r; }, e => { authPending = null; throw e; });
  return authPending;
}
let csrfRefreshing = false;
async function serverWrite(url, init = {}) {
  const send = async cred => {
    const go = () => { const headers = { ...(init.headers || {}) }; if (csrfToken) headers['X-CSRF-Token'] = csrfToken; if (cred) headers['Authorization'] = basicAuthHeader(cred.user, cred.password); return fetch(url, { ...init, headers }); };
    let r = await go();
    if (r.status === 403) { await pollStatus(); r = await go(); }   // CSRF token expired (e.g. after a restart): one refresh and one retry
    return r;
  };
  if (!csrfToken) await pollStatus();
  let r = await send(authCred);
  if (r.status === 401) {
    const got = await authAsk(authCred ? 'The server did not accept the password. Enter it again.' : 'The server asks for a password before it accepts changes.');
    if (!got || !got.password) return r;
    authStore({ user: got.user, password: got.password }, !!got.remember);
    r = await send(authCred);
    if (r.status === 401) authForget();   // a wrong password is not kept
  }
  return r;
}
async function stampedCalibration() {
  const out = { ...CALIBRATION }; if (out.sensorId == null) { const n = numericSensorId(activeSensor.id); if (n != null) out.sensorId = n; }
  const fp = out.sensorId === CALIBRATION.sensorId ? { id: state.revisionId, full: state.fullHash } : await fingerprintConfig(out);
  out.revisionId = fp.id; if (fp.full) out.contentHash = fp.full; else delete out.contentHash;
  return out;
}
// Calibration files are stored compressed on the device: PUT /data/calibration/calibration_<sensorId>_<profileId>.json, Content-Encoding: gzip.
async function sendCalibrationToDevice(config, sensorId) {
  const name = calFileName(config, sensorId);
  if (!/^calibration_\d+_[A-Za-z0-9._-]+\.json$/.test(name)) throw new Error('Only a calibration of a device sensor can be sent (the test signal has no device).');
  if (!deviceReachable) throw new Error('No device connection.');
  const gz = await gzipText(JSON.stringify(config)), max = deviceInfo && deviceInfo.maxUploadBytes;
  if (max && gz.length > max) throw new Error(`The compressed file (${fmtBytes(gz.length)}) is larger than the device accepts (${fmtBytes(max)}).`);
  const r = await serverWrite(`${CALIBRATION_DIR}/${name}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: gz });
  if (!r.ok) throw new Error(await httpErrorText(r));
  const result = await writeResult(r), e = calLibrary.get(name);
  if (e) { e.onDevice = true; e.sizeBytes = gz.length; } else calLibraryAdd(config, sensorId);
  return { name, bytes: gz.length, result };
}
async function uploadCalibration() {
  if (!deviceReachable) { showCalibrationMessages([], ['No device connection.'], ''); return; }
  try { const r = await sendCalibrationToDevice(await stampedCalibration(), activeSensor.id); showCalibrationMessages([], [], `Sent ${r.name} (${fmtBytes(r.bytes)} compressed): ${writeResultText(r.result)}. To make it the sensor’s default, choose it in Settings Menu → Sensor and apply.`); }
  catch (e) { showCalibrationMessages([`Could not send the calibration: ${e.message}`], [], ''); }
}

// ===== v16: AUXILIARY CHANNELS, CHARACTERIZATION, USE CONDITIONS ===================================================
// (handout v14.1, implemented in one round). Pure functions first (no DOM, no state), then the channel registry, then the UI glue.
const AUX_MAX_GAP_FACTOR = 2.5, AUX_CAPACITY = 100000, AUX_RATE_WINDOW_DEFAULT_S = 60;   // aux value is never interpolated across a gap longer than 2.5 channel periods
const CREEP_TIMES_S = [30, 60, 120, 300, 600, 900, 1200, 1800], CREEP_AVG_HALF_S = 2, CREEP_SETTLE_DEFAULT_S = 10, CREEP_MINUTES_DEFAULT = 5, CREEP_MINUTES_MAX = 30;
const DRIFT_MINUTES_DEFAULT = 10, DRIFT_MINUTES_MAX = 60, DRIFT_BLOCKS = 20;
const TEMP_FIT_MIN_RANGE_K = 2, TEMP_FIT_MIN_POINTS = 5, CHAR_MAX_SAMPLES = 600000;   // rules of thumb; revisit after real measurements
const ECC_POSITIONS = ['centre', 'front', 'back', 'left', 'right'];
const USE_COND_DEFAULTS = Object.freeze({ readingDelayS: 30, sessionSinceTareS: 3600, temperatureDeltaK: 3 });   // browser session only: never written to any file
const AUX_COLORS = ['#4fc3f7', '#81c784', '#ff8a65', '#ba68c8', '#fff176'];
const isCalObs = o => !o.purpose || o.purpose === 'calibration';
function wizCalObs(W) { return W.observations.filter(isCalObs); }

// ---- conversions (applied to the channel's native raw value) ---------------------------------------------------------------
// polynomial: c0 + c1 x + c2 x^2 ...   steinhart-hart {a,b,c}: raw = resistance in ohm, 1/T = a + b ln R + c (ln R)^3, T in K -> degC
// beta {beta, r0, t0, rSeries}: raw = measured resistance in ohm, R_ntc = raw - rSeries (leads), t0 in degC: 1/T = 1/T0 + ln(R/r0)/beta
// (the meaning of rSeries is an ASSUMPTION to be confirmed with the firmware). direct: no conversion. A failed conversion is NaN (invalid sample), never 0.
function validateAuxConversion(conv) {
  if (conv == null) return [];
  if (typeof conv !== 'object' || Array.isArray(conv)) return ['"conversion" must be an object.'];
  const t = conv.type || 'direct', n = v => typeof v === 'number' && Number.isFinite(v);
  if (conv.rawScale != null && !(n(conv.rawScale) && conv.rawScale !== 0)) return ['"rawScale" must be a non-zero number.'];
  if (conv.unit != null && typeof conv.unit !== 'string') return ['"unit" must be a text.'];
  if (t === 'direct') return [];
  if (t === 'polynomial') return Array.isArray(conv.coefficients) && conv.coefficients.length > 0 && conv.coefficients.every(n) ? [] : ['A polynomial conversion needs "coefficients": a list of numbers [c0, c1, …].'];
  if (t === 'steinhart-hart') return n(conv.a) && n(conv.b) && n(conv.c) ? [] : ['A steinhart-hart conversion needs the numbers a, b and c.'];
  if (t === 'beta') return n(conv.beta) && conv.beta > 0 && n(conv.r0) && conv.r0 > 0 && n(conv.t0) && (conv.rSeries == null || (n(conv.rSeries) && conv.rSeries >= 0)) ? [] : ['A beta conversion needs beta > 0, r0 > 0, t0 (°C) and optionally rSeries ≥ 0.'];
  return [`Unknown conversion type “${t}”. Use direct, polynomial, steinhart-hart or beta.`];
}
function convertAux(conv, raw0) {
  if (!Number.isFinite(raw0)) return NaN;
  const t = (conv && conv.type) || 'direct', raw = conv && Number.isFinite(conv.rawScale) ? raw0 * conv.rawScale : raw0;   // x = decoded raw x rawScale (e.g. m°C -> °C, mΩ -> Ω)
  if (t === 'direct') return raw;
  if (t === 'polynomial') { let s = 0; for (let k = conv.coefficients.length - 1; k >= 0; k--) s = s * raw + conv.coefficients[k]; return Number.isFinite(s) ? s : NaN; }
  if (t === 'steinhart-hart') { if (!(raw > 0)) return NaN; const l = Math.log(raw), inv = conv.a + conv.b * l + conv.c * l * l * l, T = 1 / inv; return Number.isFinite(T) && T > 0 ? T - 273.15 : NaN; }
  if (t === 'beta') { const R = raw - (conv.rSeries || 0); if (!(R > 0)) return NaN; const inv = 1 / (conv.t0 + 273.15) + Math.log(R / conv.r0) / conv.beta, T = 1 / inv; return Number.isFinite(T) && T > 0 ? T - 273.15 : NaN; }
  return NaN;
}
// ---- light ring buffer of an auxiliary channel: time (ms, shared device origin), raw (float), id, converted value ---------------
function auxNewBuffer(cap) { return { cap, count: 0, head: 0, t: new Float64Array(cap), raw: new Float64Array(cap), id: new Float64Array(cap).fill(NaN), val: new Float64Array(cap) }; }
function auxP(b, i) { return (b.head + i) % b.cap; }
function auxGrow(b, cap) { const o = auxNewBuffer(Math.max(cap, b.cap)); for (let i = 0; i < b.count; i++) { const p = auxP(b, i); o.t[i] = b.t[p]; o.raw[i] = b.raw[p]; o.id[i] = b.id[p]; o.val[i] = b.val[p]; } o.count = b.count; return o; }
function auxPush(ch, t, raw, id, val) {
  let b = ch.buf;
  if (b.count === b.cap) { if (ch.unlimited) b = ch.buf = auxGrow(b, b.cap + AUX_CAPACITY); else { b.head = (b.head + 1) % b.cap; b.count--; } }
  const p = auxP(b, b.count); b.t[p] = t; b.raw[p] = raw; b.id[p] = Number.isFinite(id) ? id : NaN; b.val[p] = val; b.count++;
}
function auxLower(b, t) { let lo = 0, hi = b.count; while (lo < hi) { const mid = (lo + hi) >>> 1; if (b.t[auxP(b, mid)] < t) lo = mid + 1; else hi = mid; } return lo; }
function auxLastId(ch) { const b = ch.buf; return b.count ? b.id[auxP(b, b.count - 1)] : NaN; }
function auxConversion(ch) { return ch.conversion || { type: 'direct' }; }
// Value of a channel at a load-cell sample time (ms): exact hit, or linear interpolation between the two neighbours; NaN outside the data
// and across a gap longer than AUX_MAX_GAP_FACTOR x the channel period. NEVER extrapolated. k = first index with time >= t.
function auxInterp(ch, t, k) {
  const b = ch.buf, n = b.count; if (!n) return NaN;
  if (k < n && b.t[auxP(b, k)] === t) { const v = b.val[auxP(b, k)]; return Number.isFinite(v) ? v : NaN; }
  if (k <= 0 || k >= n) return NaN;
  const pa = auxP(b, k - 1), pb = auxP(b, k), ta = b.t[pa], tb = b.t[pb];
  if (tb - ta > AUX_MAX_GAP_FACTOR * 1000 / ch.rateHz) return NaN;
  const va = b.val[pa], vb = b.val[pb]; if (!Number.isFinite(va) || !Number.isFinite(vb)) return NaN;
  return va + (t - ta) / (tb - ta) * (vb - va);
}
function auxValueAt(ch, t) { return auxInterp(ch, t, auxLower(ch.buf, t)); }
function auxColumn(ch, xsSec, n) {   // ascending x (seconds) -> array of values / null for the chart
  const b = ch.buf, col = new Array(n); let k = 0, any = false;
  for (let i = 0; i < n; i++) { const t = xsSec[i] * 1000; while (k < b.count && b.t[auxP(b, k)] < t) k++; const v = auxInterp(ch, t, k); if (Number.isFinite(v)) { col[i] = v; any = true; } else col[i] = null; }
  return { col, any };
}
function auxStatsRange(ch, t0, t1) {   // mean / min / max of the valid converted values with t0 <= time <= t1
  const b = ch.buf; let n = 0, s = 0, mn = Infinity, mx = -Infinity;
  for (let i = auxLower(b, t0); i < b.count; i++) { const p = auxP(b, i); if (b.t[p] > t1) break; const v = b.val[p]; if (!Number.isFinite(v)) continue; n++; s += v; if (v < mn) mn = v; if (v > mx) mx = v; }
  return n ? { mean: s / n, min: mn, max: mx, n } : null;
}
function auxRateKPerMin(ch, windowS) {   // least-squares slope of the converted value over the newest windowS seconds, per minute; null if < 3 valid points
  const b = ch.buf; if (b.count < 3) return null;
  const tN = b.t[auxP(b, b.count - 1)], t0 = tN - windowS * 1000, xs = [], ys = [];
  for (let i = b.count - 1; i >= 0; i--) { const p = auxP(b, i); if (b.t[p] < t0) break; if (Number.isFinite(b.val[p])) { xs.push(b.t[p] - tN); ys.push(b.val[p]); } }
  if (xs.length < 3) return null;
  const n = xs.length, mx = xs.reduce((a, c) => a + c, 0) / n, my = ys.reduce((a, c) => a + c, 0) / n; let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  return sxx > 0 ? sxy / sxx * 60000 : null;
}
function claimDeviceOrigin(deviceId, t) { if (!deviceOrigins.has(deviceId)) deviceOrigins.set(deviceId, t); return deviceOrigins.get(deviceId); }
function deviceIdOf(x) { return 'device'; }   // protocol v0.5: one clock for the whole device
function encodeHistoryBinaryV2(ids, ts, raws) {   // proposal v2 for float channels: 16-byte records (u32 id, u32 ms, f64 raw), version 2
  const n = ids.length, buf = new ArrayBuffer(12 + 16 * n), dv = new DataView(buf);
  dv.setUint32(0, HISTORY_MAGIC, true); dv.setUint16(4, 2, true); dv.setUint16(6, 0, true); dv.setUint32(8, n, true);
  for (let k = 0; k < n; k++) { const o = 12 + 16 * k; dv.setUint32(o, ids[k], true); dv.setUint32(o + 4, ts[k], true); dv.setFloat64(o + 8, raws[k], true); }
  return buf;
}
// ---- characterization maths (pure) ----------------------------------------------------------------------------------------
function numList(a) { return Array.isArray(a) && a.every(Number.isFinite); }
// Eccentricity: centre = reference. devMg = (raw_i - raw_centre) / slope (counts per mg at the test mass); fraction = max|devMg| / test mass.
function eccentricityAnalysis(inp) {
  const errors = [], { testMassMg, centreRaw, positions, slopeCountsPerMg } = inp;
  if (!(testMassMg > 0)) errors.push('The test mass must be greater than 0.');
  if (!Number.isFinite(centreRaw)) errors.push('The centre position is missing.');
  if (!positions || !positions.length) errors.push('At least one off-centre position is needed.');
  if (!Number.isFinite(slopeCountsPerMg) || slopeCountsPerMg === 0) errors.push('The slope of the calibration at the test mass is not available.');
  if (errors.length) return { ok: false, errors };
  const pos = positions.map(p => ({ name: p.name, raw: p.raw, devMg: (p.raw - centreRaw) / slopeCountsPerMg })), maxAbsDevMg = Math.max(...pos.map(p => Math.abs(p.devMg)));
  return { ok: true, errors, testMassMg, centreRaw, positions: pos, maxAbsDevMg, fractionOfLoad: maxAbsDevMg / testMassMg };
}
function seriesMeanAround(series, t, half) {
  let s = 0, n = 0; for (const p of series) if (Math.abs(p.tS - t) <= half) { s += p.raw; n++; }
  if (n) return s / n;
  let best = null; for (const p of series) if (!best || Math.abs(p.tS - t) < Math.abs(best.tS - t)) best = p;
  return best ? best.raw : NaN;
}
// Creep: fraction(t) = (r(t) - r(settle)) / (r(settle) - r_empty) at the times of CREEP_TIMES_S that fit into the recording (t measured from the
// start of the recording; r = mean of the series points within +-CREEP_AVG_HALF_S).
function creepAnalysis(inp) {
  const errors = [], series = inp.series || [], settleS = inp.settleS == null ? CREEP_SETTLE_DEFAULT_S : inp.settleS;
  if (series.length < 3) errors.push('The creep recording has too few points.');
  if (!Number.isFinite(inp.emptyRaw)) errors.push('No empty-platform observation is available as the reference (record the empty platform in the calibration first).');
  if (errors.length) return { ok: false, errors };
  const last = series[series.length - 1].tS, rs = seriesMeanAround(series, settleS, CREEP_AVG_HALF_S), d = rs - inp.emptyRaw;
  if (!(Math.abs(d) > 0)) return { ok: false, errors: ['The loaded reading equals the empty reading; the creep fraction is undefined.'] };
  const samples = CREEP_TIMES_S.filter(t => t > settleS && t <= last).map(t => ({ tS: t, fraction: (seriesMeanAround(series, t, CREEP_AVG_HALF_S) - rs) / d }));
  if (!samples.length) return { ok: false, errors: [`The recording is too short: it must last longer than ${CREEP_TIMES_S[0]} s.`] };
  return { ok: true, errors, settleS, samples, settleRaw: rs };
}
function creepFractionAt(creep, t) {   // linear in the stored curve; 0 at the settle time; constant beyond the last point (flagged)
  const s = creep.samples, settle = creep.settleS == null ? CREEP_SETTLE_DEFAULT_S : creep.settleS;
  if (!s || !s.length) return { value: 0, flagged: false };
  if (t <= settle) return { value: 0, flagged: false };
  if (t <= s[0].tS) return { value: s[0].fraction * (t - settle) / (s[0].tS - settle || 1), flagged: false };
  for (let k = 0; k + 1 < s.length; k++) if (t <= s[k + 1].tS) return { value: s[k].fraction + (t - s[k].tS) / (s[k + 1].tS - s[k].tS) * (s[k + 1].fraction - s[k].fraction), flagged: false };
  return { value: s[s.length - 1].fraction, flagged: true };
}
// Zero drift: weighted straight-line fit of the empty-platform readings (block means, weights 1 / se^2 with a floor) against time; rate +- standard
// error in mg/h. series: [{tS, raw, n?, sd?}]. Standard error of the slope = sqrt(s2 / Sxx_w), s2 = sum w r^2 / (n - 2) (scaled by the residuals).
function zeroDriftAnalysis(inp) {
  const series = inp.series || [], errors = [];
  if (series.length < 3) errors.push('The drift recording has too few points.');
  if (!Number.isFinite(inp.slopeCountsPerMg) || inp.slopeCountsPerMg === 0) errors.push('The slope of the calibration is not available.');
  if (errors.length) return { ok: false, errors };
  const se = series.map(p => (Number.isFinite(p.sd) && p.n > 0 ? p.sd / Math.sqrt(p.n) : NaN)), fin = se.filter(v => v > 0).sort((a, b) => a - b);
  const floor = fin.length ? 0.2 * fin[Math.floor(fin.length / 2)] : 0, w = series.map((p, i) => (fin.length ? 1 / Math.pow(Math.max(se[i] > 0 ? se[i] : floor, floor, 1e-12), 2) : 1));
  const x = series.map(p => p.tS / 3600), y = series.map(p => p.raw), sw = w.reduce((a, b) => a + b, 0), mx = x.reduce((a, v, i) => a + w[i] * v, 0) / sw, my = y.reduce((a, v, i) => a + w[i] * v, 0) / sw;
  let sxx = 0, sxy = 0; for (let i = 0; i < x.length; i++) { sxx += w[i] * (x[i] - mx) ** 2; sxy += w[i] * (x[i] - mx) * (y[i] - my); }
  if (!(sxx > 0)) return { ok: false, errors: ['The recording has no time extent.'] };
  const b = sxy / sxx, a = my - b * mx; let ssr = 0; for (let i = 0; i < x.length; i++) ssr += w[i] * (y[i] - a - b * x[i]) ** 2;
  const s2 = ssr / (x.length - 2), seB = Math.sqrt(Math.max(0, s2) / sxx);
  return { ok: true, errors, rateCountsPerH: b, rateMgPerH: b / inp.slopeCountsPerMg, seMgPerH: seB / Math.abs(inp.slopeCountsPerMg), durationS: series[series.length - 1].tS - series[0].tS, blocks: series.length };
}
// Temperature sensitivity: raw = a + a1 dT + b x + b2 x dT (x = mass / scale, dT = T - mean T) by least squares. Zero shift = a1 / (b / scale) in mg per K,
// span change = b2 / b in ppm per K. The standard errors ignore the (small) uncertainty of b. Refused (with a reason) if the temperature range is
// below TEMP_FIT_MIN_RANGE_K, or the observations are too few / temperature varies together with the mass.
function fitTemperatureSensitivity(points) {
  const errors = [], p = (points || []).filter(q => Number.isFinite(q.massMg) && Number.isFinite(q.raw) && Number.isFinite(q.tempC));
  if (p.length < TEMP_FIT_MIN_POINTS) return { ok: false, errors: [`Needs at least ${TEMP_FIT_MIN_POINTS} observations that carry a temperature; there are ${p.length}.`] };
  const tmin = Math.min(...p.map(q => q.tempC)), tmax = Math.max(...p.map(q => q.tempC)), range = tmax - tmin;
  if (!(range >= TEMP_FIT_MIN_RANGE_K)) return { ok: false, errors: [`The temperature only varied by ${range.toFixed(2)} K during the observations; at least ${TEMP_FIT_MIN_RANGE_K} K is needed (warm-up, or two sessions at different temperatures).`], rangeK: range };
  if (new Set(p.map(q => fitKey(q.massMg))).size < 2) return { ok: false, errors: ['At least two different masses are needed.'] };
  const T0 = p.reduce((s, q) => s + q.tempC, 0) / p.length, scale = Math.max(...p.map(q => Math.abs(q.massMg))) || 1, n = p.length;
  const X = p.map(q => { const dT = q.tempC - T0, x = q.massMg / scale; return [1, dT, x, x * dT]; });
  const A = Array.from({ length: 4 }, () => new Array(4).fill(0)), bv = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) for (let r = 0; r < 4; r++) { bv[r] += X[i][r] * p[i].raw; for (let c = 0; c < 4; c++) A[r][c] += X[i][r] * X[i][c]; }
  const coef = fitSolve(A, bv); if (!coef) return { ok: false, errors: ['The temperature varies together with the mass (or too little): the effects cannot be separated.'] };
  const inv = []; for (let j = 0; j < 4; j++) { const e = [0, 0, 0, 0]; e[j] = 1; const col = fitSolve(A, e); if (!col) return { ok: false, errors: ['The temperature varies together with the mass: the effects cannot be separated.'] }; inv.push(col); }
  let sse = 0; for (let i = 0; i < n; i++) { const r = p[i].raw - (coef[0] * X[i][0] + coef[1] * X[i][1] + coef[2] * X[i][2] + coef[3] * X[i][3]); sse += r * r; }
  const dof = n - 4, s2 = dof > 0 ? sse / dof : 0, b = coef[2];
  if (!Number.isFinite(b) || b === 0) return { ok: false, errors: ['The response to mass could not be determined.'] };
  return { ok: true, errors, referenceC: T0, zeroMgPerK: coef[1] * scale / b, zeroSe: dof > 0 ? Math.sqrt(s2 * inv[1][1]) * scale / Math.abs(b) : null, spanPpmPerK: coef[3] / b * 1e6, spanSe: dof > 0 ? Math.sqrt(s2 * inv[3][3]) / Math.abs(b) * 1e6 : null, n, dof, rangeK: range };
}
// Which long recordings count: creep and zero-drift recordings DRIFT by design, so only gaps, range, vibration and a real STEP (a moved weight) can invalidate them.
const CHAR_RELEVANT_CHECKS = { creep: ['gaps', 'range', 'vibration', 'step'], 'zero-drift': ['gaps', 'range', 'vibration', 'step'] };
function charRelevantChecks(an, purpose) {
  const ids = CHAR_RELEVANT_CHECKS[purpose]; if (!ids) return an.checks || [];
  return (an.checks || []).filter(c => ids.includes(c.id) && (c.id !== 'step' || c.stepLike === true));
}
function charStatus(an, purpose) {
  if (!CHAR_RELEVANT_CHECKS[purpose]) return an.status;
  const st = worstVerdict(charRelevantChecks(an, purpose));
  if (an.status === 'insufficient' && (st === 'ok' || st === 'n/a')) return 'insufficient';
  return st === 'n/a' ? 'ok' : st;
}
function binSeries(times, raws, binS) {
  const t0 = times[0], bins = new Map();
  for (let i = 0; i < times.length; i++) {
    const k = Math.floor((times[i] - t0) / 1000 / binS); let b = bins.get(k); if (!b) { b = { n: 0, s: 0, q: 0, ts: 0 }; bins.set(k, b); }
    b.n++; b.s += raws[i]; b.q += raws[i] * raws[i]; b.ts += (times[i] - t0) / 1000;
  }
  return [...bins.keys()].sort((a, b) => a - b).map(k => { const b = bins.get(k), m = b.s / b.n; return { tS: b.ts / b.n, raw: m, n: b.n, sd: Math.sqrt(Math.max(0, b.q / b.n - m * m)) }; });
}
function charIncludedNames(ch) {   // names (as in the "not included" list) of the components a characterization block supplies
  const s = new Set(); if (!ch || typeof ch !== 'object' || ch.status === 'none') return s;
  if (ch.eccentricity && Number.isFinite(ch.eccentricity.fractionOfLoad)) s.add('off-centre loading');
  if (ch.creep && Array.isArray(ch.creep.samples) && ch.creep.samples.length) s.add('creep');
  if (ch.zeroDrift && Number.isFinite(ch.zeroDrift.rateMgPerH)) s.add('drift between calibration and use');
  if (ch.temperature && (Number.isFinite(ch.temperature.zeroMgPerK) || Number.isFinite(ch.temperature.spanPpmPerK))) s.add('temperature');
  return s;
}
function charNotIncluded(list, ch) { const inc = charIncludedNames(ch); return (list || []).filter(x => !inc.has(x)); }
function joinAnd(a) { return a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
function useConditionsOf(sensor) { return { ...USE_COND_DEFAULTS, ...((sensor && sensor.settings && sensor.settings.useConditions) || {}) }; }
function applyUseConditions(sensor, o) {
  const errors = [], out = { ...USE_COND_DEFAULTS }; o = o || {};
  const num = (k, hi, label) => { if (o[k] == null || o[k] === '') return; const v = Number(o[k]); if (!Number.isFinite(v) || v < 0 || v > hi) { errors.push(`${label} must be between 0 and ${hi}.`); return; } out[k] = v; };
  num('readingDelayS', 86400, 'Reading delay'); num('sessionSinceTareS', 31536000, 'Time since tare'); num('temperatureDeltaK', 100, 'Temperature difference');
  if (errors.length) return { errors };
  sensor.settings.useConditions = out; return { errors: [] };
}
// ---- registry of auxiliary channels ---------------------------------------------------------------------------------------------
function makeAux(def) {
  const ch = { id: String(def.id), name: String(def.name || def.id), kind: def.kind, unit: def.unit, rawUnit: def.rawUnit || '', rawFormat: def.rawFormat || null, conversion: def.conversion || { type: 'direct' }, def: def.def || null, attachedTo: def.attachedTo || [], archiveAttach: new Set(), archived: false, disabled: false,
    sseUrl: def.sseUrl || null, rateHz: def.rateHz, paused: false, unlisted: false, unlimited: false, epochNo: 1, configRev: null, status: null, err: null,
    buf: auxNewBuffer(AUX_CAPACITY), rejected: 0, dropped: 0, invalid: 0, lastWall: null, firstLiveId: null, skipNextGap: false, gaps: [], gapCount: 0,
    history: { status: 'idle', loaded: 0, running: false, error: null, minId: null, autoStarted: false } };
  auxChannels.set(ch.id, ch); return ch;
}
function applyAuxEntry(e, id, result, m) {
  const kind = m.kind;
  if (sensors.has(id)) { result.errors.push(`The id ${id} is already a load cell.`); return false; }
  const conv = e.conversion == null ? { type: 'direct' } : e.conversion, ce = validateAuxConversion(conv);
  if (ce.length) { result.errors.push(`Channel ${id}: ${ce.join(' ')}`); return false; }
  const unit = typeof conv.unit === 'string' && conv.unit ? conv.unit : (kind === 'temperature' ? '°C' : '');
  if (kind === 'temperature' && !/^(°C|C|degC)$/.test(unit)) { result.errors.push(`Channel ${id}: a temperature channel must deliver °C (differences are always in K).`); return false; }
  if (e.attachedTo != null && (!Array.isArray(e.attachedTo) || !e.attachedTo.every(v => Number.isInteger(v) && v >= 0))) { result.errors.push(`Channel ${id}: "attachedTo" must be a list of load-cell ids (numbers).`); return false; }
  const attachedTo = (e.attachedTo || []).map(String), name = typeof e.name === 'string' && e.name.trim() ? e.name.trim() : `Sensor ${id}`, known = auxChannels.get(id);
  if (known && !known.archived) {
    const changed = JSON.stringify(known.conversion) !== JSON.stringify(conv);
    Object.assign(known, { name, sseUrl: STREAM_URL, unit, rawUnit: e.unit || '', attachedTo, rateHz: m.rate, conversion: conv, rawFormat: m.rf, def: cloneJson(e), disabled: e.enabled === false, unlisted: false });
    if (changed) auxReconvert(known); result.auxUpdated.push(id);
  } else { makeAux({ id, name, kind, sseUrl: STREAM_URL, rawFormat: m.rf, unit, rawUnit: e.unit || '', conversion: conv, attachedTo, rateHz: m.rate, def: cloneJson(e) }).disabled = e.enabled === false; result.auxAdded.push(id); }
  return true;
}
function auxReconvert(ch) { const b = ch.buf, c = auxConversion(ch); ch.invalid = 0; for (let i = 0; i < b.count; i++) { const p = auxP(b, i); b.val[p] = convertAux(c, b.raw[p]); if (!Number.isFinite(b.val[p])) ch.invalid++; } }
function attachedAux(sensor, kind) { return [...auxChannels.values()].filter(c => (c.attachedTo.includes(sensor.id) || (c.archiveAttach && c.archiveAttach.has(sensor.id))) && (!kind || c.kind === kind)); }
function primaryTempChannel(sensor) { const list = attachedAux(sensor, 'temperature'), want = sensor.settings && sensor.settings.primaryTemperatureSensorId; return list.find(c => c.id === want) || list[0] || null; }
function auxTemperaturesFor(sensor, t0, t1) {
  const out = {}; for (const ch of attachedAux(sensor, 'temperature')) { const s = auxStatsRange(ch, t0, t1); if (s) out[ch.id] = { mean: s.mean, min: s.min, max: s.max, unit: ch.unit }; }
  return Object.keys(out).length ? out : null;
}
function ingestAux(ch, raw, timeMs, id, forceInvalid) {
  if (ch.paused) { ch.dropped++; return false; }
  ch.lastWall = performance.now();
  const b = ch.buf; if (b.count && timeMs <= b.t[auxP(b, b.count - 1)]) { ch.rejected++; return false; }
  if (Number.isFinite(id)) {
    const last = auxLastId(ch);
    if (Number.isFinite(last)) { if (id <= last) { ch.rejected++; return false; } if (id > last + 1 && !ch.skipNextGap) auxNoteGap(ch, last + 1, id - 1); }
    ch.skipNextGap = false; if (ch.firstLiveId == null) { ch.firstLiveId = id; auxHistoryScheduleInitial(ch); }
  }
  const val = forceInvalid ? NaN : convertAux(auxConversion(ch), raw); if (!Number.isFinite(val)) ch.invalid++;
  auxPush(ch, timeMs, raw, id, val); return true;
}
function handleAuxSample(ch, it) {
  const raw = decodeRaw(it.raw, ch.rawFormat), t = toNum(it.t);
  if (!Number.isFinite(raw) || !Number.isFinite(t)) { ch.rejected++; return; }
  if (ch.paused) { ch.dropped++; return; }
  const origin = claimDeviceOrigin(deviceIdOf(ch), t / 1000), flags = Number(toNum(it.flags)) || 0;
  ingestAux(ch, raw, t / 1000 - origin, it.n == null ? undefined : toNum(it.n), !!(flags & FLAG_INVALID));   // a flagged-invalid reading is stored as invalid (NaN), never as a value
}
function setAuxPaused(ch, paused, quiet = false) { ch.paused = paused; if (!paused) { ch.skipNextGap = true; ch.lastWall = performance.now(); } if (!quiet) { syncConnections(); renderAuxToggles(); updateStatusUI(); } }
function auxStaleMs(ch, now) { if (ch.paused || ch.unlisted || ch.lastWall == null) return 0; const age = now - ch.lastWall; return age > Math.max(STREAM_TIMEOUT_MIN_MS, STREAM_TIMEOUT_PERIODS * 1000 / ch.rateHz) ? age : 0; }
function auxLink(ch) {
  if (ch.archived) return { key: 'archived', text: 'archived epoch' };
  if (ch.disabled) return { key: 'disabled', text: 'disabled on the device' };
  if (ch.err) return { key: 'sensorerr', text: `${ch.err.state}: ${ch.err.message || ch.err.code || ''}` };
  if (ch.paused) return { key: 'paused', text: 'paused' };
  if (ch.unlisted) return { key: 'unlisted', text: 'not in the list' };
  if (!ch.sseUrl) return { key: 'idle', text: 'no SSE URL' };
  const c = sseConnections.get(ch.sseUrl); if (!c) return { key: 'idle', text: 'not connected' };
  if (c.status === 'live') { const age = auxStaleMs(ch, performance.now()); return age > 0 ? { key: 'timeout', text: `no data for ${(age / 1000).toFixed(0)} s` } : { key: 'live', text: 'streaming' }; }
  return c.status === 'error' ? { key: 'error', text: 'connection failed' } : { key: 'connecting', text: 'connecting…' };
}
function auxClear(ch) { ch.buf = auxNewBuffer(ch.buf.cap); ch.gaps = []; ch.gapCount = 0; ch.skipNextGap = true; ch.firstLiveId = null; }
// history merge / gaps of a channel (same rules as for load cells: merge by time, duplicates by id, nothing extrapolated)
function mergeAuxHistory(ch, chunk) {
  const b = ch.buf, n = chunk.t.length; if (!n) return { added: 0, duplicates: 0, dropped: 0, count: b.count };
  let mn = Infinity; for (const v of chunk.t) if (v < mn) mn = v;
  const origin = claimDeviceOrigin(deviceIdOf(ch), mn), ex = { t: new Array(b.count), raw: new Array(b.count), id: new Array(b.count) };
  for (let i = 0; i < b.count; i++) { const p = auxP(b, i); ex.t[i] = b.t[p]; ex.raw[i] = b.raw[p]; ex.id[i] = b.id[p]; }
  const m = mergeSampleLists(ex, { t: chunk.t.map(v => v - origin), raw: chunk.raw, id: chunk.id });
  if (!m.added) return { added: 0, duplicates: m.duplicates, dropped: 0, count: b.count };
  let total = m.t.length, from = 0, dropped = 0; if (!ch.unlimited && total > b.cap) { dropped = total - b.cap; from = dropped; total = b.cap; }
  const cap = ch.unlimited ? Math.max(b.cap, Math.ceil(total / AUX_CAPACITY) * AUX_CAPACITY) : b.cap, nb = auxNewBuffer(cap), conv = auxConversion(ch);
  for (let i = 0; i < total; i++) { const k = from + i; nb.t[i] = m.t[k]; nb.raw[i] = m.raw[k]; nb.id[i] = m.id[k]; nb.val[i] = convertAux(conv, m.raw[k]); }
  nb.count = total; ch.buf = nb;
  return { added: m.added, duplicates: m.duplicates, dropped, count: total };
}
function auxNoteGap(ch, fromId, toId) {
  ch.gapCount += toId - fromId + 1; const g = ch.gaps[ch.gaps.length - 1];
  if (g && g.status === 'pending' && fromId <= g.toId + 1) g.toId = Math.max(g.toId, toId); else ch.gaps.push({ fromId, toId, status: 'pending' });
  if (historyUrlFor(ch)) setTimeout(() => auxFillGaps(ch), 0); else ch.gaps[ch.gaps.length - 1].status = 'no history server';
}
async function auxFillGaps(ch) {
  if (ch.history.fillingGaps || !historyUrlFor(ch)) return; ch.history.fillingGaps = true;
  try {
    for (const g of ch.gaps) {
      if (g.status !== 'pending') continue; let got = 0;
      try { for (let a = g.fromId; a <= g.toId; a += historyChunkSize()) { const bb = Math.min(g.toId, a + historyChunkSize() - 1), chunk = await historyFetchChunk(ch, a, bb); if (chunk.id.length) got += mergeAuxHistory(ch, chunk).added; } g.status = got >= g.toId - g.fromId + 1 ? 'filled' : (got ? 'partly filled' : 'not available: stays a gap'); g.got = got; }
      catch (e) { g.status = 'failed: ' + e.message; }
    }
  } finally { ch.history.fillingGaps = false; }
}
function auxHistoryScheduleInitial(ch) { const h = ch.history; if (h.autoStarted || !historyUrlFor(ch)) return; h.autoStarted = true; setTimeout(() => auxHistoryLoadOlder(ch), 0); }
async function auxHistoryLoadOlder(ch) {
  const base = historyUrlFor(ch), h = ch.history;
  if (!base) { h.status = 'not configured'; return h; } if (h.running) return h;
  h.running = true; h.error = null; h.status = 'loading';
  try {
    for (let guard = 0; guard < HISTORY_MAX_CHUNKS; guard++) {
      let first = NaN; for (let i = 0; i < ch.buf.count; i++) { const v = ch.buf.id[auxP(ch.buf, i)]; if (Number.isFinite(v)) { first = v; break; } }
      if (!Number.isFinite(first)) { h.status = 'waiting for the first sample id'; break; }
      if (!ch.unlimited && ch.buf.count >= ch.buf.cap) { h.status = 'buffer full'; break; }
      const to = first - 1, floor = h.minId == null ? 0 : h.minId; if (to < floor) { h.status = 'complete (server start reached)'; break; }
      const room = ch.unlimited ? Infinity : ch.buf.cap - ch.buf.count, from = Math.max(floor, to - Math.min(historyChunkSize(), room) + 1), chunk = await historyFetchChunk(ch, from, to);
      if (!chunk.id.length) { h.minId = to + 1; h.status = 'complete (server has nothing older)'; break; }
      const r = mergeAuxHistory(ch, chunk); h.loaded += r.added; let lo = Infinity; for (const v of chunk.id) if (Number.isFinite(v) && v < lo) lo = v; if (lo > from) h.minId = lo;
      if (!r.added) { h.status = 'complete (no new samples)'; break; } h.status = 'loading';
    }
    if (h.status === 'loading') h.status = 'paused (chunk limit)';
  } catch (e) { h.error = e.message; h.status = 'error'; }
  h.running = false; return h;
}
// ---- check weighings (long-term drift, weeks): FORMAT ONLY, no component in the uncertainty yet (handout v14.1 section 8) ------------------------------
// checkweighings.json: {schemaVersion:1, calibrationRevisionId, entries:[{recordedAt, weightId, referenceMassMg, readingMg, sigmaMg, neff, temperatureC|null, note}]}
function validateCheckweighings(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { errors: ['The top level must be a JSON object.'] };
  if (doc.schemaVersion !== 1) errors.push('schemaVersion must be 1.');
  if (typeof doc.calibrationRevisionId !== 'string' || !doc.calibrationRevisionId.trim()) errors.push('"calibrationRevisionId" must be a non-empty text.');
  if (!Array.isArray(doc.entries)) { errors.push('"entries" must be a list.'); return { errors }; }
  doc.entries.forEach((e, i) => {
    const at = `entries[${i}]`, f = (v, lo) => Number.isFinite(v) && (lo == null || v >= lo);
    if (!e || typeof e !== 'object') { errors.push(`${at} must be an object.`); return; }
    if (typeof e.recordedAt !== 'string' || Number.isNaN(Date.parse(e.recordedAt))) errors.push(`${at}.recordedAt must be a date/time text.`);
    if (e.weightId != null && typeof e.weightId !== 'string') errors.push(`${at}.weightId must be a text.`);
    if (!f(e.referenceMassMg, 0) || !(e.referenceMassMg > 0)) errors.push(`${at}.referenceMassMg must be a number greater than 0.`);
    if (!f(e.readingMg)) errors.push(`${at}.readingMg must be a number.`);
    if (e.sigmaMg != null && !f(e.sigmaMg, 0)) errors.push(`${at}.sigmaMg must be a number ≥ 0 or null.`);
    if (e.neff != null && !f(e.neff, 1)) errors.push(`${at}.neff must be a number ≥ 1 or null.`);
    if (e.temperatureC != null && !f(e.temperatureC)) errors.push(`${at}.temperatureC must be a number or null.`);
    if (e.note != null && typeof e.note !== 'string') errors.push(`${at}.note must be a text.`);
  });
  return { errors };
}
function checkweighingsDoc(calibrationRevisionId, entries) { return { schemaVersion: 1, calibrationRevisionId, entries: entries || [] }; }
// ---- aux UI glue ---------------------------------------------------------------------------------------------------------------
function auxShownChannels() { return activeSensor && state ? attachedAux(activeSensor).filter(c => !state.auxHidden.has(c.id)) : []; }
function auxSigNow() { return auxShownChannels().map(c => c.id).join(','); }
function emptyMainData() { const d = [[], [], [], [], []]; for (let k = 0; k < auxShownChannels().length; k++) d.push([]); return d; }
function auxRateWindowS() { const v = Number($('tempRateWindow').value); return Number.isFinite(v) && v >= 5 ? Math.min(3600, v) : AUX_RATE_WINDOW_DEFAULT_S; }
function auxApplySeriesVisibility() {
  const u = state.mainPlot; if (!u) return; const any = state.auxColsAny || [];
  if (state.auxAxisShown !== state.auxHasData) { state.auxAxisShown = state.auxHasData; if (state.auxHasData !== undefined && auxShownChannels().length) { try { u.setSize({ width: u.width, height: u.height }); } catch (_) {} } }   // the right-hand axis changes its width (0 while there is nothing to show)
  for (let k = 0; k < any.length; k++) if (state.auxSeriesShown[k] !== any[k]) { state.auxSeriesShown[k] = any[k]; try { u.setSeries(5 + k, { show: any[k] }); } catch (_) {} }
}
function auxLatest(ch) { const b = ch.buf; for (let i = b.count - 1; i >= 0 && i >= b.count - 50; i--) { const p = auxP(b, i); if (Number.isFinite(b.val[p])) return { v: b.val[p], t: b.t[p] }; } return null; }
function updateAuxReadout() {
  const el = $('auxReadout'); if (!el || !activeSensor) return;
  const list = attachedAux(activeSensor).filter(c => c.buf.count && auxLatest(c)); el.hidden = !list.length; if (!list.length) return;
  const w = auxRateWindowS();
  setHTML(el, list.map(c => { const l = auxLatest(c), r = c.kind === 'temperature' ? auxRateKPerMin(c, w) : null;
    return `${esc(c.name)} <strong>${esc(fmtNumber(l.v, 2))} ${esc(c.unit)}</strong>${r == null ? '' : ` · ${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)} K/min <span class="small">(${w} s)</span>`}`; }).join(' · '));
}
function renderAuxToggles() {
  const f = $('auxField'); if (!f || !activeSensor || !state) return; const list = attachedAux(activeSensor); f.hidden = !list.length;
  setHTML($('auxToggles'), list.map(c => `<label class="check"><input type="checkbox" data-aux="${esc(c.id)}" ${state.auxHidden.has(c.id) ? '' : 'checked'}> ${esc(c.name)} <span class="small">(${esc(c.unit || '—')}) · ${esc(auxLink(c).text)}</span></label>`).join(''));
}
// Plain-words effect of the use conditions on the estimated uncertainty (Settings Menu, Sensor tab)
function useConditionsNote(sensor) {
  const uc = useConditionsOf(sensor), ch = sensor.state.calConfig && sensor.state.calConfig.characterization, inc = charIncludedNames(ch);
  if (!inc.size) return 'The calibration of this sensor has no characterization (off-centre, creep, zero drift, temperature), so these numbers do not change any uncertainty yet. Measure them in the calibration wizard (Characterization / Extra checks).';
  const mid = sensor.state.calPrepared && sensor.state.calPrepared.anchors ? Math.abs(sensor.state.calPrepared.anchors[sensor.state.calPrepared.anchors.length - 1].massMg) / 2 : 0, out = [];
  if (ch.creep && inc.has('creep')) out.push(`creep after ${uc.readingDelayS} s: ±${(Math.abs(creepFractionAt(ch.creep, uc.readingDelayS).value) * mid).toPrecision(2)} mg at half load`);
  if (ch.zeroDrift && inc.has('drift between calibration and use')) out.push(`zero drift ${uc.sessionSinceTareS} s after the tare: ±${(Math.abs(ch.zeroDrift.rateMgPerH) * uc.sessionSinceTareS / 3600).toPrecision(2)} mg`);
  if (ch.temperature && inc.has('temperature')) out.push(`temperature ${uc.temperatureDeltaK} K away from the calibration temperature (only used without a temperature sensor): up to ±${Math.hypot((ch.temperature.zeroMgPerK || 0) * uc.temperatureDeltaK, (ch.temperature.spanPpmPerK || 0) * 1e-6 * mid * uc.temperatureDeltaK).toPrecision(2)} mg at half load`);
  return 'These numbers decide how large the estimated uncertainty is: ' + (out.join('; ') || 'nothing measured applies') + '.';
}
function auxSetConversion(ch, conv) {
  const c = conv == null ? { type: 'direct' } : conv, errs = validateAuxConversion(c); if (errs.length) return errs;
  if (ch.kind === 'temperature') { const u = typeof c.unit === 'string' && c.unit ? c.unit : '°C'; if (!/^(°C|C|degC)$/.test(u)) return ['A temperature channel must deliver °C.']; ch.unit = u; } else if (typeof c.unit === 'string') ch.unit = c.unit;
  ch.conversion = c; auxReconvert(ch); return [];
}
// ---- characterization in the wizard (builder, long recordings, panes) ----------------------------------------------------------------
function wizCharNew() { return { eccLoadId: null, eccPct: '', creepLoadId: null, creepMin: CREEP_MINUTES_DEFAULT, creepSettleS: CREEP_SETTLE_DEFAULT_S, creepPct: '', driftMin: DRIFT_MINUTES_DEFAULT, driftMgH: '', tempMode: 'auto', tempChannelId: null, tempZero10K: '', tempSpanPpm: '', tempRefC: '' }; }
function wizChar() { return wiz.char || (wiz.char = wizCharNew()); }
function wizCharFromConfig(cfg) {
  const C = wizCharNew(), ch = cfg && cfg.characterization; if (!ch || typeof ch !== 'object') return C;
  if (ch.eccentricity && ch.eccentricity.source === 'user-estimate' && Number.isFinite(ch.eccentricity.fractionOfLoad)) C.eccPct = ch.eccentricity.fractionOfLoad * 100;
  if (ch.creep && ch.creep.source === 'user-estimate' && ch.creep.samples && ch.creep.samples.length) C.creepPct = ch.creep.samples[0].fraction * 100;
  if (ch.zeroDrift && ch.zeroDrift.source === 'user-estimate') C.driftMgH = ch.zeroDrift.rateMgPerH;
  const t = ch.temperature;
  if (t) { if (t.source === 'user-estimate') { C.tempMode = 'typed'; C.tempZero10K = t.zeroMgPerK * 10; C.tempSpanPpm = t.spanPpmPerK; C.tempRefC = t.referenceC == null ? '' : t.referenceC; } else if (t.channelId) C.tempChannelId = t.channelId; }
  return C;
}
function wizEmptyRaw(W) {
  const v = []; for (const o of W.observations) { if (!isCalObs(o) || !o.include || !Number.isFinite(o.rawMean)) continue; const l = W.loads.find(x => x.loadId === o.loadId); if (!l) continue; let m; try { m = wizLoadMassMg(W, l); } catch (_) { continue; } if (m === 0) v.push(o.rawMean); }
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}
// The `characterization` block of the calibration file. Tests are observations with a purpose; they never enter the fit. Measured values win over typed estimates.
function buildCharacterization(W, fit) {
  const C = W.char || wizCharNew(), notes = [], pid = W.profile.profileId, res = { status: 'none', profileId: pid, eccentricity: null, creep: null, zeroDrift: null, temperature: null, overriddenObservations: [], notes };
  const obsOf = p => W.observations.filter(o => o.purpose === p && o.include && Number.isFinite(o.rawMean));
  const massOf = id => { const l = W.loads.find(x => x.loadId === id); if (!l) return NaN; try { return wizLoadMassMg(W, l); } catch (_) { return NaN; } };
  const track = list => { for (const o of list) if (o.override) res.overriddenObservations.push(o.observationId); }, mean = a => a.reduce((s, o) => s + o.rawMean, 0) / a.length;
  const eo = obsOf('eccentricity'), ctr0 = eo.filter(o => o.position === 'centre');
  if (ctr0.length) {
    const loadId = ctr0[0].loadId, tm = massOf(loadId), same = eo.filter(o => o.loadId === loadId), names = [...new Set(same.map(o => o.position).filter(p => p !== 'centre'))];
    const a = eccentricityAnalysis({ testMassMg: tm, centreRaw: mean(same.filter(o => o.position === 'centre')), positions: names.map(n => ({ name: n, raw: mean(same.filter(o => o.position === n)) })), slopeCountsPerMg: fit.slopeAt(tm) });
    if (a.ok) { res.eccentricity = { testMassMg: a.testMassMg, centreRaw: a.centreRaw, positions: a.positions, maxAbsDevMg: a.maxAbsDevMg, fractionOfLoad: a.fractionOfLoad, source: 'measured', observationIds: same.map(o => o.observationId), calibrationProfileId: pid }; track(same); }
    else notes.push('Off-centre loading: ' + a.errors.join(' '));
  } else if (eo.length) notes.push('Off-centre loading: the centre position is missing.');
  if (!res.eccentricity) { const p = numOrNull(C.eccPct); if (p != null && p >= 0) res.eccentricity = { testMassMg: null, centreRaw: null, positions: [], maxAbsDevMg: null, fractionOfLoad: p / 100, source: 'user-estimate', observationIds: [], calibrationProfileId: pid }; }
  const co = obsOf('creep').filter(o => Array.isArray(o.series) && o.series.length);
  if (co.length) {
    const o = co[co.length - 1], a = creepAnalysis({ series: o.series, settleS: o.settleS == null ? CREEP_SETTLE_DEFAULT_S : o.settleS, emptyRaw: wizEmptyRaw(W) });
    if (a.ok) { res.creep = { testMassMg: massOf(o.loadId), settleS: a.settleS, samples: a.samples, source: 'measured', observationIds: [o.observationId], calibrationProfileId: pid }; track([o]); } else notes.push('Creep: ' + a.errors.join(' '));
  }
  if (!res.creep) { const p = numOrNull(C.creepPct); if (p != null) res.creep = { testMassMg: null, settleS: CREEP_SETTLE_DEFAULT_S, samples: [{ tS: 60, fraction: p / 100 }], source: 'user-estimate', observationIds: [], calibrationProfileId: pid }; }
  const dobs = obsOf('zero-drift').filter(o => Array.isArray(o.series) && o.series.length);
  if (dobs.length) {
    const o = dobs[dobs.length - 1], a = zeroDriftAnalysis({ series: o.series, slopeCountsPerMg: fit.slopeAt(0) });
    if (a.ok) { res.zeroDrift = { rateMgPerH: a.rateMgPerH, seMgPerH: a.seMgPerH, durationS: a.durationS, source: 'measured', observationIds: [o.observationId], calibrationProfileId: pid }; track([o]); } else notes.push('Zero drift: ' + a.errors.join(' '));
  }
  if (!res.zeroDrift) { const p = numOrNull(C.driftMgH); if (p != null) res.zeroDrift = { rateMgPerH: p, seMgPerH: null, durationS: null, source: 'user-estimate', observationIds: [], calibrationProfileId: pid }; }
  if (C.tempMode === 'typed') {
    const z = numOrNull(C.tempZero10K), s = numOrNull(C.tempSpanPpm);
    if (z != null || s != null) { const ref = numOrNull(C.tempRefC) != null ? numOrNull(C.tempRefC) : numOrNull(W.profile.temperatureC); res.temperature = { referenceC: ref, zeroMgPerK: (z || 0) / 10, zeroSe: null, spanPpmPerK: s || 0, spanSe: null, source: 'user-estimate', channelId: null, note: 'typed by the user (datasheet or own estimate)', calibrationProfileId: pid }; }
  } else if (C.tempChannelId) {
    const pts = []; for (const o of W.observations) { if (!isCalObs(o) || !o.include || !o.temperatures || !o.temperatures[C.tempChannelId]) continue; pts.push({ massMg: massOf(o.loadId), raw: o.rawMean, tempC: o.temperatures[C.tempChannelId].mean }); }
    if (pts.length) { const t = fitTemperatureSensitivity(pts); if (t.ok) res.temperature = { referenceC: t.referenceC, zeroMgPerK: t.zeroMgPerK, zeroSe: t.zeroSe, spanPpmPerK: t.spanPpmPerK, spanSe: t.spanSe, source: 'measured', channelId: C.tempChannelId, note: `regression of ${t.n} observations over ${t.rangeK.toFixed(1)} K`, calibrationProfileId: pid }; else notes.push('Temperature: ' + t.errors.join(' ')); }
  }
  const present = ['eccentricity', 'creep', 'zeroDrift', 'temperature'].filter(k => res[k]), srcs = present.map(k => res[k].source);
  res.status = !present.length ? 'none' : srcs.every(s => s === 'user-estimate') ? 'user-estimate' : (present.length === 4 && srcs.every(s => s === 'measured') ? 'measured' : 'partly measured');
  return res;
}
function charSummaryText(ch) {
  if (!ch || ch.status === 'none') return 'not characterized';
  const p = []; if (ch.eccentricity) p.push(`off-centre ${(ch.eccentricity.fractionOfLoad * 100).toFixed(2)} % of the load (${ch.eccentricity.source})`);
  if (ch.creep) p.push(`creep (${ch.creep.source})`); if (ch.zeroDrift) p.push(`zero drift ${fmtNumber(ch.zeroDrift.rateMgPerH, 2)} mg/h (${ch.zeroDrift.source})`);
  if (ch.temperature) p.push(`temperature (${ch.temperature.source})`); return `${ch.status}: ${p.join('; ')}`;
}
// ---- long recordings (creep, zero drift): samples are collected while they arrive, independent of the ring buffer ----------------------------
function charRecSample(t, raw, id) {
  const r = state.charRec; if (r.t0 == null) r.t0 = t; r.times.push(t); r.raws.push(raw); r.ids.push(Number.isFinite(id) ? id : NaN); r.count = r.times.length;
  if (t - r.t0 >= r.durationS * 1000 - PERIOD_MS / 2) charRecFinish();
}
function cancelCharRec(reason) {
  if (!state.charRec) return; state.charRec = null; wiz.capture = null; wiz.message = `Recording cancelled: ${reason}`;
  appendLogEntry({ type: 'note', entryId: `note-${Date.now()}`, createdAt: new Date().toISOString(), text: `Recording cancelled: ${reason}` });
  if (wiz.open) wizRender();
}
function charRecFinish() {
  const r = state.charRec; state.charRec = null; const n = r.times.length;
  const an = analyzeSeries(r.raws, r.times, { nominalMs: PERIOD_MS, counters: r.ids.every(Number.isFinite) ? r.ids : null }), status = charStatus(an, r.purpose), comp = compactAnalysis(an); comp.status = status;
  comp.note = (comp.note ? comp.note + '; ' : '') + 'for creep and zero-drift recordings only gaps, range, vibration and a step count (a slow change is what is measured)';
  const st = rawStats(r.raws), flagged = charRelevantChecks(an, r.purpose).filter(c => c.verdict === 'suspect' || c.verdict === 'invalid').map(c => c.label.split(' / ')[0]);
  const series = binSeries(r.times, r.raws, r.purpose === 'creep' ? Math.max(1, r.durationS / 400) : r.durationS / DRIFT_BLOCKS);
  const o = { observationId: wizNextObsId(), loadId: r.loadId, recordedAt: new Date().toISOString(), placementRunId: wiz.runId, placementIndex: wiz.observations.length + 1, removedAndReplaced: true, loadingDirection: null,
    rawMean: st.mean, rawStdDev: st.sd, rawMedian: st.median, rawMAD: st.mad, sampleCount: st.n, durationMs: r.times[n - 1] - r.times[0] + PERIOD_MS,
    validity: { status, flagged, analysis: comp }, include: status !== 'invalid', exclusionReason: status === 'invalid' ? 'validity check: invalid' : undefined, source: 'capture',
    purpose: r.purpose, position: null, series, settleS: r.settleS, temperatures: auxTemperaturesFor(activeSensor, r.times[0], r.times[n - 1]), recordedUnderRevision: state.revisionId };
  wiz.observations.push(o); wiz.capture = null;
  wiz.message = wizMode === 'simple' ? `Recorded: ${wizPlainVerdict(o.validity)}${o.include ? '' : ' (left out until you choose “include anyway”)'}.` : `Observation ${o.observationId} (${r.purpose}) recorded: ${n.toLocaleString()} samples, validity ${STATUS_TEXT[status] || status}${o.include ? '' : ' (excluded by default)'}.`;
  if (wiz.open) wizRender();
}
function wizRecordLong(purpose) {
  const why = wizBlock(); if (why) { wiz.message = why; wizRender(); return; }
  const C = wizChar(); let loadId, durationS, settleS = null;
  if (purpose === 'creep') { loadId = C.creepLoadId; durationS = clamp(Number(C.creepMin) || CREEP_MINUTES_DEFAULT, 1, CREEP_MINUTES_MAX) * 60; settleS = clamp(Number(C.creepSettleS) || CREEP_SETTLE_DEFAULT_S, 1, 120); }
  else { const e = wiz.loads.find(l => l.auto && l.weightRef === 'ref-empty'); loadId = e && e.loadId; durationS = clamp(Number(C.driftMin) || DRIFT_MINUTES_DEFAULT, 1, DRIFT_MINUTES_MAX) * 60; }
  if (!loadId) { wiz.message = purpose === 'creep' ? 'Choose the weight for the creep test.' : 'The empty platform is missing from the loads.'; wizRender(); return; }
  if (durationS * RATE_HZ > CHAR_MAX_SAMPLES) { wiz.message = `The recording would exceed ${CHAR_MAX_SAMPLES.toLocaleString()} samples at ${RATE_HZ} Hz; choose a shorter time.`; wizRender(); return; }
  state.charRec = { purpose, loadId, durationS, settleS, tag: 'calibration wizard', times: [], raws: [], ids: [], t0: null, count: 0 };
  wiz.capture = { loadId, target: Math.round(durationS * RATE_HZ), purpose };
  wiz.message = purpose === 'creep' ? `Recording the creep for ${(durationS / 60).toFixed(0)} min. Place the weight now and do not touch the platform.` : `Recording the empty platform for ${(durationS / 60).toFixed(0)} min. Nothing on the platform, do not touch it.`;
  wizRender();
}
// ---- panes ---------------------------------------------------------------------------------------------------------------------------
function wizTempChannels() { return attachedAux(sensors.get(wiz.sensorId) || activeSensor, 'temperature'); }
function wizCharEnsureDefaults() {
  const C = wizChar(), ms = wiz.loads.filter(l => l.components.length).map(l => ({ l, m: wizLoadMassSafe(l) })).filter(x => Number.isFinite(x.m) && x.m > 0);
  if (ms.length) {
    const cap = Math.max(...ms.map(x => x.m));
    if (!C.eccLoadId || !wiz.loads.some(l => l.loadId === C.eccLoadId)) C.eccLoadId = ms.reduce((a, b) => Math.abs(b.m - cap / 3) < Math.abs(a.m - cap / 3) ? b : a).l.loadId;
    if (!C.creepLoadId || !wiz.loads.some(l => l.loadId === C.creepLoadId)) C.creepLoadId = ms.reduce((a, b) => b.m > a.m ? b : a).l.loadId;
  }
  const ch = wizTempChannels(); if (!C.tempChannelId || !ch.some(c => c.id === C.tempChannelId)) C.tempChannelId = ch.length ? (primaryTempChannel(sensors.get(wiz.sensorId) || activeSensor) || ch[0]).id : null;
}
function wizCharResults() { const { fits } = wizFits(), fit = fits[wizActiveModel(fits)]; return fit && fit.ok ? buildCharacterization(wiz, fit) : null; }
function wizCharObsTable(purpose, simple) {
  const rows = wiz.observations.map((o, i) => {
    if (o.purpose !== purpose) return ''; const l = wiz.loads.find(x => x.loadId === o.loadId);
    const use = simple ? (o.include ? (o.override ? '<span class="warning">used anyway</span>' : 'used') : (o.validity && o.validity.status === 'invalid' ? `<button data-wa="inclAnyway" data-i="${i}" title="Use it although the check failed. This is recorded in the file.">include anyway</button>` : 'not used'))
      : `<input type="checkbox" data-w="obsInclude" data-i="${i}" ${o.include ? 'checked' : ''} aria-label="Use">${o.override ? '<div class="small warning">included anyway</div>' : ''}`;
    return `<tr class="${o.include ? '' : 'excl'}"><td>${esc(o.observationId)}</td><td>${esc(o.position || '')}</td><td>${esc(l ? l.name : '?')}</td><td>${fmtNumber(o.rawMean, 2)}</td><td>${o.sampleCount == null ? '—' : o.sampleCount.toLocaleString()}${o.durationMs ? ' · ' + fmtSpan(o.durationMs / 1000) : ''}</td><td>${simple ? esc(wizPlainVerdict(o.validity)) + (o.validity && o.validity.analysis ? wizValidityCell(o) : '') : wizValidityCell(o)}</td><td>${use}</td><td><button data-wa="delObs" data-i="${i}" aria-label="Delete">✕</button></td></tr>`;
  }).join('');
  return rows ? `<div class="tablewrap"><table class="wiz-table"><thead><tr><th>ID</th><th>Position</th><th>Load</th><th>Mean (counts)</th><th>n · time</th><th>Validity</th><th>Use</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="small">Nothing recorded yet.</div>';
}
function wizPaneChar(simple) {
  wizCharEnsureDefaults();
  const C = wizChar(), why = wizBlock(), busy = !!wiz.capture, res = wizCharResults(), u = wiz.profile.unit, us = unitById(u).symbol, dis = why || busy ? 'disabled' : '';
  const loadOpts = sel => wiz.loads.filter(l => l.components.length).map(l => `<option value="${esc(l.loadId)}"${l.loadId === sel ? ' selected' : ''}>${esc(l.name)} · ${wizMassText(wizLoadMassSafe(l), u)}</option>`).join('');
  const num = (f, v, extra = '') => `<input type="number" step="any" data-w="char" data-f="${f}" value="${esc(v == null ? '' : v)}" ${extra}>`;
  const none = res ? '' : '<div class="small warning">Finish the calibration observations first: the slope of the calibration is needed to turn counts into mass.</div>';
  const mgTxt = mg => `${fmtNumber(mgToUnit(mg, u), 4)} ${us}`;
  const e = res && res.eccentricity, c = res && res.creep, z = res && res.zeroDrift, t = res && res.temperature;
  const eccBtns = ECC_POSITIONS.map(p => `<button class="primary" data-wa="recordChar" data-purpose="eccentricity" data-pos="${p}" ${dis}>● ${p} (${wiz.observations.filter(o => o.purpose === 'eccentricity' && o.position === p).length})</button>`).join('');
  const eccRes = e ? `<div class="status-note">${e.source === 'measured' ? `Largest change when the weight is off-centre: <strong>${mgTxt(e.maxAbsDevMg)}</strong> = <strong>${(e.fractionOfLoad * 100).toFixed(3)} %</strong> of the test weight (${esc(e.positions.map(p => `${p.name} ${p.devMg >= 0 ? '+' : ''}${fmtNumber(mgToUnit(p.devMg, u), 4)}`).join(', '))} ${esc(us)}).` : `Your estimate: <strong>${(e.fractionOfLoad * 100).toFixed(3)} %</strong> of the load.`} <span class="small">(${esc(e.source)})</span></div>` : '';
  const creepRes = c ? `<div class="status-note">${c.source === 'measured' ? `Creep after ${esc(c.samples.map(s => `${s.tS} s: ${(s.fraction * 100).toFixed(3)} %`).join(', '))} of the load change (settle time ${c.settleS} s).` : `Your estimate: ${(c.samples[0].fraction * 100).toFixed(3)} % after 1 min.`} <span class="small">(${esc(c.source)})</span></div>` : '';
  const driftRes = z ? `<div class="status-note">Zero drift: <strong>${fmtNumber(z.rateMgPerH, 2)} mg/h</strong>${z.seMgPerH != null ? ` ± ${fmtNumber(z.seMgPerH, 2)}` : ''}${z.durationS ? ` over ${fmtSpan(z.durationS)}` : ''}. <span class="small">(${esc(z.source)})</span></div>` : '';
  const chans = wizTempChannels(), tf = fitTemperatureSensitivity(wizCalObs(wiz).filter(o => o.include && o.temperatures && C.tempChannelId && o.temperatures[C.tempChannelId]).map(o => ({ massMg: wizLoadMassSafe(wiz.loads.find(l => l.loadId === o.loadId) || { components: [] }), raw: o.rawMean, tempC: o.temperatures[C.tempChannelId].mean })));
  const tempRes = t ? `<div class="status-note">Temperature: zero shift <strong>${fmtNumber(t.zeroMgPerK, 3)} mg/K</strong>${t.zeroSe != null ? ` ± ${fmtNumber(t.zeroSe, 3)}` : ''}, span <strong>${fmtNumber(t.spanPpmPerK, 1)} ppm/K</strong>${t.spanSe != null ? ` ± ${fmtNumber(t.spanSe, 1)}` : ''}${t.referenceC != null ? ` · reference ${fmtNumber(t.referenceC, 1)} °C` : ''} <span class="small">(${esc(t.source)}; ${esc(t.note)})</span></div>` : (C.tempMode === 'auto' ? `<div class="small">${chans.length ? esc(tf.ok ? '' : tf.errors[0]) : 'No temperature channel is attached to this sensor. Type your own estimate instead.'}</div>` : '');
  const typed = `<div class="control-grid"><div class="field"><label>Zero shift (${esc(us)} per 10 K)</label>${num('tempZero10K', C.tempZero10K)}</div><div class="field"><label>Span change (ppm per K)</label>${num('tempSpanPpm', C.tempSpanPpm)}</div><div class="field"><label>Reference temperature (°C)</label>${num('tempRefC', C.tempRefC)}</div></div>`;
  const notes = res && res.notes.length ? res.notes.map(n => `<div class="small warning">⚠ ${esc(n)}</div>`).join('') : '';
  const head = (a, b) => `<h3 style="margin:14px 0 4px">${simple ? a : b}</h3>`;
  const rec = '<progress id="wizRecBar" max="1" value="0" ' + (busy ? '' : 'hidden') + '></progress><div class="small" id="wizRecProgress">' + (why ? esc(why) : '') + '</div>';
  const cancel = busy ? '<div class="button-row"><button data-wa="cancelRec">Cancel recording</button></div>' : '';
  return `<div class="small">${simple ? 'Optional extra checks. Each one makes the estimated uncertainty more complete; skip any of them. Nothing here changes the calibration curve.' : 'Characterization tests are stored as observations with a purpose and never enter the calibration fit. They feed the off-centre, creep, zero-drift and temperature components of the uncertainty.'}</div>${none}${notes}
  ${head('Extra check 1 of 3 · Off-centre loading', 'Eccentricity (off-centre loading)')}
  <div class="small">${simple ? 'How much does the reading change if you put the weight off-centre? Use one weight of about a third of the maximum load. Put it in the centre first, then near each of the four edges. Take it off and put it back before every recording.' : 'One weight of about a third of capacity: centre, then four edge positions. Deviation = (counts − centre counts) / slope; fraction of load = largest |deviation| / test mass.'}</div>
  <div class="field"><label>Test weight</label><select data-w="char" data-f="eccLoadId">${loadOpts(C.eccLoadId)}</select></div><div class="button-row">${eccBtns}</div>${wizCharObsTable('eccentricity', simple)}${eccRes}
  ${simple ? '' : `<div class="field"><label>or your own estimate: largest change when off-centre (% of the load)</label>${num('eccPct', C.eccPct, 'min="0"')}</div>`}
  ${head('Extra check 2 of 3 · Creep', 'Creep')}
  <div class="small">${simple ? 'Does the reading keep creeping after a weight is placed? Place the weight and press Record at once; leave it for the chosen time.' : 'Place a weight, record for N minutes. fraction(t) = (r(t) − r(settle)) / (r(settle) − r_empty) at 30 s, 1 min, 2 min, 5 min … (those that fit). The empty-platform observation of the calibration is the reference.'}</div>
  <div class="control-grid"><div class="field"><label>Weight</label><select data-w="char" data-f="creepLoadId">${loadOpts(C.creepLoadId)}</select></div><div class="field"><label>Recording time (min, up to ${CREEP_MINUTES_MAX})</label>${num('creepMin', C.creepMin, 'min="1"')}</div>${simple ? '' : `<div class="field"><label>Settle time (s)</label>${num('creepSettleS', C.creepSettleS, 'min="1"')}</div>`}</div>
  <div class="button-row"><button class="primary" data-wa="recordLong" data-purpose="creep" ${dis}>● Record creep</button></div>${wizCharObsTable('creep', simple)}${creepRes}
  ${simple ? '' : `<div class="field"><label>or your own estimate: creep after 1 min (% of the load)</label>${num('creepPct', C.creepPct)}</div>`}
  ${head('Extra check 3 of 3 · Zero drift', 'Zero drift')}
  <div class="small">${simple ? 'Does the empty scale drift? Clear the platform completely and record. A step (something touched it) makes the recording unusable.' : 'Empty platform for N minutes; weighted straight-line fit of the block means gives the rate ± its standard error in mg/h.'}</div>
  <div class="control-grid"><div class="field"><label>Recording time (min, up to ${DRIFT_MINUTES_MAX})</label>${num('driftMin', C.driftMin, 'min="1"')}</div></div>
  <div class="button-row"><button class="primary" data-wa="recordLong" data-purpose="zero-drift" ${dis}>● Record the empty platform</button></div>${wizCharObsTable('zero-drift', simple)}${driftRes}
  ${simple ? '' : `<div class="field"><label>or your own estimate: zero drift (${esc(us)} per hour, mg/h)</label>${num('driftMgH', C.driftMgH)}</div>`}
  ${cancel}${rec}
  ${simple ? `<details style="margin-top:10px"><summary>Temperature (optional, not a step)</summary><div class="small" style="margin:6px 0">${chans.length ? 'A temperature sensor is attached: if the calibration observations were taken at temperatures at least ' + TEMP_FIT_MIN_RANGE_K + ' K apart, the sensitivity is measured automatically. Otherwise type your own estimate (data sheet):' : 'No temperature sensor is attached. If you know the sensitivity (data sheet), type it:'}</div>${typed}${tempRes}</details>`
  : `${head('', 'Temperature sensitivity')}<div class="small">With a sensor: the calibration observations carry their mean temperature (automatically); at least ${TEMP_FIT_MIN_RANGE_K} K range is needed. Without: type your own estimate (source “user-estimate”). Temperature correction of the readings is not done; it only enters the uncertainty.</div><div class="control-grid"><div class="field"><label>Source</label><select data-w="char" data-f="tempMode"><option value="auto"${C.tempMode === 'auto' ? ' selected' : ''}>measured with a temperature channel</option><option value="typed"${C.tempMode === 'typed' ? ' selected' : ''}>typed by me (user estimate)</option></select></div><div class="field"><label>Temperature channel</label><select data-w="char" data-f="tempChannelId">${chans.map(ch => `<option value="${esc(ch.id)}"${ch.id === C.tempChannelId ? ' selected' : ''}>${esc(ch.name)}</option>`).join('') || '<option value="">none attached</option>'}</select></div></div>${typed}${tempRes}`}
  <div class="readout" style="margin-top:10px">Characterization: <strong>${esc(charSummaryText(res))}</strong></div>`;
}

// uPlot is pinned to one exact version (reproducible builds; no surprise breaking changes). To
// upgrade, change only this constant. 1.6.32 is the newest release verified at build time.
const UPLOT_VERSION='1.6.32';
function localUPlotAssets(){
  if(!deviceFiles||!Array.isArray(deviceFiles.files))return null;
  const f=deviceFiles.files.filter(x=>x.kind==='asset'&&/uplot/i.test(String(x.path||''))),js=f.find(x=>/\.js$/i.test(x.path)),css=f.find(x=>/\.css$/i.test(x.path));
  return js?{js:js.path,css:css?css.path:null}:null;
}
// The ESP serves uPlot itself (an asset listed by /api/files); the jsDelivr CDN is only the fallback for development and testing.
function loadUPlotAsync(){return new Promise((resolve,reject)=>{
  if(window.uPlot){resolve();return;}
  const add=(js,cssHref,onFail)=>{
    if(cssHref){const css=document.createElement('link');css.rel='stylesheet';css.href=cssHref;document.head.appendChild(css);}
    const script=document.createElement('script');script.src=js;script.async=true;script.onload=()=>resolve();script.onerror=onFail;document.head.appendChild(script);
  };
  const cdn=()=>{const base=`https://cdn.jsdelivr.net/npm/uplot@${UPLOT_VERSION}/dist/`;add(base+'uPlot.iife.min.js',base+'uPlot.min.css',()=>reject(new Error('Unable to load uPlot from the device or from jsDelivr.')));};
  const loc=localUPlotAssets();if(loc)add(loc.js,loc.css,cdn);else cdn();
});}
let uplotStarted=false;
function startUPlot(){
  if(uplotStarted)return;uplotStarted=true;
  requestAnimationFrame(()=>requestAnimationFrame(()=>loadUPlotAsync().then(()=>{chartsPending=false;createCharts();updateStatusUI();scheduleRender();}).catch(error=>{$('statusText').textContent='Chart library unavailable';$('mainChart').innerHTML='<p class="warning">uPlot could not be loaded (not served by the device, and the CDN is not reachable). Reload the page.</p>';console.error(error);})));
}
async function boot(){
  populateSettings();initEvents();setNavPanelVisible(false);syncUIFromState();initSettingsMenu();initWizard();initUiSettings();$('sensorReloadBtn').disabled=true;setSensorListInfo('Looking for the device…');
  // The revision id is computed BEFORE acquisition starts, so no sample or tare event can be stamped with the placeholder revision id.
  embeddedFp=await fingerprintConfig(EMBEDDED_CALIBRATION);
  initSensorCalibration(testSensor.state,embeddedFp);testSensor.state.paused=true;
  updateCalibrationInfo();updateEstimatorFields();syncMeasurementInputs('samples');updateMeasurementUI();updateStatusUI();
  tickTimer=setInterval(tick,PERIOD_MS);setInterval(housekeeping,500);setInterval(statusTimer,3000);
  // Display the shell and start acquisition first; the device is asked in the background (protocol startup order), uPlot is loaded as soon as /api/files told where it lives.
  deviceStartup().catch(error=>{console.error(error);startupHold=false;}).finally(()=>{if(typeof fetch==='undefined'||!deviceReachable){const el=$('sensorListInfo');if(el&&/Looking/.test(el.textContent))setSensorListInfo('No device reachable. Only the test signal is available.');}startUPlot();});
}
boot();
