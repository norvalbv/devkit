import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const root=process.argv[2],here=path.join(root,'public-pair-critique'),require=createRequire(import.meta.url);
const observations=[];
async function request(app,url) {
 const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {const response=await fetch('http://127.0.0.1:'+server.address().port+url);return{status:response.status,body:await response.text()};}
 finally {await new Promise(resolve=>server.close(resolve));}
}
async function middleware(stage,scenario,adapt) {
 const express=require(path.join(root,'public-datasets/express-8',stage,'index.js')),app=express();
 if(adapt)app.use=(await import(path.join(root,'qualified-middleware-path',stage+'.mjs'))).registerMiddleware;
 const calls=[];let error;const first=(req,res,next)=>{calls.push('first');next();},second=(req,res,next)=>{calls.push('second');next();};
 try {
  if(scenario==='empty path multiple handlers')app.use('',first,second);
  if(scenario==='regexp path')app.use(/^\/match/,first);
  if(scenario==='array paths')app.use(['/match','/alternate'],first);
  if(scenario==='nested arrays with error handler') {app.use([[function(req,res,next){next(Error('expected'));}],[function(err,req,res,next){calls.push(err.message);next();}]]);}
  if(scenario==='mounted app yields to parent') {
   const child=express();child.use((req,res,next)=>{calls.push(req.app===child?'child':'wrong-app');next();});
   app.use('/match',child);app.use((req,res,next)=>{calls.push(req.app===app?'parent':'wrong-parent');next();});
  }
  if(scenario==='empty path nested arrays')app.use('',[[first],[second]]);
  if(scenario==='invalid array element')app.use([first,null,second]);
  if(scenario==='no arguments')app.use();
  if(scenario==='falsy nonstring path')app.use(false,first);
 } catch(e){error={name:e.name,message:e.message};}
 if(error)return{error,calls};
 app.use((req,res)=>res.end(JSON.stringify({calls,url:req.url})));
 app.use((err,req,res,next)=>{res.statusCode=500;res.end(err.message);});
 return await request(app,'/match/child');
}
for(const stage of ['base','bug','repair'])for(const scenario of ['empty path multiple handlers','regexp path','array paths','nested arrays with error handler','mounted app yields to parent','empty path nested arrays','invalid array element','no arguments','falsy nonstring path']) {
 const original=await middleware(stage,scenario,false),adapted=await middleware(stage,scenario,true);assert.deepEqual(adapted,original);
 observations.push({family:'middleware-path',stage,scenario,original,adapted,equal:true});
}
async function parameter(stage,scenario,mode) {
 const express=require(path.join(root,'public-datasets/express-params',stage,'index.js')),app=express(),router=express.Router();
 const {createParameterRun}=await import(path.join(root,'qualified-parameter-cache',stage+'.mjs'));
 if(mode!=='source') {
  const runs=new WeakMap();
  router.process_params=stage==='base'?function(layer,req,res,done){return createParameterRun(router.params)(layer,req,res,done);}:function(layer,called,req,res,done){
   const key=mode==='parent-request-cache'?req:called;
   if(!runs.has(key))runs.set(key,createParameterRun(router.params));
   return runs.get(key)(layer,req,res,done);
  };
 }
 let calls=0;const trace=[];
 router.param('id',(req,res,next,value)=>{
  calls++;trace.push(['first',value]);
  if(scenario==='multiple asynchronous callbacks'){req.params.id='normalized';return setImmediate(next);}
  if(scenario==='repeated router dispatch'){req.params.id='normalized-'+calls;return next();}
  if(scenario==='skip and changed value'&&value==='first')return next('route');
  if(scenario==='same value skip')return next('route');
  if(scenario==='cached ordinary error')return next(Error('parameter failure'));
  next();
 });
 if(scenario==='multiple asynchronous callbacks')router.param('id',(req,res,next,value)=>{trace.push(['second',value,req.params.id]);next();});
 if(scenario==='repeated router dispatch') {
  router.use('/:id',(req,res,next)=>{trace.push(['middleware',req.params.id]);next();});
  app.use('/mount',router);app.use('/mount',router);
 }else{
  app.use(router);
  if(scenario==='skip and changed value'){
   router.get('/:id/second',(req,res,next)=>next());router.get('/first/:id',(req,res)=>res.end(JSON.stringify({id:req.params.id,calls,trace})));
  }else if(scenario==='optional missing parameter')router.get('/item/:id?',(req,res)=>res.end(JSON.stringify({id:req.params.id,calls,trace})));
  else if(scenario==='duplicate parameter keys')router.get('/item/:id/:id',(req,res)=>res.end(JSON.stringify({id:req.params.id,calls,trace})));
  else {
   router.get('/item/:id',(req,res,next)=>next('route'));router.get('/item/:id',(req,res)=>res.end(JSON.stringify({id:req.params.id,calls,trace})));router.get('/item/value',(req,res)=>res.end(JSON.stringify({literal:true,calls,trace})));
  }
 }
 app.use((req,res)=>res.end(JSON.stringify({calls,trace})));
 app.use((err,req,res,next)=>{res.statusCode=500;res.end(JSON.stringify({error:err.message,calls,trace}));});
 const url=scenario==='repeated router dispatch'?'/mount/value':scenario==='skip and changed value'?'/first/second':scenario==='optional missing parameter'?'/item':scenario==='duplicate parameter keys'?'/item/left/right':'/item/value';
 return await request(app,url);
}
for(const stage of ['base','bug','repair'])for(const scenario of ['multiple asynchronous callbacks','repeated router dispatch','skip and changed value','optional missing parameter','duplicate parameter keys','same value skip','cached ordinary error']) {
 const original=await parameter(stage,scenario,'source'),adapted=await parameter(stage,scenario,'dispatch-cache');assert.deepEqual(adapted,original);
 const record={family:'parameter-cache',stage,scenario,original,adapted,equal:true};
 if(scenario==='repeated router dispatch'){record.parentHarness=await parameter(stage,scenario,'parent-request-cache');record.parentHarnessEqual=JSON.stringify(record.parentHarness)===JSON.stringify(original);}
 observations.push(record);
}
fs.writeFileSync(path.join(here,'express-boundary-observations.json'),JSON.stringify({runtime:process.version,observations},null,2)+'\n');
console.log(JSON.stringify({middlewareComparisons:27,parameterComparisons:21,allSourceAdaptationEqual:true,parentRequestCacheMismatches:observations.filter(o=>o.parentHarnessEqual===false)}));
