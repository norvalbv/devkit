import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import assert from 'node:assert/strict';import {isIP} from 'node:net';import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const root=process.argv[2],here=path.join(root,'public-pair-critique'),dir=path.join(root,'qualified-repair-only'),require=createRequire(import.meta.url);
const rows=JSON.parse(fs.readFileSync(path.join(dir,'proposals.json'),'utf8')),observations=[];
const spans=JSON.parse(fs.readFileSync(new URL('./getter-spans.json',import.meta.url),'utf8'));
const getFunction=(source,name)=>{const positions=spans[createHash('sha256').update(source).digest('hex')]?.[name];assert(positions);return vm.runInNewContext('('+source.slice(positions.start,positions.end)+')',{isIP});};
const observe=fn=>{try{return{value:JSON.stringify(fn())};}catch(e){return{error:{name:e.name,message:e.message}};}};
for(const stage of ['base','repair']) {
 const id='corr-ip-address-subdomains-clean';const input=fs.readFileSync(path.join(dir,id+'-'+stage+'-source.js'),'utf8');
 const source=getFunction(input,'subdomains'),host=getFunction(input,'host'),adapted=(await import(path.join(dir,id+'-'+stage+'.mjs'))).extractSubdomains;
 for(const header of ['tobi.ferrets.example.com:8080','example.com','localhost','127.0.0.1:80','[::1]:443','[2001:db8::1]','127.0.0.1.',undefined])for(const offset of [0,1,2,3,-1])for(const trusted of [false,true]) {
  const request={connection:{remoteAddress:'127.0.0.1'},app:{get:key=>key==='subdomain offset'?offset:()=>trusted},get:key=>key==='X-Forwarded-Host'?'10.20.30.40:444':header};
  Object.defineProperty(request,'host',{get:()=>host.call(request)});
  const original=observe(()=>source.call(request)),actual=observe(()=>adapted.call(request));assert.deepEqual(actual,original);
  if(stage==='repair'&&header==='127.0.0.1:80'&&!trusted&&offset===2)assert.equal(actual.value,'[]');
  observations.push({id,stage,scenario:{header,offset,trusted,computedHost:request.host},original,actual,equal:true});
 }
}
for(const stage of ['base','repair']) {
 const id='corr-bracketed-host-port-clean',source=getFunction(fs.readFileSync(path.join(dir,id+'-'+stage+'-source.js'),'utf8'),'host'),adapted=(await import(path.join(dir,id+'-'+stage+'.mjs'))).requestHost;
 const headers=['example.com','example.com:443','[::1]','[::1]:443','[2001:db8:1::1]:80','[fe80::1%25eth0]:80','[v1.a:b]:8080','127.0.0.1:80','localhost:0','example.com:','',undefined];
 for(const header of headers)for(const trust of [false,true])for(const forwarded of [undefined,'[2001:db8::2]:8443']) {
  const request={app:{get:()=>trust},get:key=>key==='X-Forwarded-Host'?forwarded:header};
  const original=observe(()=>source.call(request)),actual=observe(()=>adapted.call(request));assert.deepEqual(actual,original);
  if(stage==='repair') {
   const selected=(trust&&forwarded)||header;
   if(selected?.startsWith('['))assert.equal(actual.value,JSON.stringify(selected.slice(0,selected.indexOf(']')+1)));
  }
  observations.push({id,stage,scenario:{header,trust,forwarded},original,actual,equal:true});
 }
}
const string=s=>[83,0,Buffer.byteLength(s),...Buffer.from(s)];
for(const stage of ['base','repair']) {
 const row=rows.find(r=>r.id==='corr-null-map-key-clean'),code=Object.values(stage==='base'?row.repo.base:row.repo.staged)[0];
 const {readMapProperties}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 const lib=require(path.join(dir,'hessian9-'+stage,'index.js'));
 for(const className of ['', 'java.util.HashMap'])for(const key of [null,false,true,7,'$map','constructor','toString','hasOwnProperty','__proto__','this$0','ordinary','']) {
  const encoded=key===null?[78]:key===false?[70]:key===true?[84]:typeof key==='number'?[73,0,0,0,key]:string(key);
  const bytes=Buffer.from([77,116,0,Buffer.byteLength(className),...Buffer.from(className),...encoded,...string('value'),122]);
  const original=observe(()=>lib.decode(bytes)),actual=observe(()=>readMapProperties([[key,'value']]));assert.deepEqual(actual,original);
  if(stage==='repair'&&key===null)assert.equal(actual.value,'{"null":"value"}');
  observations.push({id:row.id,stage,scenario:{className,key},original,actual,equal:true});
 }
}
fs.writeFileSync(path.join(here,'standalone-repair-observations.json'),JSON.stringify({runtime:process.version,observations},null,2)+'\n');
console.log(JSON.stringify({comparisons:observations.length,subdomainComparisons:160,hostComparisons:96,hessianComparisons:48,allEqual:true}));
