const fs = require('fs'), vm = require('vm'), assert = require('assert');
// Expose the real finale callback only inside the VM so its asynchronous lifecycle is testable.
const source = fs.readFileSync(__dirname + '/../djGame.js', 'utf8').replace(/\r\n/g, '\n').replace(/^import .*$/mg, '').replace(/^export /mg, '').replace('  return {\n    update,', '  return {\n    finishSet,\n    update,');
const element = () => ({append() {}, appendChild(node) {return node;}, setAttribute() {}, getContext: () => ({}), classList: {toggle() {}}});
const box = {console, performance, requestAnimationFrame() {}, document: {createElement: element, getElementById: () => ({})}};
vm.createContext(box); vm.runInContext(source + '\nglobalThis.createDjGame = createDjGame;', box);
(async () => {
  let resolveEnd, results = 0;
  const queue = {holdControls() {}, endSet: () => new Promise(resolve => resolveEnd = resolve)};
  const game = box.createDjGame(queue, {stage: element(), camera: {}, rail: element(), deck: {}, onSetEnd: () => results++});
  game.finishSet();
  game.reset();
  resolveEnd(true); await Promise.resolve();
  assert.equal(results, 0, 'a reset game must not receive results from an older finale');
  game.finishSet(); resolveEnd(true); await Promise.resolve();
  assert.equal(results, 1, 'the current game still receives its results');
  console.log('PASS: stale finales cannot replace a restarted game with old results');
})().catch(error => {console.error(error); process.exitCode = 1;});
