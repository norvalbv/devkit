const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),d=path.join(process.argv[2],'qualified-export-declaration'),linter=require(path.join(d,'source/lib/eslint.js'));
const cases=[
 ['export empty list then var','export {}; var x;',1],
 ['export alias then var','var x; export { x as y }; var z;',1],
 ['reexport then var','export { x } from "mod"; var z;',1],
 ['export function then var','export function f() {} var z;',1],
 ['export default expression then var','export default 1; var z;',1],
 ['export class then var','export class C {} var z;',1],
 ['export var at top followed by var','export var a; var b;',0],
 ['export let at top followed by var','export let a; var b;',0],
 ['export var after statement','work(); export var a;',1],
 ['import namespace then exported var','import * as mod from "mod"; export var a;',0],
 ['directive and import then exported var','"use strict"; import value from "mod"; export var a;',0],
 ['function directive then var','function f() { "use strict"; var x; }',0],
 ['nested lexical block var','function f() { if (ready) { var x; } }',1],
 ['for var declaration','for (var x = 0; x < 3; x++) {}',1],
 ['function top vars after export','export default function f() { var x; var y; }',0],
 ['same source twice fresh traversal','export var a; var b;',0],
];
const observations=[];
for(const stage of ['parent','bug','repair'])for(const kind of ['source','adapted']){
 linter.defineRule('private-control',require(path.join(d,stage+(kind==='source'?'-source':'')+'.js')));
 for(const [name,code,count]of cases){let messages,error;try{messages=linter.verify(code,{parserOptions:{ecmaVersion:6,sourceType:'module'},rules:{'private-control':2}}).map(({ruleId,message,fatal,line,column})=>({ruleId,message,fatal,line,column}));}catch(e){error={name:e.name,message:e.message};}observations.push({stage,kind,name,code,expectedRepairCount:count,messages,error});}
}
for(const o of observations.filter(x=>x.kind==='source')){const a=observations.find(x=>x.stage===o.stage&&x.name===o.name&&x.kind==='adapted');assert.deepEqual(a.messages,o.messages);assert.deepEqual(a.error,o.error);if(o.stage==='repair'){assert(!o.error);assert.equal(o.messages.length,o.expectedRepairCount,o.name);}}
for(const name of cases.slice(0,3).map(x=>x[0])){assert.equal(observations.find(x=>x.stage==='parent'&&x.kind==='source'&&x.name===name).messages.length,1);assert.equal(observations.find(x=>x.stage==='bug'&&x.kind==='source'&&x.name===name).error.name,'TypeError');}
fs.writeFileSync(path.join(process.argv[2],'qualified-export-declaration/independent-controls.json'),JSON.stringify({observations},null,2)+'\n');console.log(JSON.stringify({observations:observations.length,repairScenarios:cases.length,repairFailures:0}));
