// Run: node tests/tracking.cjs [path/to/baseline-index.html]
// Uses the actual inline module and airdeck.fake/update. DOM, audio and WebGL
// are stubbed: this tests tracking/state, not MediaPipe inference or rendering.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
function boot(path) {
 const code = fs.readFileSync(path,'utf8').split('<script type="module">')[1].split('</script>')[0].replace(/^import .*$/mg,'');
 const noop=()=>{}, gradient={addColorStop:noop};
 const ctx=new Proxy({measureText:t=>({width:t.length*7}),createLinearGradient:()=>gradient}, {get:(o,k)=>k in o?o[k]:noop});
 const elements=new Map();
 const el=()=>({width:1280,height:720,style:{},classList:{toggle:noop,contains:()=>false,add:noop,remove:noop},addEventListener:noop,appendChild:noop,remove:noop,getContext:()=>ctx,querySelector:()=>({style:{}}),querySelectorAll:()=>[],textContent:'',value:''});
 const events={};
 const box={console,performance,Math,Float32Array,Uint8Array, setTimeout:()=>0,clearTimeout:noop,
 window:{addEventListener:(k,f)=>(events[k]??=[]).push(f)},document:{getElementById:k=>{if(!elements.has(k))elements.set(k,el());return elements.get(k)},createElement:el,querySelector:el,querySelectorAll:()=>[],body:el()},
 localStorage:{getItem:()=>null,setItem:noop},requestAnimationFrame:noop,Audio:class{play(){return Promise.resolve()}},
 Deck:class {constructor(){return new Proxy({currentSlot:null,blendState:()=>null,effectState:()=>({}),slotState:()=>[],waveform:()=>new Float32Array(128),bass:()=>0},{get:(o,k)=>k in o?o[k]:noop})}},
 FrameFx:class{constructor(){this.canvas=el();this.ok=true} resize(){}clear(){}render(){}},
 FilesetResolver:{forVisionTasks:async()=>({})},HandLandmarker:{createFromOptions:async()=>({})}};
 vm.createContext(box);vm.runInContext(code+'\nwindow.test={sides,resetSide,drawFrame,frameTips,assignSides,processHand,setVisual,OneEuro};',box);
 return {box,api:box.window.airdeck,internal:box.window.test,events,run:c=>vm.runInContext(c,box)};
}
// World fixture has straight index + extended thumb; other fingers curled by 180 degrees.
function hand(x=.3,y=.65,{bend=0,pinch=.5,noise=0,rand=Math.random,label='Left'}={}) {
 const w=Array.from({length:21},()=>({x:0,y:0,z:0}));
 w[0]={x:0,y:0,z:0};w[1]={x:-.018,y:-.014,z:0};w[2]={x:-.03,y:-.028,z:0};w[3]={x:-.052,y:-.028,z:0};w[4]={x:-.08,y:-.028,z:0};
 for(let j=0;j<4;j++) {let m=5+j*4,b=j===0?bend:150; w[m]={x:-.018+j*.014,y:-.05,z:0};w[m+1]={x:w[m].x,y:-.078,z:0};w[m+2]={x:w[m].x+.024*Math.sin(b*Math.PI/180),y:-.078-.024*Math.cos(b*Math.PI/180),z:0};w[m+3]={x:w[m+2].x,y:w[m+2].y-.018,z:0};}
 // Independent image geometry for control/noise fixtures (world points remain valid).
 const l=w.map(p=>({x:1-x+p.x*1.8+(rand()-.5)*noise,y:y+p.y*3.2+(rand()-.5)*noise,z:0}));
 // Place thumb segment parallel to upper index, with controllable gap in palm units.
 if(pinch!==null){ const gap=pinch*.10;l[3]={x:l[7].x-gap,y:l[7].y,z:0};l[4]={x:l[8].x-gap,y:l[8].y,z:0}; }
 return {l,w,label};
}
function result(hands){return {landmarks:hands.map(h=>h.l),worldLandmarks:hands.map(h=>h.w),handedness:hands.map(h=>[{categoryName:h.label,score:.99}])}}
function seed(){let n=12345;return()=>((n=Math.imul(1664525,n)+1013904223|0)>>>0)/4294967296}
function feed(env,hands,t){env.api.fake=result(hands);env.api.update(env.api.fake,t)}
function sd(a){let m=a.reduce((x,y)=>x+y,0)/a.length;return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/a.length)}
function metrics(path){
 let e=boot(path),r=seed(),raw=[],sm=[];
 for(let i=0;i<360;i++){let h=hand(.3,.65,{noise:.01,rand:r});feed(e,[h],1000+i*1000/30);if(i>60){raw.push((1-h.l[8].x)*1280);sm.push(e.internal.sides.left.hand.pts[8].x)}}
 const jitter={raw:sd(raw),filtered:sd(sm)};
 e=boot(path);let lags=[];
 for(let i=0;i<120;i++){let x=.2+Math.max(0,i-30)/30*.10;let h=hand(x);feed(e,[h],1000+i*1000/30);if(i>50&&i<110)lags.push(((1-h.l[8].x)*1280-e.internal.sides.left.hand.pts[8].x)/128*1000)}
 const lag=lags.reduce((a,b)=>a+b,0)/lags.length;
 e=boot(path);let swaps=0;
 for(let i=0;i<=90;i++){const a=hand(.2+.6*i/90,.62,{label:'Left'}),b=hand(.8-.6*i/90,.68,{label:'Right'});feed(e,i%2?[b,a]:[a,b],1000+i*1000/30);if(Math.abs(e.internal.sides.left.hand.wristX-(1-a.l[0].x))>1e-6)swaps++}
 e=boot(path);let flips=0,last=null;
 for(let i=0;i<180;i++){feed(e,[hand(.3,.65,{bend:i? (i%2?33:37):20})],1000+i*1000/30);const ext=e.internal.sides.left.hand.ext[1];if(last!==null&&ext!==last)flips++;last=ext;}
 e=boot(path);let pj=[];r=seed();
 for(let i=0;i<360;i++){feed(e,[hand(.3,.65,{pinch:.5+(r()-.5)*.1})],1000+i*1000/30);if(i>60)pj.push(e.internal.sides.left.hand.pinch)}
 e=boot(path);let step=null;
 for(let i=0;i<100;i++){feed(e,[hand(.3,.65,{pinch:i<30?.3:.7})],1000+i*1000/30);if(i===29)var start=e.internal.sides.left.hand.pinch;if(i===99)var end=e.internal.sides.left.hand.pinch;(e.values??=[]).push(e.internal.sides.left.hand.pinch)}
 step=(e.values.findIndex((v,i)=>i>=30&&v>start+(end-start)*.5)-30)*1000/30;
 return {jitterPx:jitter,pointRampLagMs:lag,crossingWrongFrames:swaps,fingerThresholdFlips:flips,pinchJitter:sd(pj),pinchStep50Ms:step};
}

