import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import vm from 'node:vm';import {isIP} from 'node:net';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';
const root=process.argv[2],dir=path.join(root,'qualified-repair-only'),require=createRequire(import.meta.url),observations=[];
const spans=JSON.parse(fs.readFileSync(new URL('./getter-spans.json',import.meta.url),'utf8'));
function getter(text,name){const p=spans[createHash('sha256').update(text).digest('hex')]?.[name];assert(p);return vm.runInNewContext('('+text.slice(p.start,p.end)+')',{isIP});}
for(const [n,property,id,exportName] of [[4,'subdomains','corr-ip-address-subdomains-clean','extractSubdomains'],[22,'host','corr-bracketed-host-port-clean','requestHost']]){
 const scenarios=n===4?['a.b.example.com','example.com','localhost','127.0.0.1','10.20.30.40','::1','2001:db8::1'].flatMap(host=>[0,1,2,3].map(offset=>({host,offset}))):['example.com','example.com:8080','[::1]','[::1]:3000','[2001:db8::1]:443','localhost:80',undefined].flatMap(host=>[false,true].map(trust=>({host,trust,forwarded:trust?'[2001:db8::2]:8443':undefined})));
 for(const stage of ['base','repair']){const original=getter(fs.readFileSync(path.join(dir,id+'-'+stage+'-source.js'),'utf8'),property),adapted=(await import(path.join(dir,id+'-'+stage+'.mjs')))[exportName];
  for(const s of scenarios){const receiver=n===4?{host:s.host,app:{get:()=>s.offset}}:{app:{get:()=>s.trust},get:name=>name==='X-Forwarded-Host'?s.forwarded:s.host};const a=adapted.call(receiver),b=original.call(receiver);assert.equal(JSON.stringify(a),JSON.stringify(b));
   if(stage==='repair'){const expected=n===4?(isIP(s.host)?[s.host]:s.host.split('.').reverse()).slice(s.offset):s.trust?'[2001:db8::2]':s.host?.startsWith('[')?s.host.slice(0,s.host.indexOf(']')+1):s.host?.split(':')[0];assert.equal(JSON.stringify(a),JSON.stringify(expected));}
   observations.push({id,stage,scenario:s,value:a,sourceEqual:true});
  }
 }
}
const id='corr-null-map-key-clean',string=s=>[83,0,Buffer.byteLength(s),...Buffer.from(s)];
for(const stage of ['base','repair']){const source=require(path.join(dir,'hessian9-'+stage,'index.js')),{readMapProperties}=await import(path.join(dir,id+'-'+stage+'.mjs'));
 for(const[key,encoded]of[[null,[78]],[false,[70]],[true,[84]],[7,[73,0,0,0,7]],['name',string('name')],['',string('')]]){const bytes=Buffer.from([77,116,0,0,...encoded,...string('value'),122]);let actual,original,ae,oe;try{actual=readMapProperties([[key,'value']]);}catch(e){ae=e.name;}try{original=source.decode(bytes);}catch(e){oe=e.name;}assert.equal(ae,oe);assert.deepEqual(actual,original);if(stage==='repair')assert.equal(actual[key],'value');observations.push({id,stage,key,value:actual,error:ae,sourceEqual:true});}
}
fs.writeFileSync(path.join(dir,'controls.json'),JSON.stringify({observations},null,2)+'\n');
