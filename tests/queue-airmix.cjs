// Run: node tests/queue-airmix.cjs. Real queue with simulated cache/download/decode I/O.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const code = fs.readFileSync(path.join(__dirname, '..', 'queue.js'), 'utf8')
  .replace(/^import .*$/mg, '').replace(/^export /mg, '');
function setup({empty = false, failDecode = false, libraryFailures = 0} = {}) {
  const downloads = [];
  const songs = empty ? [] : [
    {id:'first', title:'First', artist:'Artist', bpm:96},
    {id:'second', title:'Second', artist:'Artist', bpm:93},
  ];
  const deck = {playing:false, buffer:null, offset:0, setVolume(){}, setFrequency(){},
    ensureContext(){}, stopSource(){this.playing=false}, position(){return 0}};
  const box = {console, Date, Math, performance, Promise, setTimeout, clearTimeout,
    setInterval(){}, clearInterval(){},
    createTransitions:()=>({prepare(){}, cancel(){}}),
    OfflineAudioContext:class {async decodeAudioData(){if(failDecode)throw new Error('bad audio');return {duration:10};}},
    fetch:async(url, options={})=>{
      if(url==='library.json')return {ok:libraryFailures-- <= 0, json:async()=>({songs})};
      if(options.method==='HEAD')return {ok:false};
      if(url==='/api/youtube') {
        const id = new URL(JSON.parse(options.body).url).searchParams.get('v');
        downloads.push(id);
        return {ok:true,json:async()=>({file:`downloads/${id}.m4a`})};
      }
      return {ok:true,arrayBuffer:async()=>new ArrayBuffer(8)};
    }};
  vm.createContext(box); vm.runInContext(code+'\nglobalThis.createQueue=createQueue;', box);
  return {queue:box.createQueue(deck), downloads};
}
(async()=>{
  const {queue, downloads} = setup();
  await queue.playSet(['second', 'first']);
  assert.deepEqual(downloads, ['second', 'first']);
  assert.deepEqual(Array.from(queue.getState().items, item=>item.libraryId), ['second', 'first']);
  assert.equal(queue.getState().currentId, null, 'preparation waits for countdown');
  await queue.readyToStart();
  await assert.rejects(setup({empty:true}).queue.libraryReady(), /library could not load/);
  const retry = setup({libraryFailures:2}).queue;
  await assert.rejects(retry.libraryReady(), /library could not load/);
  await retry.libraryReady();
  assert.equal(retry.getState().library.length, 2, 'retry fetches the library again');
  const failed = setup({failDecode:true}).queue;
  await failed.playSet(['first', 'second']);
  await assert.rejects(failed.readyToStart(), /bad audio/);
  console.log('PASS: AirMix downloads uncached sets in order, waits to start, and surfaces library/decode failures');
})().catch(error=>{console.error(error);process.exitCode=1});
