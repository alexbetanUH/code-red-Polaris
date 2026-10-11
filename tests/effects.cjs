// Run: node tests/effects.cjs. Verify DSP output and bounded gain/feedback controls.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const parameter = (value = 1) => ({ value, setTargetAtTime(v) { this.value = v; }, cancelScheduledValues() {}, setValueAtTime(v) { this.value = v; } });
const node = () => ({ links: [], gain: parameter(), frequency: parameter(), Q: parameter(), delayTime: parameter(),
 connect(target) { this.links.push(target); return target; }, disconnect(target) { this.links = this.links.filter(x => x !== target); }, start() {} });
class Context {
 constructor() { this.currentTime = 0; this.sampleRate = 8000; this.destination = node(); }
 createGain() { return node(); } createBiquadFilter() { return node(); } createAnalyser() { return Object.assign(node(), { frequencyBinCount: 512 }); }
 createDynamicsCompressor() { const n=node(); for(const k of ['threshold','knee','ratio','attack','release']) n[k]=parameter(); return n; }
 createConvolver() { return node(); } createDelay() { return node(); } createOscillator() { return node(); } createWaveShaper() { return node(); }
 createBuffer(channels, length) { const data=Array.from({length:channels},()=>new Float32Array(length)); return { getChannelData: ch=>data[ch] }; }
}
const root=path.join(__dirname,'..');
const box={AudioContext:Context, Math, Float32Array, Uint8Array, console, clearTimeout(){},setTimeout(){}, URL};
vm.createContext(box);
const audio=fs.readFileSync(path.join(root,'audio.js'),'utf8').replace('export class Deck','class Deck').replaceAll('import.meta.url',JSON.stringify('file://'+path.join(root,'audio.js')));
vm.runInContext(audio+'\nglobalThis.Deck=Deck;',box);
const deck=new box.Deck(); deck.ensureContext();
assert.equal(deck.fxDry.gain.value,1,'all effects off preserves clean audio');
assert.equal(deck.fxHeadroom.gain.value,1,'no attenuation when all effects are off');
deck.setEffect('echo',true);deck.setEffectAmount('echo',0.1);const quietFeedback=deck.echoFeedback.gain.value;
deck.setEffectAmount('echo',1);assert(deck.echoFeedback.gain.value>quietFeedback);assert(deck.echoFeedback.gain.value<0.8,'echo feedback stays below runaway');
deck.setEffect('flanger',true);deck.setEffectAmount('flanger',1);
assert(deck.flangerFeedback.gain.value<0.8);assert(0.009-deck.flangerDepth.gain.value>0,'flanger never asks for a negative delay');
deck.setEffect('bitcrush',true);deck.setEffectAmount('bitcrush',0);const fine=deck.crusher.curve;
deck.setEffectAmount('bitcrush',1);const coarse=deck.crusher.curve;
const error=c=>c.reduce((sum,v,i)=>sum+Math.abs(v-(i/(c.length-1)*2-1)),0)/c.length;
assert(error(coarse)>error(fine)*20,'high bitcrush materially reduces waveform resolution');
assert.equal(deck.fxDry.gain.value,0,'full bitcrush replaces clean signal');
deck.setEffect('reverb',true);deck.setEffectAmount('reverb',1);
assert(deck.fxHeadroom.gain.value<0.5,'stacking effects reserves output headroom');
deck.clearEffects();assert.equal(deck.fxDry.gain.value,1);assert.equal(deck.fxHeadroom.gain.value,1);
console.log('PASS: effect intensity, dry mix, bounded feedback, flanger delay and stack headroom');

let Processor;
const worklet={AudioWorkletProcessor:class{},registerProcessor(name,type){Processor=type;}, Math};
vm.createContext(worklet);vm.runInContext(fs.readFileSync(path.join(root,'bitcrush-worklet.js'),'utf8'),worklet);
const input=Float32Array.from({length:128},(_,i)=>Math.sin(i*0.2));
const dryOut=[new Float32Array(128),new Float32Array(128)];
new Processor().process([[input]],[dryOut],{amount:[0]});assert.deepEqual(dryOut[0],input);assert.deepEqual(dryOut[1],input,'mono source works in both channels');
const wetOut=[new Float32Array(128),new Float32Array(128)];
const processor=new Processor();processor.process([[input]],[wetOut],{amount:[1]});
const changes=wetOut[0].slice(1).reduce((n,x,i)=>n+(x!==wetOut[0][i]),0);assert(changes<=4,'strong bitcrush holds samples at a much lower rate');
assert.deepEqual(wetOut[0],wetOut[1]);processor.process([[]],[wetOut],{amount:[1]});assert(wetOut[0].every(x=>x===0),'no stale samples when input disappears');
console.log('PASS: actual sample-hold output, stereo/mono behavior and silence reset');
