import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import domain from 'node:domain';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const root=process.argv[2],dir=path.join(root,'cache-pair-critique'),sourceRoot=path.join(root,'public-datasets/shields-cache'),qualified=path.join(root,'qualified-cache-resource');
const require=createRequire(path.join(sourceRoot,'runtime/package.json')),queryString=require('query-string');
const realDate=Date,realTimeout=setTimeout,realClear=clearTimeout;const clone=x=>JSON.parse(JSON.stringify(x));const tick=()=>new Promise(resolve=>setImmediate(resolve));
function createSource(stage,ports,clock) {
 const folder=stage==='upstream-repair'||stage==='repair'?'repair':stage;
 const cacheModule={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(sourceRoot,folder,'lib/lru-cache.js'),'utf8'),{module:cacheModule,Map,process,console,setInterval});
 const module={exports:{}};const dependencies={'domain':domain,'request':ports.request,'./badge':ports.badge,'./badge-data':{makeBadgeData:ports.getBadgeData},'./log':ports.log,'./lru-cache':cacheModule.exports,'./analytics':ports.analytics,'./result-sender':{makeSend:ports.makeSend},'query-string':queryString};
 const text=stage==='repair'?fs.readFileSync(path.join(qualified,'agent-derived-source-repair.js'),'utf8'):fs.readFileSync(path.join(sourceRoot,folder,'lib/request-handler.js'),'utf8');
 vm.runInNewContext(text,{module,require:name=>{assert(Object.hasOwn(dependencies,name),name);return dependencies[name];},Date:clock.Date,setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout,Set,Map,Object});return module.exports;
}
async function observe(stage,mode,scenario) {
 let now=100000,timerId=0,handlerCalls=0;const timers=new Map(),events=[],network=[],sent=[],headers=[],received=[],pending=[];
 class ClockDate extends realDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
 const clock={Date:ClockDate,setTimeout(fn,delay){const id=++timerId;timers.set(id,{fn,at:now+delay});return id;},clearTimeout(id){timers.delete(id);}};
 const advance=ms=>{now+=ms;for(const [id,t]of [...timers])if(t.at<=now){timers.delete(id);t.fn();}};
 const ports={
  queryString,analytics:{noteRequest(query,match){events.push(['analytics',match[0]]);}},
  log:{error(label,stack){events.push(['error',label,String(stack).split('\n')[0]]);}},
  getBadgeData(label,query){events.push(['fallback',label,Object.hasOwn(query,'__proto__')?query.__proto__:null]);return{text:[label,'fallback'],custom:query.token};},
  badge(data,send){send(data);},makeSend(format,res,end){return data=>end({format,data});},
  request(options,callback){network.push(clone(options));if(scenario==='network error')return callback(Error('network unavailable'),null,null);callback(null,{headers:{'cache-control':scenario==='vendor max age'?'public, max-age=2':'no-cache'}},'body');},
 };
 const makeHandler=()=>(query,match,send,request)=>{
  handlerCalls++;received.push({resource:match[0],keys:Object.keys(query),query:clone(query),ownPrototype:Object.hasOwn(query,'__proto__')});
  if(scenario==='async vendor error'){setImmediate(()=>{throw Error('vendor callback failed');});return;}
  if(scenario==='timeout without cache'||scenario==='timeout with cache'&&handlerCalls>1||scenario==='late vendor completion'){pending.push(()=>send('svg',{text:['vendor','late']}));return;}
  const complete=()=>send(match[0].split('.').pop(),{text:['vendor',scenario==='refresh payload'?'version-'+handlerCalls:match[0]+':'+String(query.token)+':'+String(query.__proto__)]});
  if(['vendor max age','network error','network options string','network options object','network options explicit'].includes(scenario)){
   const callback=(err,res,body)=>{events.push(['network-callback',err?.message??null,body]);complete();};
   if(scenario==='network options object')request({uri:'https://example.invalid/resource',headers:{Accept:'text/plain'}},callback);
   else if(scenario==='network options explicit')request('https://example.invalid/resource',{headers:{'User-Agent':'explicit-client'}},callback);
   else request('https://example.invalid/resource',callback);
  }else complete();
 };
 const api=mode==='source'?createSource(stage,ports,clock):(await import(path.join(qualified,stage+'.mjs'))).createRequestHandlers(ports);
 const handler=makeHandler();const declared=['token','__proto__','constructor','hasOwnProperty'];const handle=api.handleRequest(stage==='base'?handler:{handler,queryParams:declared});
 const call=(resource='/badge.svg',query={})=>{const h={};handle(query,[resource],result=>sent.push(clone(result)),{res:{setHeader(k,v){h[k]=v;}}});headers.push(h);};
 try {
  globalThis.Date=ClockDate;globalThis.setTimeout=clock.setTimeout;globalThis.clearTimeout=clock.clearTimeout;
  if(scenario==='allowed query filtering'){const q=Object.assign(Object.create(null),{token:'selected',label:'label',unknown:'drop',__proto__:'proto',constructor:'ctor',hasOwnProperty:'hop'});Object.defineProperty(q,'__proto__',{value:'proto',enumerable:true});call('/badge.svg',q);}
  else if(scenario==='prototype value identity'){for(const value of ['first','second']){const q=Object.create(null);q.__proto__=value;call('/badge.svg',q);}}
  else if(scenario==='canonical escaped ordering'){call('/badge.svg',{label:'a&b?c',style:'flat',link:['one','two']});call('/badge.svg',{link:['one','two'],style:'flat',label:'a&b?c'});}
  else if(scenario==='different resources'){call('/first.svg');call('/second.svg');}
  else if(scenario==='different formats'){call('/badge.svg');call('/badge.json');}
  else if(scenario==='headers'){call('/badge.svg',{maxAge:'0012'});call('/badge.svg',{maxAge:'1x'});}
  else if(scenario==='cache clear'){call();api.clearRequestCache();call();}
  else if(scenario==='capacity eviction'){for(let i=0;i<=1000;i++)call('/badge-'+i+'.svg');call('/badge-0.svg');}
  else if(scenario==='timeout without cache'||scenario==='late vendor completion'){call('/badge.svg',{token:'original'});advance(25000);if(scenario==='late vendor completion')pending[0]();}
  else if(scenario==='timeout with cache'){call();advance(5000);call();advance(25000);pending[0]();}
  else if(scenario==='async vendor error'){call();await tick();await tick();advance(25000);}
  else if(scenario==='vendor max age'){call();advance(1999);call();advance(1);call();}
  else if(scenario==='refresh payload'){call();advance(5000);call();advance(1);call();}
  else call();
  // Compact the capacity observation without hiding its exact call/output behavior.
  return{handlerCalls,sent:scenario==='capacity eviction'?{count:sent.length,first:sent[0],last:sent.at(-1)}:sent,received:scenario==='capacity eviction'?{count:received.length,first:received[0],last:received.at(-1)}:received,network,events:scenario==='capacity eviction'?{count:events.length}:events,headers:scenario==='capacity eviction'?{count:headers.length}:headers,pendingTimerCount:timers.size};
 }finally{globalThis.Date=realDate;globalThis.setTimeout=realTimeout;globalThis.clearTimeout=realClear;}
}
const scenarios=['allowed query filtering','prototype value identity','canonical escaped ordering','different resources','different formats','headers','cache clear','capacity eviction','timeout without cache','late vendor completion','timeout with cache','async vendor error','vendor max age','refresh payload','network error','network options string','network options object','network options explicit'];
const observations=[];
for(const stage of ['base','bug','upstream-repair','repair'])for(const scenario of scenarios) {
 const original=await observe(stage,'source',scenario),adapted=await observe(stage,'adaptation',scenario);assert.deepEqual(adapted,original,stage+':'+scenario);
 if(['different resources','different formats'].includes(scenario))assert.equal(adapted.handlerCalls,stage==='bug'?1:2);
 if(scenario==='allowed query filtering'&&stage==='repair'){assert(!adapted.received[0].keys.includes('unknown'));assert.equal(adapted.received[0].query.__proto__,'proto');}
 if(scenario==='prototype value identity')assert.equal(adapted.handlerCalls,stage==='repair'?2:1);
 if(scenario==='capacity eviction')assert.equal(adapted.handlerCalls,stage==='bug'?1:1002);
 if(scenario==='vendor max age')assert.equal(adapted.handlerCalls,2);
 if(scenario==='late vendor completion')assert.equal(adapted.sent.length,1);
 observations.push({stage,scenario,original,adapted,equal:true});
}
fs.writeFileSync(path.join(dir,'cache-observations.json'),JSON.stringify({runtime:process.version,queryStringVersion:require('query-string/package.json').version,operation:'Full original/derived source and actual LRU versus full prepared ported module; explicit controlled clock/render/network/analytics ports',observations},null,2)+'\n');
console.log(JSON.stringify({comparisons:observations.length,allEqual:true,stageCount:4,scenarios:scenarios.length}));
