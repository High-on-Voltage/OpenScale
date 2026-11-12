// Headless audit harness: loads the REAL inline <script> of a workbench HTML file into a
// vm context with a minimal DOM stub (no browser, no uPlot, no timers) and probes the
// numerical / calibration / estimator logic. Rendering, pointer and touch code is NOT covered.
const fs = require('fs'), vm = require('vm');
const file = process.argv[2];
const html = fs.readFileSync(file, 'utf8');
const json = id => html.match(new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`))[1];
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const code = scripts[scripts.length - 1][1];

async function load() {
  const els = {}; const ctxRef = {};
  const mk = () => ({style:{}, classList:{toggle(){},add(){},remove(){}}, children:[], value:'', checked:false, textContent:'', innerHTML:'', hidden:false,
    dataset:{}, min:0, max:0, step:0, disabled:false, clientWidth:800, addEventListener(){}, setAttribute(){}, appendChild(){}, remove(){}, click(){},
    getBoundingClientRect(){return {left:0,width:100};}, closest(){return null;}, dispatchEvent(){}});
  const document = {getElementById:id=>els[id]||(els[id]=Object.assign(mk(),
      id==='unitConfig'?{textContent:json('unitConfig')}:id==='calibrationConfig'?{textContent:json('calibrationConfig')}:{})),
    createElement:()=>mk(), documentElement:mk(), addEventListener(){}, body:mk(), head:mk()};
  const ctx = vm.createContext({document, window:{addEventListener(){}}, navigator:{language:'en-US'}, crypto:require('crypto').webcrypto,
    setInterval:()=>0, setTimeout:(f,ms)=>setTimeout(f,ms), clearTimeout(){}, requestAnimationFrame(){}, performance:{now:()=>ctxRef.__now||0}, console, Intl, TextEncoder, URL, Blob});
  ctx.globalThis = ctx; Object.defineProperty(ctxRef,'__now',{get:()=>ctx.__now,set:v=>{ctx.__now=v}});
  vm.runInContext(code, ctx);
  for (let i=0;i<200 && vm.runInContext('state.revisionId',ctx)==='embedded-demo-v1';i++) await new Promise(r=>setTimeout(r,5));
  return src => vm.runInContext(src, ctx);
}
let fails = 0;
const ok = (name, cond, info='') => { if(!cond) fails++; console.log(`${cond?'PASS':'FAIL'}  ${name}${info?'  — '+info:''}`); };
const near = (a,b,rel=1e-9,abs=1e-9) => Math.abs(a-b) <= Math.max(abs, rel*Math.abs(b));

(async () => {
  console.log('== '+file);
  let R = await load();
  // T1 calibration maths on a kinked curve (the demo curve is exactly linear, so it cannot exercise this)
  const cfg = `(()=>{const c=JSON.parse(JSON.stringify(CALIBRATION));c.calibrationUnit='mg';
    c.calibrationAnchors=[{anchorId:'a',rawMean:0,referenceValue:0,referenceUnit:'mg'},{anchorId:'b',rawMean:100,referenceValue:1000,referenceUnit:'mg'},{anchorId:'c',rawMean:200,referenceValue:3000,referenceUnit:'mg'}];
    return prepareCalibration(c);})()`;
  ok('T1 interpolation inside range', R(`calibrateAbsolute(150,${cfg}).valueMg`)===2000);
  ok('T1 extrapolation high + flag', R(`JSON.stringify(calibrateAbsolute(250,${cfg}))`).includes('"valueMg":4000') && R(`calibrateAbsolute(250,${cfg}).outOfRange`));
  ok('T1 extrapolation low + flag', R(`calibrateAbsolute(-50,${cfg}).valueMg`)===-500 && R(`calibrateAbsolute(-50,${cfg}).outOfRange`));
  ok('T1 anchor exact, in range', R(`calibrateAbsolute(100,${cfg}).valueMg`)===1000 && !R(`calibrateAbsolute(100,${cfg}).outOfRange`));
  // T1b order of operations: f(mean raw) != mean f(raw) on a kinked curve (documents WHY the pipeline is per-sample)
  ok('T1b kink: mean(f(raw)) differs from f(mean(raw))', R(`(calibrateAbsolute(50,${cfg}).valueMg+calibrateAbsolute(150,${cfg}).valueMg)/2`)===1250 && R(`calibrateAbsolute(100,${cfg}).valueMg`)===1000);
  // T2 units
  ok('T2 kg round trip', R(`mgToUnit(massToMg(2.5,'kg'),'kg')`)===2.5);
  ok('T2 lb_av = 453.59237 g', near(R(`massToMg(1,'lb_av')`),453592.37));
  ok('T2 oz_av = 28.349523125 g', near(R(`massToMg(1,'oz_av')`),28349.523125));
  ok('T2 troy oz = 31.1034768 g', near(R(`massToMg(1,'oz_troy')`),31103.4768));
  ok('T2 stone = 14 lb', near(R(`massToMg(1,'st')`),14*453592.37,1e-8));
  ok('T2 raw is not a mass unit', R(`(()=>{try{massToMg(1,'raw');return false}catch(e){return true}})()`));
  // T3 rolling statistics vs brute force, with ring wrap and a tare boundary
  R = await load();
  R(`resizeBuffers(1000); state.window=state.activeWindow=80; for(let i=0;i<1500;i++) appendSample(nextSensorValue());
     autoTare(); for(let i=0;i<150;i++) appendSample(nextSensorValue());`);
  const brute = R(`(()=>{const e=state.tareEvents[0];let k=0;while(k<state.count&&tareEventAt(getTime(state.count-1-k))===e)k++;
    const n=Math.min(80,k),v=[],r=[];for(let j=state.count-n;j<state.count;j++){v.push(getNetMg(j));r.push(getRaw(j));}
    const m=a=>a.reduce((s,x)=>s+x,0)/a.length,sd=a=>{const mu=m(a);return Math.sqrt(a.reduce((s,x)=>s+(x-mu)**2,0)/a.length)};
    const L=state.count-1;return {n,maE:getMassMA(L)-m(v),sdE:getMassSD(L)-sd(v),maRef:m(v),sdRef:sd(v),rmaE:getRawMA(L)-m(r),rsdE:getRawSD(L)-sd(r)}})()`);
  ok('T3 mass MA matches brute force (wrap + tare epoch)', near(brute.maE,0,1e-9,1e-6), JSON.stringify(brute));
  ok('T3 mass SD matches brute force', near(brute.sdE,0,1e-6,1e-4));
  ok('T3 raw MA/SD match brute force', near(brute.rmaE,0,1e-9,1e-9) && near(brute.rsdE,0,1e-6,1e-6));
  // T4 tare is an event: earlier net values unchanged
  R = await load();
  R(`for(let i=0;i<300;i++) appendSample(nextSensorValue());`);
  const before = R(`getNetMg(100)`); R(`autoTare(); for(let i=0;i<5;i++) appendSample(5000);`);
  ok('T4 tare does not rewrite earlier samples', R(`getNetMg(100)`)===before);
  ok('T4 tare applies from next sample', R(`getNetMg(state.count-1)===getMassMg(state.count-1)-state.tareEvents[0].tareMassMg`));
  // T5 estimators
  R = await load();
  const est = (m,v)=>JSON.parse(R(`JSON.stringify(estimate(${JSON.stringify(v)},[],'${m}',{trimPercent:10}))`));
  const tied=[5,5,5,5,5,5,5.4,5,5,5,9];
  const h=est('hampel',tied);
  console.log('     hampel on tied data (MAD=0):', JSON.stringify(h));
  ok('T5 hampel with MAD=0 keeps the near-median 5.4 sample (scale floor)', h.rejected<=1, 'rejected='+h.rejected+' (only the 9 should go)');
  ok('T5 median even n', est('median',[1,2,3,4]).value===2.5);
  ok('T5 trimmed 10%/tail of 10 removes 1+1', est('trimmed',[1,2,3,4,5,6,7,8,9,100]).rejected===2 && est('trimmed',[1,2,3,4,5,6,7,8,9,100]).value===5.5);
  // T6 numerical hazard: large offset, tiny noise (raw counts near Int32 max)
  R = await load();
  R(`resizeBuffers(1000); state.window=state.activeWindow=80; let s=0; for(let i=0;i<400;i++){s=(s*1103515245+12345)%2147483648; appendSample(2000000000+(s%7)-3);}`);
  const num = R(`(()=>{const v=[],L=state.count-1;for(let j=L-79;j<=L;j++)v.push(getRaw(j));const m=v.reduce((a,b)=>a+b,0)/80;return {ref:Math.sqrt(v.reduce((a,b)=>a+(b-m)**2,0)/80),got:getRawSD(L),massGot:getMassSD(L)}})()`);
  ok('T6 raw rolling SD survives 2e9 offset', near(num.got,num.ref,1e-6,1e-6), JSON.stringify(num));
  ok('T6 mass rolling SD survives 5e11 mg offset (expected SD = 250 mg/count * raw SD)', near(num.massGot,num.ref*250,1e-4,1e-3), 'massSD='+num.massGot);
  // T7 calibration validation
  R = await load();
  const bad = `(()=>{const c=JSON.parse(JSON.stringify(CALIBRATION));c.calibrationAnchors[1].referenceValue=300;try{prepareCalibration(c);return 'accepted'}catch(e){return 'rejected'}})()`;
  ok('T7b anchor with Infinity raw is rejected', R(`(()=>{const c=JSON.parse(JSON.stringify(CALIBRATION));c.calibrationAnchors[2].rawMean=1e999;try{prepareCalibration(c);return false}catch(e){return true}})()`));
  ok('T7 non-monotonic mass response is rejected', R(bad)==='rejected', 'result='+R(bad));
  // T8 selection streaming vs brute force
  R = await load();
  R(`for(let i=0;i<5000;i++) appendSample(nextSensorValue());`);
  const sel = JSON.parse(R(`(()=>{const s=calculateSelection(1000,4000,{estimator:'mean'});let a=0,b=0;for(let i=1000;i<4000;i++){const x=getNetMg(i);a+=x;}a/=3000;for(let i=1000;i<4000;i++){b+=(getNetMg(i)-a)**2;}
    return JSON.stringify({mean:s.originalValueMg-a,sd:s.spreadMg-Math.sqrt(b/3000)})})()`));
  ok('T8 selection mean/SD match brute force', near(sel.mean,0,1e-9,1e-6) && near(sel.sd,0,1e-6,1e-4), JSON.stringify(sel));
  // T9 revision hash is deterministic and key-order independent (only meaningful once canonicalised)

  // ---- v8 tests -------------------------------------------------------------------------------
  const net = (R,a,b)=>R(`(()=>{let s=0;for(let i=${a};i<${b};i++)s+=getNetMg(i);return s/(${b}-${a})})()`);
  // T10 unified window: panel statistics only use the current tare epoch
  R = await load();
  R(`state.window=state.activeWindow=80; for(let i=0;i<500;i++) appendSample(nextSensorValue()); autoTare(); for(let i=0;i<20;i++) appendSample(nextSensorValue()); updateMetrics();`);
  ok('T10 panel window is limited to the current tare epoch', R(`$('currentValueDetail').textContent`).includes('20 samples'), R(`$('currentValueDetail').textContent`));
  ok('T10 panel value = mean of the 20 post-tare net samples', near(R(`getMassMA(state.count-1)`), net(R,R(`state.count`)-20,R(`state.count`)),1e-9,1e-6));
  // T11 measurement: collects the NEXT N samples, reuses the selection maths, logs, highlights
  R = await load();
  R(`for(let i=0;i<100;i++) appendSample(nextSensorValue()); $('measSamples').value=400; startMeasurement();`);
  ok('T11 measurement running after start', R(`state.measurement!==null&&state.measurement.collected===0`));
  R(`for(let i=0;i<399;i++) appendSample(nextSensorValue());`);
  ok('T11 still running at 399/400', R(`state.measurement&&state.measurement.collected===399`));
  R(`appendSample(nextSensorValue());`);
  const mres = JSON.parse(R(`JSON.stringify({done:state.measurement===null,n:state.lastMeasurement.totalSamples,first:state.lastMeasurement.firstIndex,v:state.lastMeasurement.originalValueMg,log:state.logs[0].type,hl:state.highlight&&state.highlight.t0===state.lastMeasurement.t0&&state.highlight.t1===state.lastMeasurement.t1,sec:state.lastMeasurement.nominalDurationS})`));
  ok('T11 measurement finished with exactly 400 samples starting after the press', mres.done&&mres.n===400&&mres.first===100, JSON.stringify(mres));
  ok('T11 result equals brute-force mean of those samples', near(mres.v, net(R,100,500),1e-9,1e-6));
  ok('T11 logged as measurement; highlight = measured samples; nominal 5 s', mres.log==='measurement'&&mres.hl&&mres.sec===5);
  // T12 tare aborts a running measurement
  R = await load();
  R(`for(let i=0;i<100;i++) appendSample(nextSensorValue()); $('measSamples').value=400; startMeasurement(); for(let i=0;i<10;i++) appendSample(nextSensorValue()); autoTare();`);
  ok('T12 tare cancels a running measurement and logs a note', R(`state.measurement===null&&state.highlight===null&&state.logs.some(e=>e.type==='note'&&/tare/.test(e.text))`));
  // T13 selection crossing a tare boundary is flagged
  R = await load();
  R(`for(let i=0;i<200;i++) appendSample(nextSensorValue()); autoTare(); for(let i=0;i<200;i++) appendSample(nextSensorValue());`);
  ok('T13 selection across a tare is flagged', R(`calculateSelection(100,300).crossesTare===true`));
  ok('T13 selection inside one epoch is not flagged', R(`calculateSelection(250,300).crossesTare===false`));
  // T14 auto-tare records out-of-range samples
  R = await load();
  R(`for(let i=0;i<50;i++) appendSample(4000); autoTare();`);
  ok('T14 auto-tare stores the out-of-range count', R(`state.tareEvents[0].outOfRangeCount`)===50);
  // T15 calibration import: validation
  R = await load();
  const mod = f => `(()=>{const c=JSON.parse(JSON.stringify(CALIBRATION));${f};return validateCalibrationConfig(c).errors.length})()`;
  ok('T15 valid embedded profile passes validation', R(mod(''))===0);
  ok('T15 non-monotonic mass rejected', R(mod('c.calibrationAnchors[1].referenceValue=300'))>0);
  ok('T15 duplicate anchorId rejected', R(mod("c.calibrationAnchors[1].anchorId='anchor-000'"))>0);
  ok('T15 unknown observation reference rejected', R(mod("c.calibrationAnchors[0].sourceObservationIds=['nope']"))>0);
  ok('T15 unknown unit rejected', R(mod("c.calibrationUnit='furlong'"))>0);
  ok('T15 raw is not a calibration unit', R(mod("c.calibrationUnit='raw'"))>0);
  ok('T15 non-object top level rejected', R(`validateCalibrationConfig([1,2]).errors.length`)>0);
  // T16 calibration switch: new epoch, old samples keep their recorded calibration
  R = await load();
  R(`for(let i=0;i<100;i++) appendSample(5000);`);
  const oldMass = R(`getMassMg(50)`), oldRev = R(`state.revisionId`);
  const sw = await R(`(async()=>{const c=JSON.parse(JSON.stringify(CALIBRATION));c.profileId='half-scale';c.profileName='<b>half</b>';for(const a of c.calibrationAnchors)a.referenceValue/=2;const r=await activateCalibration(c,'test');return JSON.stringify({err:r.errors.length})})()`);
  R(`for(let i=0;i<100;i++) appendSample(5000);`);
  ok('T16 switch accepted', JSON.parse(sw).err===0);
  ok('T16 earlier samples are NOT recomputed', R(`getMassMg(50)`)===oldMass);
  ok('T16 new samples use the new calibration (half scale)', near(R(`getMassMg(150)`), oldMass/2, 1e-12, 1e-6));
  ok('T16 calibrationAt returns the recorded revision per sample', R(`calibrationAt(getTime(50)).revisionId`)===oldRev && R(`calibrationAt(getTime(150)).revisionId`)===R(`state.revisionId`) && oldRev!==R(`state.revisionId`));
  ok('T16 tare was reset at the switch', R(`currentTareEvent().method`).includes('calibration changed') && R(`currentTareMassMg()`)===0);
  ok('T16 selection across the switch is flagged', R(`(()=>{const s=calculateSelection(50,150);return s.crossesCalibration&&s.calibrationChanged&&s.crossesTare})()`));
  ok('T16 calibration info escapes untrusted text', !R(`$('calibrationInfo').innerHTML`).includes('<b>half</b>') && R(`$('calibrationInfo').innerHTML`).includes('&lt;b&gt;'));
  ok('T16 re-activating the same calibration is a no-op', (await R(`(async()=>{const r=await activateCalibration(JSON.parse(JSON.stringify(CALIBRATION)),'again');return r.unchanged===true&&state.calibrations.length===2})()`)));
  // T17 CSV provenance per row (calibration revision as recorded)
  R(`Blob=class{constructor(p){this.parts=p}}; downloadBlob=(b)=>{globalThis.__csv=b.parts.join('')}; exportCSV();`);
  const csv = R(`__csv`).trim().split('\n'); const cols = csv[0].split(',').length;
  ok('T17 CSV: 11 columns, one row per sample', cols===11 && csv.length===R(`state.count`)+1 && csv.every(r=>r.split(',').length===cols));
  ok('T17 CSV: revision column follows the sample, not the active calibration', csv[1].split(',')[9]===oldRev && csv[csv.length-1].split(',')[9]===R(`state.revisionId`));
  // T18 periodic exact refresh keeps the rolling statistics exact over long runs
  R = await load();
  R(`resizeBuffers(1000); state.window=state.activeWindow=80; for(let i=0;i<30000;i++) appendSample(nextSensorValue());`);
  const lr = JSON.parse(R(`(()=>{const L=state.count-1,v=[];for(let j=L-79;j<=L;j++)v.push(getNetMg(j));const m=v.reduce((a,b)=>a+b,0)/80;return JSON.stringify({ma:getMassMA(L)-m,sd:getMassSD(L)-Math.sqrt(v.reduce((a,b)=>a+(b-m)**2,0)/80)})})()`));
  ok('T18 rolling MA/SD exact after 30,000 samples (3 refreshes)', near(lr.ma,0,1e-9,1e-6)&&near(lr.sd,0,1e-6,1e-4), JSON.stringify(lr));
  // T19 simulator pacing follows wall-clock time
  R = await load();
  R(`__now=1000; tick();`); ok('T19 first tick only sets the baseline', R(`state.count`)===0);
  R(`__now=2000; tick();`); ok('T19 1.000 s of wall-clock = 80 samples (even if ticks were delayed)', R(`state.count`)===80);
  R(`__now=2000+12500; tick();`);
  ok('T19 long stall: at most 400 samples, the rest becomes a timestamp gap', R(`state.count`)===480 && near(R(`newestTime()`),(80+1000)*12.5-12.5,1e-12,1e-9), 'count='+R(`state.count`)+' newest='+R(`newestTime()`));
  R(`state.paused=true; __now+=5000; tick();`); ok('T19 paused: no samples', R(`state.count`)===480);
  // T20 settings placeholder / duplicate controls removed
  ok('T20 removed controls are really gone from the markup', !/id="(maToggle|spreadToggle|applySettingsBtn|estimatorWindow|latestValue)"/.test(html));
  ok('T20 grams default to 3 decimals', R(`unitById('g').decimals`)===3);
  ok('T20 uPlot pinned to one version constant, no stale URLs', /const UPLOT_VERSION='1\.6\.32'/.test(html) && !/uplot@1\.6\.30/.test(html));

  // ---- v9 tests -------------------------------------------------------------------------------
  const E = (R,vals,m,o={})=>JSON.parse(R(`JSON.stringify(estimate(${JSON.stringify(vals)},${JSON.stringify(o.times||[])},'${m}',${JSON.stringify(o)}))`));
  R = await load();
  const d5=[1,2,3,4,100];
  ok('T21 median -> sigma = 1.4826 x MAD', near(E(R,d5,'median').sigma,1.4826,1e-12));
  ok('T21 trimmed -> SD of retained samples', near(E(R,d5,'trimmed',{trimPercent:20}).sigma,Math.sqrt(2/3),1e-12) && E(R,d5,'trimmed',{trimPercent:20}).value===3);
  ok('T21 hampel -> SD of kept samples (outlier rejected)', near(E(R,d5,'hampel').sigma,Math.sqrt(1.25),1e-12) && E(R,d5,'hampel').rejected===1);
  ok('T21 mean -> population SD', near(E(R,d5,'mean').sigma,R(`calculateStd([1,2,3,4,100])`),1e-12));
  const t=[0,12.5,25,37.5,50]; const em=E(R,[0,10,10,10,10],'ema',{tau:.05,times:t});
  ok('T21 ema -> value unchanged vs v8 recursion; exponentially weighted SD is finite and > 0', em.sigma>0 && Number.isFinite(em.sigma) && em.value>0 && em.value<10, JSON.stringify(em));
  ok('T21 median sigma falls back when MAD = 0 (tied data)', E(R,[5,5,5,5,5,5,5.4,5,5,9],'median').sigma>0);
  // T22 chart curve = per-sample estimator values, never across a tare epoch
  R = await load();
  R(`state.window=state.activeWindow=40; for(let i=0;i<300;i++) appendSample(nextSensorValue()); autoTare(); for(let i=0;i<200;i++) appendSample(nextSensorValue());
     state.estimator='median'; state.live=false; state.viewMin=getTime(250); state.viewMax=newestTime();`);
  const cv = JSON.parse(R(`(()=>{const [lo,hi]=visibleIndices(),d=buildVisibleData(),res=[];
     for(const i of [lo+3,lo+20,305,hi-30,hi]){const a=Math.max(i-39,i>=300?300:0),v=[];for(let j=a;j<=i;j++)v.push(getNetMg(j));const r=estimate(v,[],'median',{});
       const k=i-lo;res.push({c:d[2][k]-mgToUnit(r.value,state.unitId),u:d[3][k]-mgToUnit(r.value+r.sigma,state.unitId),l:d[4][k]-mgToUnit(r.value-r.sigma,state.unitId),i});}
     return JSON.stringify({res,len:d[0].length,n:hi-lo+1,stride:state.curveStride})})()`));
  ok('T22 median centre and +-sigma band equal the direct estimator (incl. truncated window after a tare)', cv.res.every(x=>near(x.c,0,1e-12,1e-9)&&near(x.u,0,1e-12,1e-9)&&near(x.l,0,1e-12,1e-9)) && cv.len===cv.n && cv.stride===1, JSON.stringify(cv.res.slice(0,2)));
  // T22b sparse evaluation + interpolation
  const sp = JSON.parse(R(`(()=>{state.window=state.activeWindow=1000; const lo=0,hi=state.count-1;const c=buildEstimatorCurve(lo,hi,false);
     const stride=c.stride;let aligned=-1;for(let i=1;i<hi;i++)if(absIndex(i)%stride===0){aligned=i;break;}
     const direct=i=>{const a=Math.max(i-999,i>=300?300:0),v=[];for(let j=a;j<=i;j++)v.push(getNetMg(j));return estimate(v,[],'median',{}).value;};
     const nodeErr=c.center(aligned)-direct(aligned);
     const n1=aligned,n2=aligned+stride,mid=n1+Math.floor(stride/2);const lin=direct(n1)+(mid-n1)/(n2-n1)*(direct(n2)-direct(n1));
     return JSON.stringify({stride,nodeErr,interpErr:c.center(mid)-lin,endErr:c.center(hi)-direct(hi)})})()`));
  ok('T22b sparse grid: stride>1 when many samples are visible', sp.stride>1, 'stride='+sp.stride);
  ok('T22b grid nodes are exact, in-between points are linear interpolations, endpoints exact', near(sp.nodeErr,0,1e-12,1e-9)&&near(sp.interpErr,0,1e-12,1e-9)&&near(sp.endErr,0,1e-12,1e-9), JSON.stringify(sp));
  // T23 EMA curve = estimator EMA over the tare epoch
  R(`state.window=state.activeWindow=40; state.estimator='ema'; state.emaTau=0.5;`);
  const ec = JSON.parse(R(`(()=>{const hi=state.count-1,c=buildEstimatorCurve(hi,hi,false),v=[],t=[];for(let j=300;j<=hi;j++){v.push(getNetMg(j));t.push(getTime(j));}
     const r=estimate(v,t,'ema',{tau:.5});return JSON.stringify({dc:c.center(hi)-r.value,ds:c.sigma(hi)-r.sigma,s:r.sigma})})()`));
  ok('T23 EMA curve value and EW sigma equal the estimator over the tare epoch', near(ec.dc,0,1e-12,1e-9)&&near(ec.ds,0,1e-12,1e-9)&&ec.s>0, JSON.stringify(ec));
  // T24 selection / measurement spread follows the estimator
  const sm = JSON.parse(R(`(()=>{const out={};for(const m of ['median','trimmed','hampel','ema','mean']){const s=calculateSelection(300,500,{estimator:m,trimPercent:10,emaTau:.5});
     const v=[],t=[];for(let j=300;j<500;j++){v.push(getNetMg(j));t.push(getTime(j));}const r=estimate(v,t,m,{trimPercent:10,tau:.5});out[m]=s.spreadMg-r.sigma;}return JSON.stringify(out)})()`));
  ok('T24 selection spread = estimator sigma for every estimator', Object.values(sm).every(x=>near(x,0,1e-9,1e-6)), JSON.stringify(sm));
  // T25 measurement slider + text fields
  R = await load();
  ok('T25 slider: default position is 5 s = 400 samples', R(`sliderToSamples(489)`)===400 && R(`samplesToSlider(400)`)===489);
  ok('T25 slider range: 0.1 s .. 300 s', R(`sliderToSamples(0)`)===8 && R(`sliderToSamples(1000)`)===24000);
  R(`$('measSamples').value='1234'; syncMeasurementInputs('samples');`);
  ok('T25 typing samples updates duration and slider', R(`$('measDuration').value`)===15.425 && R(`$('measSlider').value`)===R(`samplesToSlider(1234)`));
  R(`$('measDuration').value='60'; syncMeasurementInputs('duration');`);
  ok('T25 typing duration updates samples (60 s = 4800)', R(`$('measSamples').value`)===4800);
  R(`$('measSamples').value='5000000'; startMeasurement();`);
  ok('T25 an absurd value is clamped to the maximum when starting', R(`state.measurement.target`)===100000 && R(`$('measSamples').value`)===100000);
  // T26 layout contract
  const head = html.split('</header>')[0], main = html.split('</header>')[1];
  ok('T26 Pause and +100k are in the header; Calibration is in the Settings menu', /id="pauseBtn"/.test(head)&&/id="testSamplesBtn"/.test(head)&&/id="calibrationInfo"/.test(head)&&/id="calImportBtn"/.test(head));
  ok('T26 old toolbar is gone', !/class="toolbar"/.test(main));
  const afterMini = main.slice(main.indexOf('id="miniChart"'));
  ok('T26 Track/Select/Export/Buffer are below the navigator graph', ['trackBtn','selectModeBtn','exportBtn','bufferInput'].every(id=>afterMini.indexOf('id="'+id+'"')>0 && afterMini.indexOf('id="'+id+'"')<afterMini.indexOf('</section>')));
  ok('T26 spread card sits beside the mass card; settings panel follows in the same spanning column', /class="mcol span2">\s*<div class="metric-pair">[\s\S]*?id="currentValue"[\s\S]*?id="currentSpread"[\s\S]*?<\/div>\s*<section class="panel compact" aria-label="Display and estimator settings">/.test(main));
  ok('T26 charts are full width: layout is a single column and the log follows the side panels', /\.layout\{grid-template-columns:minmax\(0,1fr\)!important\}/.test(html) && main.indexOf('</aside>')>0 && main.indexOf('log-panel')>main.indexOf('</aside>'));
  // T9 revision fingerprint must not depend on JSON key order
  R = await load();
  const id1 = R(`state.revisionId`);
  R(`(()=>{for(const k of Object.keys(CALIBRATION).reverse()){const v=CALIBRATION[k];delete CALIBRATION[k];CALIBRATION[k]=v;}})()`);
  await R(`calculateCalibrationRevision().then(()=>state.revisionId)`); const id2 = R(`state.revisionId`);
  ok('T9 revision id is key-order independent', id1===id2, id1+' vs '+id2);
  console.log('     revision:', R(`state.revisionId+' ('+state.hashType+')'`));
  console.log(fails? `\n${fails} FAILED` : '\nall passed');
  process.exitCode = fails?1:0;
})();
