const fs = require('fs'), vm = require('vm'), assert = require('assert');
for (const file of ['audio.js', 'aiDeck.js']) {
  const code = fs.readFileSync(__dirname + '/../' + file, 'utf8').replace(/^export /mg, '').replace(/import.meta.url/g, '"http://localhost/audio.js"');
  const box = {console}; vm.createContext(box); vm.runInContext(code + '\nglobalThis.Deck = Deck;', box);
  const deck = new box.Deck();
  Object.assign(deck, {ctx: {currentTime: 10}, buffer: {duration: 30}, offset: 0, anchorTime: 10.1, playing: true, source: {playbackRate: {setTargetAtTime() {}}, stop() {}, disconnect() {}}});
  assert.equal(deck.position(), 0, file + ': scheduled playback cannot have negative position');
  deck.setSpeed(1.25);
  assert.equal(deck.anchorTime, 10.1, file + ': speed changes preserve a future start');
  deck.pause();
  assert.equal(deck.offset, 0, file + ': an immediate pause must leave a resumable offset');
}
console.log('PASS: both decks preserve future source starts and nonnegative pause offsets');
