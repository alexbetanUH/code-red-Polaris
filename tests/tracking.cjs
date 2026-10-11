// Run: node tests/tracking.cjs [path/to/baseline-index.html]
// Uses the actual inline module and airdeck.fake/update. DOM, audio and WebGL
// are stubbed: this tests tracking/state, not MediaPipe inference or rendering.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
function boot(path) {
 const code = fs.readFileSync(path,'utf8').split('<script type="module">')[1].split('</script>')[0].replace(/^import .*$/mg,'');
 const noop=()=>{}, gradient={addColorStop:noop};
 const ctx=new Proxy({measureText:t=>({width:t.length*7}),createLinearGradient:()=>gradient}, {get:(o,k)=>k in o?o[k]:noop});
 const elements=new Map();
 const el=()=>({width:1280,height:720,style:{},classList:{toggle:noop,contains:()=>false,add:noop,remove:noop},addEventListener:noop,appendChild:noop,append:noop,remove:noop,getContext:()=>ctx,querySelector:()=>({style:{}}),querySelectorAll:()=>[],textContent:'',value:''});
 const events={};
 const box={console,performance,Math,Float32Array,Uint8Array, setTimeout:()=>0,clearTimeout:noop,
 window:{addEventListener:(k,f)=>(events[k]??=[]).push(f)},document:{getElementById:k=>{if(!elements.has(k))elements.set(k,el());return elements.get(k)},createElement:el,querySelector:el,querySelectorAll:()=>[],body:el()},
 localStorage:{getItem:()=>null,setItem:noop},requestAnimationFrame:noop,Audio:class{play(){return Promise.resolve()}},
 Deck:class {constructor(){return new Proxy({currentSlot:null,blendState:()=>null,effectState:()=>({}),slotState:()=>[],waveform:()=>new Float32Array(128),bass:()=>0},{get:(o,k)=>k in o?o[k]:noop})}},
 FrameFx:class{constructor(){this.canvas=el();this.ok=true} resize(){}clear(){}render(){}},
 createQueue:()=>({calls:[],on:noop,next(){this.calls.push('next')},play(id){this.calls.push('play:'+id)},seek(t){this.calls.push('seek:'+t)},getUpNext:()=>null,mixNow:()=>false,holdControls:noop,coachPing:noop,startHandMix:async()=>null,startDefaultQueue(){this.calls.push('default');return new Promise(()=>{})},getState:()=>({items:[{id:'a'},{id:'b'}],currentId:'b',downloads:[],status:null,dj:{}})}),createQueuePanel:()=>({toggle:noop}),createTransport:el,createUpNext:()=>({element:el()}),location:{hash:'',replace:noop},
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
function start(e){for(let i=0;i<12;i++)feed(e,pair(),1000+i*1000/30);assert(e.api.frame.active,'two tracked hands start shape');}
function projection(e){start(e);for(let i=0;i<45;i++){let hs=pair();for(let h of hs){h.l[3]={...h.l[6]};h.l[4]={...h.l[6],x:h.l[6].x+.005};}feed(e,hs,1400+i*1000/30)}return e.api.frame.active}
if (baseline) console.log('Shape survives false segment pinch:', {before:projection(boot(baseline)),after:projection(boot(path))});
assert(projection(boot(path)));
let e=boot(path);start(e);
// Pose and pinch do not release the shape; only missing/degenerate geometry does.
let close=pair();close[0].l[4]={...close[0].l[8]};close[0].l[3]={...close[0].l[8]};
feed(e,close,1400);assert(e.api.frame.active);feed(e,pair(),1433);assert(e.api.frame.active);
for(let i=0;i<7;i++)feed(e,close,1500+i*1000/30);
assert(e.api.frame.active,'closed tips do not impose a pose gate');
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
console.log('PASS: false pinch, pose-independent activation, loss/reacquisition, malformed input, unlabeled crossings, single-hand continuity, keyboard modes, debug draw');
// Synthetic gesture workflows: fist zones, held choices, commit on exit, and lock.
function counted(x,y,n,label){const h=hand(x,y,{pinch:null,label});h.w[4]={...h.w[5]};for(let j=0;j<4;j++){const m=5+j*4,b=j<n?0:150;h.w[m+2]={x:h.w[m].x+.024*Math.sin(b*Math.PI/180),y:-.078-.024*Math.cos(b*Math.PI/180),z:0};h.w[m+3]={x:h.w[m+2].x,y:h.w[m+2].y-.018,z:0};}if(n===5)h.w[4]={x:-.08,y:-.028,z:0};return h;}
for(const mode of ['song','fx','vis']){const e=boot(path),picks=[];e.api.deck.pickSlot=(n)=>picks.push(n);e.api.deck.toggleEffect=(name)=>{picks.push(name);return false};for(let i=0;i<40;i++){const hs=mode==='fx'?[counted(.06,.6,0,'Left'),counted(.6,.6,2,'Right')]:[counted(.3,.6,3,'Left'),counted(.9,mode==='vis'?.94:.6,0,'Right')];feed(e,hs,1000+i*1000/30)}assert.equal(e.api.modes.current,mode);assert.equal(e.api.modes.pending,mode==='fx'?2:3);for(let i=0;i<20;i++)feed(e,[counted(.3,.6,3,'Left'),counted(.6,.6,2,'Right')],2400+i*1000/30);assert.equal(e.api.modes.current,'normal');if(mode==='song')assert.deepEqual(e.run('queue.calls'),[],'3 fingers in the song zone = nothing');if(mode==='fx')assert.equal(picks[0],'echo');if(mode==='vis')assert.equal(e.run('visualFx'),'kaleido');}
{const e=boot(path),key=(k)=>{for(const f of e.events.keydown)f({key:k,target:{tagName:'BODY'},preventDefault(){}})};key('s');key('1');key('2');assert.deepEqual(e.run('queue.calls'),['next','play:a'],'song keys: 1 = next, 2 = previous')}
// Song gestures start playback from idle; Previous on the first song must play,
// rather than seek (which preserves the paused state). Playing decks keep hand mixes.
{
 const e=boot(path);
 e.api.deck.playing=false;
 e.run(`queue.getState=()=>({items:[{id:'a'},{id:'b'}],currentId:null});queue.getUpNext=()=>({item:{id:'a'}});queue.mixNow=()=>{throw new Error('idle next must play directly')};`);
 e.run('enterMode("song",true);pick(1);pick(2);');
 assert.deepEqual(e.run('queue.calls'),['next','play:a'],'idle next and previous start queued playback');
 e.run(`queue.calls.length=0;queue.getState=()=>({items:[{id:'a'},{id:'b'}],currentId:'a'});pick(2);`);
 assert.deepEqual(e.run('queue.calls'),['play:a'],'previous on a paused first song starts it');
 e.run(`queue.calls.length=0;queue.getState=()=>({items:[],currentId:null});pick(1);pick(2);`);
 assert.deepEqual(e.run('queue.calls'),['default'],'empty queue boots defaults once, without a double skip');
 e.run('defaultQueueStarting=false;queue.calls.length=0;');
 e.api.deck.playing=true;
 e.run(`queue.getState=()=>({items:[{id:'a'},{id:'b'}],currentId:'a'});queue.getUpNext=()=>({item:{id:'b'}});queue.startHandMix=()=>{queue.calls.push('handmix');return new Promise(()=>{})};pick(1);`);
 assert.deepEqual(e.run('queue.calls'),['handmix'],'next while playing retains the hand blend');
}
e=boot(path);for(let i=0;i<51;i++)feed(e,[counted(.4,.3,5,'Left')],1000+i*1000/30);assert(e.api.lock.locked,'top hold locks');
for(let i=0;i<20;i++)feed(e,[counted(.4,.7,5,'Left')],2800+i*1000/30);
for(let i=0;i<66;i++)feed(e,[counted(.4,.3,5,'Left')],3600+i*1000/30);assert(!e.api.lock.locked,'second top hold unlocks');
console.log('PASS: song/effects/visual fist-zone selection and commit, top-zone lock/unlock');
// Drive the actual pipeline with right-hand palm positions below/inside the lock zone.
{
 const e=boot(path),state={echo:{on:true,amount:0.5}};
 e.api.deck.effectState=()=>state;e.api.deck.setEffectAmount=(name,value)=>state[name].amount=value;
 e.run('lastFx="echo";');
 const atPalm=y=>{const h=hand(.6,.7,{pinch:null,label:'Right'});const palm=[0,5,9,13,17].reduce((s,i)=>s+h.l[i].y,0)/5;for(const p of h.l)p.y+=y-palm;return h;};
 let time=1000;
 for(let i=0;i<50;i++)feed(e,[atPalm(.85)],time+=34);
 assert(state.echo.amount<.02,'low hand gives minimum strength');
 for(let i=1;i<=30;i++)feed(e,[atPalm(.85-(.45*i/30))],time+=34);
 for(let i=0;i<50;i++)feed(e,[atPalm(.40)],time+=34);
 assert(state.echo.amount>.98,'maximum is reachable below the lock zone');assert(!e.api.lock.locked);
 for(let i=1;i<=15;i++)feed(e,[atPalm(.4-(.15*i/15))],time+=34);
 state.echo.amount=.45;
 for(let i=0;i<15;i++)feed(e,[atPalm(.25)],time+=34);
 assert.equal(state.echo.amount,.45,'lock-zone hand holds the effect amount');
 for(let i=1;i<=30;i++)feed(e,[atPalm(.25+(.375*i/30))],time+=34);
 for(let i=0;i<50;i++)feed(e,[atPalm(.625)],time+=34);
 assert(Math.abs(state.echo.amount-.5)<.02,'middle hand gives middle strength');
 feed(e,[],time+=1000);assert(Math.abs(state.echo.amount-.5)<.02,'hand loss holds the last strength');
}
console.log('PASS: simple right-hand effect height, full range below lock zone, lock-zone/loss hold');


console.log(JSON.stringify({ ...(baseline ? {before: metrics(baseline)} : {}), after: metrics(path) }, null, 2));
// A narrow visible shape stays visible through the hysteresis band; hidden shapes
// need the larger entry area. Debug must retain the renderer's hide reason.
e=boot(path);start(e);e.internal.drawFrame(1400);
for (const [area, visible] of [[.00000075,true],[.00000025,false],[.00000075,false],[.000002,true]]) {
  e.run(`shownCorners=null; frame.target=[{x:0,y:0},{x:128,y:0},{x:128,y:${area*7200}},{x:0,y:${area*7200}}];`);
  e.internal.drawFrame(1450);
  assert.equal(e.run('fxShown'),visible);
  if(!visible) assert.equal(e.api.trackingDebug.renderReason,'projected shape too small');
}
console.log('PASS: shape area hysteresis and renderer diagnostic reason');

// Open palms must activate directly, without passing through L.
e=boot(path);
for(let i=0;i<12;i++) feed(e,[counted(.25,.7,5,'Left'),counted(.75,.7,5,'Right')],1000+i*1000/30);
assert(e.api.frame.active); assert(!e.internal.sides.left.hand.lNow);
// Basic controls remain live while the automatic visual is active.
const oldSpeed=e.api.controls.speed;
for(let i=0;i<30;i++) feed(e,[hand(.25,.7,{pinch:.1}),hand(.75,.7,{pinch:.8,label:'Right'})],1500+i*1000/30);
assert(e.api.frame.active); assert.notEqual(e.api.controls.speed,oldSpeed);
// Cross at the same wrist height, independently rotate one hand, reverse detector order.
e=boot(path);
for(let i=0;i<121;i++) {
  const a=hand(.2+.6*i/120,.7,{pinch:null,label:'Left'}), b=hand(.8-.6*i/120,.7,{pinch:null,label:'Right'});
  const angle=i/120*Math.PI*2, origin={...a.l[0]};
  for(const p of a.l) {const x=p.x-origin.x,y=p.y-origin.y;p.x=origin.x+x*Math.cos(angle)-y*Math.sin(angle);p.y=origin.y+x*Math.sin(angle)+y*Math.cos(angle);}
  feed(e,i%2?[b,a]:[a,b],1000+i*1000/30);
  assert(e.api.frame.active);
  assert(Math.abs(e.internal.sides.left.hand.wristX-(1-a.l[0].x))<1e-6);
}
// Test the renderer's actual triangulation: both windings, each reflex position,
// and randomized angularly sorted points. Triangle areas must sum to polygon area.
const frameSource=fs.readFileSync(require('path').join(__dirname,'..','frame.js'),'utf8');
const tri=vm.runInNewContext(frameSource.slice(frameSource.indexOf('export function triangulateQuad')).replace('export ', '')+';triangulateQuad');
const area=q=>Math.abs(q.reduce((s,p,i)=>{const n=q[(i+1)%q.length];return s+p.x*n.y-n.x*p.y},0))/2;
const verify=q=>{const ids=tri(q);assert.equal(new Set(ids).size,4);const sum=area(ids.slice(0,3).map(i=>q[i]))+area(ids.slice(3).map(i=>q[i]));assert(Math.abs(sum-area(q))<1e-8);};
for(const points of [[[0,0],[4,0],[1,1],[0,4]],[[0,0],[4,0],[4,4],[1,1]],[[0,0],[4,0],[4,4],[0,4]]]) {
 for(const rev of [false,true])for(let shift=0;shift<4;shift++){let q=points.map(([x,y])=>({x,y}));if(rev)q.reverse();q=q.slice(shift).concat(q.slice(0,shift));verify(q);}
}
const rng=seed();
for(let i=0;i<1000;i++){const q=Array.from({length:4},()=>({x:rng(),y:rng()}));e.box.geometry=q;verify(e.run('orderByAngle(geometry)'));}
console.log('PASS: open-palm activation, simultaneous controls, same-height crossing/rotation, concave triangulation in both windings (1000 random layouts)');
