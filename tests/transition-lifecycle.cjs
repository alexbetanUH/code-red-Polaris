// Exercise real transition scheduling with independently controlled wall/audio clocks.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const code = fs.readFileSync(__dirname + '/../transitions.js', 'utf8').replace(/^import .*$/mg, '').replace(/^export /mg, '');
let wall = 0, nextTimer = 0;
const timers = new Map(), nodes = [];
const schedule = (fn, ms, repeat) => { const id = ++nextTimer; timers.set(id, {fn, ms, repeat, at: wall + ms}); return id; };
function advance(ms) {
  const until = wall + ms;
  for (;;) {
    const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    const [id, t] = due; wall = t.at;
    if (t.repeat) t.at += t.ms; else timers.delete(id);
    t.fn();
  }
  wall = until;
}
const param = value => ({value, setTargetAtTime(v) {this.value = v;}, setValueAtTime(v) {this.value = v;}, cancelScheduledValues() {}, linearRampToValueAtTime(v) {this.value = v;}, exponentialRampToValueAtTime(v) {this.value = v;}});
const node = () => { const n = {disconnected: false, connect() {return this;}, disconnect() {this.disconnected = true;}, stop() {this.stopped = true;}}; nodes.push(n); return n; };
const ctx = {currentTime: 10, createGain: () => Object.assign(node(), {gain: param(1)}), createBiquadFilter: () => Object.assign(node(), {frequency: param(0)}), createBufferSource: () => Object.assign(node(), {playbackRate: param(1), start() {}})};
const buffer = () => ({duration: 30, sampleRate: 8, getChannelData: () => new Float32Array(240).fill(.5)});
const deck = {ctx, buffer: buffer(), source: node(), rate: 1.25, playing: true, filter: node(), position: () => 12, setSpeed(v) {this.rate = v;}};
const box = {console, Float32Array, Math, performance: {now: () => wall}, setTimeout: (f, ms) => schedule(f, ms, false), setInterval: (f, ms) => schedule(f, ms, true), clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id)};
vm.createContext(box); vm.runInContext(code + '\nglobalThis.createTransitions = createTransitions;', box);
(async () => {
  const transitions = box.createTransitions(deck);
  const {hands} = await transitions.mixInto(buffer(), {hands: true, mixOutAt: 0});
  assert.equal(deck.rate, 1.25, 'manual mixing preserves non-default speed');
  const incomingNodes = nodes.filter(n => n.gain || n.frequency).slice(-2);
  hands.finish(1);
  advance(5000); // audio context stays frozen throughout a long pause
  assert.equal(hands.done, false, 'wall-clock time must not finish a suspended audio transition');
  ctx.currentTime += 2;
  advance(250);
  assert.equal(hands.done, true, 'transition finishes after the audio clock reaches its endpoint');
  assert(incomingNodes.every(n => n.disconnected), 'temporary incoming nodes are disconnected');
  console.log('PASS: paused blends follow audio time, retain speed, and clean up incoming nodes');
})().catch(error => {console.error(error); process.exitCode = 1;});
