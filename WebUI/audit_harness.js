// Headless audit harness: loads the REAL inline <script> of a workbench HTML file into a
// vm context with a minimal DOM stub (no browser, no uPlot, no timers) and probes the
// numerical / calibration / estimator logic. Rendering, pointer and touch code is NOT covered.
const fs = require('fs'), vm = require('vm');
const file = process.argv[2];
const html = fs.readFileSync(file, 'utf8');
const json = id => html.match(new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`))[1];
// v11: the application script is an external file referenced by <script src=...> (same folder as the HTML)
const srcMatch = html.match(/<script src="([^"]+)"><\/script>/);
const code = srcMatch ? fs.readFileSync(require('path').join(require('path').dirname(file), srcMatch[1]), 'utf8')
                      : [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()[1];

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
  ok('T20 uPlot pinned to one version constant, no stale URLs', /const UPLOT_VERSION='1\.6\.32'/.test(code) && !/uplot@1\.6\.30/.test(code));

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
  // ===================== v10 tests =====================
  R = await load();
  const RNG = `let __s=987654321;const rnd=()=>{__s=(__s*1103515245+12345)%2147483648;return __s/2147483648;};const gauss=()=>{const u=rnd()||1e-9,v=rnd();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);};`;
  const AN = (gen, times='T', opts='{}') => JSON.parse(R(`(()=>{${RNG}const N=2000,T=Array.from({length:N},(_,i)=>i*12.5);const x=Array.from({length:N},(_,i)=>${gen});const t=${times};const r=analyzeSeries(x,t,${opts});return JSON.stringify({status:r.status,seg:r.segments,v:Object.fromEntries(r.checks.map(c=>[c.id,c.verdict])),c:Object.fromEntries(r.checks.map(c=>[c.id,c]))})})()`));
  { const a = AN('5000+gauss()'); ok('V1 white noise: no problem detected', a.status==='ok', JSON.stringify(a.v)); }
  { const a = AN('5000+gauss()+i*0.01'); ok('V1 drift: invalid (autocorrelation / n_eff collapses)', a.status==='invalid' && a.v.autocorrelation==='invalid', JSON.stringify(a.v)); }
  { const a = AN('5000+gauss()+(i>1000?8:0)'); ok('V1 step of 8 sigma: step check invalid and classified as a step', a.v.step==='invalid' && a.c.step.stepLike===true && Math.abs(a.c.step.changeIndex-1000)<25, JSON.stringify(a.v)+' k='+a.c.step.changeIndex); }
  { const a = AN('5000+gauss()+2*Math.sin(2*Math.PI*50*i/80)'); ok('V1 50 Hz tone: vibration invalid, apparent frequency 30 Hz (alias)', a.v.vibration==='invalid' && Math.abs(a.c.vibration.frequencyHz-30)<0.5, a.c.vibration.valueText); }
  { const a = AN('5000+gauss()+0.6*Math.sin(2*Math.PI*10*i/80)'); ok('V1 weak 10 Hz tone is at least suspect, at 10 Hz', a.v.vibration!=='ok' && Math.abs(a.c.vibration.frequencyHz-10)<0.5, a.c.vibration.valueText); }
  { const a = AN('5000+gauss()','T.map((v,i)=>i>=1000?v+500:v)'); ok('V1 gap: flagged suspect/invalid, split in 2 segments', a.v.gaps!=='ok' && a.seg===2, JSON.stringify(a.v)); }
  { const a = AN('5000+gauss()','T.map((v,i)=>i===500?T[499]:v)'); ok('V1 duplicate timestamp: invalid', a.v.gaps==='invalid', JSON.stringify(a.v)); }
  { const a = JSON.parse(R(`JSON.stringify(analyzeSeries([1,2,3,4,5],[0,12.5,25,37.5,50]))`)); ok('V1 too-short interval: checks n/a, status insufficient (not a pass, not a finding)', a.status==='insufficient' && a.checks.filter(c=>c.verdict==='n/a').length===4, a.note); }
  { const a = AN('5000'); ok('V1 constant series does not crash and is not invalid', a.status!=='invalid', JSON.stringify(a.v)); }
  { const r = JSON.parse(R(`(()=>{${RNG}let a=0;const x=Array.from({length:20000},()=>a=0.8*a+gauss());const k=analysisAutocorr(x,100);return JSON.stringify({ratio:k.ratio,rho1:k.rho1})})()`)); ok('V2 AR(1) rho=0.8: rho1 ~ 0.8, n_eff/n ~ (1-rho)/(1+rho) = 0.11', near(r.rho1,0.8,0.03) && r.ratio>0.07 && r.ratio<0.17, JSON.stringify(r)); }
  { const r = JSON.parse(R(`(()=>{${RNG}const x=Array.from({length:20000},()=>gauss());const p=analysisAllan(x,1/80);return JSON.stringify(p.map(q=>q.adev))})()`)); ok('V3 Allan deviation of white noise falls ~ tau^-1/2 (m=1 -> m=16 : factor 4)', near(r[0]/r[4],4,0.12), 'ratio '+(r[0]/r[4]).toFixed(2)); }
  { const e = R(`(()=>{const n=16,re=new Float64Array(n),im=new Float64Array(n),x=[];for(let i=0;i<n;i++){x.push(Math.sin(i)+i*0.1);re[i]=x[i];}analysisFFT(re,im);let m=0;for(let k=0;k<n;k++){let sr=0,si=0;for(let i=0;i<n;i++){sr+=x[i]*Math.cos(2*Math.PI*k*i/n);si-=x[i]*Math.sin(2*Math.PI*k*i/n);}m=Math.max(m,Math.abs(sr-re[k]),Math.abs(si-im[k]));}return m})()`); ok('V4 FFT equals the naive DFT', e<1e-9, 'err '+e); }
  { const g = JSON.parse(R(`JSON.stringify(analysisGaps(Array.from({length:10},(_,i)=>i*12.5),12.5,[1,2,3,5,6,7,7,8,9,10]))`)); ok('V5 device counter: jump and repeat detected independently of timestamps', g.verdict==='invalid' && /1 jump/.test(g.detail) && /1 repeated/.test(g.detail), g.detail); }

  // V6 real Hampel filter
  { const r = JSON.parse(R(`(()=>{${RNG}const n=400,x=Array.from({length:n},(_,i)=>5000+i*0.5+gauss());const spikes=[100,250];x[100]+=40;x[250]-=40;
      const f=hampelFlags(x,5,3);const idx=[];f.forEach((v,i)=>{if(v)idx.push(i)});
      const loc=estimate(x,[],'hampelLocal',{hampelHalf:5,hampelSigma:3}),glob=estimate(x,[],'hampel',{}),mean=estimate(x,[],'mean',{});
      return JSON.stringify({idx,locRej:loc.rejected,globRej:glob.rejected,locV:loc.value,meanV:mean.value})})()`));
    ok('V6 local Hampel flags both spikes on a ramp (and only a few ordinary samples)', r.idx.includes(100)&&r.idx.includes(250)&&r.locRej<=12, JSON.stringify(r));
    ok('V6 on a ramp the old global gate misses both spikes (its scale is inflated by the drift) while the local filter catches them', r.globRej===0 && r.locRej>=2, `global ${r.globRej} vs local ${r.locRej}`); }
  { const r = JSON.parse(R(`(()=>{const x=[];for(let i=0;i<300;i++)x.push(5000+(i%7===0?1:0)+(i%11===0?-1:0));const f=hampelFlags(x,5,3);return JSON.stringify({n:f.reduce((a,b)=>a+b,0)})})()`)); ok('V6 tied quantised data (local MAD = 0) is not wholesale flagged (scale floor)', r.n<=3, 'flagged '+r.n); }
  { const r = JSON.parse(R(`(()=>{const x=[1,2,3];return JSON.stringify({n:hampelFlags(x,5,3).length,e:estimate(x,[],'hampelLocal',{}).value})})()`)); ok('V6 tiny series: no crash, mean returned', r.n===3 && r.e===2); }

  // V7 seed-normalised EMA
  { const r = JSON.parse(R(`(()=>{${RNG}const n=300,t=Array.from({length:n},(_,i)=>i*12.5),x=Array.from({length:n},()=>10+gauss()),tau=0.4;
      const e=emaNormalised(x,t,tau);
      // brute-force weights: w_i=(1-a_i)*prod_{j>i}a_j, a_j=exp(-dt_j/tau), first sample counts as one nominal period
      const a=t.map((_,i)=>Math.exp(-(i>0?(t[i]-t[i-1]):12.5)/1000/tau));let sw=0,sx=0,sw2=0;const w=new Array(n);
      for(let i=0;i<n;i++){let p=1-a[i];for(let j=i+1;j<n;j++)p*=a[j];w[i]=p;sw+=p;sx+=p*x[i];}const m=sx/sw;let sv=0;for(let i=0;i<n;i++){sv+=w[i]*(x[i]-m)**2;sw2+=w[i]*w[i];}
      const big=emaNormalised(x,t,1e6),mean=x.reduce((s,v)=>s+v,0)/n;
      return JSON.stringify({dm:e.value-m,ds:e.sigma-Math.sqrt(sv/sw),dn:e.neff-sw*sw/sw2,bigErr:big.value-mean})})()`));
    ok('V7 EMA-normalised value, weighted SD and Kish n_eff equal the brute-force weight formula', Math.abs(r.dm)<1e-9&&Math.abs(r.ds)<1e-9&&Math.abs(r.dn)<1e-7, JSON.stringify(r));
    ok('V7 tau >> T tends to the arithmetic mean', Math.abs(r.bigErr)<1e-3, JSON.stringify(r.bigErr)); }
  { const r = JSON.parse(R(`(()=>{const x=[0,0,0,0,0,10],t=x.map((_,i)=>i*12.5);return JSON.stringify({plain:estimate(x,t,'ema',{tau:0.5}).value,norm:estimate(x,t,'emaNorm',{tau:0.5}).value})})()`)); ok('V7 short interval: normalised EMA weights the last sample more (no weight left on a seed)', r.norm>r.plain, JSON.stringify(r)); }
  R = await load();
  R(`resizeBuffers(5000);state.window=state.activeWindow=80;for(let i=0;i<300;i++)appendSample(nextSensorValue());autoTare();for(let i=0;i<600;i++)appendSample(nextSensorValue());state.estimator='emaNorm';state.emaTau=0.3;`);
  { const r = JSON.parse(R(`(()=>{const L=state.count-1,lo=L-300,c=buildEstimatorCurve(lo,L,false),w=[],tm=[];const e=tareEventAt(getTime(L));let k=0;while(k<state.count&&tareEventAt(getTime(L-k))===e)k++;const s0=L-k+1;for(let i=s0;i<=L;i++){w.push(getNetMg(i));tm.push(getTime(i));}
      const d=emaNormalised(w,tm,0.3);return JSON.stringify({dc:c.center(L)-d.value,ds:c.sigma(L)-d.sigma})})()`)); ok('V7 EMA-normalised curve equals the estimator over the tare epoch', Math.abs(r.dc)<1e-3&&Math.abs(r.ds)<1e-3, JSON.stringify(r)+' (curve starts its recursion 7 tau before the view: tail weight < 0.1 %)'); }
  { const r = JSON.parse(R(`(()=>{const L=state.count-1,first=L-399,end=L+1;const s=calculateSelection(first,end,{estimator:'emaNorm',emaTau:0.3});const w=[],tm=[];for(let i=first;i<end;i++){w.push(getNetMg(i));tm.push(getTime(i));}const d=emaNormalised(w,tm,0.3);return JSON.stringify({dv:s.currentValueMg-s.currentValueMg,dsp:s.spreadMg-d.sigma,hasN:s.emaNeff>1,hasA:!!s.analysis&&Array.isArray(s.analysis.checks)})})()`)); ok('V7 selection with emaNorm: sigma = estimator sigma, n_eff reported, analysis attached', Math.abs(r.dsp)<1e-6&&r.hasN&&r.hasA, JSON.stringify(r)); }
  { const r = JSON.parse(R(`(()=>{const L=state.count-1,s=calculateSelection(L-499,L+1,{estimator:'hampelLocal',hampelHalf:5,hampelSigma:3});const x=[];for(let i=L-499;i<=L;i++)x.push(getNetMg(i));const e=estimate(x,[],'hampelLocal',{hampelHalf:5,hampelSigma:3});return JSON.stringify({d:s.currentValueMg-e.value,rej:s.rejectedSamples-e.rejected})})()`)); ok('V6 selection with hampelLocal equals the estimator on the same samples', Math.abs(r.d)<1e-6&&r.rej===0, JSON.stringify(r)); }

  // V8 analyzeInterval on the real buffer (simulator modes)
  { R = await load();
    const run = (mode,n=1200,extra='') => JSON.parse(R(`(()=>{resizeBuffers(20000);state.simMode='${mode}';state.simOffset=0;state.simN=0;for(let i=0;i<${n};i++){${extra}appendSample(nextSensorValue());}const a=analyzeInterval(100,state.count);return JSON.stringify({s:a.status,v:Object.fromEntries(a.checks.map(c=>[c.id,c.verdict])),n:a.n})})()`));
    const q = run('quiet'); ok('V8 simulated quiet signal passes (or at worst one suspect)', q.s==='ok'||q.s==='suspect', JSON.stringify(q));
    R = await load(); const h = run('hum'); ok('V8 simulated 50 Hz hum is detected by analyzeInterval', h.v.vibration==='invalid'||h.v.vibration==='suspect', JSON.stringify(h));
    R = await load(); const g = run('quiet',1200,'if(i===600)state.nextTime+=2000;'); ok('V8 a timestamp gap in the buffer is detected', g.v.gaps!=='ok', JSON.stringify(g));
    R = await load(); const sm = JSON.parse(R(`(()=>{resizeBuffers(20000);state.simMode='quiet';for(let i=0;i<500;i++)appendSample(nextSensorValue());state.simMode='quiet';state.simOffset=60;for(let i=0;i<500;i++)appendSample(nextSensorValue());const a=analyzeInterval(0,state.count);return JSON.stringify(Object.fromEntries(a.checks.map(c=>[c.id,c.verdict])))})()`)); ok('V8 a moved weight (+60 counts) in the buffer is detected as invalid', sm.step==='invalid', JSON.stringify(sm));
    R = await load(); R(`for(let i=0;i<100;i++) appendSample(nextSensorValue()); $('measSamples').value=400; startMeasurement(); for(let i=0;i<400;i++) appendSample(nextSensorValue());`);
    ok('V8 a finished measurement carries the analysis result and a validity badge in its log entry', R(`(()=>{const e=state.logs.find(l=>l.type==='measurement');return !!e&&!!e.analysis&&e.analysis.checks.length>=5&&/Validity/.test(analysisBadgeHTML(e.analysis))})()`)); }

  // V9 navigator data: aligned buckets, stable under growth, bounded size
  { R = await load();
    R(`resizeBuffers(60000);for(let i=0;i<30000;i++)appendSample(nextSensorValue());`);
    const r = JSON.parse(R(`(()=>{const a=buildMiniData();const ax=Array.from(a[0]),ay=Array.from(a[1]);for(let i=0;i<7;i++)appendSample(nextSensorValue());const b=buildMiniData();const bm=new Map();for(let i=0;i<b[0].length;i++)bm.set(b[0][i],b[1][i]);
      const lo=ax[0]+5,hi=ax[ax.length-1]-5;let same=0,tot=0;for(let i=0;i<ax.length;i++)if(ax[i]>=lo&&ax[i]<=hi){tot++;if(bm.get(ax[i])===ay[i])same++;}
      return JSON.stringify({pts:ax.length,tot,same})})()`));
    ok('V9 navigator: adding samples leaves the interior of the curve bit-identical (no flicker)', r.same===r.tot && r.tot>1000, JSON.stringify(r));
    ok('V9 navigator: point count bounded (~4 per pixel) and far above the old 1,600', r.pts<=4096+4 && r.pts>1600, 'points '+r.pts);
    R(`resizeBuffers(1000);`); ok('V9 navigator after a buffer shrink: same data, no crash', R(`buildMiniData()[0].length>0`));
    const w = JSON.parse(R(`(()=>{resizeBuffers(60000);const a=buildMiniData();state.unitId='kg';const b=buildMiniData();return JSON.stringify({k:b[1][5]/a[1][5]})})()`)); ok('V9 navigator: unit change only rescales cached values', near(w.k,1e-3,1e-9), JSON.stringify(w)); }

  // V10 Y-axis dead-band
  { const r = JSON.parse(R(`(()=>{const latch=[false,false];let cur={min:0,max:100};const pad=4;let moved=0;
      for(let i=0;i<2000;i++){const j=Math.sin(i)*0.8;const t={min:j-0.5,max:100+j+0.5};const n=autoYStep(cur,t,pad,0.05,latch,false);if(n.min!==cur.min||n.max!==cur.max)moved++;cur=n;}
      const edge={min:cur.min,max:cur.max};let steps=0;const latch2=[false,false];let c2=cur;for(let i=0;i<400;i++){c2=autoYStep(c2,{min:-40,max:140},pad,0.1,latch2,false);steps++;if(Math.abs(c2.min+40)<2.1&&Math.abs(c2.max-140)<2.8)break;}
      const sn=autoYStep(cur,{min:5,max:50},pad,0.05,[false,false],true);
      const loose=autoYStep({min:0,max:100},{min:30,max:70},pad,1,[false,false],false);
      const tight=autoYStep({min:0,max:100},{min:0,max:70},pad,1,[false,false],false);
      return JSON.stringify({moved,edge,steps,end:c2,sn,loose,tight})})()`));
    ok('V10 Y dead-band: +-1.3 % wobble of the data extent (inside half the padding) never moves the view', r.moved===0, JSON.stringify(r.edge)+' moved '+r.moved);
    ok('V10 Y dead-band: data crossing the threshold makes the view follow (damped) and then settle', r.steps>1 && r.steps<400 && Math.abs(r.end.min+40)<3, JSON.stringify({steps:r.steps,end:r.end}));
    ok('V10 Y snap: undamped, exactly on the target', r.sn.min===5&&r.sn.max===50);
    ok('V10 Y: too much empty space shrinks that side only; a tight side does not move without a crossing', r.loose.min===30 && r.loose.max===70 && r.tight.min===0 && r.tight.max===70, JSON.stringify({loose:r.loose,tight:r.tight})); }

  // V11 event hit-testing, ranges and descriptions
  { R = await load();
    R(`for(let i=0;i<800;i++)appendSample(nextSensorValue());autoTare();for(let i=0;i<400;i++)appendSample(nextSensorValue());state.logs=[];`);
    R(`$('measSamples').value=200;startMeasurement();for(let i=0;i<200;i++)appendSample(nextSensorValue());selectInterval&&0;`);
    const r = JSON.parse(R(`(()=>{const u={posToVal:(x)=>x*0.1};   // 1 px = 100 ms
      const tareT=state.tareEvents[state.tareEvents.length-1].effectiveFromTime;const m=state.logs.find(l=>l.type==='measurement');
      const hTare=hitTestEvents(u,tareT/100+2,100),hLane=hitTestEvents(u,(m.t0+m.t1)/2/100,5),hBody=hitTestEvents(u,(m.t0+m.t1)/2/100,100),hNone=hitTestEvents(u,(m.t1+60000)/100,5);
      const row=logEntryRange(m),tr=logEntryRange({type:'tare',effectiveFromTime:5});
      return JSON.stringify({tare:hTare.length&&hTare[0].prio===0,lane:hLane.some(h=>h.entry===m),body:hBody.some(h=>h.entry===m),none:hNone.length,row:row.t0===m.t0&&row.t1===m.t1,marker:!!(tr&&tr.marker),desc:describeEventHTML(m),tdesc:describeEventHTML(state.tareEvents[state.tareEvents.length-1])})})()`));
    ok('V11 hovering a tare marker (within 6 px) hits it first', r.tare);
    ok('V11 the top lane hits a logged measurement; far away hits nothing', r.lane && r.none===0);
    ok('V11 the last measurement is still hoverable over the full height while it is highlighted', r.body);
    ok('V11 log row ranges: measurement span and tare marker', r.row && r.marker);
    ok('V11 event descriptions carry the result, sigma and the validity badge', /Measurement/.test(r.desc)&&/σ/.test(r.desc)&&/Validity/.test(r.desc)&&/Tare/.test(r.tdesc), r.desc.slice(0,120)); }

  // V12 static cross-checks: every $('id') exists, estimator options wired, charts independent
  { const used = new Set([...code.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)].map(m=>m[1])), have = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m=>m[1]));
    const missing = [...used].filter(i=>!have.has(i));
    ok('V12 every $(\'id\') in the script exists in the HTML', missing.length===0, missing.join(','));
    ok('V12 estimator select offers the new options', /value="hampelLocal"/.test(html)&&/value="emaNorm"/.test(html)&&/value="hampel"/.test(html)&&/value="ema"/.test(html));
    const h = code.match(/\$\('estimatorSelect'\)\.addEventListener\('change'[^\n]*\n?/)[0];
    ok('V12 changing the estimator rebuilds only the main chart', /recreateMainChart\(\)/.test(h) && !/miniPlot/.test(h) && !/createMiniChart/.test(h), h.slice(0,160)); }

  // T9 revision fingerprint must not depend on JSON key order
  R = await load();
  const id1 = R(`state.revisionId`);
  R(`(()=>{for(const k of Object.keys(CALIBRATION).reverse()){const v=CALIBRATION[k];delete CALIBRATION[k];CALIBRATION[k]=v;}})()`);
  await R(`calculateCalibrationRevision().then(()=>state.revisionId)`); const id2 = R(`state.revisionId`);
  ok('T9 revision id is key-order independent', id1===id2, id1+' vs '+id2);
  console.log('     revision:', R(`state.revisionId+' ('+state.hashType+')'`));

  // ===== v11 =====================================================================================
  R = await load();
  // V13 'insufficient': derived minimum sample count (rate independent)
  { const m = JSON.parse(R(`JSON.stringify(analysisMinSamples())`));
    ok('V13 minimum sample count: acf 64, step 35, allan 64, welch 64 -> 64', m.acf===64 && m.step===35 && m.allan===64 && m.welch===64 && m.n===64 && R(`ANALYSIS_THRESHOLDS.minSamples`)===64, JSON.stringify(m)); }
  let seed = 12345; const rnd = () => (seed = (seed*1664525+1013904223)>>>0)/4294967296;
  const gauss = () => { let s=0; for(let i=0;i<12;i++) s+=rnd(); return s-6; };
  const series = (n,dt) => { const v=[],tt=[]; for(let i=0;i<n;i++){v.push(Math.round(5000+gauss()*2));tt.push(i*dt);} return [v,tt]; };
  { const [v,tt]=series(63,12.5); const a=JSON.parse(R(`JSON.stringify(analyzeSeries(${JSON.stringify(v)},${JSON.stringify(tt)},{nominalMs:12.5}))`)); ok('V13 63 uniform samples -> insufficient', a.status==='insufficient', a.status); }
  { const [v,tt]=series(64,12.5); const a=JSON.parse(R(`JSON.stringify(analyzeSeries(${JSON.stringify(v)},${JSON.stringify(tt)},{nominalMs:12.5}))`)); ok('V13 64 uniform white-noise samples are analysed (not insufficient)', a.status!=='insufficient' && a.checks.every(c=>c.id==='gaps'||c.verdict!=='n/a'||c.id==='step'), a.status+' '+a.checks.map(c=>c.id+':'+c.verdict).join(',')); }
  { const [v,tt]=series(40,100); const a=JSON.parse(R(`JSON.stringify(analyzeSeries(${JSON.stringify(v)},${JSON.stringify(tt)},{nominalMs:100}))`)); ok('V13 10 Hz sensor: same count, duration reported in its own rate', a.status==='insufficient' && /6\.40 s at 10 Hz/.test(a.checks.find(c=>c.id==='autocorrelation').valueText), a.checks.find(c=>c.id==='autocorrelation').valueText); }
  { const [v,tt]=series(40,12.5); tt[20]=tt[19]; const a=JSON.parse(R(`JSON.stringify(analyzeSeries(${JSON.stringify(v)},${JSON.stringify(tt)},{nominalMs:12.5}))`)); ok('V13 a found problem (duplicate time) outranks insufficient', a.status==='invalid', a.status); }
  ok('V13 badge text for insufficient', /insufficient data \(30 of ≥ 64/.test(R(`analysisBadgeHTML({status:'insufficient',analyzedN:30,checks:[]})`)));
  // V14 details open state survives re-render; setHTML avoids rewriting identical markup
  R(`state.detailsOpen={}`);
  ok('V14 default open honoured', / open>/.test(R(`analysisHTML({status:'ok',checks:[]},true,'sel')`)));
  R(`state.detailsOpen.sel=false`);
  ok('V14 stored closed state wins over default open', !/ open>/.test(R(`analysisHTML({status:'ok',checks:[]},true,'sel')`)));
  R(`globalThis.__el={innerHTML:''};setHTML(__el,'<b>x</b>');globalThis.__w=0;Object.defineProperty(__el,'innerHTML',{get(){return this._h},set(v){this._h=v;globalThis.__w++}});__el._h='<b>x</b>';__el.__out='<b>x</b>';__el.__src='<b>x</b>';setHTML(__el,'<b>x</b>');`);
  ok('V14 identical markup is not rewritten', R(`__w`)===0);
  // V15 auto Track Live at the far right
  R = await load();
  R(`for(let i=0;i<500;i++) appendSample(nextSensorValue()); state.live=false; state.viewMin=1000; state.viewMax=newestTime()-1000; autoTrackIfAtEnd();`);
  ok('V15 view away from the end stays historical', R(`state.live`)===false);
  R(`state.viewMax=newestTime(); autoTrackIfAtEnd();`);
  ok('V15 view moved to the far right switches Track Live on', R(`state.live`)===true);
  R(`state.live=false; state.viewMax=newestTime(); state.selection={t0:0,t1:1}; autoTrackIfAtEnd();`);
  ok('V15 not while an interval is selected', R(`state.live`)===false);
  // V16 Y damping keeps asking for frames until the latch releases (paused-chart fix)
  { const r=JSON.parse(R(`(()=>{const l=[false,false];let cur={min:0,max:10};const tgt={min:50,max:60};let n=0;while(n<2000){cur=autoYStep(cur,tgt,.4,.05,l,false);n++;if(!l[0]&&!l[1])break;}return JSON.stringify({n,cur,l})})()`));
    ok('V16 damping settles (latches release) within a bounded number of frames, close to the target', r.n<400 && Math.abs(r.cur.min-50)<=0.02*10+1e-9, JSON.stringify(r)); }
  // V17 multi-sensor
  R = await load();
  R(`globalThis.__es=[];globalThis.EventSource=class{constructor(u){this.url=u;this.readyState=0;this.closed=false;__es.push(this)}close(){this.closed=true;this.readyState=2}}`);
  const open = () => JSON.parse(R(`JSON.stringify(__es.filter(e=>!e.closed).map(e=>e.url).sort())`));
  let res = JSON.parse(R(`JSON.stringify(applySensorList([{id:'a',name:'Scale A',sseUrl:'/s1'},{id:'b',name:'Scale B',sseUrl:'/s1',rateHz:10},{id:'c',name:'<b>C</b>',sseUrl:'/s2'},{id:'test',name:'x',sseUrl:'/s9'},{id:'bad',sseUrl:'ftp://x'}]))`));
  ok('V17 list: 3 added; reserved id and non-http URL rejected', res.added.join()==='a,b,c' && res.errors.length===2, JSON.stringify(res));
  ok('V17 sensors sharing an SSE URL share ONE connection', JSON.stringify(open())==='["/s1","/s2"]');
  R(`setSensorPaused(sensors.get('a'),true)`); ok('V17 pausing one of two sensors on a URL keeps the connection', open().length===2);
  R(`setSensorPaused(sensors.get('b'),true)`); ok('V17 pausing the last user of a URL closes it', JSON.stringify(open())==='["/s2"]');
  R(`pauseAllToggle()`); ok('V17 Pause all closes everything', open().length===0 && R(`[...sensors.values()].every(s=>s.state.paused)`));
  R(`pauseAllToggle()`); ok('V17 Resume all reopens the connections', JSON.stringify(open())==='["/s1","/s2"]' && R(`[...sensors.values()].every(s=>!s.state.paused)`));
  const msg = (id,i0,n,dt=12.5,base=1e9) => JSON.stringify(Array.from({length:n},(_,k)=>({id,t:base+(i0+k)*dt,raw:5000+((i0+k)%7)})));
  R(`handleSseMessage('/s1',${JSON.stringify(msg('a',0,300))}); handleSseMessage('/s1',${JSON.stringify(msg('b',0,50,100))}); handleSseMessage('/s2',${JSON.stringify(msg('c',0,20))})`);
  ok('V17 samples routed to the right sensors; first device time becomes the origin', R(`sensors.get('a').state.count`)===300 && R(`sensors.get('b').state.count`)===50 && R(`sensors.get('a').state.times[0]`)===0 && R(`sensors.get('a').state.times[299]`)===299*12.5);
  ok('V17 hidden sensors store raw only (no derived arrays)', R(`sensors.get('a').state.derivedReady`)===false && R(`sensors.get('a').state.massMg.length`)===0 && R(`sensors.get('a').state.unprocessed`)===300);
  R(`handleSseMessage('/s2',${JSON.stringify(msg('a',0,5))})`); ok('V17 data for a sensor on another URL is ignored', R(`sensors.get('a').state.count`)===300);
  R(`handleSseMessage('/s1',${JSON.stringify(msg('a',100,5))})`); ok('V17 non-monotonic times are rejected', R(`sensors.get('a').state.count`)===300 && R(`sensors.get('a').state.rejected`)===5);
  R(`setSensorPaused(sensors.get('c'),true); handleSseMessage('/s2',${JSON.stringify(msg('c',20,10))})`); ok('V17 paused sensor discards incoming data', R(`sensors.get('c').state.count`)===20 && R(`sensors.get('c').state.dropped`)===10);
  R(`setSensorPaused(sensors.get('c'),false)`);
  // test sensor keeps recording in the background (raw only), then catches up when shown
  R(`for(let i=0;i<400;i++) ingestSample(testSensor,nextSensorValue(testSensor.state)); autoTare();`);
  ok('V17 tare is logged on the shown (test) sensor only', R(`state.logs.length`)===1 && R(`sensors.get('a').state.logs.length`)===0 && R(`state===testSensor.state`));
  R(`activateSensor('a')`);
  ok('V17 switching: derived arrays allocated and filled for the newly shown sensor', R(`state===sensors.get('a').state&&state.derivedReady&&state.unprocessed===0&&RATE_HZ===80`));
  const chk = R(`(()=>{let ok1=true;for(let i=0;i<state.count;i++){if(getMassMg(i)!==calibrateAbsolute(getRaw(i)).valueMg){ok1=false;break;}}let s=0;const n=80;for(let j=state.count-n;j<state.count;j++)s+=getRaw(j);return {ok1,ma:getRawMA(state.count-1)-s/n,unit:state.unitId}})()`);
  ok('V17 caught-up values equal direct calibration; rolling mean equals brute force', chk.ok1 && Math.abs(chk.ma)<1e-9 && chk.unit==='raw', JSON.stringify(chk));
  R(`activateSensor('b')`); ok('V17 per-sensor rate follows the sensor (10 Hz)', R(`RATE_HZ`)===10 && R(`PERIOD_MS`)===100);
  R(`for(let i=0;i<300;i++) ingestSample(testSensor,nextSensorValue(testSensor.state)); autoTare`); 
  ok('V17 hidden test signal grows without being processed', R(`testSensor.state.unprocessed`)===300 && R(`testSensor.state.count`)===700);
  R(`activateSensor('test')`);
  { const b=R(`(()=>{const n=Math.min(state.window,state.count-lowerBoundTime(currentTareEvent().effectiveFromTime));let s=0;for(let j=state.count-n;j<state.count;j++)s+=getNetMg(j);return getMassMA(state.count-1)-s/n})()`);
    ok('V17 test sensor after catch-up: net moving average matches brute force across the tare', Math.abs(b)<1e-6, String(b)); }
  ok('V17 logs stay separate per sensor after switching back', R(`state.logs.length`)===1 && R(`sensors.get('b').state.logs.length`)===0);
  const countsBefore = R(`sensors.get('a').state.count`);
  res = JSON.parse(R(`JSON.stringify(applySensorList({sensors:[{id:'a',name:'Scale A (renamed)',sseUrl:'/s1'},{id:'d',name:'D',sseUrl:'/s3'}]}))`));
  ok('V17 reload: data kept, renamed, new sensor added, missing ones marked not in list', R(`sensors.get('a').state.count`)===countsBefore && R(`sensors.get('a').name`)==='Scale A (renamed)' && res.added.join()==='d' && res.unlisted.sort().join()==='b,c' && R(`sensors.get('b').state.count`)===50);
  ok('V17 unlisted sensors get no connection; listed ones do', JSON.stringify(open())==='["/s1","/s3"]');
  R(`handleSseMessage('/s1',${JSON.stringify(msg('a',400,10))})`); ok('V17 data still flows into a sensor after a list reload', R(`sensors.get('a').state.count`)===countsBefore+10);
  ok('V17 an empty sensor can be shown without errors', (()=>{ try { R(`activateSensor('d'); renderEmpty(); activateSensor('test')`); return true; } catch(e){ console.log(e); return false; } })());

  console.log(fails? `\n${fails} FAILED` : '\nall passed');
  process.exitCode = fails?1:0;
})();
