const fs = require('fs'), vm = require('vm'), assert = require('assert');
const code = fs.readFileSync(__dirname + '/../landing.js', 'utf8');
const method = code.slice(code.indexOf('  async toggleHand()'), code.indexOf('\n  onHand('));
let release, stopped = 0;
const elements = new Map();
const box = {console, navigator: {mediaDevices: {getUserMedia: () => new Promise(resolve => release = resolve)}}, document: {getElementById: id => {if (!elements.has(id)) elements.set(id, {setAttribute() {}, play: async () => {}}); return elements.get(id);}}, performance, requestAnimationFrame() {}};
vm.createContext(box); vm.runInContext(`globalThis.page = {landmarker: {}, ${method}};`, box);
(async () => {
  const pending = box.page.toggleHand();
  await box.page.toggleHand(); // turn off while permission request is open
  release({getTracks: () => [{stop() {stopped++;}}]});
  await pending;
  assert.equal(stopped, 1, 'late camera stream must stop after user turns hand control off');
  assert.equal(elements.get('handCam').srcObject, null);
  assert.equal(box.page.handOn, false);
  console.log('PASS: late camera permission cannot reopen disabled hand control');
})().catch(error => {console.error(error); process.exitCode = 1;});