const path = require('path').join(__dirname, '..', 'index.html');
const baseline = process.argv[2];

function pair(){return [hand(.25,.65,{pinch:null,label:'Left'}),hand(.75,.7,{pinch:null,label:'Right'})]}
function start(e){for(let i=0;i<12;i++)feed(e,pair(),1000+i*1000/30);assert(e.api.frame.active,'L starts shape');}
function projection(e){start(e);for(let i=0;i<45;i++){let hs=pair();for(let h of hs){h.l[3]={...h.l[6]};h.l[4]={...h.l[6],x:h.l[6].x+.005};}feed(e,hs,1400+i*1000/30)}return e.api.frame.active}
if (baseline) console.log('Shape survives false segment pinch:', {before:projection(boot(baseline)),after:projection(boot(path))});
assert(projection(boot(path)));
let e=boot(path);start(e);
// One bad close sample must not hide the visual; a deliberate release must.
let close=pair();close[0].l[4]={...close[0].l[8]};close[0].l[3]={...close[0].l[8]};
feed(e,close,1400);assert(e.api.frame.active);feed(e,pair(),1433);assert(e.api.frame.active);
for(let i=0;i<7;i++)feed(e,close,1500+i*1000/30);
assert(!e.api.frame.active,'confirmed closed tips release');
e=boot(path);start(e);feed(e,[],1600);assert(e.api.frame.active,'brief loss held');feed(e,pair(),1633);assert(e.api.frame.active,'returns smoothly');feed(e,[],2200);assert(!e.api.frame.active,'sustained loss expires');
e=boot(path);start(e);const before=e.internal.sides.left.lastSeen;let bad=pair();bad[0].l[8].x=NaN;feed(e,bad,1400);assert.equal(e.internal.sides.left.lastSeen,before,'invalid hand skipped');feed(e,pair(),1433);assert(Number.isFinite(e.internal.sides.left.hand.pinch));
// Assignment without handedness, reversed result order, and a single moving hand.
e=boot(path);for(let i=0;i<91;i++){let a=hand(.2+.6*i/90,.62),b=hand(.8-.6*i/90,.68);a.label=b.label=null;feed(e,i%2?[b,a]:[a,b],1000+i*1000/30);assert(Math.abs(e.internal.sides.left.hand.wristX-(1-a.l[0].x))<1e-6)}
e=boot(path);for(let i=0;i<91;i++)feed(e,[hand(.2+.6*i/90)],1000+i*1000/30);assert(e.internal.sides.left.hand.wristX>.7);assert.equal(e.internal.sides.right.hand,null);
// A newly acquired hand cannot inherit old filters after the hold expires.
feed(e,[hand(.8)],6000);assert.equal(e.internal.sides.right.hand.pts[0].x,.8*1280);
// All original keyboard mode entries still work, and D toggles diagnostics.
e=boot(path);for(const [key,mode] of [['s','song'],['f','fx'],['v','vis'],['Escape','normal']]){for(const f of e.events.keydown)f({key,target:{tagName:'BODY'},preventDefault(){}});assert.equal(e.api.modes.current,mode)}
for(const f of e.events.keydown)f({key:'d',target:{tagName:'BODY'},preventDefault(){}});assert(e.api.trackingDebug.enabled);start(e);e.internal.drawFrame(1400);
console.log('PASS: false pinch, transient/confirmed release, loss/reacquisition, malformed input, unlabeled crossings, single-hand continuity, keyboard modes, debug draw');
// Synthetic gesture workflows: fist zones, held choices, commit on exit, and lock.
function counted(x,y,n,label){const h=hand(x,y,{pinch:null,label});h.w[4]={...h.w[5]};for(let j=0;j<4;j++){const m=5+j*4,b=j<n?0:150;h.w[m+2]={x:h.w[m].x+.024*Math.sin(b*Math.PI/180),y:-.078-.024*Math.cos(b*Math.PI/180),z:0};h.w[m+3]={x:h.w[m+2].x,y:h.w[m+2].y-.018,z:0};}if(n===5)h.w[4]={x:-.08,y:-.028,z:0};return h;}
for(const mode of ['song','fx','vis']){const e=boot(path),picks=[];e.api.deck.pickSlot=(n)=>picks.push(n);e.api.deck.toggleEffect=(name)=>{picks.push(name);return false};for(let i=0;i<40;i++){const hs=mode==='fx'?[counted(.06,.6,0,'Left'),counted(.6,.6,2,'Right')]:[counted(.3,.6,3,'Left'),counted(.9,mode==='vis'?.94:.6,0,'Right')];feed(e,hs,1000+i*1000/30)}assert.equal(e.api.modes.current,mode);assert.equal(e.api.modes.pending,mode==='fx'?2:3);for(let i=0;i<20;i++)feed(e,[counted(.3,.6,3,'Left'),counted(.6,.6,2,'Right')],2400+i*1000/30);assert.equal(e.api.modes.current,'normal');if(mode==='song')assert.equal(picks[0],2);if(mode==='fx')assert.equal(picks[0],'echo');if(mode==='vis')assert.equal(e.run('visualFx'),'kaleido');}
e=boot(path);for(let i=0;i<51;i++)feed(e,[counted(.4,.3,5,'Left')],1000+i*1000/30);assert(e.api.lock.locked,'top hold locks');
for(let i=0;i<20;i++)feed(e,[counted(.4,.7,5,'Left')],2800+i*1000/30);
for(let i=0;i<66;i++)feed(e,[counted(.4,.3,5,'Left')],3600+i*1000/30);assert(!e.api.lock.locked,'second top hold unlocks');
console.log('PASS: song/effects/visual fist-zone selection and commit, top-zone lock/unlock');

console.log(JSON.stringify({ ...(baseline ? {before: metrics(baseline)} : {}), after: metrics(path) }, null, 2));
// A narrow visible shape stays visible through the hysteresis band; hidden shapes
// need the larger entry area. Debug must retain the renderer's hide reason.
e=boot(path);start(e);e.internal.drawFrame(1400);
for (const [area, visible] of [[.003,true],[.001,false],[.003,false],[.005,true]]) {
  e.run(`shownCorners=null; frame.target=[{x:0,y:0},{x:128,y:0},{x:128,y:${area*7200}},{x:0,y:${area*7200}}];`);
  e.internal.drawFrame(1450);
  assert.equal(e.run('fxShown'),visible);
  if(!visible) assert.equal(e.api.trackingDebug.renderReason,'projected shape too small');
}
console.log('PASS: shape area hysteresis and renderer diagnostic reason');
