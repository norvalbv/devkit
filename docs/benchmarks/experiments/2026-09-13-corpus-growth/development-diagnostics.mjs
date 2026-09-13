import fs from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const P=path.dirname(fileURLToPath(import.meta.url)),W=path.resolve(P,'../../../..');
const freeze=JSON.parse(fs.readFileSync(`${P}/freeze/protocol.json`,'utf8'));
const rows=fs.readFileSync(`${W}/gate-engine/review/eval/reviewers/cases-correctness.jsonl`,'utf8').trim().split('\n').map(line=>JSON.parse(line));
let sequence=0;
const source=(row,side,file)=>side==='base'?row.repo.base[file]:row.repo.staged[file]??row.repo.base[file];
const module=async(text)=>import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}#diagnosis-${++sequence}`);
const results=[];
async function check(id,file,exercise,interpretation){
 const metadata=freeze.rows.find(r=>r.id===id);assert.equal(metadata.partition,'development');
 const row=rows.find(r=>r.id===id);const observations={};
 for(const side of ['base','staged']){
  const text=source(row,side,file);const loaded=await module(text);
  observations[side]={sourceSha256:createHash('sha256').update(text).digest('hex'),observed:await exercise(loaded)};
 }
 results.push({id,file,partition:'development',observations,interpretation});
}
await check('corr-async-view-unmounted-retry-repaired','src/async-view.mjs',async({defineAsyncView})=>{
 let calls=0,rejectInitial,definition;
 const loader=()=>{calls++;return new Promise((resolve,reject)=>{if(calls===1)rejectInitial=reject;});};
 definition=defineAsyncView(loader);
 const mounted={isUnmounted:false,onError:()=>definition.setup({isUnmounted:false,onError:()=>{}})};
 const unmounted={isUnmounted:true,onError:()=>{}};
 definition.setup(mounted);definition.setup(unmounted);rejectInitial(new Error('first load failed'));
 for(let i=0;i<12;i++)await Promise.resolve();
 const beforeLaterMount=calls;definition.setup({isUnmounted:false,onError:()=>{}});
 return {loaderCallsBeforeLaterMount:beforeLaterMount,loaderCallsAfterLaterMount:calls};
},'The alleged stale-rejection clearing occurs in both versions: the original also clears pendingRequest in onError. This control supports pre-existing causality for this specific claim, not complete safety.');
await check('corr-empty-middleware-path-repaired','src/register-middleware.js',async({registerMiddleware})=>{
 let calls=0;
 const app={lazyrouter(){},_router:{use(){calls++;}}};
 let error=null;try{registerMiddleware.call(app,[[],()=>{}]);}catch(e){error=e.message;}
 return {routerRegistrations:calls,error};
},'Both versions reject the leading-empty nested array. The staged method adds nested-array support, so original failure does not by itself refute a new-feature contract defect. Whether every recursively flattened shape is promised remains a label dispute.');
await check('corr-null-map-key-clean','src/read-map-properties.js',async({readMapProperties})=>{
 let nullKey;try{nullKey={result:readMapProperties([[null,1]])};}catch(e){nullKey={error:e.constructor.name};}
 const symbol=Symbol('id'),result=readMapProperties([[symbol,1]]);
 return {nullKey,stringKeys:Object.keys(result),symbolKeys:Object.getOwnPropertySymbols(result).map(String)};
},'Null keys are the verified source repair target, so a change from throw to property does not establish a regression. Symbol behavior differs, but the binary-decoder qualification does not supply symbol keys; the standalone adaptation leaves that source-domain constraint unavailable to the reviewer.');
await check('corr-failed-audio-cooldown-repaired','src/notification-sound.js',async({playNotification})=>{
 const oldNow=Date.now,oldContext=globalThis.AudioContext;let now=10000,notes=0;
 Date.now=()=>now;
 globalThis.AudioContext=class{state='running';currentTime=0;destination={};createOscillator(){return {frequency:{setValueAtTime(){}},connect(){},start(){notes++;},stop(){}};}createGain(){return {gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){}};}};
 try{await playNotification();now=5000;await playNotification();return {notesAfterWallClockRollback:notes};}
 finally{Date.now=oldNow;if(oldContext===undefined)delete globalThis.AudioContext;else globalThis.AudioContext=oldContext;}
},'The staged cooldown suppresses playback after a backward wall-clock jump while the base plays. This is a plausible adjacent new-feature defect against a real elapsed-time cooldown, beyond the qualification controls; preserve the clean-label dispute.');
const value={schemaVersion:1,performedAfterBaselineStarted:true,reservedOutcomesUsed:false,labelsChanged:false,qualificationObservationCountsUnchanged:true,scope:'Four targeted development-claim controls after the frozen baseline exposed findings. These are agent-selected diagnostic observations, not independent adjudication or additional admissions.',results};
console.log(JSON.stringify(value,null,2));
