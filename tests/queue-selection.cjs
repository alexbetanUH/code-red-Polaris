// Run: node tests/queue-selection.cjs. Exercises real queue requests with a slow decode.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const code=fs.readFileSync(path.join(__dirname,'..','queue.js'),'utf8').replace(/^import .*$/mg,'').replace(/^export /mg,'');
async function run({fail=false,remove=false}={}) {
 let releaseB;const started=[];const slow=new Promise((resolve,reject)=>releaseB=()=>fail?reject(new Error('superseded decode failed')):resolve({duration:10,label:'B'}));
 const deck={playing:false,buffer:null,offset:0,setVolume(){},setFrequency(){},ensureContext(){},stopSource(){this.playing=false},play(){this.playing=true;started.push(this.buffer.label)},position(){return 0}};
 const box={console,Date,Math,performance,Promise,setInterval(){},clearInterval(){},setTimeout(){},clearTimeout(){},
 createTransitions:()=>({prepare(){},cancel(){}}),
 OfflineAudioContext:class{decodeAudioData(label){return label==='B'?slow:Promise.resolve({duration:10,label})}},
 fetch:async()=>({ok:true,json:async()=>({songs:[]})})};
 vm.createContext(box);vm.runInContext(code+'\nglobalThis.createQueue=createQueue;',box);
 const queue=box.createQueue(deck),add=label=>queue.addFile({name:label+'.wav',arrayBuffer:async()=>label});
 add('A');await queue.play(queue.getState().items[0].id);
 add('B');const bId=queue.getState().items[1].id;const bPlay=queue.play(bId);
 await new Promise(resolve=>setImmediate(resolve));
 let cPlay;if(remove)queue.remove(bId);else{add('C');cPlay=queue.play(queue.getState().items[2].id);}
 releaseB();await bPlay;if(cPlay)await cPlay;
 assert.deepEqual(started,remove?['A']:['A','C'],'a superseded/removed decode never starts B');
 assert.equal(queue.getState().status,null,'stale decoding errors do not replace the latest status');
 console.log('PASS: slow decode '+(remove?'removed track':fail?'superseded failure':'latest selection')+' preserves playback');
}
(async()=>{await run();await run({fail:true});await run({remove:true})})().catch(error=>{console.error(error);process.exitCode=1});
