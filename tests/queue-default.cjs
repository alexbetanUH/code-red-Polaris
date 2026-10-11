// Run: node tests/queue-default.cjs. Uses the real queue with simulated library/audio I/O.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const code=fs.readFileSync(path.join(__dirname,'..','queue.js'),'utf8').replace(/^import .*$/mg,'').replace(/^export /mg,'');
async function run(available) {
 let releaseLibrary,downloads=0,plays=0;
 const songs=Array.from({length:5},(_,i)=>({id:'song'+i,title:'Song '+i,artist:'Artist',bpm:100}));
 const gate=new Promise(resolve=>releaseLibrary=resolve);
 const deck={playing:false,buffer:null,offset:0,setVolume(){},setFrequency(){},ensureContext(){},stopSource(){this.playing=false},play(){this.playing=true;plays++},position(){return 0}};
 const box={console,Date,Math,performance,Promise,setInterval(){},clearInterval(){},setTimeout(){},clearTimeout(){},
 createTransitions:()=>({prepare(){},cancel(){}}),
 OfflineAudioContext:class{async decodeAudioData(){return {duration:10}}},
 fetch:async(url,options={})=>{
  if(url==='library.json'){await gate;return {ok:true,json:async()=>({songs})};}
  if(options.method==='HEAD')return {ok:available};
  if(url==='/api/youtube'){downloads++;const id=new URL(JSON.parse(options.body).url).searchParams.get('v');return {ok:true,json:async()=>({file:'downloads/'+id+'.m4a'})};}
  return {ok:true,arrayBuffer:async()=>new ArrayBuffer(8)};
 }};
 vm.createContext(box);vm.runInContext(code+'\nglobalThis.createQueue=createQueue;',box);
 const queue=box.createQueue(deck);
 const first=queue.startDefaultQueue(),repeat=queue.startDefaultQueue();
 assert.strictEqual(first,repeat,'repeated startup shares one request');
 assert.equal(queue.getState().items.length,0,'startup waits for the library availability check');
 releaseLibrary();await first;
 const state=queue.getState();assert.equal(state.items.length,5,'whole default library is queued');
 assert.equal(state.currentId,state.items[0].id,'first default song is selected, not skipped');
 assert(deck.playing,'default queue autoplays');assert.equal(plays,1,'only one startup play');
 await new Promise(resolve=>setImmediate(resolve));
 if(available)assert.equal(downloads,0,'prefetched music needs no YouTube download');
 else {assert(downloads>0,'missing music downloads through the existing server');assert(downloads<5,'startup does not download the whole library');}
 console.log('PASS: default startup, duplicate gestures, first-song autoplay, '+(available?'local music':'lazy download fallback'));
}
(async()=>{await run(true);await run(false)})().catch(error=>{console.error(error);process.exitCode=1});
