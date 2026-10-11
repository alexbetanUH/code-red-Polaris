// Run: node tests/hand-blend.cjs. Real transition code with audio nodes stubbed.
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const code=fs.readFileSync(__dirname+'/../transitions.js','utf8').replace(/^import .*$/mg,'').replace(/^export /mg,'');
const param=value=>({value,setTargetAtTime(v){this.value=v},setValueAtTime(v){this.value=v},cancelScheduledValues(){},linearRampToValueAtTime(v){this.value=v},exponentialRampToValueAtTime(v){this.value=v}});
const nodes=[];
const node=()=>({connect(){return this},disconnect(){},stop(){}});
const ctx={currentTime:10,createGain(){const n={...node(),gain:param(1)};nodes.push(n);return n},createBiquadFilter(){const n={...node(),frequency:param(0)};nodes.push(n);return n},createBufferSource(){return {...node(),playbackRate:param(1),start(when,offset){this.when=when;this.at=offset}}}};
const buffer=()=>({duration:30,sampleRate:8,length:240,numberOfChannels:1,getChannelData(){return new Float32Array(240).fill(.5)}});
const deck={ctx,buffer:buffer(),source:node(),rate:1,playing:true,filter:node(),position:()=>12,setSpeed(v){this.rate=v}};
let analysis=0;
const box={console,Float32Array,Math,performance,setTimeout(){},setInterval(){},clearTimeout(){},clearInterval(){},analyzeTempo(){analysis++;throw Error('manual blending must not analyze tempo')}};
vm.createContext(box);vm.runInContext(code+'\nglobalThis.createTransitions=createTransitions;',box);
(async()=>{
 const t=box.createTransitions(deck);
 const result=await t.mixInto(buffer(),{hands:true,fromBpm:60,toBpm:190,mixOutAt:0});
 assert(result.hands,'widely different BPMs still return hand controls');
 assert.equal(analysis,0,'no tempo analysis for hand mix');
 assert.equal(deck.source.playbackRate.value,1,'incoming song has no tempo nudge');
 assert(Math.abs(result.hands.startsIn-.1)<.001,'starts immediately without a downbeat wait');
 const filters=nodes.filter(n=>n.frequency);
 assert(filters.every(n=>n.frequency.value===10),'both songs retain full bass');
 result.hands.setIncoming(.6);result.hands.setOutgoing(.4);result.hands.swapBass();
 assert(filters.every(n=>n.frequency.value===10),'crossfade never changes bass automatically');
 console.log('PASS: any-tempo hand blend starts immediately, retains speed and full sound');
})().catch(e=>{console.error(e);process.exitCode=1});
