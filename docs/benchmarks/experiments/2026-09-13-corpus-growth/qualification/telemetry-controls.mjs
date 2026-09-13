// Adaptation-only replay of admitted telemetry fixtures. Original source linkage is recorded separately.
// Reads the canonical corpus and uses temporary modules; makes no model, network or user-data calls.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const root=fileURLToPath(new URL('../../../../../',import.meta.url));
const require=createRequire(path.join(root,'package.json'));
const rows=new Map(fs.readFileSync(path.join(root,'gate-engine/review/eval/reviewers/cases-correctness.jsonl'),'utf8').trim().split('\n').map(line=>{const row=JSON.parse(line);return[row.id,row];}));
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'corpus-telemetry-controls-'));
const summaries=[];
function versions(id){const bug=rows.get(id),repair=rows.get(id+'-repaired');assert(bug&&repair);assert.deepEqual(bug.repo.base,repair.repo.base);return{base:bug.repo.base,bug:{...bug.repo.base,...bug.repo.staged},repair:{...repair.repo.base,...repair.repo.staged}};}
function moduleCode(id,file){return Object.fromEntries(Object.entries(versions(id)).map(([stage,files])=>[stage,files[file]]));}
function materialize(id,file){const dir=path.join(temporary,id);for(const[stage,files]of Object.entries(versions(id))){const d=path.join(dir,stage);fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'package.json'),'\x7b"type":"module"\x7d');for(const[name,body]of Object.entries(files)){const p=path.join(d,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,body);}if(file)fs.writeFileSync(path.join(dir,stage+'.mjs'),files[file]);}return dir;}
function finish(id,observations){summaries.push({id,observations:observations.length,expectedBugFailures:observations.filter(o=>o.pass===false).length});}
try {
{
const id='corr-abandoned-browser-launch-link',dir=materialize(id,'src/authorization.js');
const observations=[];const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const settle=()=>new Promise(r=>setImmediate(r));
const projection=map=>Object.fromEntries([...map].map(([k,v])=>[k,typeof v==='string'?{url:v,browserLaunchFailed:false}:v]));
for(const stage of ['base','bug','repair']){
 const {createAuthorizer}=await import(path.join(dir,`${stage}.mjs`));
 // Real AbortController and separately held browser-launch promises create the production await interleaving.
 let next=0;const launches=new Map(),polls=[],errors=[],reports=[];
 const client=createAuthorizer({createSession:async()=>({success:true,connectLink:`https://example.test/session/${++next}`}),openExternal:url=>{const d=deferred();launches.set(url,d);return d.promise;},pollConnection:async input=>{polls.push(input);return{found:false};},onError:(...a)=>errors.push(a),reportException:e=>reports.push(e.message)});
 const first=client.start('calendar');await settle();client.cancel('calendar');const second=client.start('calendar');await settle();
 launches.get('https://example.test/session/1').resolve({success:false,error:'launch failed'});await first;
 const state=projection(client.getLinks());const pass=state.calendar.url==='https://example.test/session/2';assert.equal(pass,stage!=='bug');
 observations.push({stage,name:'cancel then retry while first launch pending',state,pass,polls:polls.length});
 client.cancel('calendar');launches.get('https://example.test/session/2').resolve({success:true});await second;assert.equal(errors.length,0);
 // Settled positive controls: success, recoverable launch failure, session rejection and cancellation before session creation resolves.
 for(const scenario of ['success','launch failure','session failure','early cancellation']){
  const events=[];let capturedLinks;const sessionGate=deferred();
  const c=createAuthorizer({createSession:async()=>{if(scenario==='early cancellation')await sessionGate.promise;return{success:scenario!=='session failure',connectLink:'https://example.test/sign-in',error:'unavailable'};},openExternal:async()=>({success:scenario!=='launch failure',error:'blocked'}),pollConnection:async()=>{capturedLinks=projection(c.getLinks());return{found:true,connectionId:'connection-1'};},onError:(...args)=>events.push(['error',...args]),reportException:()=>events.push(['diagnostic'])});
  const running=c.start('calendar');if(scenario==='early cancellation'){c.cancel('calendar');sessionGate.resolve();}const result=await running;const links=capturedLinks??projection(c.getLinks());assert.deepEqual(projection(c.getLinks()),{});
  if(scenario==='success'||scenario==='launch failure')assert.deepEqual(result,{providerId:'calendar',connectionId:'connection-1'});else assert.equal(result,null);
  if(scenario==='launch failure')assert.equal(links.calendar.browserLaunchFailed,stage!=='base');
  if(scenario==='early cancellation')assert.deepEqual(links,{});
  observations.push({stage,name:scenario,result,links,events,pass:true});
 }
}
finish(id,observations);
}
{
const id='corr-failed-audio-cooldown',slices=moduleCode(id,'src/notification-sound.js');
const savedAudio=globalThis.AudioContext,savedNow=Date.now;const observations=[];
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j});return{promise,resolve,reject};};
let serial=0;
async function observe(code,fnName,scenario){
 let now=100000,starts=0,constructs=0,resumes=0;const oldResume=deferred();
 Date.now=()=>now;
 globalThis.AudioContext=class{
  constructor(){constructs++;if(scenario==='constructor failure'&&constructs===1)throw Error('unavailable');this.state=scenario.includes('resume')?'suspended':'running';this.currentTime=0;this.destination={};}
  async resume(){resumes++;if(scenario==='resume failure'&&resumes===1)throw Error('blocked');if(scenario==='late resume failure'&&resumes===1)return oldResume.promise;this.state='running';}
  createOscillator(){return{type:'',frequency:{setValueAtTime(){}},connect(){},start(){starts++;},stop(){}};}
  createGain(){return{gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){}};}
 };
 const module=await import('data:text/javascript;base64,'+Buffer.from(code+`\n// sample ${++serial}`).toString('base64'));const play=module[fnName];
 if(scenario==='late resume failure'){
  const first=play();await Promise.resolve();now+=2100;await play();oldResume.reject(Error('old attempt failed'));await first;now++;await play();
 }else{await play();if(scenario==='cooldown boundary')now+=2000;else now++;await play();}
 return{starts,constructs,resumes};
}
try{
 for(const stage of ['base','bug','repair'])for(const scenario of ['constructor failure','resume failure','successful burst','cooldown boundary','late resume failure']){
  const adapted=await observe(slices[stage],'playNotification',scenario);
  const target=scenario.endsWith('failure')&&!scenario.startsWith('late');const wanted=target?2:scenario==='successful burst'||scenario==='late resume failure'?(stage==='base'?4:2):4;
  const pass=adapted.starts===wanted;assert.equal(pass,!(stage==='bug'&&target),stage+':'+scenario);
  observations.push({stage,scenario,adapted,expectedStarts:wanted,pass});
 }
}finally{Date.now=savedNow;globalThis.AudioContext=savedAudio;}
finish(id,observations);
}
{
const id='corr-command-block-argument-boundary',dir=materialize(id);
const observations=[];
const block=(name,body)=>`[/cmd:${name}]\n${body}\n[/cmd-end]\n`;
const first=block('custom','Do $ARGUMENTS');
const cases=[
 {name:'two blocks',text:first+block('other','Inspect file'),expected:first+block('other','Inspect file'),target:true},
 {name:'args before second block',text:first+'some args\n'+block('other','Inspect file'),expected:first+'some args\n'+block('other','Inspect file'),target:true},
 {name:'three blocks',text:first+block('other','$ARGUMENTS')+block('third','More'),expected:first+block('other','$ARGUMENTS')+block('third','More'),target:true},
 {name:'single block',text:first+'  this task  ',expected:block('custom','Do this task')+'  this task  ',feature:true},
 {name:'literal replacement tokens',text:first+'$& $$ $`',expected:block('custom','Do $& $$ $`')+'$& $$ $`',feature:true},
 {name:'empty args',text:first,expected:block('custom','Do '),feature:true},
 {name:'no placeholder',text:block('custom','Read files')+'tail',expected:block('custom','Read files')+'tail'},
 {name:'prefix text',text:'prefix\n'+first+'args',expected:'prefix\n'+first+'args'},
 {name:'ordinary message',text:'hello there',expected:'hello there'},
 {name:'custom slash',text:'/custom data',expected:'Do data'},
 {name:'builtin',text:'/compact data',expected:'/compact data'},
 {name:'unknown command',text:'/unknown data',expected:'/unknown data'},
 {name:'lookup rejected',text:'/custom data',expected:'/custom data',reject:true},
 {name:'slash literal tokens',text:'/custom $& $$',expected:'Do $& $$',feature:true},
];
for(const stage of ['base','bug','repair']) {
 const module=await import(path.join(dir,stage,'src/expand-command.js'));
 for(const test of cases){
  let fetches=0;
  const output=await module.expandSlashCommand(test.text,undefined,{listCommands:async()=>{fetches++;if(test.reject)throw Error('offline');return[{name:'custom',path:'commands/custom.md'}];},getContent:async()=>'Do $ARGUMENTS'});
  const expected=(stage==='base'&&test.feature)?null:test.expected;
  const pass=output===expected;
  if(expected!==null)assert.equal(pass,!(stage==='bug'&&test.target),`${stage}: ${test.name}`);
  if(!test.text.startsWith('/custom')&&!test.text.startsWith('/unknown'))assert.equal(fetches,0);
  observations.push({stage,name:test.name,output,expected,pass:expected===null?'pre-feature':pass,fetches});
 }
}
finish(id,observations);
}
{
const id='corr-empty-home-override',adapted=moduleCode(id,'src/profile-directory.js');
const observations=[];
const keys=['APP_HOME','APP_NODES_DIR'];
const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
const scenarios=[
 {name:'empty override',home:'',nodeDir:undefined,target:true},
 {name:'blank override',home:'   ',nodeDir:undefined,target:true},
 {name:'unset override',home:undefined,nodeDir:undefined},
 {name:'explicit home',home:'/tmp/example-profile',nodeDir:undefined,feature:true},
 {name:'explicit node directory',home:'/tmp/example-profile',nodeDir:'/tmp/example-nodes'},
 {name:'node directory with empty home',home:'',nodeDir:'/tmp/example-nodes'},
 {name:'relative node directory',home:'',nodeDir:'local-nodes'},
];
try{
 for(const stage of ['base','bug','repair'])for(const test of scenarios){
  for(const k of keys){const value=k.endsWith('HOME')?test.home:test.nodeDir;if(value===undefined)delete process.env[k];else process.env[k]=value;}
  const output=(await import('data:text/javascript;base64,'+Buffer.from(adapted[stage]+`\n// ${test.name}`).toString('base64'))).APP_NODES_DIR;
  const expected=path.resolve(test.nodeDir??path.join((stage!=='base'&&test.feature)?test.home:os.homedir(),'.app','nodes'));
  const applies=!(stage==='base'&&test.feature);
  const pass=output===expected;
  if(applies)assert.equal(pass,!(stage==='bug'&&test.target),stage+':'+test.name);
  observations.push({stage,name:test.name,output,expected:applies?expected:null,pass:applies?pass:'pre-feature'});
 }
}finally{for(const k of keys){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}}finish(id,observations);
}
{
 const id='corr-query-punctuation-routing',dir=materialize(id,'src/query-classifier.js'),observations=[];
 for(const stage of ['base','bug','repair']){
  const {classify}=await import(path.join(dir,stage+'.mjs'));
  for(const [input,expected] of [['fix auth bug?','conceptual_medium'],['fix auth bug','conceptual_medium'],['why does function hang','conceptual_high'],['src/cache.ts','literal'],['getCache','literal'],['^foo.*$','literal'],[null,'literal'],["Cannot read 'name'",'literal'],['export async function getFooBar','literal']]){
   const actual=classify(input).category,preFeature=stage==='base'&&input==='export async function getFooBar';
   const pass=actual===expected;
   if(!preFeature)assert.equal(pass,!(stage==='bug'&&input==='fix auth bug?'));
   observations.push({stage,input,actual,expected,pass:preFeature?'pre-feature':pass});
  }
 }
 finish(id,observations);
}
{
 const id='corr-delete-reserved-prefix-recovery',dir=materialize(id,'src/node-delete-policy.js'),observations=[];
 for(const stage of ['base','bug','repair']){
  const {canDelete}=await import(path.join(dir,stage+'.mjs'));
  for(const [name,allowed]of [['calendar_custom',true],['issues_old',true],['local-node',true],['calendar',true],['local_node',true],['calendarcustom',true],['',false],['../local',false],['folder/node',false],['local.node',false],['Local',false],[7,false],[null,false],['_local',false],['integrations',stage==='base']]){
   const actual=canDelete(name,['calendar','issues']),pass=actual===allowed;
   assert.equal(pass,!(stage==='bug'&&['calendar_custom','issues_old'].includes(name)));
   observations.push({stage,name,actual,expected:allowed,pass});
  }
 }
 finish(id,observations);
}
{
 const id='corr-reply-draft-expiration',dir=materialize(id,'src/draft-store.js'),observations=[];
 const savedNow=Date.now,now=1800000000000,day=86400000;Date.now=()=>now;
 try{
  for(const stage of ['base','bug','repair']){
   const {createDraftStore}=await import(path.join(dir,stage+'.mjs'));
   for(const [name,key,age,text,reply]of [['old reply','thread:reply',30*day,'reply',true],['fresh reply','thread:reply',day,'reply',true],['boundary reply','thread:reply',7*day,'reply',true],['epoch reply','thread:reply',now,'reply',true],['empty reply','thread:reply',day,'',true],['old scratch','scratch',8*day,'note',false],['boundary scratch','scratch',7*day,'note',false],['fresh scratch','scratch',day,'note',false]]){
    if(stage==='base'&&!reply)continue;
    let data=JSON.stringify({[key]:{text,updatedAt:now-age},unrelated:{text:'retained',updatedAt:0}});
    const storage={getItem:()=>data,setItem:(key,value)=>{data=value;}},store=createDraftStore(storage);
    const actual=reply?store.readReply('thread','reply'):store.readScratch(key),expected=!reply&&age>7*day?null:text||null,pass=actual===expected;
    assert.equal(pass,!(stage==='bug'&&['old reply','epoch reply'].includes(name)));
    assert.equal(JSON.parse(data).unrelated.text,'retained');
    observations.push({stage,name,actual,expected,pass});
   }
   const store=createDraftStore({getItem:()=>'{broken',setItem(){throw Error('read only');}});
   assert.equal(store.readReply('thread','reply'),null);
   observations.push({stage,name:'malformed storage',pass:true});
  }
 }finally{Date.now=savedNow;}
 finish(id,observations);
}
{
 const id='corr-unparsed-import-graph',dir=materialize(id,'src/check-generated-modules.js'),observations=[];
 const {init,parse}=require('es-module-lexer');await init;
 const cases=[
  ['valid',[['dist/entry.mjs','export const ok=true;']],['dist/entry.mjs'],0,false],
  ['malformed string',[['dist/entry.mjs',"'unterminated"]],['dist/entry.mjs'],1,true],
  ['missing import',[['dist/entry.mjs',"import './missing.mjs';"]],['dist/entry.mjs'],1,false],
  ['cycle',[['dist/entry.mjs',"import './next.mjs';"],['dist/next.mjs',"import './entry.mjs';"]],['dist/entry.mjs'],0,false],
  ['unselected malformed',[['dist/entry.mjs','export const ok=true;'],['dist/unselected.mjs',"'unterminated"]],['dist/entry.mjs'],0,false],
  ['nonmodule ignored',[['dist/message.txt',"'unterminated"]],['dist/message.txt'],0,false],
  ['imported text asset',[['dist/entry.mjs',"import './message.txt';"],['dist/message.txt',"'unterminated"]],['dist/entry.mjs'],0,false],
  ['dynamic relative',[['dist/entry.mjs',"import('./missing.mjs');"]],['dist/entry.mjs'],1,false],
 ];
 for(const stage of ['base','bug','repair']){
  const {checkGeneratedModules}=await import(path.join(dir,stage+'.mjs'));
  for(const[name,files,entries,expected,target]of cases){const actual=checkGeneratedModules(new Map(files),entries,parse).code,pass=actual===expected;assert.equal(pass,!(stage==='bug'&&target));observations.push({stage,name,actual,expected,pass});}
 }
 finish(id,observations);
}
{
 const id='corr-deleted-branch-attribution',dir=materialize(id,'src/validate-branch-push.js'),observations=[];
 for(const stage of ['base','bug','repair']){
  const {validateBranchPush}=await import(path.join(dir,stage+'.mjs'));
  for(const width of [40,64])for(const [name,deletion,status,enabled]of [['deleted branch',true,7,true],['ordinary update',false,7,true],['green tests',true,0,true],['disabled',false,7,false]]){
   const zero='0'.repeat(width),head='a'.repeat(width),remote='b'.repeat(width);let narrated=0,checks=0;
   const result=await validateBranchPush([{localOid:deletion?zero:head,remoteOid:remote}],head,async()=>{checks++;return status;},{hasCommit:async()=>true,mergeBase:async()=>'common-base'},async()=>{narrated++;},enabled);
   assert.equal(result,status);assert.equal(checks,1);
   const expected=stage!=='base'&&!deletion&&status!==0&&enabled?1:0,pass=narrated===expected;
   assert.equal(pass,!(stage==='bug'&&deletion&&width===64&&status!==0&&enabled));
   observations.push({stage,width,name,actual:narrated,expected,pass});
  }
 }
 finish(id,observations);
}

} finally {fs.rmSync(temporary,{recursive:true,force:true});}
console.log(JSON.stringify({mode:'adaptation-only',families:summaries.length,observations:summaries.reduce((n,s)=>n+s.observations,0),summaries},null,2));
