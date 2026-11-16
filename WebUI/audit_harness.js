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
  vm.runInContext("wizMode='advanced'", ctx);   // v13: the v12 wizard tests assume the Advanced mode; Simple-mode tests switch explicitly
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

  // ===== v12 =====================================================================================
  R = await load();
  const J = s => JSON.parse(R(`JSON.stringify(${s})`));
  // W1 fitting maths on the demo observations (analytic: counts = 4600 + 4 m[g], residuals -2, 0, 0, +2 ... )
  R(`wizLoadFromConfig(JSON.parse(JSON.stringify(EMBEDDED_CALIBRATION)))`);
  { const f = J(`(()=>{const p=wizPoints(wiz).points;const l=fitCalibration(p,'linear');return {n:p.length,ok:l.ok,sd:l.sdRawRes,dof:l.dof,slope:(l.g(200000)-l.g(0))/200,a:l.g(0),mono:l.monotone,nodes:l.nodes,gm:l.groups.length}})()`);
    ok('W1 demo observations: 5 points, 3 distinct masses', f.n===5&&f.gm===3);
    ok('W1 linear fit: 4 counts/g, intercept 4600, s = sqrt(8/3), dof 3', near(f.slope,4,1e-9)&&near(f.a,4600,1e-9)&&near(f.sd,Math.sqrt(8/3),1e-9)&&f.dof===3, JSON.stringify(f)); }
  { const f = J(`(()=>{const a=fitCalibration(wizPoints(wiz).points,'anchors');return {an:a.anchors.map(x=>[x.massMg,x.raw]),dof:a.dof}})()`);
    ok('W1 anchors model reproduces the embedded anchors (mean of the three 100 g placements = 5000)', JSON.stringify(f.an)==='[[0,4600],[100000,5000],[200000,5400]]'&&f.dof===2, JSON.stringify(f)); }
  // W2 curved cell: quadratic recovers the truth; written anchors invert it
  { const r = J(`(()=>{const pts=[];for(let k=0;k<=8;k++){const m=k*25000;pts.push({id:'p'+k,massMg:m,raw:5000+4*(m/1000)+0.002*(m/1000)**2});}
      const q=fitCalibration(pts,'poly2'),l=fitCalibration(pts,'linear');
      const cfg=prepareCalibration({schemaVersion:1,calibrationUnit:'mg',calibrationAnchors:q.anchors.map((a,i)=>({anchorId:'a'+i,rawMean:a.raw,referenceValue:a.massMg,referenceUnit:'mg'}))});
      let worst=0;for(let g=1;g<=199;g+=0.5){const raw=5000+4*g+0.002*g*g;worst=Math.max(worst,Math.abs(calibrateAbsolute(raw,cfg).valueMg-g*1000));}
      return {rms:q.rmsMassMg,sd:q.sdRawRes,lin:l.maxAbsMassMg,nodes:q.nodes,interp:q.maxInterpErrMg,worst}})()`);
    ok('W2 quadratic fit of exactly quadratic data has ~0 residual; a straight line does not', r.sd<1e-6&&r.rms<1e-6&&r.lin>1000, JSON.stringify(r));
    ok('W2 sampled anchors invert the curve: worst error over 1..199 g below 1e-5 of the span and equal to the reported bound', r.worst<=1e-5*200000*1.0001&&r.interp<=1e-5*200000, JSON.stringify(r)); }
  // W3 errors: too few masses, non-monotonic cubic, inverse polarity accepted
  { const r = J(`(()=>{const mk=(a)=>a.map((y,i)=>({id:'p'+i,massMg:i*1000,raw:y}));
      return {one:fitCalibration([{id:'a',massMg:5,raw:1},{id:'b',massMg:5,raw:2}],'linear').errors.length,
              quad2:fitCalibration(mk([0,10]),'poly2').errors.length,
              nonmono:fitCalibration(mk([0,100,90,300]),'poly3').errors.length,
              inv:fitCalibration(mk([5000,4000,3000,2000]),'linear').ok}})()`);
    ok('W3 one mass / degree too high / non-monotonic fit are rejected; falling counts (inverted polarity) accepted', r.one>0&&r.quad2>0&&r.nonmono>0&&r.inv, JSON.stringify(r)); }
  // W4 config -> validate -> activate -> calibration really used; excluded observation stays in file but not in fit
  R = await load();
  R(`wizLoadFromConfig(JSON.parse(JSON.stringify(EMBEDDED_CALIBRATION))); wiz.sensorId=activeSensor.id; wiz.rateHz=80; wiz.fitModel='linear'; wiz.profile.profileId='wizard-test'; wiz.profile.profileName='<i>wiz</i>'; wiz.observations[1].include=false;`);
  { const r = J(`(()=>{const b=wizBuild();return {err:b.errors,n:b.fit.n,excl:b.cfg.observations.filter(o=>o.excluded).map(o=>o.observationId),an:b.cfg.calibrationAnchors.length,unit:b.cfg.calibrationUnit,v:validateCalibrationConfig(b.cfg).errors.length,m:b.cfg.calibrationMethod}})()`);
    ok('W4 built document validates; excluded observation is marked in the file and not fitted', r.err.length===0&&r.n===4&&r.excl.join()==='obs-100-A-01'&&r.v===0&&r.m==='piecewise-linear'&&r.an===2, JSON.stringify(r)); }
  { const res = await R(`wizActivate().then(()=>JSON.stringify({m:wiz.message,rev:state.revisionId,n:state.calibrations.length,c:calibrateAbsolute(5200).valueMg}))`); const o = JSON.parse(res);
    ok('W4 activation starts a new calibration epoch; 5200 counts = 149.875 g on the fitted line (intercept 4600.5 without the excluded 4998)', o.n===2&&near(o.c,149875,1e-9,1e-3), JSON.stringify(o));
    ok('W4 wizard cannot activate on another sensor', await R(`(async()=>{wiz.sensorId='other';await wizActivate();return /not the wizard/.test(wiz.message)&&state.calibrations.length===2})()`)); }
  ok('W4 wizard HTML escapes untrusted profile names', !R(`(()=>{wiz.sensorId=activeSensor.id;wiz.tab='weights';wizRender();return wq('wizBody').innerHTML})()`).includes('<i>wiz</i>'));
  for (const t of ['weights','observations','fit','review']) ok(`W4 tab "${t}" renders without error`, (()=>{ try { R(`wiz.tab='${t}';wizRender();wq('wizBody').innerHTML.length`); return true; } catch(e){ console.log(e); return false; } })());
  // W5 capture through the measurement machinery
  R = await load();
  R(`for(let i=0;i<100;i++)appendSample(nextSensorValue()); wizNew(); wiz.sensorId=activeSensor.id; wiz.rateHz=80; wiz.captureSeconds=5; wiz.open=true; wizRecord();`);
  ok('W5 recording starts a tagged measurement of 400 samples', R(`state.measurement&&state.measurement.target===400&&state.measurement.tag==='calibration wizard'&&wiz.capture!==null`));
  R(`for(let i=0;i<400;i++)appendSample(nextSensorValue());`);
  { const o = J(`(()=>{const ob=wiz.observations[0],v=[];for(let i=100;i<500;i++)v.push(getRaw(i));const m=v.reduce((a,b)=>a+b,0)/400;return {n:wiz.observations.length,cnt:ob.sampleCount,dm:ob.rawMean-m,load:ob.loadId,st:ob.validity.status,done:wiz.capture===null,idx:ob.placementIndex,dur:ob.durationMs}})()`);
    ok('W5 observation = brute-force raw mean of exactly the 400 samples after the press', o.n===1&&o.cnt===400&&near(o.dm,0,1e-12,1e-9)&&o.done&&o.idx===1&&near(o.dur,5000,1e-9,1e-6), JSON.stringify(o)); }
  R(`wiz.selLoad='load-empty'; wizRecord(); for(let i=0;i<10;i++)appendSample(nextSensorValue()); autoTare();`);
  ok('W5 a tare during a capture cancels it and leaves no observation', R(`wiz.capture===null&&state.measurement===null&&wiz.observations.length===1&&/cancelled/.test(wiz.message)`));
  R(`wizUseSelection()`); ok('W5 "use selected interval" without a selection is refused', R(`wiz.observations.length===1&&/no selected/.test(wiz.message)`));
  R(`selectInterval(getTime(150),getTime(349));wizUseSelection()`); ok('W5 selected interval becomes an observation', R(`wiz.observations.length===2&&wiz.observations[1].sampleCount===200&&wiz.observations[1].source==='selection'`));
  // W6 UI settings
  R = await load();
  ok('W6 sanitize: defaults for missing keys, wrong types and versions reported', J(`sanitizeUiSettings({schemaVersion:1,theme:'light'}).value.yResponsePercent`)===5 && J(`sanitizeUiSettings({schemaVersion:1,theme:'pink'}).errors.length`)===1 && J(`sanitizeUiSettings({schemaVersion:2}).value`)===null && J(`sanitizeUiSettings({schemaVersion:1,yResponsePercent:500}).errors.length`)===0 && J(`sanitizeUiSettings({schemaVersion:1,yResponsePercent:500}).value.yResponsePercent`)===100);
  R(`globalThis.__ls={};globalThis.localStorage={getItem:k=>(k in __ls?__ls[k]:null),setItem:(k,v)=>{__ls[k]=String(v)},removeItem:k=>{delete __ls[k]}};`);
  R(`$('yResponseRange').value=17;$('downsampleToggle').checked=true;$('zeroLine').checked;uiLocalWrite(collectUiSettings())`);
  { const o = J(`uiLocalRead()`); ok('W6 collect -> localStorage -> read round trip', o&&o.yResponsePercent===17&&o.downsample===true&&o.theme==='dark', JSON.stringify(o)); }
  R(`$('yResponseRange').value=5;$('downsampleToggle').checked=false;applyUiSettings(uiLocalRead())`);
  ok('W6 applying stored settings restores the controls', R(`$('yResponseRange').value`)===17&&R(`$('downsampleToggle').checked`)===true&&R(`$('yResponseText').textContent`)==='17%');
  R(`globalThis.__ls.massTelemetryWorkbench_bad=1;localStorage.setItem(UI_LOCAL_KEY,'{not json')`); ok('W6 corrupt stored settings are ignored', R(`uiLocalRead()`)===null);
  await R(`uiResetLocal()`); ok('W6 reset clears the browser copy and restores the built-in values', R(`uiLocalRead()`)===null&&R(`$('yResponseRange').value`)===5&&R(`$('downsampleToggle').checked`)===false&&R(`uiTheme`)==='dark');
  ok('W6 without a server the server buttons are disabled and say so', R(`updateUiSettingsInfo(),$('uiSaveServerBtn').disabled`)===true && (await R(`uiSaveAsServerDefault().then(()=>$('uiMessages').textContent)`)).includes('not configured')===false && (await R(`$('uiMessages').textContent`)).includes('No settings server'));
  // W7 sensor settings document
  R = await load();
  R(`applySensorList([{id:'a',name:'Scale A',sseUrl:'/s1',rateHz:10},{id:'b',name:'B',sseUrl:'/s1'}]); sensors.get('a').settings.notes='bench 2'`);
  { const d = J(`sensorSettingsDoc()`); ok('W7 sensor_settings.json lists the server sensors (not the test signal) with rate and notes', d.schemaVersion===1&&d.sensors.length===2&&d.sensors[0].nominalRateHz===10&&d.sensors[0].notes==='bench 2'&&!d.sensors.some(s=>s.id==='test'), JSON.stringify(d)); }
  R(`ssSelectedId='a';$('ssName').value='Scale A2';$('ssRate').value=20;$('ssNotes').value='n';`);
  await R(`sensorSettingsApply()`);
  ok('W7 apply: name and notes updated; rate changeable while empty; nothing sent without server', R(`sensors.get('a').name`)==='Scale A2'&&R(`sensors.get('a').state.rateHz`)===20&&/Nothing was sent/.test(R(`$('ssMessages').textContent`)));
  R(`handleSseMessage('/s1',JSON.stringify([{id:'a',t:1000,raw:5000},{id:'a',t:1050,raw:5001}]))`);
  R(`ssSelectedId='a';$('ssRate').value=99;sensorSettingsApply()`); await new Promise(r=>setTimeout(r,10));
  ok('W7 rate is fixed once samples exist', R(`sensors.get('a').state.rateHz`)===20&&R(`sensorSettingsRender(),$('ssRate').disabled`)===true);
  // W8 static: dynamic wizard ids and modals exist
  ok('W8 modals and settings-menu controls exist in the HTML', ['settingsModal','wizModal','wizBody','wizMin','wizClose','calWizardBtn','openSettingsMenuBtn','uiResetBtn','uiSaveServerBtn','uiResetServerBtn','uiExportBtn','ssSensor','ssApplyBtn','ssDownloadBtn','smTab_ui','smTab_sensor','smPane_ui','smPane_sensor','uiMessages','uiSettingsInfo'].every(i=>html.includes(`id="${i}"`)));


  // ===== v13 =====================================================================================
  const RNG13 = `let __s=424242;const rnd=()=>{__s=(__s*1103515245+12345)%2147483648;return __s/2147483648;};const gauss=()=>{const u=rnd()||1e-9,v=rnd();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);};`;
  R = await load();
  // X1 navigator at a full ring buffer (v12 bug: cached bucket became the oldest bucket after part of it was evicted)
  for (const cap of [1000, 10000]) {
    R = await load();
    R(`resizeBuffers(${cap}); for(let i=0;i<${cap}-10;i++) appendSample(nextSensorValue());`);
    const bad = R(`(()=>{let bad=0;for(let s=0;s<${cap}*0.9;s++){appendSample(nextSensorValue());const d=buildMiniData(),x=d[0],y=d[1];let ok=x.length>0&&Math.abs(x[0]-oldestTime()/1000)<0.5&&Math.abs(x[x.length-1]-newestTime()/1000)<0.1;for(let i=0;i<x.length;i++){if(!Number.isFinite(x[i])||!Number.isFinite(y[i])||(i&&x[i]<x[i-1])){ok=false;break;}}if(!ok)bad++;}return bad})()`);
    ok(`X1 navigator data stays valid while the ring buffer is full and wrapping (capacity ${cap})`, bad===0, 'bad frames '+bad);
  }
  R = await load();
  ok('X1 navigator refresh interval is shorter while the buffer is small', R(`(state.count=100,miniRefreshMs())`)===50 && R(`(state.count=30000,miniRefreshMs())`)===160 && R(`(state.count=100000,miniRefreshMs())`)===250);
  // X2 status counts only really streaming sensors
  R = await load();
  R(`globalThis.EventSource=class{constructor(u){this.url=u;this.readyState=0}close(){}}`);
  R(`applySensorList([{id:'a',name:'A',sseUrl:'/s1'},{id:'b',name:'B',sseUrl:'/s1'},{id:'c',name:'C',sseUrl:'/s2'}])`);
  ok('X2 unreachable streams are not counted as streaming (only the test signal)', /1 of 4 sensors streaming/.test(R(`$('statusText').textContent`)), R(`$('statusText').textContent`));
  R(`sseConnections.get('/s1').status='live'; updateStatusUI()`);
  ok('X2 a stream that opened counts for each of its sensors', /3 of 4 sensors streaming/.test(R(`$('statusText').textContent`)), R(`$('statusText').textContent`));
  // X3 static layout contract
  { const hdr = html.split('</header>')[0], mainHtml = html.split('</header>')[1];
    ok('X3 header order: title, sensor selector, test-signal select ... buttons, status last (right-bound)', hdr.indexOf('class="brand"')<hdr.indexOf('id="sensorSelect"') && hdr.indexOf('id="sensorSelect"')<hdr.indexOf('id="simModeSelect"') && hdr.indexOf('id="simModeSelect"')<hdr.indexOf('id="pauseBtn"') && hdr.indexOf('id="settingsBtn"')<hdr.indexOf('id="statusText"'));
    ok('X3 navigator is part of the main chart panel and has no title of its own', !/class="panel navigator"/.test(html) && !/Timeline navigator/.test(html) && mainHtml.indexOf('id="miniChart"')>mainHtml.indexOf('id="mainChart"') && mainHtml.indexOf('id="miniChart"')<mainHtml.indexOf('</section>', mainHtml.indexOf('id="mainChart"')));
    ok('X3 charts have no fixed CSS height that the legend would overflow', !/#mainChart\{height:/.test(html) && !/#miniChart\{height:/.test(html));
    ok('X3 Y axes are sized from their widest label; navigator X axis has room for its labels', (code.match(/size:axisWidthFit/g)||[]).length===2 && /size:30,grid/.test(code));
    ok('X3 wizard mode switch exists', /id="wizMode"/.test(html)); }

  // ---- weighted fitting ---------------------------------------------------------------------------------------------------
  R = await load();
  { const pts = `(()=>{const p=[];for(let k=0;k<9;k++){const g=k*25;for(let q=0;q<3;q++)p.push({id:'o'+k+'_'+q,massMg:g*1000,raw:5000+4*g+[ -1.3,0.4,0.9][q]*(0.3+0.05*g),n:400});}return p})()`;
    const a = J(`(()=>{const p=${pts};const x=fitCalibration(p,'linear'),y=fitCalibration(p,'linear',{weighting:'equal'});return {same:JSON.stringify(x.coef)===JSON.stringify(y.coef)&&x.sdRawRes===y.sdRawRes,scheme:y.weighting.scheme,red:y.reducedChi2,std:x.residuals[0].std,w:x.residuals[0].w}})()`);
    ok('X4 default weighting is "equal" and bit-identical to explicit equal weights (v12 behaviour)', a.same && a.scheme==='equal' && a.red===null && a.w===1); }
  { // weighted least squares against the closed form of weighted simple regression
    const r = J(`(()=>{const xs=[0,1,2,3],ys=[0.1,1.2,1.9,6],ws=[1,2,0.5,0.05],sw=ws.reduce((a,b)=>a+b),mx=ws.reduce((s,w,i)=>s+w*xs[i],0)/sw,my=ws.reduce((s,w,i)=>s+w*ys[i],0)/sw;
      let sxy=0,sxx=0;ws.forEach((w,i)=>{sxy+=w*(xs[i]-mx)*(ys[i]-my);sxx+=w*(xs[i]-mx)**2});const b=sxy/sxx,a=my-b*mx;const f=fitPolynomial(xs,ys,1,ws);return {da:f.g(0)-a,db:f.g(1)-f.g(0)-b}})()`);
    ok('X4 weighted line equals the closed-form weighted regression', near(r.da,0,1e-9,1e-9)&&near(r.db,0,1e-9,1e-9), JSON.stringify(r)); }
  { const r = J(`(()=>{${RNG13}const rms=a=>Math.sqrt(a.reduce((x,y)=>x+y*y,0)/a.length),res={equal:[],shrinkage:[],'variance-model':[]};
      for(let run=0;run<400;run++){const pts=[];for(let k=0;k<9;k++){const g=k*25;for(let p=0;p<4;p++)pts.push({id:'o'+k+'_'+p,massMg:g*1000,raw:5000+4*g+(0.3+0.08*g)*gauss(),n:400});}
        for(const m of Object.keys(res)){const f=fitCalibration(pts,'linear',{weighting:m});res[m].push((f.g(200000)-f.g(0))/200-4);}}
      return {e:rms(res.equal),s:rms(res.shrinkage),v:rms(res['variance-model'])}})()`);
    ok('X4 heteroscedastic data (sigma grows 0.3 -> 20 counts), 400 seeded runs: both weightings estimate the slope better than equal weights', r.s<r.e && r.v<r.e, `slope RMS error equal ${r.e.toFixed(4)}, shrinkage ${r.s.toFixed(4)}, variance model ${r.v.toFixed(4)}`);
    ok('X4 the variance model is clearly better than equal weights here (> 25 % lower error)', r.v<0.75*r.e, (100*(1-r.v/r.e)).toFixed(0)+' % lower'); }
  { const mk=(per)=>`(()=>{const p=[];[0,50,100].forEach((g,k)=>{for(let q=0;q<${per}[k];q++)p.push({id:'o'+k+'_'+q,massMg:g*1000,raw:5000+4*g+q*0.7,n:400});});return p})()`;
    const a = J(`(()=>{const p=${mk('[1,1,1]')};const f=fitCalibration(p,'linear',{weighting:'shrinkage'});return {s:f.weighting.scheme,r:f.weighting.reason}})()`);
    ok('X4 fallback: no replicate anywhere -> equal weights, reason announced', a.s==='equal' && /No reference mass/.test(a.r), JSON.stringify(a));
    const b = J(`(()=>{const p=[];[0,100].forEach((g,k)=>{for(let q=0;q<3;q++)p.push({id:'o'+k+'_'+q,massMg:g*1000,raw:5000+4*g+q,n:400});});const f=fitCalibration(p,'linear',{weighting:'shrinkage'});return {s:f.weighting.scheme,r:f.weighting.reason}})()`);
    ok('X4 fallback: only 2 different masses -> equal weights, reason announced', b.s==='equal' && /Fewer than 3/.test(b.r), JSON.stringify(b));
    const c = J(`(()=>{const p=${mk('[3,1,1]')};const f=fitCalibration(p,'linear',{weighting:'variance-model'});return {s:f.weighting.scheme,r:f.weighting.reason}})()`);
    ok('X4 fallback: variance model with < 3 replicated masses -> shrinkage, reason announced', c.s==='shrinkage' && /variance model needs/.test(c.r), JSON.stringify(c));
    const d = J(`(()=>{const p=${mk('[3,3,3]')};const f=fitCalibration(p,'anchors',{weighting:'shrinkage'});return {s:f.weighting.scheme,r:f.weighting.reason}})()`);
    ok('X4 the piecewise-linear model is not weighted (says so)', d.s==='equal' && /do not apply/.test(d.r), JSON.stringify(d)); }
  { // shrinkage: single-placement masses get the pooled variance; a "lucky" triple with SD ~ 0 does not get an infinite weight
    const r = J(`(()=>{const p=[];const add=(g,vals)=>vals.forEach((v,q)=>p.push({id:'o'+g+'_'+q,massMg:g*1000,raw:5000+4*g+v,n:400}));
      add(0,[0,0,0]);add(50,[-2,0,2]);add(100,[-3,1,2]);add(150,[0.4]);const f=fitCalibration(p,'linear',{weighting:'shrinkage'});const s=f.weighting.sigmaPerMass;
      return {s:s.map(x=>x.sigma),pooled:f.weighting.pooledSd,floor:f.weighting.floorSigma,sp2:(0+4+ (9+1+4) -0)}})()`);
    ok('X4 shrinkage: sigma stays above the floor for an all-equal triple and equals the pooled SD for a single placement', r.s[0]>=r.floor && r.s[0]>0.5*r.pooled && near(r.s[3],r.pooled,1e-9,1e-9), JSON.stringify(r)); }
  { const r = J(`(()=>{${RNG13}const p=[];for(let k=0;k<5;k++){const g=k*40;for(let q=0;q<3;q++)p.push({id:'o'+k+'_'+q,massMg:g*1000,raw:5000+4*g+(0.5+0.05*g)*gauss(),n:400});}
      const f=fitCalibration(p,'linear',{weighting:'shrinkage'});let chi=0;for(const x of f.residuals){chi+=x.w*x.resRaw*x.resRaw;if(Math.abs(x.std-x.resRaw*Math.sqrt(x.w))>1e-12)return {bad:true}}
      return {d:f.chi2-chi,red:f.reducedChi2-chi/f.dof,dof:f.dof}})()`);
    ok('X4 chi-square = sum w r^2, reduced chi-square = chi-square / dof, standardised residual = r sqrt(w)', !r.bad && near(r.d,0,1e-9,1e-9) && near(r.red,0,1e-9,1e-9) && r.dof===13, JSON.stringify(r)); }

  // ---- weight groups ----------------------------------------------------------------------------------------------------------
  R = await load();
  R(`wizLoadFromConfig(JSON.parse(JSON.stringify(EMBEDDED_CALIBRATION)))`);
  { const r = J(`(()=>({g:wiz.groups.map(g=>[g.groupId,g.massBasis,g.nominalMass,g.unit]),members:wiz.weights.filter(w=>w.groupId).length,mass:wizPoints(wiz).points.filter(p=>p.massMg===100000).length}))()`);
    ok('X5 a v12 file (no referenceWeightGroups) is migrated: the three 100 g weights form one nominal group', r.g.length===1 && r.g[0][1]==='nominal' && r.g[0][2]===100 && r.members===3 && r.mass===3, JSON.stringify(r)); }
  { // 3 weights x 4 placements with known weight offsets (-3, 0, +3 counts) and placement noise (+-0.5): ANOVA and relative masses are exact
    const r = J(`(()=>{wizLoadFromConfig(JSON.parse(JSON.stringify(EMBEDDED_CALIBRATION)));wiz.observations=[];const pat=[0.5,-0.5,0.5,-0.5],off={'ref-100-A':-3,'ref-100-B':0,'ref-100-C':3};
      let n=1;const add=(wid,load,base)=>{for(let q=0;q<4;q++)wiz.observations.push({observationId:'x'+(n++),loadId:load,rawMean:base+(off[wid]||0)+pat[q],include:true,sampleCount:400,placementIndex:q+1,removedAndReplaced:q>0,validity:{status:'ok',flagged:[],analysis:null}});};
      add('ref-empty','load-empty',4600);for(const l of ['A','B','C'])add('ref-100-'+l,'load-100-'+l,5000);add('ref-200-A','load-200-A',5400);
      const {points}=wizPoints(wiz),f=fitCalibration(points,'linear');const s=weightGroupStats(wiz,f)[0];
      return {sW:s.sW,sB:s.sB,dfW:s.dfW,dfB:s.dfB,verdict:s.verdict,rel:s.members.map(m=>m.relMassMg),slope:(f.g(200000)-f.g(0))/200000,se:s.members.map(m=>m.relMassSeMg)}})()`);
    ok('X5 variance components: within-weight SD = sqrt(SSw/(N-a)) = sqrt(1/3), between-weight SD = sqrt((MSB-MSW)/n0) = 2.986 (hand-computed for the constructed data), verdict "differ"', near(r.sW,Math.sqrt(1/3),1e-9,1e-9) && r.dfW===9 && r.dfB===2 && r.verdict==='differ' && near(r.sB,Math.sqrt((36-1/3)/4),1e-9,1e-9), JSON.stringify(r));
    ok('X5 relative masses = counts difference / slope: -0.75 g, 0, +0.75 g (4 counts per g); standard errors present', near(r.rel[0],-750,1e-6,1e-6)&&near(r.rel[1],0,1e-6,1e-6)&&near(r.rel[2],750,1e-6,1e-6)&&r.se.every(x=>x>0), JSON.stringify(r.rel)); }
  { const r = J(`(()=>{wizLoadFromConfig(JSON.parse(JSON.stringify(EMBEDDED_CALIBRATION)));const f=fitCalibration(wizPoints(wiz).points,'anchors');const s=weightGroupStats(wiz,f)[0];return {a:s.a,N:s.N,sW:s.sW,reason:s.reason,rel:s.members.map(m=>m.relMassMg)}})()`);
    ok('X5 demo data (one placement per weight): no variance components (no repeat), relative masses still given (-0.5, 0, +0.5 g)', r.a===3&&r.N===3&&r.sW===undefined&&/placed more than once/.test(r.reason)&&near(r.rel[0],-500,1e-6,1e-6)&&near(r.rel[2],500,1e-6,1e-6), JSON.stringify(r)); }
  { // massBasis nominal: assigned masses of the members are ignored; assigned: individual masses, different masses stay separate
    const r = J(`(()=>{wizLoadFromConfig(JSON.parse(JSON.stringify(EMBEDDED_CALIBRATION)));const A=wiz.weights.find(w=>w.weightId==='ref-100-A');A.assignedMass=100.2;
      const nom=wizPoints(wiz).points.map(p=>p.massMg);wiz.groups[0].massBasis='assigned';const asg=wizPoints(wiz).points.map(p=>p.massMg);
      const f=fitCalibration(wizPoints(wiz).points,'anchors');return {nom,asg,distinct:f.distinct}})()`);
    ok('X5 massBasis nominal: all members at the group mass; assigned: own masses, a deviating weight becomes its own mass level', r.nom.filter(m=>m===100000).length===3 && r.asg.includes(100200) && r.distinct===4, JSON.stringify(r)); }
  { const r = J(`(()=>{wizLoadFromConfig(JSON.parse(JSON.stringify(EMBEDDED_CALIBRATION)));wiz.sensorId=activeSensor.id;wiz.rateHz=80;wiz.fitModel='anchors';wiz.groups[0].aggregation='variance-components';
      wiz.observations.push({observationId:'extra',loadId:'load-100-A',rawMean:5008,include:true,sampleCount:400,placementIndex:9,removedAndReplaced:true,validity:{status:'ok',flagged:[],analysis:null}});
      const p=wizPoints(wiz).points,f=fitCalibration(p,'anchors');const a=f.anchors.find(x=>x.massMg===100000).raw;
      wiz.groups[0].aggregation='mean-of-placements';const f2=fitCalibration(wizPoints(wiz).points,'anchors');return {vc:a,mp:f2.anchors.find(x=>x.massMg===100000).raw}})()`);
    ok('X5 aggregation: mean of weight means ((5003+5000+5002)/3 = 5001.667) differs from mean of placements ((4998+5008+5000+5002)/4 = 5002)', near(r.vc,(5003+5000+5002)/3,1e-9,1e-9) && near(r.mp,5002,1e-9,1e-9), JSON.stringify(r)); }
  { const r = J(`(()=>{wizLoadFromConfig(JSON.parse(JSON.stringify(EMBEDDED_CALIBRATION)));wiz.sensorId=activeSensor.id;wiz.rateHz=80;wiz.fitModel='anchors';const b=wizBuild(),c=b.cfg;
      return {errs:b.errors,groups:c.referenceWeightGroups.map(g=>[g.groupId,g.massBasis,g.memberWeightIds.length,g.traceable,g.aggregation]),wg:c.referenceWeights.map(w=>w.groupId),rel:c.referenceWeights.filter(w=>w.relativeMassToGroupMean).length,
        fit:{w:c.fit.weighting.scheme,warn:c.fit.warnings.length,ov:c.fit.overriddenObservations},v:validateCalibrationConfig(c).errors.length,anchorSrc:c.calibrationAnchors.find(a=>a.referenceValue===100).sourceObservationIds.length}})()`);
    ok('X5 file: referenceWeightGroups, weights[].groupId, relative masses, fit.weighting / fit.warnings / fit.overriddenObservations written; validates; anchor lists all member observations', r.errs.length===0 && r.groups.length===1 && r.groups[0][2]===3 && r.groups[0][3]===false && r.wg.filter(x=>x).length===3 && r.rel===3 && r.fit.w==='equal' && r.fit.warn>0 && r.fit.ov.length===0 && r.v===0 && r.anchorSrc===3, JSON.stringify(r)); }
  { const bad = x => `(()=>{const c=JSON.parse(JSON.stringify(EMBEDDED_CALIBRATION));c.referenceWeightGroups=[{groupId:'g1',name:'g',nominalMass:100,unit:'g',memberWeightIds:['ref-100-A'],massBasis:'nominal',aggregation:'mean-of-placements'}];${x};return validateCalibrationConfig(c).errors.length})()`;
    ok('X5 validation: unknown group id, unknown member weight and bad massBasis are rejected; a consistent group passes', R(bad(''))===0 && R(bad("c.referenceWeights[1].groupId='nope'"))>0 && R(bad("c.referenceWeightGroups[0].memberWeightIds=['zzz']"))>0 && R(bad("c.referenceWeightGroups[0].massBasis='x'"))>0); }

  // ---- "include anyway" override ------------------------------------------------------------------------------------------------
  { R = await load();
    R(`wizLoadFromConfig(JSON.parse(JSON.stringify(EMBEDDED_CALIBRATION)));wiz.sensorId=activeSensor.id;wiz.rateHz=80;wiz.fitModel='linear';const o=wiz.observations[2];o.validity={status:'invalid',flagged:['Level step'],analysis:null};wizSetInclude(o,false);`);
    ok('X6 an excluded invalid observation is marked excluded in the file', R(`wizBuild().cfg.observations[2].excluded`)===true);
    R(`wizSetInclude(wiz.observations[2],true)`);
    const r = J(`(()=>{const b=wizBuild(),o=b.cfg.observations[2];return {inc:o.included,r:o.overrideReason,at:!!o.overrideAt,list:b.cfg.fit.overriddenObservations,warn:b.warnings.some(w=>w.code==='override'),plain:b.warnings.find(w=>w.code==='override').plain}})()`);
    ok('X6 "include anyway" is recorded: included, overrideReason, overrideAt, fit.overriddenObservations, and a warning', r.inc===true && r.r==='included anyway by user' && r.at && r.list.join()==='obs-100-B-01' && r.warn, JSON.stringify(r));
    R(`wizSetInclude(wiz.observations[2],false)`);
    ok('X6 excluding it again removes the override record', R(`wizBuild().cfg.observations[2].overrideReason`)===undefined && R(`wizBuild().cfg.fit.overriddenObservations.length`)===0);
    R(`wizSetInclude(wiz.observations[2],true); wizLoadFromConfig(JSON.parse(JSON.stringify(wizBuild().cfg)))`);
    ok('X6 a file written with an override loads it back (override survives a round trip)', R(`wiz.observations[2].override&&wiz.observations[2].override.reason`)==='included anyway by user' && R(`wiz.observations[2].include`)===true); }
  { // a fit without degrees of freedom is allowed, with a stored warning
    R = await load();
    R(`wizLoadFromConfig(JSON.parse(JSON.stringify(EMBEDDED_CALIBRATION)));wiz.sensorId=activeSensor.id;wiz.rateHz=80;wiz.fitModel='anchors';wiz.observations=wiz.observations.filter(o=>o.observationId!=='obs-100-B-01'&&o.observationId!=='obs-100-C-01');`);
    const r = J(`(()=>{const b=wizBuild();return {err:b.errors.length,dof:b.fit.dof,stored:b.cfg.fit.warnings.some(t=>/degrees of freedom/.test(t))}})()`);
    ok('X6 a fit without degrees of freedom is allowed and the warning is stored in the file (fit.warnings)', r.err===0 && r.dof===0 && r.stored, JSON.stringify(r)); }

  // ---- wizard observations list (v13 fixes) ----------------------------------------------------------------------------------
  R = await load();
  R(`for(let i=0;i<300;i++)appendSample(nextSensorValue()); wizNew(); wiz.sensorId=activeSensor.id; wiz.rateHz=80; wiz.captureSeconds=5; wiz.open=true; wizRecord(); for(let i=0;i<400;i++)appendSample(nextSensorValue());`);
  { const htmlObs = R(`wizPaneObs()`);
    ok('X7 the validity result of a recorded observation is expandable (details list with the individual checks)', /<details class="an" data-key="obs:obs-001"/.test(htmlObs) && /Autocorrelation/.test(htmlObs) && /Allan/.test(htmlObs));
    ok('X7 the full check list is kept in the observation and written to the file (validityChecks)', R(`wiz.observations[0].validity.analysis.checks.length`)>=5);
    ok('X7 load selector has previous / next buttons (previous disabled at the first load)', /data-wa="loadPrev"[^>]*disabled/.test(htmlObs) && /data-wa="loadNext"/.test(htmlObs));
    ok('X7 manual entry is one collapsible box, closed by default', /<details id="wizManualBox" style="margin-top:8px">/.test(htmlObs) && !/<details id="wizManualBox"[^>]* open/.test(htmlObs));
    R(`wiz.manualOpen=true`); ok('X7 the manual box keeps its open state across re-renders', /<details id="wizManualBox"[^>]* open>/.test(R(`wizPaneObs()`))); }
  R(`wizNew(); wiz.weights.push({weightId:'ref-a',name:'A',nominalMass:100,assignedMass:null,unit:'g',referenceUncertainty:null,groupId:null}); wizSyncLoads(); wiz.selLoad='load-empty';`);
  R(`wizOnClick({target:{closest:()=>({dataset:{wa:'loadNext'}})}})`); ok('X7 "next" selects the next load', R(`wiz.selLoad`)==='load-a');
  R(`wizOnClick({target:{closest:()=>({dataset:{wa:'loadPrev'}})}})`); ok('X7 "previous" goes back', R(`wiz.selLoad`)==='load-empty');
  { const w = JSON.parse(R(`JSON.stringify((()=>{wizNew();wiz.weights.push({weightId:'ref-a',name:'A',nominalMass:100,assignedMass:null,unit:'g',referenceUncertainty:null,groupId:null},{weightId:'ref-b',name:'B',nominalMass:100,assignedMass:null,unit:'g',referenceUncertainty:null,groupId:null});wizSyncLoads();
      wiz.comboOpen=true;const h1=wizPaneWeights();wiz.comboPick={'ref-a':true,'ref-b':true};wizOnClick({target:{closest:()=>({dataset:{wa:'comboCreate'}})}});
      const l=wiz.loads.find(x=>!x.auto);return {qty:/Qty/.test(wizPaneWeights())||/newQty/.test(wizPaneWeights()),dialog:/data-w="comboPick"/.test(h1),combo:l&&l.components.map(c=>c.quantity).join(),mass:l&&wizLoadMassSafe(l),open:wiz.comboOpen}})())`));
    ok('X7 Qty column is gone; a combination is made in a dialog with one checkbox per weight (quantity 1 each)', !w.qty && w.dialog && w.combo==='1,1' && w.mass===200000 && w.open===false, JSON.stringify(w)); }

  // ---- Simple mode ---------------------------------------------------------------------------------------------------------------
  { const p = s => J(`parseWeightSpec(${JSON.stringify(s)})`);
    const a = p('3 x 100 g, 1 x 200 g'), b = p('2×0.5 kg; 100g'), c = p('3 x 100 g, 100 g'), d = p('abc'), e = p('3 x 100 stone2'), f = p('');
    ok('X8 weight list parser: "3 x 100 g, 1 x 200 g"; "×", ";", decimals and units; equal masses are merged', JSON.stringify(a.items)==='[{"qty":3,"value":100,"unit":"g"},{"qty":1,"value":200,"unit":"g"}]' && b.items[0].unit==='kg' && b.items[0].qty===2 && b.items[0].value===0.5 && b.items[1].unit==='g' && c.items.length===1 && c.items[0].qty===4);
    ok('X8 weight list parser: garbage, unknown unit and empty input give readable errors', d.errors.length===1 && e.errors.length===1 && f.errors.length===1 && /3 x 100 g/.test(d.errors[0])); }
  R = await load(); R(`wizMode='simple'; wizNew(); wiz.sensorId=activeSensor.id; wiz.rateHz=80;`);
  { R(`wizSimpleSetWeights(parseWeightSpec('3 x 100 g, 1 x 200 g').items)`);
    const r = J(`(()=>({w:wiz.weights.length,g:wiz.groups.map(g=>[g.groupId,g.massBasis,g.memberWeightIds.length]),plan:wizPlan().map(p=>[p.load.name,p.req]),sel:wiz.selLoad}))()`);
    ok('X8 Simple: 3 x 100 g + 1 x 200 g -> empty + 4 weights, one nominal group of 3; plan: 3 placements per mass (group members take turns)', r.w===5 && r.g.length===1 && r.g[0][1]==='nominal' && r.g[0][2]===3 && JSON.stringify(r.plan)==='[["Empty platform",3],["100 g weight A",1],["100 g weight B",1],["100 g weight C",1],["200 g weight",3]]', JSON.stringify(r)); }
  { const r = J(`(()=>{wizNew();wizSimpleSetWeights(parseWeightSpec('2 x 50 g, 4 x 10 g').items);return wizPlan().map(p=>p.req)})()`);
    ok('X8 Simple plan: 2 members -> 2 + 1 placements, 4 members -> 1 each for the first three only', JSON.stringify(r)==='[3,1,1,1,0,2,1]', JSON.stringify(r)); }
  { R(`wizNew();wizSimpleSetWeights(parseWeightSpec('3 x 100 g, 1 x 200 g').items);wizRender();`);
    ok('X8 Simple: the next placement is proposed automatically (first load with missing placements)', R(`wiz.selLoad`)==='load-empty');
    // record the full plan through the real measurement machinery (10 s fixed = 800 samples each)
    R(`wiz.open=true; wiz.tab='observations'; for(let i=0;i<100;i++)appendSample(nextSensorValue());`);
    R(`wizRecord()`); ok('X8 Simple: recording length is fixed at 10 s (800 samples) whatever wiz.captureSeconds says', R(`state.measurement&&state.measurement.target`)===800 && R(`wizMode`)==='simple'); }
  { // plain verdicts
    const v = s => R(`wizPlainVerdict(${JSON.stringify(s)})`);
    ok('X8 plain-language verdicts: settled / still drifting / vibration / not analysed', v({status:'ok'})==='settled' && /still drifting/.test(v({status:'invalid',flagged:['Level step']})) && /vibration/.test(v({status:'suspect',flagged:['Vibration']})) && v({status:'n/a'})==='not analysed' && /not usable/.test(v({status:'invalid',flagged:['Allan deviation']}))); }
  { // automatic model choice
    R = await load(); R(`wizMode='simple'; wizLoadFromConfig(JSON.parse(JSON.stringify(EMBEDDED_CALIBRATION))); wiz.sensorId=activeSensor.id; wiz.rateHz=80;`);
    ok('X8 Simple chooses a straight line for the (nearly linear) demo data and uses shrinkage weights', R(`wizBuild().model`)==='linear' && R(`wizBuild().fit.weighting.requested`)==='shrinkage');
    R(`wiz.observations.find(o=>o.observationId==='obs-200-A-01').rawMean=5700`);
    ok('X8 Simple falls back to point-to-point lines when the line misses an observation by > 0.5 % of the span', R(`wizBuild().model`)==='anchors');
    R(`wizMode='advanced'; wiz.fitModel='poly2'`); ok('X8 Advanced uses the user\'s model choice', R(`wizBuild().model`)==='poly2'); 
    R(`wizMode='simple'; wiz.tab='fit'; wizRender()`); ok('X8 Simple has no Fit tab (a stored "fit" tab shows the Finish step)', /Step 3 of 3/.test(R(`wq('wizBody').innerHTML`))); 
    for (const t of ['weights','observations','review']) ok(`X8 Simple tab "${t}" renders without error`, (()=>{ try { R(`wiz.tab='${t}';wizRender();wq('wizBody').innerHTML.length`); return true; } catch(e){ console.log(e); return false; } })()); }
  { R = await load(); R(`wizMode='simple'; wizNew(); wiz.sensorId=activeSensor.id; wiz.rateHz=80; wizSimpleSetWeights(parseWeightSpec('3 x 100 g').items);`);
    R(`wiz.observations.push({observationId:'o1',loadId:'load-100g-A',rawMean:5000,include:false,exclusionReason:'validity check: invalid',validity:{status:'invalid',flagged:['Allan deviation'],analysis:null},placementIndex:1,removedAndReplaced:true,sampleCount:800}); wiz.tab='observations';`);
    const h2 = R(`wizSimpleMeasure()`);
    ok('X8 Simple: an unusable observation offers "include anyway"; the click records the override', /data-wa="inclAnyway"/.test(h2) && (R(`wizOnClick({target:{closest:()=>({dataset:{wa:'inclAnyway',i:'0'}})}})`),R(`wiz.observations[0].include&&wiz.observations[0].override.reason`)==='included anyway by user')); }
  // ---- wizard mode in ui-settings.json ----------------------------------------------------------------------------------------------
  R = await load();
  ok('X9 ui settings: wizardMode defaults to "simple", accepts "advanced", rejects other values', J(`sanitizeUiSettings({schemaVersion:1}).value.wizardMode`)==='simple' && J(`sanitizeUiSettings({schemaVersion:1,wizardMode:'advanced'}).value.wizardMode`)==='advanced' && J(`sanitizeUiSettings({schemaVersion:1,wizardMode:'pro'}).errors.length`)===1);
  R(`globalThis.__ls={};globalThis.localStorage={getItem:k=>(k in __ls?__ls[k]:null),setItem:(k,v)=>{__ls[k]=String(v)},removeItem:k=>{delete __ls[k]}};wizMode='advanced';uiLocalWrite(collectUiSettings());wizMode='simple';applyUiSettings(uiLocalRead())`);
  ok('X9 the wizard mode is saved with the other UI settings and restored from them', R(`wizMode`)==='advanced' && J(`uiLocalRead().wizardMode`)==='advanced');
  await R(`uiResetLocal()`); ok('X9 "Reset UI settings" returns the wizard to Simple mode', R(`wizMode`)==='simple');
  ok('X9 changing the mode switch autosaves it (control is in the stored-controls list)', /new Set\(\['wizMode'/.test(code));

  // ===== v14 ======================================================================================
  // ---- Y: uncertainty maths ----------------------------------------------------------------------
  R = await load();
  ok('Y1 t factor: 7 dof = 2.365 (about 2.4), 1 dof = 12.706, infinity -> 1.96, fewer than 1 dof is treated as 1', near(R(`tFactor(7)`),2.365,1e-9) && near(R(`tFactor(1)`),12.706,1e-9) && near(R(`tFactor(1e9)`),1.96,1e-3) && R(`tFactor(0.3)`)===12.706 && R(`tFactor(Infinity)`)===1.96);
  ok('Y1 t factor: non-integer dof lies between its neighbours; more dof -> smaller factor (more placements narrow the interval)', R(`tFactor(2.5)`)<4.303 && R(`tFactor(2.5)`)>3.182 && R(`tFactor(35)`)<2.042 && R(`tFactor(35)`)>2.021 && R(`tFactor(2)`)>R(`tFactor(5)`) && R(`tFactor(5)`)>R(`tFactor(30)`));
  { const f = s => R(`weightStdUncertaintyMg(${s})`);
    ok('Y2 certificate: u = U / k (0.2 mg, k = 2 -> 0.1 mg); default k = 2', near(f(`{unit:'g',massUncertainty:{value:0.2,unit:'mg',basis:'certificate',coverageFactor:2}}`),0.1,1e-12) && near(f(`{unit:'g',massUncertainty:{value:0.2,unit:'mg',basis:'certificate'}}`),0.1,1e-12) && near(f(`{unit:'g',massUncertainty:{value:0.3,unit:'mg',basis:'certificate',coverageFactor:3}}`),0.1,1e-12));
    ok('Y2 class tolerance / own estimate: rectangular, u = limit / sqrt 3 (0.0005 g = 0.5 mg -> 0.2887 mg)', near(f(`{unit:'g',massUncertainty:{value:0.0005,unit:'g',basis:'class-tolerance'}}`),0.5/Math.sqrt(3),1e-12) && near(f(`{unit:'g',massUncertainty:{value:0.5,unit:'mg',basis:'user-estimate'}}`),0.5/Math.sqrt(3),1e-12));
    ok('Y2 nothing typed / basis none / blank / negative -> null (weight is "not traceable")', f(`{unit:'g'}`)===null && f(`{unit:'g',massUncertainty:{value:1,unit:'mg',basis:'none'}}`)===null && f(`{unit:'g',massUncertainty:{value:'',unit:'mg',basis:'class-tolerance'}}`)===null && f(`{unit:'g',massUncertainty:{value:-1,unit:'mg',basis:'class-tolerance'}}`)===null);
    ok('Y2 a weight without its own unit uses the weight unit', near(f(`{unit:'mg',massUncertainty:{value:3,basis:'class-tolerance'}}`),3/Math.sqrt(3),1e-12)); }
  { const r = J(`(()=>{const c=combineUncertainties([{u:3,dof:5},{u:4,dof:Infinity}]);const one=combineUncertainties([{u:2,dof:7}]);return {u:c.u,dof:c.dof,k:c.k,U:c.U,oneDof:one.dof,oneU:one.U,inf:combineUncertainties([{u:1,dof:Infinity}]).k}})()`);
    ok('Y3 root-sum-of-squares and Welch-Satterthwaite: u = 5, dof = 5^4 / (3^4 / 5) = 38.6, k from the t table; a single component keeps its dof', near(r.u,5,1e-12) && near(r.dof,625/(81/5),1e-9) && near(r.U,r.k*5,1e-12) && r.k>1.96 && r.k<2.05 && near(r.oneDof,7,1e-9) && near(r.oneU,2*2.365,1e-9) && r.inf===1.96, JSON.stringify(r)); }
  // fit leverage: closed form of the standard error of a regression line
  const REPL = `(()=>{const offs=[[-0.6,0.5],[0.4,-0.7],[0.9,-0.2],[-0.3,0.8],[0.2,-0.9]],p=[];[0,50,100,150,200].forEach((g,k)=>offs[k].forEach((d,q)=>p.push({id:'o'+k+'_'+q,massMg:g*1000,raw:5000+4*g+d,n:400})));return p})()`;
  { const r = J(`(()=>{const p=${REPL},f=fitCalibration(p,'linear');const xs=p.map(q=>q.massMg),n=xs.length,xb=xs.reduce((a,b)=>a+b)/n,sxx=xs.reduce((a,x)=>a+(x-xb)**2,0),s=f.sdRawRes;
      const out=[];for(const m of [0,70000,100000,200000,260000]){out.push(f.seRawAt(m)-s*Math.sqrt(1/n+(m-xb)**2/sxx));}return {out,dof:f.dof,sd:f.sdRawAt(10000)-s}})()`);
    ok('Y4 straight line, equal weights: standard error of the fitted curve = s sqrt(1/n + (x - xbar)^2 / Sxx) at every mass (also outside the range); placement scatter = s', r.out.every(d=>near(d,0,1e-9,1e-9)) && r.dof===8 && near(r.sd,0,1e-9,1e-9), JSON.stringify(r)); }
  { const r = J(`(()=>{${RNG13}const p=[];for(let k=0;k<6;k++){const g=k*40;for(let q=0;q<3;q++)p.push({id:'o'+k+'_'+q,massMg:g*1000,raw:5000+4*g+(0.3+0.05*g)*gauss(),n:400});}
      const f=fitCalibration(p,'linear',{weighting:'variance-model'});const sg=new Map(f.weighting.sigmaPerMass.map(s=>[fitKey(s.massMg),s.sigma]));
      const w0=p.map(q=>1/sg.get(fitKey(q.massMg))**2),mw=w0.reduce((a,b)=>a+b)/w0.length,w=w0.map(v=>v/mw),sw=w.reduce((a,b)=>a+b),xb=p.reduce((s,q,i)=>s+w[i]*q.massMg,0)/sw,sxx=p.reduce((s,q,i)=>s+w[i]*(q.massMg-xb)**2,0);
      let ss=0;f.residuals.forEach((r,i)=>{ss+=w[i]*r.resRaw**2});const s2=ss/f.dof;const o=[];for(const m of [0,90000,240000])o.push(f.seRawAt(m)-Math.sqrt(s2*(1/sw+(m-xb)**2/sxx)));return {o,scheme:f.weighting.scheme}})()`);
    ok('Y4 weighted line (variance model): standard error = sqrt(s2 (1/sum w + (x - xbar_w)^2 / Sxx_w)) with weights normalised to mean 1', r.scheme==='variance-model' && r.o.every(d=>near(d,0,1e-9,1e-9)), JSON.stringify(r)); }
  { const r = J(`(()=>{const p=${REPL},f=fitCalibration(p,'anchors'),rs=replicateSigmas(p,f.groups);const a=f.groups;const seA=rs.sigma[1]/Math.sqrt(2),seB=rs.sigma[2]/Math.sqrt(2);const mid=(a[1].massMg+a[2].massMg)/2;
      return {dA:f.seRawAt(a[1].massMg)-seA,dMid:f.seRawAt(mid)-Math.sqrt((0.5*seA)**2+(0.5*seB)**2),dSd:f.sdRawAt(mid)-0.5*(rs.sigma[1]+rs.sigma[2]),dof:f.dof,pooled:rs.pooled>0}})()`);
    ok('Y4 piecewise model: error of the replicate mean at an anchor = sigma_k / sqrt(n_k); between anchors the two independent means are mixed linearly (root-sum-of-squares)', near(r.dA,0,1e-9,1e-9) && near(r.dMid,0,1e-9,1e-9) && near(r.dSd,0,1e-9,1e-9) && r.dof===5 && r.pooled, JSON.stringify(r)); }
  { const r = J(`(()=>{const p=[];[0,100,200].forEach((g,k)=>p.push({id:'x'+k,massMg:g*1000,raw:5000+4*g,n:400}));const f=fitCalibration(p,'anchors'),l=fitCalibration(p,'linear');return {aHas:!!f.seRawAt,lHas:!!l.seRawAt,ldof:l.dof}})()`);
    ok('Y4 without replicates the piecewise model has no placement scatter at all; a line through single placements has a standard error only if dof > 0', r.aHas===false && r.lHas===true && r.ldof===1); }
  // leave-one-out
  { const r = J(`(()=>{const p=${REPL};const l=looResiduals(p,'linear'),f=fitCalibration(p,'linear');
      // for a least-squares line: e_loo = r / (1 - h) with the leverage h = 1/n + (x-xbar)^2/Sxx
      const xs=p.map(q=>q.massMg),n=xs.length,xb=xs.reduce((a,b)=>a+b)/n,sxx=xs.reduce((a,x)=>a+(x-xb)**2,0);
      const d=p.map((q,i)=>{const h=1/n+(q.massMg-xb)**2/sxx;return l[i].looRaw-f.residuals[i].resRaw/(1-h)});
      const a=looResiduals(p,'anchors');const g=p.filter(q=>q.massMg===50000);const exp0=g[0].raw-g[1].raw;
      return {d,dA:a[2].looRaw-exp0,n:l.length,mm:l[0].looMassMg-l[0].looRaw/f.slopeAt(p[0].massMg)}})()`);
    ok('Y5 leave-one-out residual of a least-squares line equals r / (1 - leverage) (hat-matrix identity)', r.d.every(x=>near(x,0,1e-9,1e-9)) && r.n===10, JSON.stringify(r.d.slice(0,3)));
    ok('Y5 leave-one-out for the piecewise model with 2 placements: predicted by the other placement of the same mass', near(r.dA,0,1e-9,1e-9), String(r.dA)); }
  { const r = J(`(()=>{const p=[{id:'a',massMg:0,raw:1,n:1},{id:'b',massMg:1000,raw:2,n:1}];return looResiduals(p,'linear')})()`);
    ok('Y5 leave-one-out never throws: not enough masses left -> null', r.every(x=>x.looRaw===null)); }
  // calibration-side uncertainty block
  const WSET = (tol, extra='') => `(()=>{wizLoadFromConfig(JSON.parse(JSON.stringify(EMBEDDED_CALIBRATION)));wiz.observations=[];const pat=[0.5,-0.5,0.4],off={'ref-100-A':-3,'ref-100-B':0,'ref-100-C':3};let n=1;
      const add=(wid,load,base)=>{for(let q=0;q<3;q++)wiz.observations.push({observationId:'x'+(n++),loadId:load,rawMean:base+(off[wid]||0)+pat[q],include:true,sampleCount:400,placementIndex:q+1,removedAndReplaced:q>0,validity:{status:'ok',flagged:[],analysis:null}});};
      add('ref-empty','load-empty',4600);for(const l of ['A','B','C'])add('ref-100-'+l,'load-100-'+l,5000);add('ref-200-A','load-200-A',5400);${tol};${extra};
      const f=fitCalibration(wizPoints(wiz).points,'linear');return {f,p:buildUncertaintyProfile(wiz,f,null)}})()`;
  R = await load();
  { R(`globalThis.__u=${WSET('')}`);
    const r = J(`(()=>{const p=__u.p;const w=p.components.find(c=>c.id==='weight-tolerance');return {st:p.status,tr:p.traceable,basis:p.basis,wInc:w.included,notInc:p.notIncluded,nt:p.combined.table.length,dof:p.dof,k:p.k.value,cov:p.coverageProbability,validationKept:true}})()`);
    ok('Y6 no weight tolerance typed: block is "estimated", not traceable, basis repeatability; weight component left out and listed as not included', r.st==='estimated' && r.tr===false && r.basis==='repeatability' && r.wInc===false && r.notInc.includes('weight tolerance') && r.notInc.includes('hysteresis') && r.notInc.includes('temperature') && r.notInc.includes('creep') && r.notInc.includes('off-centre loading') && r.notInc.includes('drift between calibration and use') && r.nt>=21 && r.cov===0.95, JSON.stringify(r));
    const m = J(`(()=>{const u=computeUncertainty(__u.p,{massMg:100000,sigmaMg:20,neff:25,sigmaCounts:0.1,slopeMgPerCount:250});return {st:u.status,ids:u.components.map(c=>c.id),lab:u.label,U:u.expandedMg,uc:u.combinedMg,k:u.k,dof:u.dof,rssOk:Math.abs(u.combinedMg-Math.sqrt(u.components.reduce((s,c)=>s+c.uMg**2,0)))<1e-9,noise:u.components.find(c=>c.id==='reading-noise').uMg,res:u.components.find(c=>c.id==='resolution').uMg}})()`);
    ok('Y6 measurement: components = placement repeatability, object placement, reading noise (sigma / sqrt n_eff = 4 mg), resolution (one count = 250 mg, not dithered: 250 / sqrt 12 = 72 mg); label "estimated, repeatability only, not traceable"; U = k u_c', m.st==='ok' && m.ids.join()==='placement-repeatability,object-placement,reading-noise,resolution' && m.lab==='estimated, repeatability only, not traceable' && near(m.noise,4,1e-12) && near(m.res,250/Math.sqrt(12),1e-12) && m.rssOk && near(m.U,m.k*m.uc,1e-12) && m.dof>1 && m.dof<1e6, JSON.stringify(m));
    const d = J(`(()=>{const u=computeUncertainty(__u.p,{massMg:100000,sigmaMg:20,neff:25,sigmaCounts:2,slopeMgPerCount:250});return u.components.find(c=>c.id==='resolution').uMg-250/Math.sqrt(12)/5})()`);
    ok('Y6 reading noise above one count dithers the quantisation: resolution term is divided by sqrt n_eff', near(d,0,1e-9,1e-9));
    const q = J(`(()=>{const u=computeUncertainty(__u.p,{massMg:100000,sigmaMg:20,neff:null,sigmaCounts:0.1,slopeMgPerCount:250});return {n:u.components.find(c=>c.id==='reading-noise').uMg,note:u.components.find(c=>c.id==='reading-noise').note}})()`);
    ok('Y6 unknown n_eff (too few samples): the conservative choice n_eff = 1 is used and said so', near(q.n,20,1e-12) && /unknown/.test(q.note));
    const lo = J(`(()=>{const a=computeUncertainty(__u.p,{massMg:100000,sigmaMg:0.001,neff:50,sigmaCounts:5,slopeMgPerCount:1});const b=computeUncertainty(__u.p,{massMg:100000,sigmaMg:0.001,neff:50,sigmaCounts:5,slopeMgPerCount:1});return a.expandedMg===b.expandedMg&&a.expandedMg>0})()`);
    ok('Y6 deterministic and positive', lo); }
  { const none = J(`computeUncertainty(null,{massMg:1,sigmaMg:1,neff:5})`), bad = J(`computeUncertainty({status:'not-estimable',reason:'no replicates'},{massMg:1,sigmaMg:1,neff:5})`);
    ok('Y6 a calibration without an uncertainty block (e.g. the embedded demo) or a non-estimable block gives no number, only the reason', none.status==='unavailable' && /holds no repeatability/.test(none.reason) && bad.status==='unavailable' && bad.reason==='no replicates'); }
  { R(`globalThis.__u=${WSET("for(const w of wiz.weights)if(w.weightId!=='ref-empty')w.massUncertainty={value:0.5,unit:'mg',basis:'class-tolerance'}")}`);
    const r = J(`(()=>{const p=__u.p,w=p.components.find(c=>c.id==='weight-tolerance'),at=m=>w.table.find(t=>Math.abs(t.massMg-m)<1e-6);return {inc:w.included,basis:p.basis,u0:at(0).uMg,u100:at(100000).uMg,u200:at(200000).uMg,note:w.note,tab:w.table.length,lab:computeUncertainty(p,{massMg:100000,sigmaMg:5,neff:30,sigmaCounts:2,slopeMgPerCount:250}).label}})()`);
    const u1 = 0.5/Math.sqrt(3);
    ok('Y7 typed class tolerance 0.5 mg on every weight: empty platform 0; one 200 g weight = u = 0.2887 mg; THREE independent 100 g weights = u / sqrt 3 = 0.1667 mg (placements of the same weight do not reduce it)', r.inc && near(r.u0,0,1e-12,1e-12) && near(r.u200,u1,1e-9) && near(r.u100,u1/Math.sqrt(3),1e-9) && r.tab===3, JSON.stringify(r));
    ok('Y7 the common-bias caveat is part of the stored note; label becomes "estimated, not traceable"; basis names the weights', /shared by ALL the weights/.test(r.note) && r.lab==='estimated, not traceable' && r.basis==='repeatability+weight-tolerances'); }
  { R(`globalThis.__u=${WSET("for(const w of wiz.weights)if(w.weightId!=='ref-empty')w.massUncertainty={value:0.5,unit:'mg',basis:'class-tolerance'};wiz.weights.find(w=>w.weightId==='ref-100-B').massUncertainty=null")}`);
    const r = J(`(()=>{const p=__u.p,w=p.components.find(c=>c.id==='weight-tolerance');return {inc:w.included,note:w.note,lab:computeUncertainty(p,{massMg:100000,sigmaMg:5,neff:30,sigmaCounts:2,slopeMgPerCount:250}).label,notInc:p.notIncluded.includes('weight tolerance')}})()`);
    ok('Y7 one weight without a typed tolerance: the whole component is left out (never half-included), the label stays "repeatability only"', !r.inc && /left out/.test(r.note) && /repeatability only/.test(r.lab) && r.notInc, JSON.stringify(r)); }
  { const r = J(`(()=>{wizLoadFromConfig(JSON.parse(JSON.stringify(EMBEDDED_CALIBRATION)));wiz.observations=wiz.observations.filter(o=>o.observationId!=='obs-100-B-01'&&o.observationId!=='obs-100-C-01');const f=fitCalibration(wizPoints(wiz).points,'anchors');const p=buildUncertaintyProfile(wiz,f,null);return {st:p.status,reason:p.reason,comps:p.components.length,u:computeUncertainty(p,{massMg:1,sigmaMg:1,neff:3}).status}})()`);
    ok('Y7 one placement per mass (piecewise model): repeatability cannot be estimated -> "not-estimable" with a reason, and no number is ever shown', r.st==='not-estimable' && /placed more than once/.test(r.reason) && r.comps===0 && r.u==='unavailable', JSON.stringify(r)); }
  { const r = J(`(()=>{const hi=buildUncertaintyProfile(wiz,fitCalibration(wizPoints(wiz).points,'linear'),null);return 1})()`); }
  // hysteresis maths
  { const r = J(`(()=>{const P=[];const add=(g,dir,d)=>P.push({massMg:g*1000,raw:4600+4*g+d,direction:dir});add(0,'up',0);add(0,'down',0);add(100,'up',0);add(100,'up',0.4);add(100,'down',3);add(100,'down',3.4);add(200,'up',0);add(200,'down',5);add(150,null,9);add(150,'up',1);
      const h=hysteresisAnalysis(P,m=>0.004);return {n:h.levels.length,d:h.levels.map(l=>l.diffMg),dc:h.levels.map(l=>l.diffCounts),max:h.maxAbsDiffMg,se:h.levels[1].seMg,none:hysteresisAnalysis([{massMg:1,raw:1,direction:'up'}],()=>1)}})()`);
    ok('Y8 hysteresis: per mass mean(down) - mean(up) in counts and mg (3.0 counts / 0.004 per mg = 750 mg); levels without both directions and observations without direction are ignored; none -> null', r.n===3 && near(r.dc[1],3.0,1e-9) && near(r.d[1],750,1e-9) && near(r.d[2],1250,1e-9) && near(r.d[0],0,1e-9,1e-9) && near(r.max,1250,1e-9) && r.se>0 && r.none===null, JSON.stringify(r)); }
  // ---- bands --------------------------------------------------------------------------------------
  R = await load();
  { const r = J(`(()=>{const v=[...Array(70).fill(100),...Array(10).fill(0)],s=bandStats(v,'mean','symmetric',{}),a=bandStats(v,'mean','asymmetric',{}),w=bandStats(v,'mean','stepaware',{});
      const f=10/80,H=100,expUp=H*(1-f+Math.sqrt(f*(1-f)));let mx=0,mf=0;for(let k=1;k<1000;k++){const q=k/1000,y=1-q+Math.sqrt(q*(1-q));if(y>mx){mx=y;mf=q}}
      return {symUp:s.upper,expUp,asUp:a.upper,asLo:a.lower,asVal:a.value,wStart:w.start,mx,mf}})()`);
    ok('Y9 handout formula: after a down-step with 10 of 80 new samples the symmetric upper edge is H (1 - f + sqrt(f(1-f))) = 120.6 % of the old level; the maximum is 1.207 H at f = 0.146', near(r.symUp,r.expUp,1e-9) && r.symUp>100 && near(r.mx,1.2071,1e-3) && near(r.mf,0.146,2e-3), JSON.stringify(r));
    ok('Y9 asymmetric band cannot exceed the old level after a down-step: upper = mean of the samples above the mean = 100 exactly, lower = 0', near(r.asUp,100,1e-12) && near(r.asLo,0,1e-12) && near(r.asVal,87.5,1e-12)); }
  { const r = J(`(()=>{${RNG13}const noise=()=>gauss();
      const stepV=[...Array.from({length:70},()=>noise()),...Array.from({length:10},()=>10+noise())],flat=Array.from({length:80},()=>noise()),ramp=Array.from({length:80},(_,i)=>0.25*i+noise()),down=[...Array.from({length:68},()=>10+noise()),...Array.from({length:12},()=>noise())];
      const s=bandStats(stepV,'mean','stepaware',{}),f=bandStats(flat,'mean','stepaware',{}),rp=bandStats(ramp,'mean','stepaware',{}),d=bandStats(down,'mean','stepaware',{}),sym=bandStats(down,'mean','symmetric',{}),med=bandStats(stepV,'median','stepaware',{}),short=bandStats(stepV.slice(30,50),'mean','stepaware',{}),ema=bandStats(stepV,'ema','stepaware',{});
      return {sStart:s.start,sVal:s.value,sUp:s.upper,fStart:f.start,rStart:rp.start,dStart:d.start,dVal:d.value,dUp:d.upper,symUp:sym.upper,mStart:med.start,mVal:med.value,shortStart:short.start,emaStart:ema.start}})()`);
    ok('Y10 step-aware: a clean 10 sigma step is found (window restarts at about sample 70) and the band sits on the NEW level (no overshoot into the old one)', Math.abs(r.sStart-70)<=3 && Math.abs(r.sVal-10)<1 && r.sUp<10+3.5, JSON.stringify(r));
    ok('Y10 step-aware: white noise and a slow ramp do not restart the window (a ramp is a trend, not a step)', r.fStart===0 && r.rStart===0, JSON.stringify({f:r.fStart,r:r.rStart}));
    ok('Y10 step-aware after a DOWN-step: the symmetric band overshoots above the old level, the step-aware one stays at the new level + 3 sigma', r.symUp>10+2 && r.dUp<3.5 && Math.abs(r.dVal-0)<1 && Math.abs(r.dStart-68)<=3, JSON.stringify({sym:r.symUp,up:r.dUp,start:r.dStart}));
    ok('Y10 step-aware works for the median too; windows shorter than the analysis minimum and EMA estimators are not restarted', Math.abs(r.mStart-70)<=3 && Math.abs(r.mVal-10)<1 && r.shortStart===0 && r.emaStart===0); }
  // ---- authentication ---------------------------------------------------------------------------------------
  ok('Y11 base64 matches RFC 7617 example (Aladdin:open sesame) and Node for padding lengths 0, 1, 2 and non-ASCII text', R(`basicAuthHeader('Aladdin','open sesame')`)==='Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==' && ['a:b','ab:c','abc:d','user:pässword €','']  .every(s=>{const [u,...p]=s.split(':');return R(`basicAuthHeader(${JSON.stringify(u)},${JSON.stringify(p.join(':'))})`)==='Basic '+Buffer.from(s.includes(':')?s:u+':','utf8').toString('base64')}));
  // ---- history helpers ----------------------------------------------------------------------------------------
  { const r = J(`(()=>{const ex={t:[],raw:[],id:[]};for(let i=1000;i<1010;i++){ex.t.push(i*12.5);ex.raw.push(5000+i%7);ex.id.push(i)}
      const inc={t:[],raw:[],id:[]};for(let i=995;i<1005;i++){inc.t.push(i*12.5);inc.raw.push(9000);inc.id.push(i)}
      const m=mergeSampleLists(ex,inc);const noId=mergeSampleLists({t:[0,10],raw:[1,2],id:[NaN,NaN]},{t:[10,5,20],raw:[9,3,4],id:[NaN,NaN,NaN]});
      return {n:m.t.length,added:m.added,dup:m.duplicates,sorted:m.t.every((v,i)=>!i||v>m.t[i-1]),ids:m.id.join(),keptOld:m.raw[m.id.indexOf(1000)],newRaw:m.raw[0],noIdT:noId.t.join(),noIdDup:noId.duplicates}})()`);
    ok('Y12 merge: ids 995..1004 into 1000..1009 -> 5 added, 5 duplicates, ascending, existing samples win; without ids duplicates are found by time', r.n===15 && r.added===5 && r.dup===5 && r.sorted && r.ids==='995,996,997,998,999,1000,1001,1002,1003,1004,1005,1006,1007,1008,1009' && r.keptOld===5000+1000%7 && r.newRaw===9000 && r.noIdT==='0,5,10,20' && r.noIdDup===1, JSON.stringify(r)); }
  { const ids=[1,2,4000000000],ts=[10,20,4000000001],raws=[-5,2147483647,-2147483648],b=R(`encodeHistoryBinary(${JSON.stringify(ids)},${JSON.stringify(ts)},${JSON.stringify(raws)})`);
    const dec = J(`decodeHistoryBinary(new Uint8Array(${JSON.stringify(Array.from(new Uint8Array(b)))}))`);
    ok('Y12 proposed binary layout (HIST, v1, count, 12-byte records) round-trips including the u32 and i32 extremes; 12 bytes per sample', JSON.stringify(dec.id)===JSON.stringify(ids) && JSON.stringify(dec.t)===JSON.stringify(ts) && JSON.stringify(dec.raw)===JSON.stringify(raws) && b.byteLength===12+36);
    const bad = s => R(`(()=>{try{${s};return 'accepted'}catch(e){return e.message}})()`);
    ok('Y12 bad magic, unknown version and truncated chunks are rejected with a reason', /bad magic/.test(bad(`decodeHistoryBinary(new Uint8Array(20))`)) && /truncated/.test(bad(`const b=new Uint8Array(encodeHistoryBinary([1,2],[1,2],[1,2]));decodeHistoryBinary(b.slice(0,b.length-4))`)) && /version/.test(bad(`const b=new Uint8Array(encodeHistoryBinary([1],[1],[1]));b[4]=9;decodeHistoryBinary(b)`)));
    const j1 = J(`decodeHistoryJson({samples:[{n:5,t:10,raw:1.4},{n:6,t:20,raw:2}]})`), j2 = J(`decodeHistoryJson({ids:[7,8],t:[1,2],raw:[3,4]})`), j3 = J(`decodeHistoryJson([{n:9,t:5,raw:6}])`), j4 = J(`decodeHistoryJson(null)`);
    ok('Y12 JSON chunks: {samples:[{n,t,raw}]}, {ids,t,raw} and bare arrays are accepted; nonsense gives an empty chunk', j1.id.join()==='5,6' && j1.raw.join()==='1,2' && j2.id.join()==='7,8' && j3.id.join()==='9' && j4.id.length===0); }

  // ---- Z: window seconds, ± lines, bands in the curve --------------------------------------------------------------
  R = await load();
  R(`state.window=state.activeWindow=80; syncWindowSeconds();`);
  ok('Z1 window length also in seconds (samples / rate): 80 samples at 80 Hz = 1 s', R(`$('windowSeconds').value`)===1 && R(`$('windowRateText').textContent`)==='80');
  R(`setMovingAverageWindow(40,true,false,false)`); ok('Z1 changing the samples updates the seconds', R(`$('windowSeconds').value`)===0.5);
  R(`$('windowSeconds').value='7'; setMovingAverageWindow(Math.round(0.25*RATE_HZ),true,false,true)`); ok('Z1 typing seconds sets the samples (0.25 s = 20) without overwriting what is being typed', R(`state.window`)===20 && R(`$('windowSeconds').value`)==='7');
  R(`RATE_HZ=10;PERIOD_MS=100;state.window=80;syncWindowSeconds()`); ok('Z1 a 10 Hz sensor: 80 samples = 8 s', R(`$('windowSeconds').value`)===8);
  R = await load();
  R(`state.window=state.activeWindow=80; for(let i=0;i<500;i++) appendSample(5000); for(let i=0;i<40;i++) appendSample(5100); updateMetrics();`);
  { const b = J(`(()=>{const L=state.count-1,lo=L-79;let mn=Infinity,mx=-Infinity;for(let i=lo;i<=L;i++){const v=getMassMA(i);mn=Math.min(mn,v);mx=Math.max(mx,v);}return {range:mx-mn,text:$('pmStab').textContent,sig:$('pmSigma').textContent,mean:$('pmMean').textContent,st:windowStability(false,0).range}})()`);
    ok('Z2 stability = max - min of the DISPLAYED value over the last window: 40 samples at +100 counts = +50 counts = 12.5 g (250 mg per count) while the window slides', near(b.range,12500,1e-9,1e-6) && near(b.st,b.range,1e-9,1e-6) && /moved/.test(b.text) && /moved 1[23] g/.test(b.text), JSON.stringify(b));
    ok('Z2 three "±" lines exist: spread σ, σ/√n_eff of the average, stability; n_eff is shown with n', /^σ /.test(b.sig) && /±avg/.test(b.mean) && /n_eff ≈ [\d.]+ of 80/.test(b.mean), b.mean); }
  { R = await load();
    R(`state.simMode='quiet';state.window=state.activeWindow=200; for(let i=0;i<1000;i++) appendSample(nextSensorValue()); updateMetrics();`);
    const a = J(`(()=>{const L=state.count-1,x=new Float64Array(200);for(let j=0;j<200;j++)x[j]=getNetMg(L-199+j);const ac=analysisAutocorr(x,50),sd=getMassSD(L);return {neff:ac.neff,txt:$('pmMean').textContent,sd,exp:sd/Math.sqrt(ac.neff)}})()`);
    const mm = a.txt.match(/±avg ([\d.,]+) (\w+)/);
    ok('Z2 ±avg = σ / sqrt(n_eff) with n_eff from the autocorrelation of the window (quiet signal: n_eff close to n)', a.neff>100 && !!mm && Math.abs(Number(mm[1].replace(',','.'))*1000-a.exp)/a.exp<0.2, a.txt+' expected '+a.exp.toFixed(2)+' mg');
    R(`state.window=state.activeWindow=30; updateMetrics()`); ok('Z2 a window shorter than the analysis minimum says what it needs', /needs ≥ 64 samples/.test(R(`$('pmMean').textContent`))); }
  { R = await load();
    R(`state.window=state.activeWindow=80; for(let i=0;i<300;i++) appendSample(5100); for(let i=0;i<10;i++) appendSample(5000);`);
    const r = J(`(()=>{const L=state.count-1,v=[];for(let j=L-79;j<=L;j++)v.push(getNetMg(j));const o={};
      for(const m of ['symmetric','asymmetric','stepaware']){bandMode=m;state.curveCache={key:'',map:new Map()};const c=buildEstimatorCurve(L,L,false),d=bandStats(v,'mean',m,{});o[m]={u:c.upper(L)-d.upper,l:c.lower(L)-d.lower,c:c.center(L)-d.value,up:c.upper(L)};}
      bandMode='symmetric';const base=getMassMA(L)+getMassSD(L);return {o,base,old:getNetMg(0)}})()`);
    ok('Z3 chart curve = bandStats of the window for every mode (and the default is still centre ± SD from the O(1) rolling values)', ['symmetric','asymmetric','stepaware'].every(m=>near(r.o[m].u,0,1e-9,1e-6)&&near(r.o[m].l,0,1e-9,1e-6)&&near(r.o[m].c,0,1e-9,1e-6)) && near(r.o.symmetric.up,r.base,1e-9,1e-6), JSON.stringify(r.o));
    ok('Z3 after a down-step of 100 counts the symmetric band overshoots the old level; asymmetric stays at the old level (upper = old level)', r.o.symmetric.up>r.old+1 && near(r.o.asymmetric.up,r.old,1e-9,1e-6), `old ${r.old} sym ${r.o.symmetric.up} asym ${r.o.asymmetric.up}`); }
  { R = await load();
    R(`state.window=state.activeWindow=80; for(let i=0;i<400;i++) appendSample(5000+(i%5)-2); state.live=false; state.viewMin=getTime(0); state.viewMax=newestTime();`);
    const r = J(`(()=>{const o={};for(const m of ['symmetric','asymmetric','stepaware']){setBandMode(m);const d=buildVisibleData();o[m]={n:d[0].length,fin:Array.from(d[3]).every(Number.isFinite)&&Array.from(d[4]).every(Number.isFinite),ordered:Array.from(d[3]).every((v,i)=>v>=d[4][i]-1e-9),stride:state.curveStride};}
      setBandMode('bogus');return {o,back:bandMode,lab:[setBandMode('asymmetric'),bandLabels()][1]}})()`);
    ok('Z3 every band mode produces finite, ordered upper/lower series over a whole view; an unknown mode falls back to symmetric; labels follow the mode', ['symmetric','asymmetric','stepaware'].every(m=>r.o[m].fin&&r.o[m].ordered&&r.o[m].n>300) && r.back==='symmetric' && /mean of samples above/.test(r.lab[0]), JSON.stringify(r)); }
  { const s = x => J(`sanitizeUiSettings(${x})`);
    ok('Z4 UI settings: bandMode default symmetric, accepts the three modes, rejects others (additive key, schemaVersion stays 1)', s(`{schemaVersion:1}`).value.bandMode==='symmetric' && s(`{schemaVersion:1,bandMode:'stepaware'}`).value.bandMode==='stepaware' && s(`{schemaVersion:1,bandMode:'x'}`).errors.length===1 && J(`UI_DEFAULTS.schemaVersion`)===1);
    R(`globalThis.__ls={};globalThis.localStorage={getItem:k=>(k in __ls?__ls[k]:null),setItem:(k,v)=>{__ls[k]=String(v)},removeItem:k=>{delete __ls[k]}};setBandMode('asymmetric');uiLocalWrite(collectUiSettings());setBandMode('symmetric');applyUiSettings(uiLocalRead())`);
    ok('Z4 the band mode is stored with the UI settings, restored from them and reset by "Reset UI settings"', R(`bandMode`)==='asymmetric' && (await R(`uiResetLocal().then(()=>bandMode)`))==='symmetric'); }
  // ---- Z: spans ------------------------------------------------------------------------------------------------------
  ok('Z5 duration text: 0.3 s, 12.5 s, 3.0 min', R(`fmtSpan(0.3)`)==='0.30 s' && R(`fmtSpan(12.5)`)==='12.5 s' && R(`fmtSpan(180)`)==='3.0 min' && R(`fmtSpan(NaN)`)==='—');
  R = await load(); R(`state.window=state.activeWindow=80; for(let i=0;i<300;i++) appendSample(5000); state.nextTime+=5000; for(let i=0;i<200;i++) appendSample(5000); updateMetrics()`);
  { R(`selectInterval(getTime(250),getTime(349))`); const t = R(`$('selectionSummary').innerHTML`); R(`state.measurement=null`);
    ok('Z5 with a gap the duration shown is the real time span, not samples / rate', /selected samples<\/strong> · [\d.]+ s/.test(t) && J(`(()=>{const s=state.selection;return (s.t1-s.t0+PERIOD_MS)/1000})()`)>5, t.slice(0,120)); }
  // ---- Z: wizard end to end with uncertainty -------------------------------------------------------------------------------------
  const WIZ_FILL = (tol, dirs) => `(()=>{wizLoadFromConfig(JSON.parse(JSON.stringify(EMBEDDED_CALIBRATION)));wiz.sensorId=activeSensor.id;wiz.rateHz=80;wiz.fitModel='linear';wiz.observations=[];const pat=[0.5,-0.5,0.4],off={'ref-100-A':-3,'ref-100-B':0,'ref-100-C':3};let n=1;
      const add=(wid,load,base,dir,dd)=>{for(let q=0;q<3;q++)wiz.observations.push({observationId:'x'+(n++),loadId:load,rawMean:base+(off[wid]||0)+pat[q]+(dir==='down'?dd:0),include:true,sampleCount:400,durationMs:5000,placementIndex:q+1,removedAndReplaced:q>0,loadingDirection:dir,validity:{status:'ok',flagged:[],analysis:null}});};
      for(const dir of ${dirs}){add('ref-empty','load-empty',4600,dir,0);for(const l of ['A','B','C'])add('ref-100-'+l,'load-100-'+l,5000,dir,3);add('ref-200-A','load-200-A',5400,dir,5);}${tol};})()`;
  R = await load();
  R(WIZ_FILL(`for(const w of wiz.weights)if(w.weightId!=='ref-empty')w.massUncertainty={value:0.5,unit:'mg',basis:'class-tolerance'}`,`[null]`));
  { const r = J(`(()=>{const b=wizBuild(),c=b.cfg;return {err:b.errors,unc:c.uncertainty.status,basis:c.uncertainty.basis,trace:c.uncertainty.traceable,val:c.validation.status,mu:c.referenceWeights.filter(w=>w.massUncertainty).map(w=>[w.weightId,w.massUncertainty.basis,w.massUncertainty.unit,w.massUncertainty.standardUncertaintyMg,w.massUncertainty.distribution]),v:validateCalibrationConfig(c).errors.length,warn:b.warnings.map(w=>w.code)}})()`);
    ok('Z6 file: separate "uncertainty" block (estimated, not traceable, basis incl. weight tolerances) next to validation.status "not-characterized"; typed tolerances written per weight with the standard uncertainty; file validates', r.err.length===0 && r.unc==='estimated' && r.basis==='repeatability+weight-tolerances' && r.trace===false && r.val==='not-characterized' && r.mu.length===4 && r.mu[0][1]==='class-tolerance' && near(r.mu[0][3],0.5/Math.sqrt(3),1e-9) && r.mu[0][4]==='rectangular' && r.v===0 && !r.warn.includes('noTolerance'), JSON.stringify(r));
    const act = await R(`wizActivate().then(()=>JSON.stringify({msg:wiz.message,hasUnc:!!state.calConfig.uncertainty,prep:!!calibration.uncertainty,st:calibration.uncertainty&&calibration.uncertainty.status}))`);
    ok('Z6 activation carries the uncertainty block into the active (prepared) calibration', JSON.parse(act).hasUnc && JSON.parse(act).prep && JSON.parse(act).st==='estimated', act);
    R(`state.simMode='quiet'; state.window=state.activeWindow=400; resizeBuffers(20000); for(let i=0;i<50;i++)appendSample(5000); $('measSamples').value=400; startMeasurement(); for(let i=0;i<400;i++)appendSample(5000+((i*7)%5)-2);`);
    const m = J(`(()=>{const e=state.lastMeasurement,u=e.uncertainty;return {st:u&&u.status,lab:u&&u.label,U:u&&u.expandedMg,ids:u&&u.components.map(c=>c.id).join(),txt:$('measUnc').innerHTML,line:state.logs.find(l=>l.type==='measurement')&&uncertaintyLineText(state.logs.find(l=>l.type==='measurement').uncertainty),mass:u&&u.massMg,tip:describeEventHTML(e)}})()`);
    ok('Z6 a finished measurement carries "± U (estimated, not traceable)" with the 5 components (placement, object, reading noise, resolution, weight tolerance); shown in the card, the log row and the event tooltip', m.st==='ok' && m.lab==='estimated, not traceable' && m.U>0 && m.ids==='placement-repeatability,object-placement,reading-noise,resolution,weight-tolerance' && /±/.test(m.txt) && /not traceable/.test(m.txt) && /±/.test(m.line) && /not traceable/.test(m.tip), JSON.stringify({st:m.st,lab:m.lab,U:m.U,ids:m.ids}));
    ok('Z6 absolute mass of the result is used for the table lookup (5000 counts = 100 g)', near(m.mass,100000,1e-3,50), String(m.mass));
    ok('Z6 the status line under the cards describes the estimated uncertainty and what is not included', /estimated from this calibration/.test(R(`(updateMetrics(),$('uncertaintyStatus').textContent)`)) && /creep/.test(R(`$('uncertaintyStatus').textContent`))); }
  { R = await load(); R(WIZ_FILL(`0`,`[null]`));
    const r = J(`(()=>{const b=wizBuild();return {basis:b.cfg.uncertainty.basis,warn:b.warnings.map(w=>w.code),plain:b.warnings.find(w=>w.code==='noTolerance').plain}})()`);
    ok('Z6 no tolerance typed: warning "noTolerance" (plain wording) and basis "repeatability"', r.basis==='repeatability' && r.warn.includes('noTolerance') && /Type the weights’ tolerance/.test(r.plain), JSON.stringify(r)); }
  { R = await load(); R(`wizLoadFromConfig(JSON.parse(JSON.stringify(EMBEDDED_CALIBRATION)));wiz.sensorId=activeSensor.id;wiz.rateHz=80;wiz.fitModel='anchors';wiz.observations=wiz.observations.filter(o=>o.observationId!=='obs-100-B-01'&&o.observationId!=='obs-100-C-01')`);
    const r = J(`(()=>{const b=wizBuild();return {err:b.errors.length,st:b.cfg.uncertainty.status,w:b.warnings.some(w=>w.code==='uncertainty'),v:validateCalibrationConfig(b.cfg).errors.length}})()`);
    ok('Z6 a calibration whose repeatability cannot be estimated is still written (valid), marked "not-estimable", with a warning', r.err===0 && r.st==='not-estimable' && r.w && r.v===0, JSON.stringify(r)); }
  // old / imported files keep working
  { R = await load(); const u = J(`computeUncertainty(calibration.uncertainty,{massMg:1,sigmaMg:1,neff:5})`);
    ok('Z6 the embedded demo calibration has no uncertainty block: results say why there is no ± instead of inventing one', u.status==='unavailable'); 
    R(`for(let i=0;i<300;i++)appendSample(5000);selectInterval(getTime(50),getTime(250))`); ok('Z6 a selection under such a calibration shows the reason, no number', /not estimated/.test(R(`$('selectionSummary').innerHTML`)) && !/ ± [\d.]+ g/.test(R(`$('selectionSummary').innerHTML`))); }
  // ---- Z: hysteresis through the wizard ------------------------------------------------------------------------------------------------
  R = await load(); R(WIZ_FILL(`0`,`['up','down']`));
  { const r = J(`(()=>{const b=wizBuild(),c=b.cfg,h=c.reserved.hysteresisAnalysis;return {err:b.errors,dir:c.reserved.loadingDirection,use:c.fit.hysteresisUse,levels:h.levels.map(l=>[l.massMg,l.nUp,l.nDown,l.diffCounts]),dMg:h.levels.map(l=>l.diffMg),obsDir:c.observations.map(o=>o.loadingDirection).filter((v,i,a)=>a.indexOf(v)===i),n:b.fit.n,hc:c.uncertainty.components.find(x=>x.id==='hysteresis'),basis:c.uncertainty.basis,notInc:c.uncertainty.notIncluded.includes('hysteresis')}})()`);
    ok('Z7 observations carry loadingDirection; the file reports reserved.loadingDirection "both" and a hysteresisAnalysis (mean down - mean up per mass); the fit uses all 30 observations (mean path)', r.err.length===0 && r.dir==='both' && r.use==='both' && r.obsDir.join()==='up,down' && r.n===30 && r.levels.length===3, JSON.stringify(r));
    ok('Z7 differences: 0 counts at the empty platform, 3 counts at 100 g and 5 counts at 200 g (and 750 mg / 1250 mg with 4 counts per g)', near(r.levels[0][3],0,1e-9,1e-9) && near(r.levels[1][3],3,1e-9) && near(r.levels[2][3],5,1e-9) && r.levels[1][1]===9 && near(r.dMg[1],750,0.01) && near(r.dMg[2],1250,0.01), JSON.stringify(r.levels));
    ok('Z7 hysteresis enters the uncertainty as its own component (rectangular, |diff| / 2 / sqrt 3), is no longer in the not-included list, and the label says so', r.hc.included && r.basis==='repeatability+hysteresis' && !r.notInc, JSON.stringify(r.hc && r.hc.included));
    R(`wiz.hysteresisUse='up'`);
    const u = J(`(()=>{const b=wizBuild();return {n:b.fit.n,dir:b.cfg.reserved.loadingDirection,inc:b.cfg.uncertainty.components.find(x=>x.id==='hysteresis').included,w:b.warnings.some(w=>w.code==='hystOne'),hy:!!b.cfg.reserved.hysteresisAnalysis}})()`);
    ok('Z7 "up only": the fit uses just the 15 up observations, the hysteresis is still reported but not included in the uncertainty (warning)', u.n===15 && u.dir==='up' && !u.inc && u.w && u.hy, JSON.stringify(u));
    R(`wiz.hysteresisUse='both'; wizLoadFromConfig(JSON.parse(JSON.stringify(wizBuild().cfg)))`);
    ok('Z7 round trip: directions survive writing and loading the file', R(`wiz.observations.filter(o=>o.loadingDirection==='down').length`)===15 && R(`wiz.hysteresisUse`)==='both'); }
  { R = await load(); R(WIZ_FILL(`0`,`[null]`)); const r = J(`(()=>{const b=wizBuild();return {dir:b.cfg.reserved.loadingDirection,h:b.cfg.reserved.hysteresisAnalysis}})()`);
    ok('Z7 without any direction the file keeps "not-determined" and no analysis', r.dir==='not-determined' && r.h===null); }
  // ---- Z: simple mode: placements, return run, tolerance ----------------------------------------------------------------------
  R = await load(); R(`wizMode='simple'; wizNew(); wiz.sensorId=activeSensor.id; wiz.rateHz=80; wizSimpleSetWeights(parseWeightSpec('3 x 100 g, 1 x 200 g').items);`);
  { const pl = n => { R(`wiz.placements=${n}`); return J(`wizPlan().map(p=>p.req)`); };
    ok('Z8 placements per mass: default 3; 5 -> empty 5, 100 g weights 2+2+1, 200 g 5; limited to 2..10', JSON.stringify(pl(3))==='[3,1,1,1,3]' && JSON.stringify(pl(5))==='[5,2,2,1,5]' && R(`(wiz.placements=1,wizPlacements())`)===2 && R(`(wiz.placements=99,wizPlacements())`)===10 && R(`(wiz.placements='x',wizPlacements())`)===3); 
    R(`wiz.placements=3`); R(`wizOnChange({target:{dataset:{w:'placements'},type:'number',value:'7'}})`); ok('Z8 the setting is a wizard setting, not a UI setting (not in ui-settings, not in the file)', R(`wiz.placements`)===7 && !('placements' in J(`collectUiSettings()`)) && !JSON.stringify(J(`wizBuild().cfg||{}`)).includes('placements'));
    const hint = R(`wizPlacementsHint()`); ok('Z8 hint teaches the t factor: more placements -> smaller k', /k = \d\.\d\d \(2 placements: \d\.\d\d, 5 placements: \d\.\d\d, 10 placements: \d\.\d\d\)/.test(hint) && Number(hint.match(/2 placements: (\d\.\d\d)/)[1])>Number(hint.match(/10 placements: (\d\.\d\d)/)[1]), hint);
    R(`wiz.placements=3`); }
  { R(`wiz.returnRun=true`); const down = J(`wizPlanDown().map(p=>[p.load.name,p.req,p.direction])`);
    ok('Z8 return run: one placement per mass level, heaviest first, ending with the empty platform; the 100 g level uses one of its weights', down.length===3 && down[0][0]==='200 g weight' && /^100 g weight/.test(down[1][0]) && down[2][0]==='Empty platform' && down.every(d=>d[1]===1&&d[2]==='down'), JSON.stringify(down));
    R(`wiz.open=true;wiz.tab='observations';for(let i=0;i<100;i++)appendSample(nextSensorValue());`);
    // fill the way up directly, then record the first "down" through the capture machinery
    R(`for(const p of wizPlan())for(let k=0;k<p.req;k++)wiz.observations.push({observationId:'u'+wiz.observations.length,loadId:p.load.loadId,rawMean:5000,include:true,sampleCount:800,loadingDirection:'up',validity:{status:'ok',flagged:[],analysis:null},placementIndex:1})`);
    const nx = J(`(()=>{const n=wizFullPlan().find(r=>r.done<r.req);return [n.load.name,n.direction]})()`); ok('Z8 after the way up the next placement is the first one on the way down (200 g)', nx[0]==='200 g weight' && nx[1]==='down', JSON.stringify(nx));
    R(`wizRecord(); for(let i=0;i<800;i++)appendSample(nextSensorValue());`);
    const last = J(`(()=>{const o=wiz.observations[wiz.observations.length-1];return [o.loadingDirection,o.loadId]})()`); ok('Z8 the recording gets direction "down" from the plan', last[0]==='down' && last[1]==='load-200g', JSON.stringify(last));
    R(`wiz.returnRun=false;wiz.observations=[];`); R(`wizRecord(); for(let i=0;i<800;i++)appendSample(nextSensorValue());`); ok('Z8 without a return run no direction is invented', R(`wiz.observations[0].loadingDirection`)===null); }
  { const p = s => J(`parseWeightSpec(${JSON.stringify(s)})`), a = p('3 x 100 g ±0.5 mg, 1 x 200 g +-1 mg, 2 x 50 g ± 0.001'), b = p('3 x 100 g ±0.5 mg, 100 g ±0.5 mg, 100 g'), c = p('100 g ±1 furlong');
    ok('Z9 tolerance syntax: "3 x 100 g ±0.5 mg" (also +- and a bare number in the weight unit); equal masses merge only with equal tolerance; unknown tolerance unit is an error', JSON.stringify(a.items[0])==='{"qty":3,"value":100,"unit":"g","tol":{"value":0.5,"unit":"mg"}}' && a.items[1].tol.unit==='mg' && a.items[2].tol.unit==='g' && a.items[2].tol.value===0.001 && b.items.length===2 && b.items[0].qty===4 && c.errors.length===1, JSON.stringify(a.items)); 
    R = await load(); R(`wizMode='simple'; wizNew(); wizSimpleSetWeights(parseWeightSpec('3 x 100 g ±0.5 mg, 1 x 200 g').items)`);
    const w = J(`wiz.weights.map(x=>[x.name,x.massUncertainty&&x.massUncertainty.value,x.massUncertainty&&x.massUncertainty.unit])`);
    ok('Z9 Simple weights get the typed tolerance (class tolerance); untoleranced ones stay untyped; a group with a tolerance has its own group id', w.filter(x=>x[1]===0.5&&x[2]==='mg').length===3 && w.filter(x=>x[1]===null||x[1]===undefined).length===2 && R(`wiz.groups[0].groupId`).includes('-t0p5mg'), JSON.stringify(w)); }
  // ---- Z: Advanced inputs, report, panes --------------------------------------------------------------------------------------
  R = await load(); R(WIZ_FILL(`wiz.weights[1].massUncertainty={value:0.3,basis:'certificate'}`,`['up','down']`)); R(`wizMode='advanced'`);
  { R(`wizOnChange({target:{dataset:{w:'weight',i:'2',f:'uncValue'},type:'number',value:'0.5'}})`); R(`wizOnChange({target:{dataset:{w:'weight',i:'2',f:'uncBasis'},type:'select-one',value:'user-estimate'}})`);
    const a = J(`wiz.weights[2].massUncertainty`); R(`wizOnChange({target:{dataset:{w:'weight',i:'2',f:'uncBasis'},type:'select-one',value:'none'}})`);
    ok('Z10 Advanced inputs: typing a tolerance defaults the basis to class tolerance; the basis can be changed; "none" removes it', a.basis==='user-estimate' && a.value===0.5 && R(`wiz.weights[2].massUncertainty`)===null);
    R(`wizOnChange({target:{dataset:{w:'profile',i:'0',f:'temperatureC'},type:'number',value:'21.5'}});wizOnChange({target:{dataset:{w:'profile',i:'0',f:'humidityPercent'},type:'number',value:'45'}});wizOnChange({target:{dataset:{w:'profile',i:'0',f:'warmUpMinutes'},type:'number',value:'15'}})`);
    const c = J(`(()=>{const b=wizBuild().cfg;return [b.environment.temperatureC,b.environment.relativeHumidityPercent,b.reserved.warmUpDurationSeconds]})()`);
    ok('Z10 environment fields: temperature, humidity and warm-up (min -> s) are written to the file; empty means null', c[0]===21.5 && c[1]===45 && c[2]===900 && J(`(()=>{wiz.profile.temperatureC='';return wizBuild().cfg.environment.temperatureC})()`)===null);
    R(`wizLoadFromConfig(JSON.parse(JSON.stringify(wizBuild().cfg)))`);
    ok('Z10 environment and tolerances survive a round trip through the file', R(`wiz.profile.humidityPercent`)===45 && R(`wiz.profile.warmUpMinutes`)===15 && R(`wiz.weights[1].massUncertainty.basis`)==='certificate' && R(`wiz.weights[1].massUncertainty.value`)===0.3); }
  { const rep = J(`wizFitReport()`), txt = R(`wizFitReportText(wizFitReport())`);
    ok('Z11 full fit report: model comparison, residuals with leave-one-out, weight groups, hysteresis, uncertainty, warnings; text version with the same sections', rep.comparison.length===4 && rep.residuals.length===30 && rep.residuals.every(r=>r.looResidualCounts!==null) && rep.hysteresis.levels.length===3 && rep.uncertainty.status==='estimated' && Array.isArray(rep.warnings) && /# Fit report/.test(txt) && /## Model comparison/.test(txt) && /leave-one-out/.test(txt) && /## Hysteresis/.test(txt) && /## Uncertainty \(estimated/.test(txt), Object.keys(rep).join());
    R(`globalThis.__dl=[];downloadBlob=(b,n)=>__dl.push([n,b.parts?b.parts.join(''):'']);Blob=class{constructor(p){this.parts=p}};wizOnClick({target:{closest:()=>({dataset:{wa:'exportReport'}})}});wizOnClick({target:{closest:()=>({dataset:{wa:'exportReportText'}})}})`);
    const dl = J(`__dl.map(d=>d[0])`); ok('Z11 export buttons download fit-report-….json and .md', dl.length===2 && /fit-report-.*\.json$/.test(dl[0]) && /\.md$/.test(dl[1]) && JSON.parse(R(`__dl[0][1]`)).residuals.length===30); }
  for (const mode of ['advanced','simple']) for (const t of ['weights','observations','fit','review'])
    ok(`Z12 ${mode} tab "${t}" renders (uncertainty, hysteresis, leave-one-out, direction, tolerance columns)`, (()=>{ try { R(`wizMode='${mode}';wiz.tab='${t}';wizRender();wq('wizBody').innerHTML.length`); return true; } catch(e){ console.log(e); return false; } })());
  { R(`wizMode='advanced';wiz.tab='fit';wizRender()`); const h = R(`wq('wizBody').innerHTML`);
    ok('Z12 fit pane shows loading-direction choice, hysteresis table, uncertainty table with k and U, leave-one-out columns and the export buttons', /Loading directions used/.test(h) && /Hysteresis: mean\(down\)/.test(h) && /Estimated uncertainty \(/.test(h) && /U = k u/.test(h) && /Leave-one-out/.test(h) && /exportReport/.test(h));
    R(`wiz.tab='weights';wizRender()`); const w = R(`wq('wizBody').innerHTML`); ok('Z12 weights pane has tolerance / basis columns and environment fields', /± U \/ tolerance/.test(w) && /Warm-up before measuring/.test(w) && /certificate \(± U, coverage factor k\)/.test(w));
    R(`wizMode='simple';wiz.tab='observations';wizRender()`); }
  { R = await load(); R(WIZ_FILL(`0`,`[null]`)); R(`wizMode='simple';wiz.tab='review';wizRender()`);
    ok('Z12 Simple finish: one plain sentence with the typical ± and the "repeatability only, not traceable" label', /Typical uncertainty of a weighing/.test(R(`wq('wizBody').innerHTML`)) && /repeatability only, not traceable/.test(R(`wq('wizBody').innerHTML`))); }

  // ===== v14: sample ids, history, gaps ==========================================================================================
  const HSETUP = async (opts='') => { const r = await load();
    r(`globalThis.__es=[];globalThis.EventSource=class{constructor(u){this.url=u;this.readyState=0;this.closed=false;__es.push(this)}close(){this.closed=true}};
       globalThis.__calls=[];globalThis.__hist={min:1,max:100000,type:'application/json'};
       globalThis.fetch=async(url,init)=>{__calls.push([url,init]);const a=+/from_id=(\\d+)/.exec(url)[1],b=+/to_id=(\\d+)/.exec(url)[1];if(__hist.fail)throw new Error('boom');const ids=[];for(let n=Math.max(a,__hist.min);n<=Math.min(b,__hist.max);n++)ids.push(n);
         if(__hist.type==='bin')return{ok:true,status:200,headers:{get:()=>'application/octet-stream'},arrayBuffer:async()=>encodeHistoryBinary(ids,ids.map(n=>1e9+n*12.5),ids.map(n=>5000+n%7))};
         return{ok:true,status:200,headers:{get:()=>'application/json'},json:async()=>({samples:ids.map(n=>({n,t:1e9+n*12.5,raw:5000+n%7}))})};};
       globalThis.msgN=(id,n0,cnt)=>JSON.stringify(Array.from({length:cnt},(_,k)=>({id,t:1e9+(n0+k)*12.5,raw:5000+((n0+k)%7),n:n0+k})));
       applySensorList([{id:'a',name:'A',sseUrl:'/s1'${opts}}]);`);
    return r; };
  const sleep = ms => new Promise(r=>setTimeout(r,ms));
  { R = await HSETUP();
    R(`handleSseMessage('/s1',msgN('a',1000,100))`);
    ok('H1 live samples keep their id n; the first live id is remembered; ids are stored per sample', R(`sensors.get('a').firstLiveId`)===1000 && R(`sensors.get('a').state.count`)===100 && R(`withState(sensors.get('a').state,()=>[getId(0),getId(99),lastStoredId(state)])`).join()==='1000,1099,1099');
    R(`handleSseMessage('/s1',msgN('a',1050,10))`); ok('H1 a resent id (not newer than the last stored) is rejected, counted', R(`sensors.get('a').state.count`)===100 && R(`sensors.get('a').state.rejected`)===10);
    R(`handleSseMessage('/s1',msgN('a',1110,5))`);
    ok('H1 a jump in the ids (1100..1109 missing) is noticed as a gap; without a history server it stays what it is: a gap in the timestamps', R(`sensors.get('a').gapCount`)===10 && R(`sensors.get('a').gaps[0].status`)==='no history server' && R(`sensors.get('a').state.count`)===105);
    R(`setSensorPaused(sensors.get('a'),true); setSensorPaused(sensors.get('a'),false); handleSseMessage('/s1',msgN('a',1300,5))`);
    ok('H1 data thrown away while paused is not a gap to refill: the first sample after resume is the new baseline', R(`sensors.get('a').gapCount`)===10 && R(`sensors.get('a').state.count`)===110);
    ok('H1 samples without ids (old format) keep working: no gaps, NaN ids', (()=>{R(`handleSseMessage('/s1',JSON.stringify([{id:'a',t:1e9+1400*12.5,raw:5000},{id:'a',t:1e9+1401*12.5,raw:5000}]))`);return R(`sensors.get('a').state.count`)===112 && Number.isNaN(R(`lastStoredId(sensors.get('a').state)`))})()); }
  { R = await HSETUP();   // merge into a SHOWN sensor
    R(`handleSseMessage('/s1',msgN('a',1000,100)); activateSensor('a'); state.window=state.activeWindow=80; rebuildDerived(); state.live=false; state.viewMin=oldestTime(); state.viewMax=newestTime();`);
    const hist = (a,b) => `{id:${JSON.stringify(Array.from({length:b-a+1},(_,k)=>a+k))},t:${JSON.stringify(Array.from({length:b-a+1},(_,k)=>1e9+(a+k)*12.5))},raw:${JSON.stringify(Array.from({length:b-a+1},(_,k)=>5000+((a+k)%7)))}}`;
    const r1 = J(`mergeHistory(sensors.get('a'),${hist(900,999)})`);
    const chk = J(`withState(sensors.get('a').state,()=>{const s=[];let sorted=true,contig=true,cal=true;for(let i=0;i<state.count;i++){if(i&&getTime(i)<=getTime(i-1))sorted=false;if(getId(i)!==900+i)contig=false;if(getMassMg(i)!==calibrateAbsolute(getRaw(i)).valueMg)cal=false;}
      const L=state.count-1,probe=[0,40,79,80,120,L];let worst=0;for(const i of probe){const a=Math.max(0,i-79);let sm=0,n=0;for(let j=a;j<=i;j++){sm+=getNetMg(j);n++}worst=Math.max(worst,Math.abs(getMassMA(i)-sm/n));}
      const m=buildMiniData();return {count:state.count,sorted,contig,cal,worst,t0:getTime(0),tl:getTime(99),mini:m[0].length>0&&Array.from(m[0]).every((v,i)=>!i||v>=m[0][i-1]),old:oldestTime()}})`);
    ok('H2 prepending 100 older samples: 200 samples, ids 900..1099 contiguous, time ascending (the older ones before the stream origin have negative times), calibrated like new samples', r1.added===100 && r1.dropped===0 && chk.count===200 && chk.sorted && chk.contig && chk.cal && chk.t0<0 && Math.abs(chk.tl-(-12.5))<1e-9, JSON.stringify({r1,chk:{count:chk.count,t0:chk.t0}}));
    ok('H2 after the merge the rolling mean (window 80) is exact at the very first, the boundary and the newest samples (derived arrays rebuilt), and the navigator data is valid', chk.worst<1e-6 && chk.mini, 'worst '+chk.worst);
    const r2 = J(`mergeHistory(sensors.get('a'),${hist(950,1010)})`); ok('H2 an overlapping chunk is deduplicated by id: nothing added, 61 duplicates', r2.added===0 && r2.duplicates===61 && R(`sensors.get('a').state.count`)===200);
    R(`state.selection=null;state.live=true;`); R(`handleSseMessage('/s1',msgN('a',1100,20))`); ok('H2 live samples keep flowing into the merged buffer (ids continue, 220 samples)', R(`withState(sensors.get('a').state,()=>[state.count,getId(state.count-1)])`).join()==='220,1119');
    ok('H2 the caches were reset: the chart curve can be built over the whole merged range', (()=>{try{R(`state.live=false;state.viewMin=oldestTime();state.viewMax=newestTime();buildVisibleData()[0].length`);return R(`buildVisibleData()[0].length`)>=200}catch(e){console.log(e);return false}})()); }
  { R = await HSETUP();   // buffer limit
    R(`handleSseMessage('/s1',msgN('a',1000,950)); withState(sensors.get('a').state,()=>resizeBuffers(1000));`);
    const h = (a,b) => `{id:${JSON.stringify(Array.from({length:b-a+1},(_,k)=>a+k))},t:${JSON.stringify(Array.from({length:b-a+1},(_,k)=>1e9+(a+k)*12.5))},raw:${JSON.stringify(Array.from({length:b-a+1},()=>5000))}}`;
    const r = J(`mergeHistory(sensors.get('a'),${h(900,999)})`);
    ok('H3 buffer limit 1000: 950 live + 100 history -> the newest 1000 samples are kept, the 50 oldest history samples are dropped', r.dropped===50 && r.count===1000 && R(`withState(sensors.get('a').state,()=>[getId(0),getId(999)])`).join()==='950,1949');
    R(`withState(sensors.get('a').state,()=>{state.unlimited=true;})`); const u = J(`mergeHistory(sensors.get('a'),${h(800,899)})`);
    ok('H3 unlimited buffer: it grows in 100,000-sample steps instead of dropping', u.dropped===0 && u.count===1100 && R(`sensors.get('a').state.capacity`)===100000, JSON.stringify(u)); }
  { R = await HSETUP(`,historyUrl:'/hist'`);   // gap filling through the server
    R(`handleSseMessage('/s1',msgN('a',1,50)); handleSseMessage('/s1',msgN('a',70,51)); __hist.min=1;`); await sleep(40);
    const g = J(`(()=>{const s=sensors.get('a');return {status:s.gaps.map(x=>x.status),ids:withState(s.state,()=>{const o=[];for(let i=0;i<state.count;i++)o.push(getId(i));return o}),req:__calls.map(c=>c[0]),hdr:__calls.map(c=>c[1]&&c[1].headers)}})()`);
    const wanted = Array.from({length:120},(_,k)=>k+1);
    ok('H4 gap 51..69 is requested as an id range and merged into the middle of the buffer: 120 contiguous samples, gap status "filled"', g.status.join()==='filled' && JSON.stringify(g.ids.filter(v=>v>=1))===JSON.stringify(wanted.filter(v=>v>=1)) && g.req.some(u=>/sensor=a&from_id=51&to_id=69/.test(u)), JSON.stringify({s:g.status,n:g.ids.length,req:g.req}));
    ok('H4 a history request is a READ: no Authorization header, no password in the URL', g.hdr.every(h=>!h||!('Authorization' in h)) && g.req.every(u=>!/password|Authorization/i.test(u)));
    const t = J(`withState(sensors.get('a').state,()=>{let sorted=true;for(let i=1;i<state.count;i++)if(!(getTime(i)>getTime(i-1)))sorted=false;const a=analyzeInterval(0,state.count);return {sorted,gaps:a.checks.find(c=>c.id==='gaps').verdict,detail:a.checks.find(c=>c.id==='gaps').detail}})`);
    ok('H4 after filling, time is strictly ascending and the gap check (timestamps AND the id counter) finds nothing', t.sorted && t.gaps==='ok', JSON.stringify(t)); }
  { R = await HSETUP(`,historyUrl:'/hist'`);   // server only has part of the gap / nothing
    R(`__hist.min=1; __hist.max=60; handleSseMessage('/s1',msgN('a',1,50)); handleSseMessage('/s1',msgN('a',70,10));`); await sleep(40);
    ok('H4 a gap the server can only partly fill: "partly filled", the rest stays an explicit gap', R(`sensors.get('a').gaps[0].status`)==='partly filled' && R(`sensors.get('a').gaps[0].got`)===10);
    R(`__hist.max=0; handleSseMessage('/s1',msgN('a',90,10));`); await sleep(40);
    const s2 = J(`(()=>{const s=sensors.get('a');return {st:s.gaps[s.gaps.length-1].status,gaps:withState(s.state,()=>analyzeInterval(0,state.count)).checks.find(c=>c.id==='gaps')}})()`);
    ok('H4 ids the server no longer has: the gap stays, status says so, and the validity checks report it (timestamps + id counter)', /not available/.test(s2.st) && s2.gaps.verdict!=='ok' && /jump/.test(s2.gaps.detail), JSON.stringify(s2)); }
  { R = await HSETUP(`,historyUrl:'/hist'`);   // initial history: chunked, backwards, stops at the server start
    R(`__hist.min=1; handleSseMessage('/s1',msgN('a',12000,100));`); await sleep(120);
    const r = J(`(()=>{const s=sensors.get('a');return {st:s.history.status,loaded:s.history.loaded,count:s.state.count,req:__calls.map(c=>/from_id=(\\d+)&to_id=(\\d+)/.exec(c[0]).slice(1).join('-')),first:withState(s.state,()=>getId(0))}})()`);
    ok('H5 on the first live sample the UI loads the older history by itself: chunks of 5,000 going backwards (7000-11999, 2000-6999, 0-1999), then stops', r.req.slice(0,3).join()==='7000-11999,2000-6999,0-1999' && r.count===12099 && r.first===1 && /^complete/.test(r.st) && r.loaded===11999, JSON.stringify(r));
    R(`__calls.length=0`); const again = await R(`historyLoadOlder(sensors.get('a')).then(h=>h.status)`); ok('H5 loading again finds nothing older and stops without looping', /^complete/.test(again) && R(`__calls.length`)<=1, again); }
  { R = await HSETUP(`,historyUrl:'/hist'`); R(`__hist.type='bin'; sensors.get('a').history.autoStarted=true; handleSseMessage('/s1',msgN('a',500,20));`);
    const st = await R(`historyLoadOlder(sensors.get('a')).then(h=>h.status+'|'+h.loaded)`);
    ok('H5 binary chunks (application/octet-stream, HIST layout) are decoded and merged exactly like JSON', /^complete/.test(st) && R(`sensors.get('a').state.count`)===519, st);
    R = await HSETUP(`,historyUrl:'/hist'`); R(`sensors.get('a').history.autoStarted=true; __hist.fail=true; handleSseMessage('/s1',msgN('a',500,20));`);
    ok('H5 a failing server gives status "error" with the message and does not break the sensor', (await R(`historyLoadOlder(sensors.get('a')).then(h=>h.status+'|'+h.error)`))==='error|boom' && R(`sensors.get('a').state.count`)===20);
    R = await HSETUP(); ok('H5 without a history URL nothing is requested and the status says so', (await R(`historyLoadOlder(sensors.get('a')).then(h=>h.status)`))==='not configured' && R(`historyStatusText(sensors.get('a'))`)==='no history server configured' && R(`__calls.length`)===0);
    R = await HSETUP(`,historyUrl:'/hist'`); R(`sensors.get('a').history.autoStarted=true; handleSseMessage('/s1',msgN('a',5000,600)); withState(sensors.get('a').state,()=>resizeBuffers(1000));`);
    const full = await R(`historyLoadOlder(sensors.get('a')).then(h=>h.status)`);
    ok('H5 history stops when the buffer is full (request sized to the room that is left: 400 samples), nothing is thrown away', full==='buffer full' && R(`sensors.get('a').state.count`)===1000 && /from_id=4600&to_id=4999/.test(R(`__calls[0][0]`)), full + ' ' + R(`__calls[0][0]`)); }
  { R = await HSETUP(); R(`handleSseMessage('/s1',msgN('a',1000,50)); activateSensor('a'); autoTare(); for(let i=0;i<10;i++)appendSample(5000,1e9*0+ (1050+i)*12.5 - 1000*12.5 + 1000*12.5 - 1e9*0 ,1050+i);`);
    // hidden sensor with unprocessed samples + lazy sensor: merge must keep per-sample calibration and not crash
    R(`applySensorList([{id:'b',name:'B',sseUrl:'/s1'}]); handleSseMessage('/s1',msgN('b',200,30));`);
    const hh = J(`(()=>{const s=sensors.get('b');const r=mergeHistory(s,{id:[190,191],t:[1e9+190*12.5,1e9+191*12.5],raw:[5100,5101]});return {r,count:s.state.count,ready:s.state.derivedReady,un:s.state.unprocessed}})()`);
    ok('H6 a sensor that was never shown (raw only) accepts history too; its samples are calibrated when it is shown', hh.r.added===2 && hh.count===32 && !hh.ready && (R(`activateSensor('b'); withState(sensors.get('b').state,()=>{let ok1=true;for(let i=0;i<state.count;i++)if(getMassMg(i)!==calibrateAbsolute(getRaw(i)).valueMg)ok1=false;return ok1})`)===true)); 
    R(`activateSensor('a')`); R(`handleSseMessage('/s1',msgN('b',230,10))`); const hid = J(`(()=>{const s=sensors.get('b');const r=mergeHistory(s,{id:[150],t:[1e9+150*12.5],raw:[5000]});return {added:r.added,un:s.state.unprocessed,ok:withState(s.state,()=>{for(let i=0;i<state.count;i++)if(getMassMg(i)!==calibrateAbsolute(getRaw(i)).valueMg)return false;return true})}})()`);
    ok('H6 a hidden sensor that already has processed data and unprocessed new samples: the merge finishes them and keeps every sample calibrated', hid.added===1 && hid.un===0 && hid.ok, JSON.stringify(hid)); }
  { R = await HSETUP(); R(`handleSseMessage('/s1',msgN('a',1000,100)); activateSensor('a'); $('measSamples').value=200; startMeasurement(); handleSseMessage('/s1',msgN('a',1100,10));`);
    const hist = `{id:[900,901],t:[${1e9}+900*12.5,${1e9}+901*12.5],raw:[5000,5000]}`;
    R(`mergeHistory(sensors.get('a'),${hist})`); ok('H7 history older than a running measurement does not disturb it', R(`state.measurement!==null&&state.measurement.collected===10`));
    R(`mergeHistory(sensors.get('a'),{id:[1105.5],t:[1e9+1105.5*12.5],raw:[5000]})`); ok('H7 a sample inserted INTO the measured interval cancels the measurement (it would change the sample count) and says why', R(`state.measurement===null&&state.logs.some(e=>e.type==='note'&&/history was inserted/.test(e.text))`)); }
  { R = await HSETUP(); R(`handleSseMessage('/s1',msgN('a',1,100)); activateSensor('a'); resizeBuffers(1000); for(let i=0;i<2500;i++)appendSample(5000,(200+i)*12.5,101+i);`);
    ok('H8 ids survive the ring buffer: wrapping and resizing keep them aligned with their samples', R(`[getId(0),getId(state.count-1),state.count].join()`)==='1601,2600,1000' && R(`(()=>{for(let i=1;i<state.count;i++)if(getId(i)!==getId(i-1)+1)return false;return true})()`));
    const c = J(`(()=>{const ok1=analyzeInterval(0,state.count).checks.find(x=>x.id==='gaps');return {v:ok1.verdict,d:ok1.detail}})()`);
    ok('H8 the device counter is passed to the validity checks: contiguous ids -> "counter: 0 jumps"', c.v==='ok' && /counter: 0 jumps/.test(c.d), JSON.stringify(c));
    R(`resizeBuffers(5000);for(let i=0;i<30;i++)appendSample(5000,(2700+i)*12.5,2700+i)`); const d = J(`(()=>{const x=analyzeInterval(state.count-60,state.count).checks.find(y=>y.id==='gaps');return {v:x.verdict,d:x.detail}})()`);
    ok('H8 dropped frames with uninterrupted timestamps (ids jump by 100) are caught through the counter alone', d.v==='suspect' && /counter: 1 jump/.test(d.d), JSON.stringify(d)); }

  // ===== v14: authentication ===========================================================================================================
  const ASETUP = async (status) => { const r = await load();
    r(`globalThis.__ss={};globalThis.__ls={};globalThis.sessionStorage={getItem:k=>(k in __ss?__ss[k]:null),setItem:(k,v)=>{__ss[k]=String(v)},removeItem:k=>{delete __ss[k]}};
       globalThis.localStorage={getItem:k=>(k in __ls?__ls[k]:null),setItem:(k,v)=>{__ls[k]=String(v)},removeItem:k=>{delete __ls[k]}};
       globalThis.__w=[];globalThis.__prompts=0;globalThis.__answer={user:'admin',password:'s3cret',remember:false};globalThis.__need='s3cret';
       authPromptImpl=async(msg)=>{__prompts++;globalThis.__lastMsg=msg;return __answer;};
       globalThis.fetch=async(url,init)=>{__w.push([url,init]);const h=(init&&init.headers)||{};const need=__need;const ok1=!need||h['Authorization']===basicAuthHeader('admin',need);return{ok:ok1,status:ok1?200:401,headers:{get:()=>''}};};authInit();`);
    return r; };
  { R = await ASETUP(); R(`__need=null`);
    const a = await R(`serverWrite('/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.status)`);
    ok('A1 server without a password: the write goes through with no Authorization header and no dialog', a===200 && R(`__w.length`)===1 && !('Authorization' in R(`__w[0][1].headers`)) && R(`__prompts`)===0 && R(`__w[0][1].headers['Content-Type']`)==='application/json'); }
  { R = await ASETUP();
    const a = await R(`serverWrite('/settings',{method:'PUT',body:'{"x":1}'}).then(r=>r.status)`);
    ok('A2 401 -> our dialog asks ONCE -> the write is retried with Authorization: Basic base64(user:password) -> success', a===200 && R(`__prompts`)===2-1 && R(`__w.length`)===2 && R(`__w[1][1].headers['Authorization']`)==='Basic '+Buffer.from('admin:s3cret').toString('base64') && R(`__w[1][1].body`)==='{"x":1}' && R(`__w[1][0]`)==='/settings');
    ok('A2 the first attempt carried no credentials; the URL never contains the password', !('Authorization' in R(`__w[0][1].headers`)) && R(`__w.every(c=>!/s3cret|admin/.test(c[0]))`));
    ok('A2 by default the password is kept for this tab only (sessionStorage), NOT on the device (localStorage)', /s3cret/.test(R(`__ss['massTelemetryWorkbench.auth.session']`)) && !('massTelemetryWorkbench.auth.remembered' in J(`__ls`)) && /this tab only/.test(R(`$('authInfo').textContent`)));
    await R(`serverWrite('/settings2',{method:'PUT',body:'{}'}).then(r=>r.status)`); ok('A2 later writes send the header at once: no second dialog', R(`__prompts`)===1 && R(`__w[2][1].headers['Authorization']`)!==undefined && R(`__w.length`)===4-1);
    R(`globalThis.__lastMsg=''`); R(`authInit()`); ok('A2 a reload of the tab (sessionStorage still there) restores the password', R(`authCred.password`)==='s3cret'); }
  { R = await ASETUP(); R(`__answer={user:'admin',password:'wrong',remember:true}`);
    const a = await R(`serverWrite('/settings',{method:'PUT',body:'{}'}).then(r=>r.status)`);
    ok('A3 a wrong password: asked once, retried once, the 401 is handed back (no loop), and the wrong password is forgotten everywhere (even with "remember")', a===401 && R(`__prompts`)===1 && R(`__w.length`)===2 && R(`authCred`)===null && Object.keys(J(`__ss`)).length===0 && Object.keys(J(`__ls`)).length===0); }
  { R = await ASETUP(); R(`__answer=null`);
    const a = await R(`serverWrite('/settings',{method:'PUT',body:'{}'}).then(r=>r.status)`);
    ok('A4 cancelling the dialog: no retry, the 401 comes back, nothing is stored', a===401 && R(`__w.length`)===1 && R(`authCred`)===null && Object.keys(J(`__ss`)).length===0);
    R(`__answer={user:'admin',password:'',remember:false}`); const b = await R(`serverWrite('/settings',{method:'PUT',body:'{}'}).then(r=>r.status)`); ok('A4 an empty password counts as cancel', b===401 && R(`authCred`)===null); }
  { R = await ASETUP(); R(`__answer={user:'admin',password:'s3cret',remember:true}`);
    await R(`serverWrite('/s',{method:'PUT'}).then(r=>r.status)`);
    ok('A5 "remember on this device" is opt-in: it additionally writes localStorage', /s3cret/.test(R(`__ls['massTelemetryWorkbench.auth.remembered']`)) && /remembered on this device/.test(R(`$('authInfo').textContent`)));
    R(`__ss={};authCred=null;authInit()`); ok('A5 a new tab (no sessionStorage) uses the remembered password', R(`authCred&&authCred.password`)==='s3cret');
    R(`authForget()`); ok('A5 "Forget password" clears memory, sessionStorage and localStorage', R(`authCred`)===null && Object.keys(J(`__ss`)).length===0 && Object.keys(J(`__ls`)).length===0 && /none known/.test(R(`$('authInfo').textContent`))); }
  { R = await ASETUP(); R(`globalThis.__resolve=[];authPromptImpl=(m)=>{__prompts++;return new Promise(r=>__resolve.push(r))}`);
    const p1 = R(`serverWrite('/a',{method:'PUT'}).then(r=>r.status)`), p2 = R(`serverWrite('/b',{method:'DELETE'}).then(r=>r.status)`); await sleep(10);
    ok('A6 two writes that both get a 401 share ONE dialog', R(`__prompts`)===1); R(`__resolve[0]({user:'admin',password:'s3cret',remember:false})`);
    const [a,b] = await Promise.all([p1,p2]); ok('A6 both are retried with the new credentials and succeed', a===200 && b===200 && R(`__w.filter(c=>c[1].headers['Authorization']).length`)===2); }
  { ok('A7 only ONE place in the code ever sets an Authorization header (serverWrite); every PUT / DELETE / POST goes through it; reads (GET, SSE, history) never do', (code.match(/\['Authorization'\]/g)||[]).length===1 && !/fetch\([^)]*method:\s*'(PUT|POST|DELETE)'/.test(code) && (code.match(/serverWrite\(/g)||[]).length>=5);
    R = await ASETUP(); R(`authStore({user:'admin',password:'s3cret'},true)`);
    ok('A7 the password is in no exported document: UI settings, sensor settings, calibration, CSV', !/s3cret/.test(R(`JSON.stringify(collectUiSettings())+JSON.stringify(sensorSettingsDoc())+JSON.stringify(CALIBRATION)`)) && !/s3cret/.test(R(`(()=>{let o='';downloadBlob=(b)=>{o=b.parts.join('')};Blob=class{constructor(p){this.parts=p}};for(let i=0;i<5;i++)appendSample(5000);exportCSV();return o})()`))); }
  { R = await ASETUP(); R(`authPromptImpl=null`);
    const p = R(`authDialogPrompt('The server asks for a password.')`); 
    ok('A8 the dialog opens with the reason, user name and password fields', R(`$('authModal').hidden`)===false && R(`$('authMsg').textContent`)==='The server asks for a password.');
    R(`$('authUser').value='admin';$('authPass').value='pw';$('authRemember').checked=true;$('authOk').onclick()`);
    const v = await p; ok('A8 "Continue" resolves with user, password and the remember choice; the dialog closes and the password field is wiped', v.user==='admin' && v.password==='pw' && v.remember===true && R(`$('authModal').hidden`)===true && R(`$('authPass').value`)==='');
    const p2 = R(`authDialogPrompt('x')`); R(`$('authCancel').onclick()`); ok('A8 "Cancel" resolves null', (await p2)===null && R(`$('authModal').hidden`)===true);
    const p3 = R(`authDialogPrompt('x')`); R(`$('authModal').onkeydown({key:'Escape'})`); ok('A8 Esc cancels', (await p3)===null); }
  ok('A9 static: the modal, the forget button, the info line and the history controls exist in the HTML', ['authModal','authUser','authPass','authRemember','authOk','authCancel','authForgetBtn','authInfo','calUploadBtn','ssHistoryBtn','ssHistoryInfo','bandModeSelect','windowSeconds','pmLines','measUnc'].every(i=>html.includes(`id="${i}"`)) && /Trusted home network|trusted home network/.test(html));

  // ===== v15 ======================================================================================================
  R = await load();
  // ---- Track Live <-> Pause Tracking
  R(`for(let i=0;i<500;i++)appendSample(nextSensorValue()); updateViewLabel();`);
  ok('V15a live: button offers "Pause Tracking"', R(`$('trackBtn').textContent`)==='Pause Tracking');
  R(`trackToggle()`);
  ok('V15a click pauses tracking: view frozen, button now "Track Live"', R(`state.live`)===false && R(`state.trackPaused`)===true && R(`$('trackBtn').textContent`)==='Track Live');
  R(`state.viewMax=newestTime(); autoTrackIfAtEnd();`);
  ok('V15a a paused view at the far right does NOT jump back to live by itself', R(`state.live`)===false);
  R(`trackToggle()`); ok('V15a second click = Track Live again; flag cleared', R(`state.live`)===true && R(`state.trackPaused`)===false && R(`$('trackBtn').textContent`)==='Pause Tracking');
  R(`state.live=false; state.viewMax=newestTime(); autoTrackIfAtEnd();`); ok('V15a panning away and back (no pause) still auto-tracks', R(`state.live`)===true);
  // ---- logarithmic window slider
  ok('V15b window slider is logarithmic: 0 -> 2, 1000 -> 10,000, 500 -> 141, monotone, 80 samples at about 433', R(`sliderToWindow(0)`)===2 && R(`sliderToWindow(1000)`)===10000 && R(`sliderToWindow(500)`)===141 && Math.abs(R(`windowToSlider(80)`)-433)<=1 && R(`(()=>{let p=-1;for(let k=0;k<=1000;k+=7){const v=sliderToWindow(k);if(v<p)return false;p=v}return true})()`));
  ok('V15b round trip slider -> samples -> slider stays within 1 step; the control is a 0..1000 range', R(`(()=>{for(const n of [2,3,10,80,141,1000,4800,10000]){const b=sliderToWindow(windowToSlider(n));if(Math.abs(b-n)>Math.max(1,0.01*n))return false}return true})()`) && /id="windowRange" type="range" min="0" max="1000"/.test(html));
  R(`setMovingAverageWindow(80,true,false,false)`); ok('V15b setting the window moves the slider to its log position', Math.abs(R(`$('windowRange').value`)-433)<=1);
  // ---- sub-pixel setting
  ok('V15c sub-pixel: default off, stored with the UI settings (additive), uPlot gets pxAlign 0 only when on', J(`sanitizeUiSettings({schemaVersion:1}).value.subPixel`)===false && J(`sanitizeUiSettings({schemaVersion:1,subPixel:true}).value.subPixel`)===true && J(`sanitizeUiSettings({schemaVersion:1,subPixel:'x'}).errors.length`)===1 && /pxAlign:subPixel\?0:1/.test(code) && (code.match(/pxAlign:subPixel\?0:1/g)||[]).length===2 && /id="subPixelToggle"/.test(html) && R(`subPixel`)===false);
  R(`globalThis.__ls={};globalThis.localStorage={getItem:k=>(k in __ls?__ls[k]:null),setItem:(k,v)=>{__ls[k]=String(v)},removeItem:k=>{delete __ls[k]}};setSubPixel(true);uiLocalWrite(collectUiSettings());setSubPixel(false);applyUiSettings(uiLocalRead())`);
  ok('V15c the setting round-trips and "Reset UI settings" returns to off', R(`subPixel`)===true && (await R(`uiResetLocal().then(()=>subPixel)`))===false);
  // ---- clear charts
  R = await load();
  R(`globalThis.EventSource=class{constructor(u){this.url=u;this.readyState=0}close(){}}; applySensorList([{id:'a',name:'A',sseUrl:'/s1'}]);`);
  R(`for(let i=0;i<400;i++)appendSample(nextSensorValue()); autoTare(); for(let i=0;i<200;i++)appendSample(nextSensorValue()); handleSseMessage('/s1',JSON.stringify(Array.from({length:50},(_,k)=>({id:'a',t:1e6+k*12.5,raw:5000,n:k+1}))));`);
  const tBefore = R(`state.nextTime`);
  R(`clearCharts()`);
  ok('V15d "Clear charts": shown sensor loses its samples; tares, log and calibration stay; time keeps running; other sensors untouched', R(`state.count`)===0 && R(`state.appended`)===0 && R(`state.tareEvents.length`)===1 && R(`state.logs.length`)>=1 && R(`state.nextTime`)===tBefore && R(`state.calibrations.length`)>=1 && R(`sensors.get('a').state.count`)===50);
  R(`for(let i=0;i<300;i++)appendSample(nextSensorValue()); updateMetrics();`);
  ok('V15d the buffer works again after clearing (rolling statistics, navigator, tare still applied)', R(`state.count`)===300 && R(`getNetMg(299)===getMassMg(299)-state.tareEvents[0].tareMassMg`) && R(`buildMiniData()[0].length`)>0 && Number.isFinite(R(`getMassSD(299)`)));
  R(`clearAllCharts()`); ok('V15d "Clear all charts": every sensor is emptied, logs stay', R(`sensors.get('a').state.count`)===0 && R(`state.count`)===0 && R(`state.tareEvents.length`)===1);
  R(`for(let i=0;i<50;i++)appendSample(nextSensorValue()); handleSseMessage('/s1',JSON.stringify([{id:'a',t:2e6,raw:5000,n:900}])); clearAll()`);
  ok('V15d "Clear all": also tares, log, measurement and overload events; calibrations stay', R(`state.count===0&&state.tareEvents.length===0&&state.logs.length===0&&state.lastMeasurement===null&&state.calibrations.length>=1&&sensors.get('a').state.count===0&&sensors.get('a').state.logs.length===0`));
  R(`$('measSamples').value=200; for(let i=0;i<10;i++)appendSample(5000); startMeasurement(); clearCharts();`); ok('V15d clearing cancels a running measurement', R(`state.measurement===null`));
  ok('V15d the three buttons are in a collapsed <details> at the END of the settings menu', /<details id="clearArea">/.test(html) && !/<details id="clearArea"[^>]* open/.test(html) && html.indexOf('id="clearArea"')>html.indexOf('id="calMessages"') && ['clearChartsBtn','clearAllChartsBtn','clearAllBtn'].every(i=>html.indexOf('id="'+i+'"')>html.indexOf('id="clearArea"')));
  // ---- overload monitor (demo calibration: 4600 counts = 0 g, 5000 = 100 g, 5400 = 200 g; 4 counts per g)
  R = await load();
  const ST = `testSensor`;
  const feed = (sensor, raw, n) => R(`for(let i=0;i<${n};i++)ingestSample(${sensor},${raw}); 0`);
  { const r = J(`(()=>{const p=overloadApplySettings(testSensor,{maxLoad:{value:100,unit:'g'}});return {e:p.errors,c:testSensor.ovl.cfg}})()`);
    ok('V15e settings: max 100 g -> 100,000 mg; no min given (min = -max); defaults 0.1 s, 10 / 20 / 40 %, break 0.5 s', r.e.length===0 && r.c.maxMg===100000 && r.c.minMg===null && r.c.averageS===0.1 && r.c.yellowPct===10 && r.c.orangePct===20 && r.c.redPct===40 && r.c.breakS===0.5);
    const lv = (avg) => J(`overloadLevel(${avg},testSensor.ovl.cfg)`);
    ok('V15e levels: 105 g below the yellow threshold = none; 115 g yellow; 125 g orange; 150 g red; exactly the limit none; -115 g yellow (min defaults to -max); -150 g red', lv(105000).level===null && lv(115000).level==='yellow' && lv(125000).level==='orange' && lv(150000).level==='red' && lv(100000).level===null && lv(-115000).level==='yellow' && lv(-115000).side==='under' && lv(-150000).level==='red' && lv(50000).level===null); }
  { const bad = s => J(`overloadApplySettings(testSensor,${s}).errors.length`);
    ok('V15e invalid settings are refused with a reason and change nothing: min >= max, thresholds not rising, unknown unit, negative max', bad(`{maxLoad:{value:100,unit:'g'},minLoad:{value:100,unit:'g'}}`)>0 && bad(`{maxLoad:{value:100,unit:'g'},yellowPercent:30,orangePercent:20}`)>0 && bad(`{maxLoad:{value:100,unit:'furlong'}}`)>0 && bad(`{maxLoad:{value:-5,unit:'g'}}`)>0 && R(`testSensor.ovl.cfg.maxMg`)===100000);
    ok('V15e a typed minimum is used for underload (-50 g) and an empty maximum switches the monitor off', J(`(()=>{overloadApplySettings(testSensor,{maxLoad:{value:100,unit:'g'},minLoad:{value:-50,unit:'g'}});const a=overloadLevel(-57000,testSensor.ovl.cfg).level;overloadApplySettings(testSensor,{maxLoad:null});const b=overloadStep(testSensor,0,1e9);overloadApplySettings(testSensor,{maxLoad:{value:100,unit:'g'}});return [a,testSensor.ovl.cfg.maxMg,testSensor.ovl.active]})()`).join()==='yellow,100000,' ); }
  R = await load(); R(`overloadApplySettings(testSensor,{maxLoad:{value:100,unit:'g'}}); __now=1000;`);
  feed(ST,5000,40);
  ok('V15f normal load: no event, no banner', R(`testSensor.ovl.active`)===null && R(`testSensor.ovl.events.length`)===0 && R(`(updateOverloadBanner(),$('overloadBanner').hidden)`)===true);
  feed(ST,5100,1); feed(ST,5000,20);
  ok('V15f one single spike sample (average over 0.1 s = 8 samples) is not an overload', R(`testSensor.ovl.active`)===null, JSON.stringify(J(`testSensor.ovl.current`)));
  feed(ST,5060,20);
  { const a = J(`testSensor.ovl.active`);
    ok('V15f 115 g for longer than the averaging time -> event starts, yellow', a && a.peakLevel==='yellow' && a.side==='over' && a.samples>5 && a.peakMg>110000, JSON.stringify(a));
    const st = J(`(()=>{const s=overloadStatus(testSensor,performance.now());updateOverloadBanner();return {now:s.now,level:s.level,html:$('overloadBanner').innerHTML,hidden:$('overloadBanner').hidden}})()`);
    ok('V15f banner is visible, names the sensor, says OVERLOAD and "STILL OVERLOADED"', st.hidden===false && /OVERLOAD/.test(st.html) && /STILL OVERLOADED/.test(st.html) && /ovl-yellow/.test(st.html) && /Test signal/.test(st.html) && st.now===true); }
  feed(ST,5200,20);
  ok('V15f the same event escalates to red when the load rises to 150 g (peak level and peak mass kept)', R(`testSensor.ovl.active.peakLevel`)==='red' && R(`testSensor.ovl.active.peakMg`)>140000);
  feed(ST,5000,10);   // 125 ms back to normal: shorter than the 0.5 s break
  feed(ST,5060,12);
  ok('V15f a break of 0.125 s (< 0.5 s) does not start a new event', R(`testSensor.ovl.events.length`)===0 && R(`testSensor.ovl.active.peakLevel`)==='red');
  feed(ST,5000,20);   // 250 ms back to normal, still inside the break
  { const s = J(`(()=>{const x=overloadStatus(testSensor,performance.now());return {now:x.now,html:(updateOverloadBanner(),$('overloadBanner').innerHTML)}})()`);
    ok('V15f inside the break the banner stays but no longer says "still overloaded"', s.now===false && /ended/.test(s.html) && !/STILL/.test(s.html)); }
  feed(ST,5000,40);   // total 0.75 s of normal load -> event closes
  { const e = J(`testSensor.ovl.events[0]`);
    ok('V15g after 0.5 s without overload the event is closed and logged once: peak, duration (first to last overloaded sample), side, limit', R(`testSensor.ovl.events.length`)===1 && R(`testSensor.ovl.active`)===null && e.type==='overload' && e.peakLevel==='red' && e.peakMg>140000 && e.side==='over' && e.limitMg===100000 && e.durationMs>300 && R(`testSensor.state.logs[0].entryId`)===e.entryId, JSON.stringify(e));
    const d = R(`describeEventHTML(testSensor.state.logs[0])`);
    ok('V15g log row and tooltip describe it ("Overload · red", peak, limit, +%, duration); jumping to it works', /Overload · red/.test(d) && /limit/.test(d) && /\+\d+ %/.test(d) && /Overload/.test(R(`(renderLog(),$('logList').innerHTML)`)) && (()=>{try{R(`jumpToLogEntry(testSensor.state.logs[0].entryId,'overload')`);return true}catch(x){console.log(x);return false}})());
    ok('V15g the event is a range for the chart marks (log entry range, lane hit test) ', J(`logEntryRange(testSensor.state.logs[0])`).t0===e.t0 && R(`hitTestEvents({posToVal:x=>x*0.1},(testSensor.state.logs[0].t0+testSensor.state.logs[0].t1)/2/100,5).some(h=>h.entry===testSensor.state.logs[0])`)); }
  { R(`__now=5000`); const a = J(`(()=>{const s=overloadStatus(testSensor,5000);return s&&{now:s.now,ago:s.endedAgoS}})()`);
    R(`__now=1000`); const hold = J(`(()=>{testSensor.ovl.lastEndWall=1000;return [overloadStatus(testSensor,1000+3000)!==null,overloadStatus(testSensor,1000+7999)!==null,overloadStatus(testSensor,1000+8001)]})()`);
    ok('V15g after the incident the warning stays visible for the hold time (8 s) with "ended N s ago", then disappears', hold[0] && hold[1] && hold[2]===null); }
  feed(ST,5000,20); feed(ST,5060,20); feed(ST,5000,60); 
  ok('V15g a second incident after more than the break is a new event (2 events in total)', R(`testSensor.ovl.events.length`)===2);
  // underload
  R = await load(); R(`overloadApplySettings(testSensor,{maxLoad:{value:100,unit:'g'}});`);
  feed(ST,4000,20); feed(ST,4600,60);
  ok('V15h underload: -150 g (raw 4000) is red and reported as UNDERLOAD with a minus sign', R(`testSensor.ovl.events.length`)===1 && R(`testSensor.ovl.events[0].side`)==='under' && R(`testSensor.ovl.events[0].peakLevel`)==='red' && R(`testSensor.ovl.events[0].limitMg`)===-100000 && /Underload/.test(R(`describeEventHTML(testSensor.ovl.events[0])`)) && /−/.test(R(`describeEventHTML(testSensor.ovl.events[0])`)));
  // hidden sensor also monitored; unit shown in the sensor's own unit
  R = await load(); R(`globalThis.EventSource=class{constructor(u){this.url=u;this.readyState=0}close(){}}; applySensorList([{id:'a',name:'Scale A',sseUrl:'/s1'}]); overloadApplySettings(sensors.get('a'),{maxLoad:{value:100,unit:'g'}});`);
  R(`handleSseMessage('/s1',JSON.stringify(Array.from({length:60},(_,k)=>({id:'a',t:5e6+k*12.5,raw:5000,n:k+1}))));handleSseMessage('/s1',JSON.stringify(Array.from({length:40},(_,k)=>({id:'a',t:5e6+(60+k)*12.5,raw:5200,n:61+k}))));`);
  ok('V15h a sensor that is NOT shown (raw only) is monitored too and appears in the banner; clicking it is wired by data-sensor', R(`sensors.get('a').ovl.active!==null`) && R(`sensors.get('a').state.derivedReady`)===false && /data-sensor="a"/.test(R(`(updateOverloadBanner(),$('overloadBanner').innerHTML)`)) && /Scale A/.test(R(`$('overloadBanner').innerHTML`)));
  R(`for(let i=0;i<10;i++)ingestSample(testSensor,5000);`); ok('V15h the shown sensor and the hidden one keep separate events and logs', R(`testSensor.ovl.active`)===null && R(`sensors.get('a').state.logs.length`)===0);
  { R(`handleSseMessage('/s1',JSON.stringify(Array.from({length:60},(_,k)=>({id:'a',t:5e6+(100+k)*12.5,raw:5000,n:101+k}))))`);
    ok('V15h a closing event on a hidden sensor goes into ITS log, not into the log shown for the other sensor', R(`sensors.get('a').state.logs.length`)===1 && R(`testSensor.state.logs.filter(l=>l.type==='overload').length`)===0 && R(`$('logList').innerHTML`).includes('Overload')===false); }
  { R(`overloadApplySettings(sensors.get('a'),{maxLoad:null})`); R(`sensors.get('a').ovl.active=null`);
    R(`ssSelectedId='a'; sensorSettingsRender(); $('ssMaxLoad').value='200'; $('ssLoadUnit').value='g'; $('ssMinLoad').value='-50'; $('ssAvgS').value='0.2'; $('ssYellow').value='5'; $('ssOrange').value='15'; $('ssRed').value='30'; $('ssBreak').value='1'; $('ssHold').value='12';`);
    await R(`sensorSettingsApply()`);
    const c = J(`sensors.get('a').ovl.cfg`), d = J(`sensorSettingsDoc().sensors.find(s=>s.id==='a').overload`);
    ok('V15i settings tab: overload fields are read, applied and written to sensor_settings.json (weights with unit, not counts)', c.maxMg===200000 && c.minMg===-50000 && c.averageS===0.2 && c.yellowPct===5 && c.orangePct===15 && c.redPct===30 && c.breakS===1 && c.holdS===12 && d.maxLoad.value===200 && d.maxLoad.unit==='g' && d.minLoad.value===-50 && d.redPercent===30, JSON.stringify(d));
    R(`$('ssYellow').value='50'; $('ssOrange').value='15';`); await R(`sensorSettingsApply()`);
    ok('V15i invalid input is refused with a message; nothing changes', /Not applied/.test(R(`$('ssMessages').textContent`)) && R(`sensors.get('a').ovl.cfg.yellowPct`)===5);
    const m = await R(`applySensorSettingsDoc({sensors:[{id:'a',name:'Renamed',overload:{maxLoad:{value:1,unit:'kg'}}},{id:'zzz'}]}).then(x=>JSON.stringify(x))`);
    ok('V15i a sensor_settings.json can be loaded: overload applied (1 kg = 1,000,000 mg), unknown sensors reported', R(`sensors.get('a').ovl.cfg.maxMg`)===1e6 && R(`sensors.get('a').name`)==='Renamed' && /zzz/.test(m), m); }
  // ---- connection timeout
  R = await load(); R(`globalThis.EventSource=class{constructor(u){this.url=u;this.readyState=0}close(){}}; __now=1000; applySensorList([{id:'a',name:'A',sseUrl:'/s1',rateHz:80},{id:'slow',name:'Slow',sseUrl:'/s2',rateHz:0.5}]); sseConnections.get('/s1').status='live'; sseConnections.get('/s2').status='live';`);
  ok('V15j a stream that opened and delivers nothing is "timeout" after max(2 s, 20 periods): not before', R(`__now=1000+1900,sensorStaleMs(sensors.get('a'),__now)`)===0 && R(`sensorStaleMs(sensors.get('a'),1000+5000)`)>=5000 && R(`(__now=6000,sensorLink(sensors.get('a')).key)`)==='timeout' && /No data for 5 s/.test(R(`sensorLink(sensors.get('a')).text`)));
  ok('V15j a slow sensor (0.5 Hz, period 2 s) gets 40 s: not stale after 30 s, stale after 41 s', R(`sensorStaleMs(sensors.get('slow'),1000+30000)`)===0 && R(`sensorStaleMs(sensors.get('slow'),1000+41000)`)>0);
  R(`__now=8000; handleSseMessage('/s1',JSON.stringify([{id:'a',t:1000,raw:5000,n:1}]));`); ok('V15j a sample resets the timer: link is "live" again', R(`sensorLink(sensors.get('a')).key`)==='live' && R(`sensorStaleMs(sensors.get('a'),9000)`)===0);
  R(`__now=60000; setSensorPaused(sensors.get('a'),true)`); ok('V15j a paused or unlisted sensor is never reported as timed out', R(`sensorStaleMs(sensors.get('a'),__now+99999)`)===0 && R(`(sensors.get('slow').unlisted=true,sensorStaleMs(sensors.get('slow'),__now+99999))`)===0);
  R(`setSensorPaused(sensors.get('a'),false); sensors.get('slow').unlisted=false;`); ok('V15j resuming restarts the timer (no instant timeout)', R(`sensorStaleMs(sensors.get('a'),__now+1000)`)===0);
  R(`__now=100000; updateStatusUI()`); ok('V15j the status line counts a timed-out sensor as NOT streaming and shows the icon in the sensor list', !/\b3 of 3\b/.test(R(`$('statusText').textContent`)) && R(`(renderSensorSelect(),LINK_ICON.timeout)`)==='⏱');
  R(`__now=200000; handleSseMessage('/s1',JSON.stringify([{id:'a',t:1100,raw:5000,n:2}])); testSensor.state.lastWall=1;`); ok('V15j the test signal is checked too', R(`sensorLink(testSensor).key`)==='timeout');
  R(`housekeeping()`); ok('V15j housekeeping runs without error and refreshes banner and status', true);
  // ---- calibration files bound to a sensor
  R = await load(); R(`globalThis.EventSource=class{constructor(u){this.url=u;this.readyState=0}close(){}}; applySensorList([{id:'a',name:'A',sseUrl:'/s1'},{id:'b',name:'B',sseUrl:'/s1'}]);`);
  ok('V15k file name is calibration_<profileId>.json (unsafe characters replaced)', R(`calFileName({profileId:'my profile/1'})`)==='calibration_my_profile_1.json');
  const MK = (pid, sid, f='') => `(()=>{const c=JSON.parse(JSON.stringify(EMBEDDED_CALIBRATION));c.profileId='${pid}';c.profileName='${pid}';${sid?`c.sensorId='${sid}';`:''}${f}return c})()`;
  { const r = J(`(async()=>0)()&&0`);
    const wrong = await R(`activateCalibration(${MK('pa','b')},'t').then(r=>r.errors.join(' '))`);
    ok('V15k a calibration that names another sensor than the shown one is refused with the sensor name', /belongs to sensor “b”/.test(wrong) && R(`state.calibrations.length`)===1);
    const bad = R(`validateCalibrationConfig(${MK('pa','',"c.sensorId=5;")}).errors.length`); ok('V15k sensorId must be a text', bad>0 && R(`validateCalibrationConfig(${MK('pa','')}).errors.length`)===0);
    R(`activateSensor('a')`); const okr = await R(`activateCalibration(${MK('pa','a',"c.calibrationAnchors[2].rawMean=5410;")},'t').then(r=>r.errors.length)`);
    ok('V15k the owning sensor accepts it: new epoch, library entry, active file remembered in the sensor settings', okr===0 && R(`calLibrary.has('calibration_pa.json')`) && R(`sensors.get('a').settings.calibrationFile`)==='calibration_pa.json' && R(`state.calibrations.length`)===2 && R(`calLibrary.get('calibration_pa.json').sensorId`)==='a'); }
  { R(`activateSensor('b')`); ok('V15k each sensor has its OWN active calibration: sensor B still runs the embedded demo while A has file pa', R(`state.calibrations.length`)===1 && R(`sensors.get('b').settings.calibrationFile||null`)===null && R(`sensors.get('a').state.revisionId`)!==R(`state.revisionId`));
    const doc = J(`sensorSettingsDoc()`); ok('V15k sensor_settings.json stores the active calibration file per sensor', doc.sensors.find(s=>s.id==='a').calibrationFile==='calibration_pa.json' && doc.sensors.find(s=>s.id==='b').calibrationFile===null);
    const msg = await R(`selectCalibrationFile('a','calibration_pa.json')`); ok('V15k selecting a library file switches to its sensor and reports it (already active = no change)', /active for/.test(msg) && R(`activeSensor.id`)==='a');
    await R(`activateCalibration(${MK('pb','a',"for(const a of c.calibrationAnchors)a.referenceValue/=2;")},'t')`);
    const back = await R(`selectCalibrationFile('a','calibration_pa.json')`); ok('V15k switching back to an earlier file of the same sensor starts a new epoch with that file', /active for/.test(back) && R(`sensors.get('a').settings.calibrationFile`)==='calibration_pa.json' && R(`state.calibrations.length`)===4);
    const dem = await R(`selectCalibrationFile('a','')`); ok('V15k "Embedded demo" can be chosen again (file link cleared)', R(`sensors.get('a').settings.calibrationFile`)===null && /demo/.test(dem));
    const miss = await R(`selectCalibrationFile('b','calibration_unknown.json')`); ok('V15k a named file that is not loaded is reported, not guessed; the name is kept as pending', /not loaded/.test(miss) && R(`sensors.get('b').settings.calibrationFile`)==='calibration_unknown.json'); }
  { // import switches to the owner sensor; file without a sensor binds to the shown sensor
    R(`activateSensor('a')`);
    const file = (cfg,name) => `({size:1000,name:'${name}',text:async()=>JSON.stringify(${cfg})})`;
    await R(`importCalibrationFile(${file(MK('pc','b',"c.calibrationAnchors[2].rawMean=5420;"),'calibration_pc.json')})`);
    ok('V15k importing a file that belongs to sensor B while A is shown switches to B and activates it there', R(`activeSensor.id`)==='b' && R(`sensors.get('b').settings.calibrationFile`)==='calibration_pc.json' && R(`sensors.get('a').settings.calibrationFile||null`)===null);
    await R(`importCalibrationFile(${file(`{...${MK('pd','')},hello:1}`,'old.json')})`);
    ok('V15k an old file without a sensor is bound to the shown sensor and the user is told', R(`sensors.get('b').settings.calibrationFile`)==='calibration_pd.json' && /names no sensor/.test(R(`$('calMessages').innerHTML`)) );
    await R(`importCalibrationFile(${file(MK('pe','nope'),'x.json')})`); ok('V15k a file for an unknown sensor is rejected with a message', /not in the sensor list/.test(R(`$('calMessages').innerHTML`)) && R(`sensors.get('b').settings.calibrationFile`)==='calibration_pd.json'); }
  { // export: stamped with the sensor, fingerprint matches, name
    R(`globalThis.__dl=[];downloadBlob=(b,n)=>__dl.push([n,b.parts.join('')]);Blob=class{constructor(p){this.parts=p}};`);
    await R(`exportCalibration()`); const ex = JSON.parse(R(`__dl[0][1]`));
    const fp = await R(`fingerprintConfig((()=>{const c=JSON.parse(__dl[0][1]);delete c.contentHash;delete c.revisionId;return c})()).then(f=>f.id)`);
    ok('V15k export: file name calibration_<profileId>.json; the sensor id is stored; the revision id and content hash belong to that stamped content (re-import has no hash warning)', R(`__dl[0][0]`)==='calibration_pd.json' && ex.sensorId==='b' && ex.revisionId===fp && ex.revisionId.length===12);
    const re = await R(`(async()=>{const c=JSON.parse(__dl[0][1]);const r=await activateCalibration(c,'again');return r.warnings.join('|')})()`);
    ok('V15k re-importing the exported file: same revision as the active one, no "contentHash does not match" warning', !/contentHash/.test(re)); }
  { R(`wizNew(); wiz.sensorId=activeSensor.id; wiz.rateHz=80; wizLoadFromConfig(JSON.parse(JSON.stringify(EMBEDDED_CALIBRATION))); wiz.sensorId='b'; wiz.rateHz=80;`);
    R(`globalThis.__dl=[];downloadBlob=(b,n)=>__dl.push([n,b.parts.join('')]);wizOnClick({target:{closest:()=>({dataset:{wa:'exportCal'}})}})`);
    const c = JSON.parse(R(`__dl[0][1]`)); ok('V15k the wizard writes the sensor id into the calibration and names the file calibration_<profileId>.json; the file validates', c.sensorId==='b' && /^calibration_.*\.json$/.test(R(`__dl[0][0]`)) && R(`validateCalibrationConfig(JSON.parse(__dl[0][1])).errors.length`)===0); }
  ok('V15k info text shows the file name and the binding', /file calibration_/.test(R(`(updateCalibrationInfo(),$('calibrationInfo').innerHTML)`)));
  // ---- static: every new element exists, overload strings
  ok('V15l new elements exist in the HTML', ['overloadBanner','subPixelToggle','clearArea','clearChartsBtn','clearAllChartsBtn','clearAllBtn','ssCalFile','ssMaxLoad','ssLoadUnit','ssMinLoad','ssAvgS','ssYellow','ssOrange','ssRed','ssBreak','ssHold','ssLoadBtn','ssFile'].every(i=>html.includes(`id="${i}"`)));
  for (const mode of ['simple','advanced']) ok(`V15l wizard ${mode} still renders all tabs`, (()=>{try{for(const t of ['weights','observations','review'])R(`wizMode='${mode}';wiz.tab='${t}';wizRender();wq('wizBody').innerHTML.length`);return true}catch(e){console.log(e);return false}})());

  // ===== v16 (handout v14.1 implemented) ===========================================================================
  const nearAbs = (a, b, t) => Math.abs(a - b) <= t;
  // ---- conversions
  R = await load();
  { const SH = '{type:"steinhart-hart",a:0.001129148,b:0.000234125,c:8.76741e-8}';
    ok('G1 Steinhart-Hart: a 10 kΩ NTC (these coefficients) at 10,000 Ω = 25.00 °C, hot at lower resistance', nearAbs(R(`convertAux(${SH},10000)`), 25, 0.02) && R(`convertAux(${SH},3600)`) > 45);
    const T50 = 10000 * Math.exp(3950 * (1 / 323.15 - 1 / 298.15));
    ok('G1 beta: r0 at t0 = t0; R at 50 °C gives 50 °C; rSeries is subtracted', nearAbs(R(`convertAux({type:"beta",beta:3950,r0:10000,t0:25},10000)`), 25, 1e-9) && nearAbs(R(`convertAux({type:"beta",beta:3950,r0:10000,t0:25},${T50})`), 50, 1e-6) && nearAbs(R(`convertAux({type:"beta",beta:3950,r0:10000,t0:25,rSeries:100},10100)`), 25, 1e-9));
    ok('G1 polynomial c0 + c1 x (-12.3 + 0.0042 x at 5000 = 8.7); direct; quadratic', nearAbs(R(`convertAux({type:"polynomial",coefficients:[-12.3,0.0042]},5000)`), 8.7, 1e-9) && R(`convertAux({type:"direct"},21.5)`) === 21.5 && R(`convertAux(undefined,3)`) === 3 && nearAbs(R(`convertAux({type:"polynomial",coefficients:[1,2,3]},2)`), 17, 1e-12));
    ok('G1 a failed conversion is NaN, never 0 (resistance <= 0, rSeries >= R, NaN input, unknown type)', Number.isNaN(R(`convertAux(${SH},0)`)) && Number.isNaN(R(`convertAux({type:"beta",beta:3950,r0:10000,t0:25,rSeries:200},150)`)) && Number.isNaN(R(`convertAux({type:"direct"},NaN)`)) && Number.isNaN(R(`convertAux({type:"magic"},1)`)));
    const v = c => R(`validateAuxConversion(${c}).length`);
    ok('G1 conversion validation: good ones pass, malformed ones give a reason', v('{type:"polynomial",coefficients:[1,2]}') === 0 && v('{type:"polynomial"}') > 0 && v('{type:"beta",beta:-1,r0:1,t0:1}') > 0 && v('{type:"steinhart-hart",a:1,b:2}') > 0 && v('{type:"x"}') > 0 && v('null') === 0 && v('[1]') > 0); }
  // ---- aux ring buffer, ids, gaps, interpolation
  R = await load();
  R(`globalThis.ch=makeAux({id:'t1',kind:'temperature',unit:'°C',rateHz:1,attachedTo:['test'],conversion:{type:'polynomial',coefficients:[0,0.1]}}); ch.buf=auxNewBuffer(5); for(let i=0;i<8;i++)ingestAux(ch,200+i,i*1000,i+1);`);
  ok('G2 ring buffer wraps: capacity 5 keeps the newest 5 samples with ids and converted values aligned', R(`ch.buf.count`) === 5 && R(`auxLastId(ch)`) === 8 && R(`(()=>{const o=[];for(let i=0;i<ch.buf.count;i++)o.push(ch.buf.t[auxP(ch.buf,i)]+'/'+ch.buf.id[auxP(ch.buf,i)]+'/'+ch.buf.val[auxP(ch.buf,i)].toFixed(1));return o.join()})()`) === '3000/4/20.3,4000/5/20.4,5000/6/20.5,6000/7/20.6,7000/8/20.7');
  ok('G2 auxValueAt: exact hit, linear interpolation (3500 ms -> 20.35), NEVER extrapolated (before the oldest / after the newest = NaN)', nearAbs(R(`auxValueAt(ch,7000)`), 20.7, 1e-9) && nearAbs(R(`auxValueAt(ch,3500)`), 20.35, 1e-9) && Number.isNaN(R(`auxValueAt(ch,2999)`)) && Number.isNaN(R(`auxValueAt(ch,7001)`)));
  R(`ingestAux(ch,500,7500,8)`); R(`ingestAux(ch,1,5000,99)`);
  ok('G2 a repeated id and a time that is not newer are rejected and counted', R(`ch.rejected`) === 2 && R(`ch.buf.count`) === 5);
  R(`ingestAux(ch,300,8000,12)`);
  ok('G2 a jump in the ids (9..11 missing) is a gap; without a history server it stays one', R(`ch.gapCount`) === 3 && R(`ch.gaps[0].status`) === 'no history server' && R(`ch.buf.count`) === 5);
  R(`ingestAux(ch,310,20000,13)`);
  ok('G2 the max-gap rule: neighbours 12 s apart (> 2.5 periods) are not interpolated; neighbours 1 s apart are', Number.isNaN(R(`auxValueAt(ch,14000)`)) && !Number.isNaN(R(`auxValueAt(ch,7500)`)));
  R(`setAuxPaused(ch,true,true); ingestAux(ch,1,30000,14);`); ok('G2 a paused channel discards data (counted)', R(`ch.dropped`) === 1);
  R(`setAuxPaused(ch,false,true)`);
  R(`globalThis.cs=makeAux({id:'sh',kind:'temperature',unit:'°C',rateHz:1,attachedTo:[],conversion:{type:'steinhart-hart',a:0.001129148,b:0.000234125,c:8.76741e-8}}); ingestAux(cs,10000,0,1); ingestAux(cs,0,1000,2);`);
  ok('G2 a sample that cannot be converted is stored invalid (NaN, counted), never as zero; it blocks interpolation', nearAbs(R(`cs.buf.val[0]`), 25, 0.02) && Number.isNaN(R(`cs.buf.val[1]`)) && R(`cs.invalid`) === 1 && Number.isNaN(R(`auxValueAt(cs,500)`)));
  { R(`globalThis.cd=makeAux({id:'d1',kind:'temperature',unit:'°C',rateHz:1,attachedTo:[],conversion:{type:'direct'}}); for(let i=0;i<=120;i++)ingestAux(cd,20+0.01*i,i*1000,i+1);`);
    ok('G2 rate of change: 0.01 K/s = 0.60 K/min over a 60 s window; fewer than 3 points = no rate', nearAbs(R(`auxRateKPerMin(cd,60)`), 0.6, 1e-9) && R(`auxRateKPerMin(ch,0.5)`) === null);
    const st = J(`auxStatsRange(cd,10000,20000)`); ok('G2 statistics over a time range: mean / min / max of the converted values', st.n === 11 && nearAbs(st.mean, 20.15, 1e-9) && nearAbs(st.min, 20.1, 1e-9) && nearAbs(st.max, 20.2, 1e-9));
    R(`cd.buf=auxGrow(cd.buf,200000)`); ok('G2 growing keeps order and content', R(`cd.buf.cap`) === 200000 && R(`cd.buf.count`) === 121 && nearAbs(R(`auxValueAt(cd,60500)`), 20.605, 1e-9)); }
  { R(`globalThis.cw=makeAux({id:'w',kind:'generic',unit:'%',rateHz:1,attachedTo:[],conversion:{type:'direct'}}); cw.buf=auxNewBuffer(4); cw.unlimited=true; for(let i=0;i<6;i++)ingestAux(cw,i,i*1000,i+1);`);
    ok('G2 an unlimited channel grows in steps instead of dropping the oldest', R(`cw.buf.count`) === 6 && R(`cw.buf.cap`) === 4 + 100000); }
  // ---- sensor list with auxiliary channels, shared device clock
  R = await load();
  R(`globalThis.EventSource=class{constructor(u){this.url=u;this.readyState=0;this.closed=false;(globalThis.__es=globalThis.__es||[]).push(this)}close(){this.closed=true}}`);
  { const res = J(`applySensorList([{id:'a',name:'A',sseUrl:'/s1',deviceId:'esp'},{id:'t-body',kind:'temperature',name:'Body',sseUrl:'/s2',rateHz:1,unit:'°C',conversion:{type:'direct'},attachedTo:['a'],deviceId:'esp'},{id:'bad1',kind:'temperature',sseUrl:'/s2',conversion:{type:'x'}},{id:'bad2',kind:'pressure',sseUrl:'/s2'},{id:'bad3',kind:'temperature',unit:'°F',sseUrl:'/s2'},{id:'bad4',kind:'temperature',attachedTo:'a'},{id:'gen',kind:'generic',name:'Hum',sseUrl:'/s2',unit:'%',attachedTo:[],deviceId:'esp'}])`);
    ok('G3 list: load cell + valid temperature and generic channels accepted; unknown kind, bad conversion, non-°C temperature unit and bad attachedTo are rejected with a reason', res.added.join() === 'a' && res.auxAdded.join() === 't-body,gen' && res.errors.length === 4, JSON.stringify(res));
    ok('G3 channels have their own connection list entry: /s1 and /s2 are opened (the channels share one URL)', JSON.stringify(JSON.parse(R(`JSON.stringify(__es.filter(e=>!e.closed).map(e=>e.url).sort())`))) === '["/s1","/s2"]' && R(`sensors.size`) === 2 && R(`auxChannels.size`) === 2);
    ok('G3 the temperature channel is attached to the load cell, defaults: unit °C, deviceId as typed', R(`attachedAux(sensors.get('a')).map(c=>c.id).join()`) === 't-body' && R(`primaryTempChannel(sensors.get('a')).id`) === 't-body' && R(`auxChannels.get('gen').deviceId`) === 'esp'); }
  R(`handleSseMessage('/s1',JSON.stringify(Array.from({length:161},(_,k)=>({id:'a',t:1e9+k*12.5,raw:5000+(k%5),n:k+1}))))`);
  R(`handleSseMessage('/s2',JSON.stringify([{id:'t-body',t:1e9+1000,raw:21.5,n:1},{id:'t-body',t:1e9+2000,raw:22.5,n:2},{id:'t-body',t:1e9+3000,raw:23.25,n:3}]))`);
  ok('G3 one device = one time origin: the channel (first sample 1 s after the load cell\'s first) starts at 1000 ms, not 0; raw is a float, not rounded', R(`auxChannels.get('t-body').buf.t[0]`) === 1000 && R(`auxChannels.get('t-body').buf.raw[0]`) === 21.5 && R(`sensors.get('a').state.times[0]`) === 0 && R(`sensors.get('a').state.times[160]`) === 2000);
  ok('G3 alignment by timestamp: at load-cell sample 120 (1500 ms) the temperature is 22.0 (interpolated between 21.5 and 22.5); outside the channel\'s data NaN', nearAbs(R(`withState(sensors.get('a').state,()=>auxValueAt(auxChannels.get('t-body'),getTime(120)))`), 22.0, 1e-9) && Number.isNaN(R(`withState(sensors.get('a').state,()=>auxValueAt(auxChannels.get('t-body'),getTime(10)))`)));
  R(`handleSseMessage('/s1',JSON.stringify([{id:'t-body',t:1e9+4000,raw:99,n:4}]))`);
  ok('G3 a channel sample sent on another URL is ignored (unknown), a load-cell sample on the channel URL too', R(`auxChannels.get('t-body').buf.count`) === 3 && R(`sseStats.unknown`) >= 1);
  { R(`handleSseMessage('/s2',JSON.stringify([{id:'gen',t:1e9+500,raw:41.2,n:1}]))`); ok('G3 a second channel of the same device and URL starts its own series on the same origin', R(`auxChannels.get('gen').buf.t[0]`) === 500); }
  // aux in the chart data, CSV, readout
  R(`activateSensor('a'); state.window=state.activeWindow=80; rebuildDerived(); state.live=false; state.viewMin=oldestTime(); state.viewMax=newestTime();`);
  { const d = J(`(()=>{const d=buildVisibleData();return {len:d.length,n:d[0].length,aux:d[5].length,first:d[5][0],mid:d[5][Math.round(120)],any:state.auxHasData,tAt:d[0][120]}})()`);
    ok('G4 chart data: an attached channel adds one column of the same length; null before its first sample, the interpolated value inside (22.0 at 1.5 s)', d.len === 6 && d.aux === d.n && d.first === null && nearAbs(d.mid, 22.0, 1e-9) && d.any, JSON.stringify(d)); }
  R(`globalThis.getComputedStyle=()=>({getPropertyValue:()=>'#888'}); globalThis.window.innerHeight=900;`);
  { const o = J(`(()=>{const a=makeMainOptions();state.auxHidden.add('t-body');const b=makeMainOptions();state.auxHidden.delete('t-body');return {s:a.series.length,ax:a.axes.length,sc:Object.keys(a.scales),side:a.axes[2].side,sc2:a.series[5].scale,label:a.series[5].label,s0:b.series.length,ax0:b.axes.length,sc0:Object.keys(b.scales)}})()`);
    ok('G4 chart options: an attached channel adds a series on its own "aux" scale and a right-hand axis; hiding it (toggle) removes all three', o.s === 6 && o.ax === 3 && o.sc.includes('aux') && o.side === 1 && o.sc2 === 'aux' && /Body/.test(o.label) && o.s0 === 5 && o.ax0 === 2 && !o.sc0.includes('aux'), JSON.stringify(o)); }
  R(`Blob=class{constructor(p){this.parts=p}}; downloadBlob=(b)=>{globalThis.__csv=b.parts.join('')}; exportCSV();`);
  { const lines = R(`__csv`).trim().split('\n'), h = lines[0].split(',');
    ok('G4 CSV: the 11 base columns stay, attached channels follow as aux_<id>; empty where the channel has no value', h.length === 12 && h[11] === 'aux_t-body' && h[10] === 'calibration_out_of_range' && lines[1].split(',')[11] === '' && lines.length === 162 && nearAbs(Number(lines[121].split(',')[11]), 22.0, 1e-6)); }
  { R(`updateAuxReadout()`); const t = R(`$('auxReadout').innerHTML`); ok('G4 readout: name, latest converted value and unit', /Body/.test(t) && /23[.,]25/.test(t) && /°C/.test(t) && R(`$('auxReadout').hidden`) === false);
    R(`for(let i=4;i<=70;i++)handleSseMessage('/s2',JSON.stringify([{id:'t-body',t:1e9+i*1000,raw:23.25+0.02*(i-3),n:i}]));updateAuxReadout()`); const t2 = R(`$('auxReadout').innerHTML`);
    ok('G4 readout shows the rate of change in K/min over the window (0.02 K/s = +1.20 K/min)', /\+1[.,]20 K\/min/.test(t2), t2); }
  R(`activateSensor('test')`); ok('G4 a channel not attached to the shown sensor adds nothing to its chart or CSV', R(`auxShownChannels().length`) === 0 && R(`emptyMainData().length`) === 5);
  R(`pauseAllToggle()`); ok('G4 Pause all also pauses and disconnects the channels; Resume all brings them back', R(`[...auxChannels.values()].every(c=>c.paused)`) && R(`__es.filter(e=>!e.closed).length`) === R(`__es.filter(e=>!e.closed).length`) && R(`wantedConnections().size`) === 0);
  R(`pauseAllToggle()`); ok('G4 resumed: both URLs wanted again', R(`wantedConnections().size`) === 2);
  R(`clearAllCharts()`); ok('G4 "Clear all charts" also empties the channels', R(`auxChannels.get('t-body').buf.count`) === 0);
  { const doc = JSON.parse(fs.readFileSync(require('path').join(require('path').dirname(file), 'sensors_example_aux.json'), 'utf8')); R = await load(); R(`globalThis.EventSource=class{constructor(u){this.url=u;this.readyState=0}close(){}}`);
    const r = J(`applySensorList(${JSON.stringify(doc)})`); ok('G4 the shipped example (sensors_example_aux.json: load cell + body + room NTC + humidity, one device) loads without errors', r.errors.length === 0 && r.added.join() === 'scale-1' && r.auxAdded.length === 3, JSON.stringify(r)); }
  // unlisted channels, reload keeps data
  R = await load(); R(`globalThis.EventSource=class{constructor(u){this.url=u;this.readyState=0}close(){}}; applySensorList([{id:'a',sseUrl:'/s1'},{id:'t',kind:'temperature',sseUrl:'/s2',attachedTo:['a']}]); handleSseMessage('/s2',JSON.stringify([{id:'t',t:5,raw:20,n:1}]));`);
  { const r = J(`applySensorList([{id:'a',sseUrl:'/s1'}])`); ok('G4 a channel missing from a reloaded list is marked "not in list", keeps its data and gets no connection', r.auxUnlisted.join() === 't' && R(`auxChannels.get('t').buf.count`) === 1 && R(`wantedConnections().has('/s2')`) === false);
    const r2 = J(`applySensorList([{id:'a',sseUrl:'/s1'},{id:'t',kind:'temperature',sseUrl:'/s2',attachedTo:['a'],conversion:{type:'polynomial',coefficients:[1,1]}}])`); ok('G4 reloaded with a changed firmware conversion: the stored samples are converted again (20 -> 21)', r2.auxUpdated.join() === 't' && R(`auxChannels.get('t').buf.val[0]`) === 21);
    ok('G4 an id cannot be both a load cell and a channel', J(`applySensorList([{id:'a',sseUrl:'/s1'},{id:'a',kind:'temperature'}])`).errors.length === 1); }
  // ---- history for channels (binary v2, JSON floats, gaps)
  { const b = R(`encodeHistoryBinaryV2([1,4000000000],[10,20],[1.5,-2.25])`); const dec = J(`decodeHistoryBinary(new Uint8Array(${JSON.stringify(Array.from(new Uint8Array(b)))}))`);
    ok('G5 binary layout v2 (16-byte records: u32 id, u32 ms, f64 raw) round-trips floats; v1 still decodes; JSON float chunks keep the decimals', dec.raw.join() === '1.5,-2.25' && dec.id[1] === 4000000000 && b.byteLength === 12 + 32 && J(`decodeHistoryJson({samples:[{n:1,t:2,raw:20.37}]},true).raw[0]`) === 20.37 && J(`decodeHistoryJson({samples:[{n:1,t:2,raw:20.37}]}).raw[0]`) === 20); }
  { R = await load();
    R(`globalThis.EventSource=class{constructor(u){this.url=u;this.readyState=0}close(){}}; globalThis.__hist={min:1,max:100000}; globalThis.__calls=[];
       globalThis.fetch=async(url)=>{__calls.push(url);const a=+/from_id=(\\d+)/.exec(url)[1],b=+/to_id=(\\d+)/.exec(url)[1],ids=[];for(let n=Math.max(a,__hist.min);n<=Math.min(b,__hist.max);n++)ids.push(n);return{ok:true,status:200,headers:{get:()=>'application/json'},json:async()=>({samples:ids.map(n=>({n,t:1e9+n*1000,raw:20+n/10}))})};};
       applySensorList([{id:'a',sseUrl:'/s1'},{id:'t',kind:'temperature',sseUrl:'/s2',historyUrl:'/h',attachedTo:['a']}]);
       handleSseMessage('/s2',JSON.stringify(Array.from({length:11},(_,k)=>({id:'t',t:1e9+(500+k)*1000,raw:20+(500+k)/10,n:500+k}))));`);
    await sleep(80);
    const h = J(`(()=>{const c=auxChannels.get('t'),b=c.buf,ids=[],ok1=[];for(let i=0;i<b.count;i++){ids.push(b.id[auxP(b,i)]);if(i&&b.t[auxP(b,i)]<=b.t[auxP(b,i-1)])ok1.push(i)}return {n:b.count,first:ids[0],last:ids[ids.length-1],contig:ids.every((v,i)=>!i||v===ids[i-1]+1),bad:ok1.length,v3:b.val[auxP(b,2)],t0:b.t[auxP(b,0)],st:c.history.status,req:__calls.slice(0,2)}})()`);
    ok('G5 on the first live sample the channel loads its older history by itself: ids 1..510 contiguous, time strictly ascending (negative before the stream origin), floats kept (20.3), then it stops', h.n === 510 && h.first === 1 && h.last === 510 && h.contig && h.bad === 0 && nearAbs(h.v3, 20.3, 1e-9) && h.t0 < 0 && /^complete/.test(h.st) && /sensor=t&from_id=0&to_id=499/.test(h.req[0]), JSON.stringify(h));
    R(`handleSseMessage('/s2',JSON.stringify([{id:'t',t:1e9+520*1000,raw:25.2,n:520}]))`); await sleep(60);
    ok('G5 a gap in the ids (511..519) is requested from the history server and merged into the middle', R(`auxChannels.get('t').gaps[0].status`) === 'filled' && R(`auxChannels.get('t').buf.count`) === 520 && R(`auxChannels.get('t').gapCount`) === 9);
    const m = J(`mergeAuxHistory(auxChannels.get('t'),{id:[515,516],t:[1e9+515000,1e9+516000],raw:[1,1]})`); ok('G5 an overlapping chunk is deduplicated by id', m.added === 0 && m.duplicates === 2); }
  // ---- characterization maths on constructed data
  R = await load();
  { const e = J(`eccentricityAnalysis({testMassMg:100000,centreRaw:5000,positions:[{name:'front',raw:5002},{name:'back',raw:4998},{name:'left',raw:5001},{name:'right',raw:5004}],slopeCountsPerMg:0.004})`);
    ok('G6 eccentricity: dev = (raw - centre) / slope = +500, -500, +250, +1000 mg; fraction of load = 1000 / 100000 = 1 %', e.ok && e.positions.map(p => p.devMg).join() === '500,-500,250,1000' && e.maxAbsDevMg === 1000 && near(e.fractionOfLoad, 0.01, 1e-12), JSON.stringify(e));
    ok('G6 eccentricity refuses: no centre, no positions, zero slope, no test mass (reasons given)', J(`eccentricityAnalysis({testMassMg:1,centreRaw:NaN,positions:[{name:'a',raw:1}],slopeCountsPerMg:1})`).errors.length === 1 && J(`eccentricityAnalysis({testMassMg:1,centreRaw:1,positions:[],slopeCountsPerMg:1})`).errors.length === 1 && J(`eccentricityAnalysis({testMassMg:1,centreRaw:1,positions:[{name:'a',raw:1}],slopeCountsPerMg:0})`).errors.length === 1 && J(`eccentricityAnalysis({testMassMg:0,centreRaw:1,positions:[{name:'a',raw:1}],slopeCountsPerMg:1})`).errors.length === 1);
    ok('G6 a negative slope (inverted polarity) keeps the sign of the deviation', J(`eccentricityAnalysis({testMassMg:100000,centreRaw:5000,positions:[{name:'f',raw:4998}],slopeCountsPerMg:-0.004})`).positions[0].devMg === 500); }
  { const stair = `Array.from({length:321},(_,t)=>({tS:t,raw:t<20?5000:t<45?5002:t<90?5004:t<200?5008:5012}))`, c = J(`creepAnalysis({series:${stair},settleS:10,emptyRaw:4600})`);
    ok('G6 creep: fraction = (r(t) - r(settle)) / (r(settle) - r_empty) at 30, 60, 120, 300 s = 0.5 %, 1 %, 2 %, 3 % of the load change (600 s and later do not fit into the recording)', c.ok && c.samples.map(s => s.tS).join() === '30,60,120,300' && c.samples.every((s, i) => near(s.fraction, [0.005, 0.01, 0.02, 0.03][i], 1e-12, 1e-12)), JSON.stringify(c));
    const cr = `{settleS:10,samples:${JSON.stringify(c.samples)}}`, f = t => J(`creepFractionAt(${cr},${t})`);
    ok('G6 creep curve lookup: 0 up to the settle time, linear in between (20 s -> 0.25 %, 45 s -> 0.75 %), constant and FLAGGED beyond the recording', f(5).value === 0 && near(f(20).value, 0.0025, 1e-12) && near(f(45).value, 0.0075, 1e-12) && f(1000).value === 0.03 && f(1000).flagged === true && f(100).flagged === false);
    ok('G6 creep refuses a recording that is too short, a missing empty reference and an undefined denominator', J(`creepAnalysis({series:${stair}.slice(0,25),settleS:10,emptyRaw:4600})`).ok === false && J(`creepAnalysis({series:${stair},settleS:10,emptyRaw:NaN})`).errors.length === 1 && J(`creepAnalysis({series:${stair},settleS:10,emptyRaw:5000})`).ok === false); }
  { const ser = Array.from({ length: 20 }, (_, i) => ({ tS: 30 * i, raw: 5000 + 0.008 * (30 * i / 3600) })), z = J(`zeroDriftAnalysis({series:${JSON.stringify(ser)},slopeCountsPerMg:0.004})`);
    ok('G6 zero drift: 0.008 counts/h at 0.004 counts/mg = 2 mg/h exactly; standard error 0 for noise-free data; duration reported', z.ok && near(z.rateMgPerH, 2, 1e-8) && nearAbs(z.seMgPerH, 0, 1e-6) && z.durationS === 570);
    const pat = [0.3, -0.3, 0.1, -0.1, 0.2], ser2 = Array.from({ length: 20 }, (_, i) => ({ tS: 30 * i, raw: 5000 + 0.5 * (30 * i / 3600) + pat[i % 5] })), z2 = J(`zeroDriftAnalysis({series:${JSON.stringify(ser2)},slopeCountsPerMg:0.004})`);
    const x = ser2.map(p => p.tS / 3600), y = ser2.map(p => p.raw), n = 20, mx = x.reduce((a, b) => a + b) / n, my = y.reduce((a, b) => a + b) / n; let sxx = 0, sxy = 0; x.forEach((v, i) => { sxx += (v - mx) ** 2; sxy += (v - mx) * (y[i] - my); });
    const b = sxy / sxx, a0 = my - b * mx; let sse = 0; x.forEach((v, i) => { sse += (y[i] - a0 - b * v) ** 2; });
    ok('G6 zero drift with scatter (equal weights): rate and standard error equal the closed-form least-squares line, sqrt(SSE/(n-2)/Sxx), in mg/h', near(z2.rateMgPerH, b / 0.004, 1e-9) && near(z2.seMgPerH, Math.sqrt(sse / (n - 2) / sxx) / 0.004, 1e-9) && z2.seMgPerH > 0, JSON.stringify(z2));
    const ser3 = ser.map((p, i) => ({ ...p, n: 100, sd: i === 5 ? 50 : 1 })), z3 = J(`zeroDriftAnalysis({series:${JSON.stringify(ser3)},slopeCountsPerMg:0.004})`); ok('G6 zero drift weights the blocks by 1/se²: a noisy block does not pull a straight noise-free line', z3.ok && near(z3.rateMgPerH, 2, 1e-6));
    ok('G6 zero drift needs at least 3 blocks and a slope', J(`zeroDriftAnalysis({series:${JSON.stringify(ser.slice(0, 2))},slopeCountsPerMg:0.004})`).ok === false && J(`zeroDriftAnalysis({series:${JSON.stringify(ser)},slopeCountsPerMg:0})`).ok === false); }
  { const bs = J(`binSeries(Array.from({length:1000},(_,i)=>i*100),Array.from({length:1000},(_,i)=>i),10)`);
    ok('G6 binning: 1000 samples over 100 s into 10 s blocks = 10 bins of 100, mean raw and mean time per bin, SD of the bin', bs.length === 10 && bs.every(b => b.n === 100) && near(bs[0].raw, 49.5, 1e-12) && near(bs[1].tS, 14.95, 1e-9) && near(bs[0].sd, Math.sqrt((100 * 100 - 1) / 12), 1e-9)); }
  { const pts = [], Tm = (() => { let s = 0; for (let i = 0; i < 10; i++) s += 18 + 0.8 * i; return s / 10; })();
    for (let i = 0; i < 10; i++) { const m = [0, 1e5, 2e5][i % 3], T = 18 + 0.8 * i, dT = T - Tm; pts.push({ massMg: m, raw: 4600 + 0.004 * m * (1 + 1e-4 * dT) + 0.8 * dT, tempC: T }); }
    const t = J(`fitTemperatureSensitivity(${JSON.stringify(pts)})`);
    ok('G6 temperature regression: known zero shift 0.8 counts/K at 0.004 counts/mg = 200 mg/K and span +100 ppm/K are recovered; reference = mean temperature; standard errors 0 for exact data', t.ok && near(t.zeroMgPerK, 200, 1e-6) && near(t.spanPpmPerK, 100, 1e-6) && near(t.referenceC, Tm, 1e-9) && nearAbs(t.zeroSe, 0, 1e-6) && t.n === 10 && t.dof === 6, JSON.stringify(t));
    const lo = J(`fitTemperatureSensitivity(${JSON.stringify(pts.map((p, i) => ({ ...p, tempC: 20 + 0.1 * i })))})`);
    ok('G6 temperature regression refuses a range below TEMP_FIT_MIN_RANGE_K (0.9 K) and says why; also too few points and a single mass', lo.ok === false && /at least 2 K/.test(lo.errors[0]) && J(`fitTemperatureSensitivity(${JSON.stringify(pts.slice(0, 4))})`).ok === false && J(`fitTemperatureSensitivity(${JSON.stringify(pts.filter(p => p.massMg === 0).map((p, i) => ({ ...p, tempC: 10 * i })))})`).ok === false);
    ok('G6 temperature that varies together with the mass cannot be separated (singular): refused', J(`fitTemperatureSensitivity(${JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ massMg: i * 1e4, raw: 5000 + i * 40, tempC: 20 + 3 * i })))})`).ok === false); }
  { const an = (c, s) => `{status:'${s}',checks:${JSON.stringify(c)}}`;
    ok('G6 long recordings drift on purpose: for creep / zero-drift only gaps, range, vibration and a STEP can invalidate; autocorrelation, Allan and a trend cannot; other purposes keep the full status', R(`charStatus(${an([{ id: 'autocorrelation', verdict: 'invalid' }, { id: 'gaps', verdict: 'ok' }, { id: 'step', verdict: 'invalid', stepLike: false }], 'invalid')},'zero-drift')`) === 'ok' && R(`charStatus(${an([{ id: 'gaps', verdict: 'ok' }, { id: 'step', verdict: 'invalid', stepLike: true }], 'invalid')},'creep')`) === 'invalid' && R(`charStatus(${an([{ id: 'gaps', verdict: 'suspect' }], 'suspect')},'zero-drift')`) === 'suspect' && R(`charStatus(${an([{ id: 'autocorrelation', verdict: 'invalid' }], 'invalid')},'eccentricity')`) === 'invalid');
    const r = J(`(()=>{${RNG13}const n=3000,t=Array.from({length:n},(_,i)=>i*12.5),drift=Array.from({length:n},(_,i)=>5000+i*0.004+gauss()*0.5),step=Array.from({length:n},(_,i)=>5000+(i>1500?6:0)+gauss()*0.5);const a=analyzeSeries(drift,t,{nominalMs:12.5}),b=analyzeSeries(step,t,{nominalMs:12.5});return {da:a.status,dc:charStatus(a,'zero-drift'),sa:b.status,sc:charStatus(b,'zero-drift')}})()`);
    ok('G6 on simulated data: a slow drift is flagged by the general checks but accepted as a drift recording; a 12 σ level step stays invalid for it', r.da !== 'ok' && r.dc === 'ok' && r.sc === 'invalid', JSON.stringify(r)); }
  // ---- uncertainty components (hand calculations)
  R = await load();
  { const P = `{status:'estimated',basis:'repeatability',components:[{id:'placement-repeatability',label:'p',included:true,dof:5,table:[{massMg:0,uMg:1},{massMg:2e5,uMg:1}],note:''},{id:'object-placement',label:'o',included:true,dof:5,table:[{massMg:0,uMg:1},{massMg:2e5,uMg:1}],note:''}],notIncluded:['hysteresis','temperature','creep','off-centre loading','drift between calibration and use']}`;
    const CH = `{status:'partly measured',eccentricity:{fractionOfLoad:0.01,source:'measured'},creep:{settleS:10,samples:[{tS:30,fraction:0.005},{tS:60,fraction:0.01}],source:'measured'},zeroDrift:{rateMgPerH:2,seMgPerH:1,source:'measured'},temperature:{referenceC:20,zeroMgPerK:200,spanPpmPerK:100,source:'user-estimate'}}`;
    const run = (ch, uc = `{readingDelayS:30,sessionSinceTareS:7200,temperatureDeltaK:3}`, extra = '') => J(`computeUncertainty(${P},{massMg:100000,sigmaMg:0,neff:100,sigmaCounts:0.1,slopeMgPerCount:NaN,char:${ch},uc:${uc}${extra}})`);
    const u = run(CH), by = id => (u.components.find(c => c.id === id) || {}).uMg, s3 = Math.sqrt(3);
    ok('G7 off-centre: half-width = fraction x mass = 1 % of 100 g = 1000 mg (the centre is the reference: no extra ÷ 2), standard uncertainty = 1000 / √3', near(by('off-centre'), 1000 / s3, 1e-12), String(by('off-centre')));
    ok('G7 creep: fraction at the reading delay (30 s: 0.5 %) x mass = 500 mg, / √3', near(by('creep'), 500 / s3, 1e-12));
    ok('G7 zero drift: rate x time since tare (2 mg/h x 2 h = 4 mg) with the standard error of the rate (1 mg/h x 2 h = 2 mg) in quadrature before ÷ √3: sqrt(16 + 4) / √3', near(by('zero-drift'), Math.sqrt(20) / s3, 1e-12));
    ok('G7 temperature (typed ΔT = 3 K): sqrt((200 x 3)² + (100e-6 x 100000 x 3)²) = 600.75 mg, / √3', near(by('temperature'), Math.hypot(600, 30) / s3, 1e-12));
    ok('G7 combined = root-sum-of-squares of all components; the components keep their order (repeatability, object, noise, then the four new ones)', near(u.combinedMg, Math.sqrt(u.components.reduce((s, c) => s + c.uMg ** 2, 0)), 1e-12) && u.components.map(c => c.id).join() === 'placement-repeatability,object-placement,reading-noise,off-centre,creep,zero-drift,temperature');
    ok('G7 label: measured parts listed, the typed temperature named as your estimate', u.label === 'estimated, repeatability, off-centre loading, creep and zero drift measured; temperature your estimate; not traceable', u.label);
    ok('G7 the four items leave the "not included" list exactly when included (hysteresis stays)', u.notIncluded.join() === 'hysteresis');
    const u2 = run(`{status:'partly measured',creep:{settleS:10,samples:[{tS:30,fraction:0.005}],source:'measured'},zeroDrift:{rateMgPerH:2,seMgPerH:null,source:'measured'},temperature:{referenceC:20,zeroMgPerK:200,spanPpmPerK:0,source:'user-estimate'}}`);
    ok('G7 the handout\'s example label: (estimated, repeatability, creep and zero drift measured; temperature your estimate; not traceable); what is missing stays on the list', u2.label === 'estimated, repeatability, creep and zero drift measured; temperature your estimate; not traceable' && u2.notIncluded.join() === 'hysteresis,off-centre loading');
    const u3 = run(CH, `{readingDelayS:30,sessionSinceTareS:7200,temperatureDeltaK:3}`, `,tempStats:{min:21,max:25.5,mean:23}`);
    ok('G7 with a temperature channel ΔT = largest |T - reference| over the measurement (5.5 K, not the typed 3 K); a typed sensitivity stays "your estimate"', near(u3.components.find(c => c.id === 'temperature').uMg, Math.hypot(200 * 5.5, 100e-6 * 1e5 * 5.5) / s3, 1e-12) && /from the temperature channel/.test(u3.components.find(c => c.id === 'temperature').note) && /temperature your estimate/.test(u3.label));
    const CHM = CH.replace("source:'user-estimate'", "source:'measured'"), u4 = run(CHM, `{readingDelayS:30,sessionSinceTareS:7200,temperatureDeltaK:3}`, `,tempStats:{min:21,max:25.5,mean:23}`);
    ok('G7 measured sensitivity AND a sensor ΔT: the temperature is listed as measured; measured sensitivity with only a typed ΔT is still "your estimate"', u4.label === 'estimated, repeatability, off-centre loading, creep, zero drift and temperature measured; not traceable' && /temperature your estimate/.test(run(CHM).label));
    const u5 = run(CH, `{readingDelayS:500,sessionSinceTareS:7200,temperatureDeltaK:3}`); ok('G7 a reading delay beyond the recorded creep curve uses its last value and says so', near(u5.components.find(c => c.id === 'creep').uMg, 1000 / s3, 1e-12) && /beyond the recorded curve/.test(u5.components.find(c => c.id === 'creep').note));
    const u6 = J(`computeUncertainty(${P},{massMg:100000,sigmaMg:0,neff:100,sigmaCounts:0.1,slopeMgPerCount:NaN,char:{status:'measured',eccentricity:{fractionOfLoad:0.01,source:'measured',calibrationProfileId:'x'}},calibrationProfileId:'y'})`);
    ok('G7 a test converted with another calibration (profile) than the one in use says so in the component note', /another calibration \(profile x\)/.test(u6.components.find(c => c.id === 'off-centre').note));
    const u0 = J(`computeUncertainty(${P},{massMg:100000,sigmaMg:2,neff:100,sigmaCounts:0.1,slopeMgPerCount:NaN})`), u00 = J(`computeUncertainty(${P},{massMg:100000,sigmaMg:2,neff:100,sigmaCounts:0.1,slopeMgPerCount:NaN,char:{status:'none'}})`);
    ok('G7 without a characterization block (or status none) nothing changes: three components, old label, full "not included" list', u0.components.length === 3 && u0.label === 'estimated, repeatability only, not traceable' && u0.notIncluded.length === 5 && u00.components.length === 3 && u00.label === u0.label);
    ok('G7 charIncludedNames / charNotIncluded', R(`[...charIncludedNames({status:'measured',creep:{samples:[{tS:30,fraction:.1}]},temperature:{zeroMgPerK:1}})].join()`) === 'creep,temperature' && R(`charNotIncluded(['temperature','creep','x'],{status:'measured',creep:{samples:[{tS:1,fraction:1}]}}).join()`) === 'temperature,x' && R(`charIncludedNames(undefined).size`) === 0); }
  // ---- use conditions
  R = await load(); R(`globalThis.EventSource=class{constructor(u){this.url=u;this.readyState=0}close(){}}; applySensorList([{id:'a',sseUrl:'/s1'},{id:'t1',kind:'temperature',sseUrl:'/s2',attachedTo:['a']},{id:'t2',kind:'temperature',sseUrl:'/s2',attachedTo:['a']}]);`);
  { ok('G8 use conditions: defaults 30 s / 3,600 s / 3 K, no primary channel', J(`useConditionsOf(sensors.get('a'))`).readingDelayS === 30 && R(`useConditionsOf(sensors.get('a')).sessionSinceTareS`) === 3600 && R(`useConditionsOf(sensors.get('a')).temperatureDeltaK`) === 3 && R(`primaryTempChannel(sensors.get('a')).id`) === 't1');
    ok('G8 applying valid values stores them per sensor; the user picks the primary channel of several', R(`applyUseConditions(sensors.get('a'),{readingDelayS:'45',sessionSinceTareS:600,temperatureDeltaK:'2.5',primaryTemperature:'t2'}).errors.length`) === 0 && R(`useConditionsOf(sensors.get('a')).readingDelayS`) === 45 && R(`useConditionsOf(sensors.get('a')).temperatureDeltaK`) === 2.5 && R(`primaryTempChannel(sensors.get('a')).id`) === 't2');
    ok('G8 invalid values are refused with a reason and change nothing', R(`applyUseConditions(sensors.get('a'),{readingDelayS:-1}).errors.length`) === 1 && R(`applyUseConditions(sensors.get('a'),{temperatureDeltaK:'x'}).errors.length`) === 1 && R(`useConditionsOf(sensors.get('a')).readingDelayS`) === 45);
    const d = J(`sensorSettingsDoc()`); ok('G8 sensor_settings.json carries useConditions per load cell and the user conversions of the channels (null = firmware)', d.sensors[0].useConditions.primaryTemperature === 't2' && d.sensors[0].useConditions.readingDelayS === 45 && d.auxChannels.length === 2 && d.auxChannels[0].conversion === null);
    const msg = await R(`applySensorSettingsDoc({sensors:[{id:'a',useConditions:{readingDelayS:12,primaryTemperature:'t1'}}],auxChannels:[{id:'t1',conversion:{type:'polynomial',coefficients:[-1,2]}},{id:'zzz',conversion:null},{id:'t2',conversion:{type:'bogus'}}]}).then(x=>JSON.stringify(x))`);
    ok('G8 loading a sensor_settings.json applies use conditions and a conversion correction (ice-point offset), reports unknown channels and invalid conversions', R(`useConditionsOf(sensors.get('a')).readingDelayS`) === 12 && R(`primaryTempChannel(sensors.get('a')).id`) === 't1' && R(`auxConversion(auxChannels.get('t1')).coefficients.join()`) === '-1,2' && /zzz/.test(msg) && /bogus|Unknown conversion/.test(msg), msg);
    R(`ingestAux(auxChannels.get('t1'),10,1000,1)`); R(`auxSetUserConversion(auxChannels.get('t1'),{type:'polynomial',coefficients:[0.5,1]})`);
    ok('G8 a conversion correction re-converts the stored samples; resetting returns to the firmware conversion', R(`auxChannels.get('t1').buf.val[0]`) === 10.5 && R(`auxSetUserConversion(auxChannels.get('t1'),null).length`) === 0 && R(`auxChannels.get('t1').buf.val[0]`) === 10); }
  { R = await load(); R(`globalThis.__ls={};globalThis.localStorage={getItem:k=>(k in __ls?__ls[k]:null),setItem:(k,v)=>{__ls[k]=String(v)},removeItem:k=>{delete __ls[k]}};`);
    ok('G8 UI setting: temperature rate window defaults to 60 s, is clamped to 5..3600 s, stored additively, round-trips, reset restores', J(`sanitizeUiSettings({schemaVersion:1}).value.tempRateWindowS`) === 60 && J(`sanitizeUiSettings({schemaVersion:1,tempRateWindowS:1}).value.tempRateWindowS`) === 5 && J(`sanitizeUiSettings({schemaVersion:1,tempRateWindowS:'x'}).errors.length`) === 1 && (R(`$('tempRateWindow').value=120;uiLocalWrite(collectUiSettings());$('tempRateWindow').value=30;applyUiSettings(uiLocalRead());$('tempRateWindow').value`) === 120) && (await R(`uiResetLocal().then(()=>$('tempRateWindow').value)`)) === 60); }
  // ---- calibration wizard: characterization tests never enter the fit, file block, round trip
  R = await load();
  { R(WIZ_FILL(`0`, `[null]`)); const b1 = J(`(()=>{const b=wizBuild();return {err:b.errors,anch:b.cfg.calibrationAnchors.map(a=>[a.referenceValue,a.rawMean]),n:b.cfg.fit.observationsUsed,st:b.cfg.characterization.status}})()`);
    ok('G9 a file without any characterization test writes {status: none} (all four entries null) and validates', b1.err.length === 0 && b1.st === 'none' && J(`wizBuild().cfg.characterization.eccentricity`) === null && R(`validateCalibrationConfig(wizBuild().cfg).errors.length`) === 0);
    const OBS = (id, load, raw, extra) => `wiz.observations.push(Object.assign({observationId:'${id}',loadId:'${load}',rawMean:${raw},include:true,sampleCount:800,durationMs:10000,validity:{status:'ok',flagged:[],analysis:null},placementIndex:1,removedAndReplaced:true,loadingDirection:null},${extra}))`;
    R(`${OBS('e1', 'load-100-A', 5000, "{purpose:'eccentricity',position:'centre'}")};${OBS('e2', 'load-100-A', 5002, "{purpose:'eccentricity',position:'front'}")};${OBS('e3', 'load-100-A', 4998, "{purpose:'eccentricity',position:'back'}")};${OBS('e4', 'load-100-A', 5001, "{purpose:'eccentricity',position:'left'}")};${OBS('e5', 'load-100-A', 5004, "{purpose:'eccentricity',position:'right'}")}`);
    R(`${OBS('c1', 'load-200-A', 5400, "{purpose:'creep',settleS:10,series:Array.from({length:321},(_,t)=>({tS:t,raw:5400+(t<20?0:t<45?2:t<90?4:t<200?8:12)}))}")};${OBS('d1', 'load-empty', 4600, "{purpose:'zero-drift',series:Array.from({length:20},(_,i)=>({tS:30*i,raw:4600+0.008*(30*i/3600)}))}")}`);
    const b2 = J(`(()=>{const b=wizBuild();return {err:b.errors,anch:b.cfg.calibrationAnchors.map(a=>[a.referenceValue,a.rawMean]),n:b.cfg.fit.observationsUsed,fitn:b.fit.n,ch:b.cfg.characterization,pts:wizPoints(wiz).points.length,slope:b.fit.slopeAt(100000),slope0:b.fit.slopeAt(0),empty:wizEmptyRaw(wiz),nObs:b.cfg.observations.length,purposes:[...new Set(b.cfg.observations.map(o=>o.purpose))]}})()`);
    ok('G9 characterization observations never enter the fit: the anchors, the number of observations used (15) and the points are identical with and without them; the file keeps them (22 observations, purposes listed)', b2.err.length === 0 && JSON.stringify(b2.anch) === JSON.stringify(b1.anch) && b2.n === 15 && b2.fitn === 15 && b2.pts === 15 && b2.nObs === 22 && b2.purposes.join() === 'calibration,eccentricity,creep,zero-drift', JSON.stringify([b2.n, b2.nObs]));
    const ch = b2.ch;
    ok('G9 eccentricity from the observations, converted with the FIT slope at the test mass: deviations (raw - centre) / slope, fraction = max / 100 g; observation ids and profile stored', ch.eccentricity.source === 'measured' && near(ch.eccentricity.positions.find(p => p.name === 'right').devMg, 4 / b2.slope, 1e-9) && near(ch.eccentricity.fractionOfLoad, (4 / b2.slope) / 100000, 1e-9) && ch.eccentricity.observationIds.length === 5 && ch.eccentricity.testMassMg === 100000 && ch.eccentricity.calibrationProfileId === 'scale-profile-demo-0001', JSON.stringify(ch.eccentricity));
    ok('G9 creep uses the empty-platform observations of the calibration as reference: 0.5 %, 1 %, 2 %, 3 % scaled by the real denominator', ch.creep.source === 'measured' && ch.creep.samples.length === 4 && near(ch.creep.samples[0].fraction, 2 / (5400 - b2.empty), 1e-12) && near(ch.creep.samples[3].fraction, 12 / (5400 - b2.empty), 1e-12) && ch.creep.testMassMg === 200000);
    ok('G9 zero drift: 0.008 counts/h converted with the slope at zero', ch.zeroDrift.source === 'measured' && near(ch.zeroDrift.rateMgPerH, 0.008 / b2.slope0, 1e-9) && ch.zeroDrift.durationS === 570);
    ok('G9 status: three measured, temperature missing = "partly measured"; the file validates', ch.status === 'partly measured' && ch.temperature === null && R(`validateCalibrationConfig(wizBuild().cfg).errors.length`) === 0);
    // temperature: measured from the observations' temperatures
    const T = R(`(()=>{const cal=wizCalObs(wiz),Tm=cal.reduce((s,_,i)=>s+18+0.8*i,0)/cal.length;cal.forEach((o,i)=>{const l=wiz.loads.find(x=>x.loadId===o.loadId),m=wizLoadMassMg(wiz,l),T=18+0.8*i,dT=T-Tm;o.rawMean=4600+0.004*m*(1+1e-4*dT)+0.8*dT;o.temperatures={'t-body':{mean:T,min:T-0.1,max:T+0.1,unit:'°C'}};});wizChar().tempChannelId='t-body';return Tm})()`);
    const b3 = J(`(()=>{const b=wizBuild();return {st:b.cfg.characterization.status,t:b.cfg.characterization.temperature,err:b.errors,notes:b.cfg.characterization.notes}})()`);
    ok('G9 temperature measured from the temperature channel stored with the observations: 200 mg/K, +100 ppm/K, source "measured", channel and reference stored; all four measured = status "measured"', b3.err.length === 0 && b3.t.source === 'measured' && b3.t.channelId === 't-body' && nearAbs(b3.t.zeroMgPerK, 200, 0.5) && nearAbs(b3.t.spanPpmPerK, 100, 1) && near(b3.t.referenceC, T, 1e-9) && b3.st === 'measured', JSON.stringify(b3));
    R(`wizChar().tempChannelId='nope'`); ok('G9 an unknown channel (no observation carries its temperature) gives no temperature entry and no crash', J(`wizBuild().cfg.characterization.temperature`) === null);
    R(`wizChar().tempChannelId='t-body'; wizChar().tempMode='typed'; wizChar().tempZero10K=2000; wizChar().tempSpanPpm=100; wizChar().tempRefC=20;`);
    const b4 = J(`wizBuild().cfg.characterization`); ok('G9 typed temperature values = "user-estimate" (zero shift per 10 K -> per K), reference typed; the status becomes "partly measured"', b4.temperature.source === 'user-estimate' && b4.temperature.zeroMgPerK === 200 && b4.temperature.spanPpmPerK === 100 && b4.temperature.referenceC === 20 && b4.temperature.channelId === null && b4.status === 'partly measured');
    // round trip through the file
    const before = J(`wizBuild().cfg.characterization`); R(`wizLoadFromConfig(JSON.parse(JSON.stringify(wizBuild().cfg)));wiz.sensorId=activeSensor.id;wiz.rateHz=80;`);
    const after = J(`wizBuild().cfg.characterization`);
    ok('G9 round trip: the file is loaded back (observations with purpose, position, series, temperatures, typed values) and rebuilds the same block', JSON.stringify(after) === JSON.stringify(before) && R(`wiz.observations.filter(o=>o.purpose==='eccentricity').length`) === 5 && R(`wizChar().tempMode`) === 'typed' && R(`wizChar().tempZero10K`) === 2000, JSON.stringify(after).slice(0, 200));
    R(`wiz.observations.find(o=>o.observationId==='e5').include=false`); const b5 = J(`wizBuild().cfg.characterization`);
    ok('G9 excluding a test observation takes it out of the result (and the file keeps it, marked)', b5.eccentricity.positions.every(p => p.name !== 'right') && J(`wizBuild().cfg.observations.find(o=>o.observationId==='e5').excluded`) === true);
    R(`const o=wiz.observations.find(o=>o.observationId==='e5');o.validity={status:'invalid',flagged:['Level step'],analysis:null};wizSetInclude(o,true)`);
    ok('G9 "include anyway" works for test observations and is recorded (overrideReason, characterization.overriddenObservations)', J(`wizBuild().cfg.characterization.overriddenObservations`).join() === 'e1,e2,e3,e4,e5'.split(',').filter(x => x === 'e5').join() && J(`wizBuild().cfg.observations.find(o=>o.observationId==='e5').overrideReason`) === 'included anyway by user');
    const bad = (f) => R(`(()=>{const c=JSON.parse(JSON.stringify(wizBuild().cfg));${f};return validateCalibrationConfig(c).errors.length})()`);
    ok('G9 validation of the block: bad status, negative fraction, bad source, malformed creep sample, unknown purpose are rejected', bad("c.characterization.status='x'") > 0 && bad('c.characterization.eccentricity.fractionOfLoad=-1') > 0 && bad("c.characterization.temperature.source='guess'") > 0 && bad("c.characterization.creep.samples=[{tS:'a'}]") > 0 && bad("c.observations[0].purpose='x'") > 0 && bad('') === 0); }
  { R = await load(); R(WIZ_FILL(`0`, `[null]`));
    ok('G9 typed estimates alone (no tests) = status "user-estimate"; one measured + others missing = "partly measured"', R(`(()=>{const C=wizChar();C.eccPct=1.5;C.creepPct=0.2;C.driftMgH=3;C.tempMode='typed';C.tempZero10K=10;return wizBuild().cfg.characterization.status})()`) === 'user-estimate' && J(`wizBuild().cfg.characterization.eccentricity.fractionOfLoad`) === 0.015 && J(`wizBuild().cfg.characterization.creep.samples[0].fraction`) === 0.002 && J(`wizBuild().cfg.characterization.zeroDrift.rateMgPerH`) === 3 && J(`wizBuild().cfg.characterization.zeroDrift.seMgPerH`) === null); }
  { R = await load(); const u = J(`computeUncertainty(calibration.uncertainty,{massMg:1,sigmaMg:1,neff:5})`);
    ok('G9 old files and the embedded demo have no characterization: shown as "not characterized", no number is invented', u.status === 'unavailable' && R(`charSummaryText(CALIBRATION.characterization)`) === 'not characterized' && /Characterization: not characterized/.test(R(`(updateCalibrationInfo(),$('calibrationInfo').innerHTML)`)) && R(`validateCalibrationConfig(JSON.parse(JSON.stringify(EMBEDDED_CALIBRATION))).errors.length`) === 0); }
  // ---- long recordings (creep, zero drift) through the real sample path
  R = await load();
  { R(WIZ_FILL(`0`, `[null]`)); R(`wiz.open=true; wizChar().driftMin=1; wizRecordLong('zero-drift');`);
    ok('G10 a long recording starts (tagged, blocked while another runs), uses the empty platform for zero drift', R(`state.charRec!==null&&state.charRec.durationS===60&&wiz.capture!==null&&wizBlock()!==''`) && R(`wiz.observations.length`) === 15);
    R(`for(let i=0;i<4900;i++)appendSample(5000+(Math.abs((Math.sin(i*12.9898)*43758.5453)%1)-0.5)*4+i*0.0005);`);
    const o = J(`(()=>{const o=wiz.observations[wiz.observations.length-1];return {n:wiz.observations.length,p:o.purpose,cnt:o.sampleCount,ser:o.series.length,ser0:o.series[0],st:o.validity.status,inc:o.include,done:wiz.capture===null&&state.charRec===null,load:o.loadId,note:o.validity.analysis.note,dur:o.durationMs}})()`);
    ok('G10 it finishes by itself after the chosen time (60 s = about 4800 samples), independent of the ring buffer; the series is 20 block means with SD and count; a slow staircase drift is accepted', o.n === 16 && o.p === 'zero-drift' && o.cnt >= 4795 && o.cnt <= 4805 && o.ser >= 20 && o.ser <= 21 && o.ser0.n > 200 && o.inc && o.done && o.load === 'load-empty' && /only gaps, range, vibration and a step/.test(o.note) && o.dur > 59000, JSON.stringify(o));
    R(`wiz.observations.pop(); wizChar().creepMin=99; wizChar().creepLoadId='load-100-A'; wizRecordLong('creep');`);
    ok('G10 the creep recording time is clamped to 30 min and needs a chosen weight; the sample limit protects the memory', R(`state.charRec.durationS`) === 1800 && R(`state.charRec.settleS`) === 10);
    R(`autoTare()`); ok('G10 a tare cancels a running long recording and leaves no observation', R(`state.charRec===null&&wiz.capture===null&&/cancelled/.test(wiz.message)&&wiz.observations.length===15`));
    R(`wizChar().driftMin=60; RATE_HZ=100000`); R(`wizRecordLong('zero-drift')`); ok('G10 a recording that would exceed CHAR_MAX_SAMPLES is refused with a message', /would exceed/.test(R(`wiz.message`))); R(`RATE_HZ=80; cancelCharRec('test')`);
    R(`wizChar().driftMin=1; wizRecordLong('zero-drift'); appendSample(5000); state.nextTime+=5000; appendSample(5000);`); ok('G10 a gap in the samples cancels it as well', R(`state.charRec===null`)); }
  // ---- eccentricity position through the normal capture, temperatures stored automatically
  R = await load();
  { R(`globalThis.EventSource=class{constructor(u){this.url=u;this.readyState=0}close(){}}`); R(WIZ_FILL(`0`, `[null]`));
    R(`makeAux({id:'tt',kind:'temperature',unit:'°C',rateHz:1,attachedTo:['test'],conversion:{type:'direct'},deviceId:'x'}); for(let k=0;k<30;k++)ingestAux(auxChannels.get('tt'),21+k*0.1,k*1000,k+1);`);
    R(`for(let i=0;i<100;i++)appendSample(5000); wizChar().eccLoadId='load-100-A'; wiz.open=true; wiz.captureSeconds=5; wizRecord({purpose:'eccentricity',position:'front',loadId:'load-100-A'});`);
    ok('G11 an eccentricity recording is a tagged capture with purpose and position', R(`state.measurement&&state.measurement.tag==='calibration wizard'&&wiz.capture.purpose==='eccentricity'&&wiz.capture.position==='front'`));
    R(`for(let i=0;i<400;i++)appendSample(5000);`);
    const o = J(`(()=>{const o=wiz.observations[wiz.observations.length-1];return {p:o.purpose,pos:o.position,l:o.loadId,t:o.temperatures,n:o.sampleCount,cal:wizCalObs(wiz).length,rev:o.recordedUnderRevision}})()`);
    ok('G11 the observation carries its purpose, position and the mean / min / max temperature of its recording (automatic, from the attached channel), and is not a calibration observation', o.p === 'eccentricity' && o.pos === 'front' && o.l === 'load-100-A' && o.n === 400 && o.t.tt.unit === '°C' && o.t.tt.min <= o.t.tt.mean && o.t.tt.mean <= o.t.tt.max && o.cal === 15 && !!o.rev, JSON.stringify(o)); }
  // ---- wizard panes render in both modes, simple extra checks
  for (const mode of ['advanced', 'simple']) for (const t of ['weights', 'observations', 'fit', 'review', 'char', 'extra'])
    ok(`G12 ${mode} tab "${t}" renders (characterization / extra checks included)`, (() => { try { R = R; R(`wizMode='${mode}';wiz.tab='${t}';wizRender();wq('wizBody').innerHTML.length`); return true; } catch (e) { console.log(e); return false; } })());
  { R(`wizMode='advanced';wiz.tab='char';wizRender()`); const h = R(`wq('wizBody').innerHTML`);
    ok('G12 Advanced tab 5: eccentricity, creep, zero drift and temperature sections; five position buttons; typed estimates; "Characterization:" summary', /Eccentricity \(off-centre loading\)/.test(h) && /Zero drift/.test(h) && /Temperature sensitivity/.test(h) && (h.match(/data-wa="recordChar"/g) || []).length === 5 && /data-f="eccPct"/.test(h) && /data-f="tempMode"/.test(h) && /Characterization: <strong>/.test(h) && /data-wa="recordLong" data-purpose="creep"/.test(h));
    R(`wizMode='simple';wiz.tab='extra';wizRender()`); const hs = R(`wq('wizBody').innerHTML`), tabs = R(`wq('wizBody').innerHTML`);
    ok('G12 Simple "4 Extra checks": exactly three numbered steps (off-centre, creep, zero drift), plain wording, the temperature estimate as an optional folded box (not a step), no Advanced-only fields', /Extra check 1 of 3/.test(hs) && /Extra check 2 of 3/.test(hs) && /Extra check 3 of 3/.test(hs) && !/Extra check 4/.test(hs) && /<details[^>]*><summary>Temperature \(optional, not a step\)/.test(hs) && !/data-f="eccPct"/.test(hs) && /How much does the reading change if you put the weight off-centre\?/.test(hs) && /4 Extra checks/.test(tabs));
    R(`wizMode='advanced';wiz.tab='extra';wizRender()`); ok('G12 a stored tab of the other mode maps to its counterpart (extra <-> char, fit -> review)', /Eccentricity \(off-centre loading\)/.test(R(`wq('wizBody').innerHTML`)));
    R(`wizMode='simple';wiz.tab='review';wizRender()`); ok('G12 Simple Finish still says "Step 3 of 3" and mentions the optional extra checks; Advanced review shows the characterization summary', /Step 3 of 3/.test(R(`wq('wizBody').innerHTML`)) && /Extra checks/.test(R(`wq('wizBody').innerHTML`)));
    R(`wizMode='advanced';wiz.tab='review';wizRender()`); ok('G12 the review pane lists the characterization status', /Characterization: <strong>/.test(R(`wq('wizBody').innerHTML`)));
    R(`wizMode='simple';wiz.tab='observations';wizRender()`); ok('G12 characterization observations do not appear in the placement list or the plan of the calibration', !/data-wa="delObs" data-i="1[5-9]"/.test(R(`wq('wizBody').innerHTML`)) && R(`wizFullPlan().reduce((s,r)=>s+r.done,0)`) <= 15); }
  { R(`wizMode='advanced';wiz.tab='char';wizRender();wizOnChange({target:{dataset:{w:'char',f:'creepMin'},type:'number',value:'7'}});wizOnChange({target:{dataset:{w:'char',f:'eccPct'},type:'number',value:'0.8'}})`);
    ok('G12 the characterization fields are wizard state (not UI settings, not written outside the block)', R(`wizChar().creepMin`) === '7' && R(`wizChar().eccPct`) === '0.8' && !('creepMin' in J(`collectUiSettings()`))); }
  // ---- integration: a calibration with a characterization changes the uncertainty of a real selection
  R = await load();
  { R(`globalThis.EventSource=class{constructor(u){this.url=u;this.readyState=0}close(){}}`); R(WIZ_FILL(`0`, `[null]`));
    R(`(()=>{const OBS=(id,load,raw,extra)=>wiz.observations.push(Object.assign({observationId:id,loadId:load,rawMean:raw,include:true,sampleCount:800,durationMs:10000,validity:{status:'ok',flagged:[],analysis:null},placementIndex:1,removedAndReplaced:true,loadingDirection:null},extra));
      OBS('e1','load-100-A',5000,{purpose:'eccentricity',position:'centre'});OBS('e2','load-100-A',5002,{purpose:'eccentricity',position:'front'});OBS('e3','load-100-A',4998,{purpose:'eccentricity',position:'back'});
      OBS('c1','load-200-A',5400,{purpose:'creep',settleS:10,series:Array.from({length:321},(_,t)=>({tS:t,raw:5400+(t<20?0:t<45?2:t<90?4:t<200?8:12)}))});
      OBS('d1','load-empty',4600,{purpose:'zero-drift',series:Array.from({length:20},(_,i)=>({tS:30*i,raw:4600+0.008*(30*i/3600)}))});
      const cal=wizCalObs(wiz),Tm=cal.reduce((s,_,i)=>s+18+0.8*i,0)/cal.length;cal.forEach((o,i)=>{const l=wiz.loads.find(x=>x.loadId===o.loadId),m=wizLoadMassMg(wiz,l),T=18+0.8*i,dT=T-Tm;o.rawMean=4600+0.004*m*(1+1e-4*dT)+0.8*dT;o.temperatures={tt:{mean:T,min:T,max:T,unit:'°C'}};});wizChar().tempChannelId='tt';wizChar().creepLoadId='load-200-A';})()`);
    const act = await R(`wizActivate().then(()=>JSON.stringify({msg:wiz.message,hasChar:!!state.calConfig.characterization,prep:!!calibration.characterization,st:state.calConfig.characterization&&state.calConfig.characterization.status}))`);
    ok('G13 activation carries the characterization into the active (prepared) calibration; the Characterization line of the calibration info shows it', JSON.parse(act).hasChar && JSON.parse(act).prep && JSON.parse(act).st === 'measured' && /Characterization: measured/.test(R(`(updateCalibrationInfo(),$('calibrationInfo').innerHTML)`)), act);
    R(`makeAux({id:'tt',kind:'temperature',unit:'°C',rateHz:1,attachedTo:['test'],conversion:{type:'direct'},deviceId:'x'}); state.simMode='quiet'; state.window=state.activeWindow=400; resizeBuffers(20000); const t0=state.nextTime; for(let k=-2;k<40;k++)ingestAux(auxChannels.get('tt'),25.5,t0+k*1000,k+3); for(let i=0;i<600;i++)appendSample(5000+((i*7)%5)-2);`);
    R(`applyUseConditions(testSensor,{readingDelayS:60,sessionSinceTareS:1800,temperatureDeltaK:3,primaryTemperature:'tt'}); selectInterval(getTime(60),getTime(459));`);
    const u = J(`state.selection.uncertainty`), ids = u.components.map(c => c.id).join(), refC = J(`state.calConfig.characterization.temperature.referenceC`);
    ok('G13 a selection under that calibration carries all four new components, the temperature from the attached channel (ΔT = |25.5 - reference|), the use conditions (60 s reading delay, 30 min since tare) and the long label', ids === 'placement-repeatability,object-placement,reading-noise,resolution,off-centre,creep,zero-drift,temperature' && near(u.conditions.readingDelayS, 60, 0) && /from the temperature channel/.test(u.components.find(c => c.id === 'temperature').note) && new RegExp(`ΔT = ${Math.abs(25.5 - refC).toFixed(2)} K`).test(u.components.find(c => c.id === 'temperature').note) && u.label === 'estimated, repeatability, off-centre loading, creep, zero drift and temperature measured; not traceable' && u.notIncluded.join() === 'weight tolerance,hysteresis', u.label + ' | ' + ids + ' | ' + u.notIncluded.join());
    const note = R(`$('uncertaintyStatus').textContent`); R(`updateMetrics()`);
    ok('G13 the status line under the cards names the characterization and drops the items that are now included from "not included"', /Characterization: measured/.test(R(`$('uncertaintyStatus').textContent`)) && !/Not included: [^.]*creep/.test(R(`$('uncertaintyStatus').textContent`)) && /Not included: weight tolerance, hysteresis/.test(R(`$('uncertaintyStatus').textContent`)), R(`$('uncertaintyStatus').textContent`));
    ok('G13 the use-conditions note (Sensor tab) says what the numbers do', /decide how large the estimated uncertainty is/.test(R(`useConditionsNote(testSensor)`)) && /creep after 60 s/.test(R(`useConditionsNote(testSensor)`)) && /not characterized|has no characterization/.test(R(`useConditionsNote(testSensor)`)) === false);
    const hl = R(`uncertaintyHTML(state.selection.uncertainty,'k')`); ok('G13 the details list shows the new components with their notes', /off-centre loading/.test(hl) && /zero drift/.test(hl) && /temperature \(measured\)/.test(hl));
    R(`Blob=class{constructor(p){this.parts=p}}; downloadBlob=(b)=>{globalThis.__csv=b.parts.join('')}; exportCSV();`); ok('G13 CSV of the shown sensor carries the attached channel as aux_tt', /,aux_tt\n/.test(R(`__csv.split('\\n')[0]+'\\n'`)));
    const sd = J(`sensorSettingsDoc()`); ok('G13 sensor_settings.json lists the use conditions of the shown sensor', sd.sensors.length === 0 && sd.auxChannels.length === 1); }
  { R = await load(); const E = `{recordedAt:'2026-11-20T10:00:00Z',weightId:'ref-100-A',referenceMassMg:100000,readingMg:100012.5,sigmaMg:3,neff:40,temperatureC:21.5,note:'weekly'}`;
    ok('G14 check-weighing file format: a valid document passes (also null sigma / neff / temperature, no weightId)', R(`validateCheckweighings(checkweighingsDoc('abc123',[${E},{recordedAt:'2026-11-27T10:00:00Z',referenceMassMg:100000,readingMg:100001,sigmaMg:null,neff:null,temperatureC:null}])).errors.length`) === 0 && R(`validateCheckweighings(checkweighingsDoc('abc123')).errors.length`) === 0);
    const bad = f => R(`(()=>{const d=checkweighingsDoc('abc123',[${E}]);${f};return validateCheckweighings(d).errors.length})()`);
    ok('G14 check-weighing validation: wrong schema, missing revision, bad date, zero reference mass, non-number reading, neff < 1, entries not a list, top level not an object', bad('d.schemaVersion=2') > 0 && bad("d.calibrationRevisionId=''") > 0 && bad("d.entries[0].recordedAt='yesterday'") > 0 && bad('d.entries[0].referenceMassMg=0') > 0 && bad("d.entries[0].readingMg='x'") > 0 && bad('d.entries[0].neff=0.5') > 0 && bad('d.entries=5') > 0 && R(`validateCheckweighings([1]).errors.length`) > 0 && bad('') === 0); }
  // ---- static: new elements exist
  ok('G14 new elements exist in the HTML', ['auxReadout', 'auxField', 'auxToggles', 'tempRateWindow', 'ssUseNote', 'ssReadDelay', 'ssSessionS', 'ssTempDelta', 'ssPrimaryTemp', 'ssAuxBox', 'ssAuxSelect', 'ssAuxConv', 'ssAuxApply', 'ssAuxReset', 'ssAuxInfo'].every(i => html.includes(`id="${i}"`)));
  ok('G14 the script file is the v16 one, the application version is stamped 16.0', /telemetry_workbench_v16\.js/.test(html) && /16\.0-wizard/.test(code));

  console.log(fails? `\n${fails} FAILED` : '\nall passed');
  process.exitCode = fails?1:0;
})();
