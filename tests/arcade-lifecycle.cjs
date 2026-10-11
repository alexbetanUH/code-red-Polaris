const fs = require('fs'), vm = require('vm'), assert = require('assert');
const html = fs.readFileSync(__dirname + '/../arcade-versus.html', 'utf8');
const take = (from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
const elements = new Map();
const box = {console, Math: Object.assign(Object.create(Math), {random: () => 0}), $: id => {if (!elements.has(id)) elements.set(id, {style: {}, setAttribute() {}, querySelector: () => ({})}); return elements.get(id);}, schedule() {}, track() {}, drawCams() {}, updateSides() {}, drawFX() {}, rain() {box.particles++;}, particles: 0, music: {start() {}, stop() {}}, pauseLabel() {}, buildSides() {}, showOverlay() {}, beep() {}, burst() {}, PCOL: {}, rand: (a, b) => (a + b) / 2};
vm.createContext(box);
vm.runInContext(`let last = 0, clock = 0, paused = true, FX = [];
const state = {phase: 'matchover', winner: 1, game: {init() {}, draw() {}}};
${take('function resetMatch()', 'function startRound()')}
${take('function loop(now)', '$("prev").onclick')}`, box);
for (let i = 1; i <= 600; i++) vm.runInContext(`loop(${i * 16})`, box);
assert.equal(box.particles, 0, 'paused winner screen must not spawn immortal particles');
vm.runInContext('resetMatch()', box);
assert.equal(vm.runInContext('paused', box), false, 'restarting a paused match clears pause');
vm.runInContext(`let W = 1600, H = 1000; const input = {1: {height: .5}, 2: {height: .5}};
const openBoard = () => {};
${take('const pong = {', 'const pop = {')}
state.score = {1: 0, 2: 0}; pong.init(); pong.wait = 0;
pong.ball = {x: .08, y: .5, vx: -2, vy: 0}; pong.update(.05);`, box);
assert(vm.runInContext('pong.ball.vx > 0', box), 'fast ball crossing a paddle must bounce');
console.log('PASS: Arcade pause bounds particles, restart clears pause, fast paddle collisions register');
vm.runInContext(take('function buildSides()', 'function widgetHTML(p)'), box);
vm.runInContext("setHTML('widget1', 'controls'); buildSides(); $('widget1').innerHTML = ''; setHTML('widget1', 'controls');", box);
assert.equal(elements.get('widget1').innerHTML, 'controls', 'rebuilt side panels must render cached content again');
console.log('PASS: Arcade restart repopulates side-panel instructions');
