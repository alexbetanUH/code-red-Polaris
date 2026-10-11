const fs = require('fs'), vm = require('vm'), assert = require('assert');
const code = fs.readFileSync(__dirname + '/../queue.js', 'utf8').replace(/^import .*$/mg, '').replace(/^export /mg, '');
let starts = 0, resolveVoice;
const voice = new Promise(resolve => resolveVoice = resolve);
const deck = {playing: false, rate: 1, buffer: null, setVolume() {}, setFrequency() {}, ensureContext() {}, stopSource() {this.playing = false;}, position: () => 0, play() {this.playing = true; starts++;}};
const box = {console, Date, Math, performance, Promise, setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {}, createTransitions: () => ({prepare() {}, cancel() {}, entryPoint: () => 0}), OfflineAudioContext: class {decodeAudioData() {return Promise.resolve({duration: 30});}}, fetch: async (url, options = {}) => {
  if (url === 'library.json') return {ok: true, json: async () => ({songs: [{id: 'first', artist: 'Test', title: 'First'}, {id: 'second', artist: 'Test', title: 'Second'}]})};
  if (url === '/api/dj/voice') return voice;
  return {ok: true, arrayBuffer: async () => new ArrayBuffer(8)};
}};
vm.createContext(box); vm.runInContext(code + '\nglobalThis.createQueue = createQueue;', box);
const flush = () => new Promise(setImmediate);
(async () => {
  const queue = box.createQueue(deck);
  await queue.playSet(['first', 'second']); await queue.readyToStart(); queue.beginSet(); await flush();
  assert.equal(starts, 1);
  await queue.playSet(['second', 'first']); await queue.readyToStart(); queue.beginSet(); await flush();
  assert.equal(starts, 2, 'a pending old announcement must not block the restarted set');
  resolveVoice({ok: false, status: 503, json: async () => ({error: 'voice unavailable'})});
  await flush();
  assert(deck.playing);
  console.log('PASS: restarting a set invalidates pending announcement ownership');
})().catch(error => {console.error(error); process.exitCode = 1;});
