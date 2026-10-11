const fs = require('fs'), vm = require('vm'), assert = require('assert');
let wall = 0, id = 0;
const timers = new Map();
const later = (fn, ms) => {timers.set(++id, {fn, at: wall + ms}); return id;};
function advance(ms) { const until = wall + ms; for (;;) {const due = [...timers].filter(([, t]) => t.at <= until).sort((a,b) => a[1].at - b[1].at)[0]; if (!due) break; timers.delete(due[0]); wall = due[1].at; due[1].fn();} wall = until; }
const nodes = new Map();
function element() { const children = new Map(); return {isConnected: true, classList: {toggle() {}}, append() {}, remove() {this.isConnected = false;}, querySelector(key) {if (!children.has(key)) children.set(key, element()); return children.get(key);}, querySelectorAll: () => [], addEventListener() {}}; }
const box = {console, performance: {now: () => wall}, setTimeout: later, clearTimeout: key => timers.delete(key), setInterval: () => 0, clearInterval() {}, requestAnimationFrame: fn => later(fn, 16), localStorage: {getItem: () => null}, document: {head: element(), createElement: element, getElementById: () => element()}, $: key => {if (!nodes.has(key)) nodes.set(key, element()); return nodes.get(key);}};
vm.createContext(box);
const source = fs.readFileSync(__dirname + '/../djStart.js', 'utf8').replace(/^export /mg, '');
vm.runInContext(source, box);
let resumed = 0, endResolve;
box.djGame = {paused: true, setEnabled() {}, reset() {}, resume() {resumed++;}};
box.queue = {endSet: () => new Promise(resolve => endResolve = resolve)};
vm.runInContext(`const stage = document.createElement('div');
const screens = createStartScreen(stage, {library: async () => [], prepare() {}, begin() {}, startCamera: async () => true, handSeen: () => false});`, box);
const page = fs.readFileSync(__dirname + '/../ai-dj.html', 'utf8');
vm.runInContext(page.slice(page.indexOf('let inSet = false;'), page.indexOf('$("pauseBtn").addEventListener')), box);
(async () => {
  await Promise.resolve();
  vm.runInContext('inSet = true; resumeSet();', box);
  advance(2090); // ten milliseconds before the old resume countdown reaches Go
  const stopping = vm.runInContext('restartSet()', box);
  advance(20);
  assert.equal(resumed, 0, 'restart must cancel countdown before awaiting the stop fade');
  endResolve(); await stopping;
  console.log('PASS: AirMix restart cancels old resume countdown synchronously');
})().catch(error => {console.error(error); process.exitCode = 1;});
