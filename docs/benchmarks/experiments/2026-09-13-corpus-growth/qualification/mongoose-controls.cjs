const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const [number,stage]=process.argv.slice(2),root=path.join(process.env.QUALIFICATION_WORK_ROOT,'mongoose-qualification',number),mongoose=require(root+'/source'),mg=new mongoose.Mongoose(),Schema=mongoose.Schema,observations=[];
let serial=0;const model=definition=>mg.model('Control'+(++serial),definition instanceof Schema?definition:new Schema(definition));
async function check(name,fn){try{await fn();observations.push({name,pass:true});}catch(error){observations.push({name,pass:false,error:{name:error.name,message:error.message}});}}
(async()=>{
switch(+number){
case 5:
 await check('created subdocument adopts pushed owner',()=>{const M=model({docs:[{name:String}]}),m=new M(),doc=m.docs.create({name:'value'});assert.notEqual(String(doc.ownerDocument()._id),String(m._id));m.docs.push(doc);assert.equal(String(doc.ownerDocument()._id),String(m._id));assert.equal(doc.__parentArray,m.docs);});
 await check('plain object casting retains owner and fields',()=>{const M=model({docs:[{name:String}]}),m=new M({docs:[{name:'value'}]});assert.equal(m.docs[0].ownerDocument(),m);assert.equal(m.docs[0].name,'value');});
 await check('push plain object and ObjectId use all caster branches',()=>{const M=model({docs:[{name:String}]}),m=new M(),id=new mongoose.Types.ObjectId();m.docs.push({name:'plain'});m.docs.push(id);assert.equal(m.docs[0].name,'plain');assert.equal(String(m.docs[1]._id),String(id));});
 await check('already attached object remains same instance',()=>{const M=model({docs:[{name:String}]}),m=new M({docs:[{name:'value'}]}),doc=m.docs[0];assert.equal(m.docs._cast(doc),doc);assert.equal(doc.__parentArray,m.docs);});break;
case 6:
 await check('array caster leaves caller type definition intact',()=>{const cast={type:Schema.ObjectId,ref:'Other'},definition={ids:[cast]};const s=new Schema(definition);assert.equal(cast.type,Schema.ObjectId);assert.equal(cast.ref,'Other');assert.equal(s.path('ids').caster.options.ref,'Other');});
 await check('nested caller definitions remain intact',()=>{const definition={names:[{type:String,lowercase:true}],nested:[{nums:[{type:Number,min:0}]}]};new Schema(definition);assert.equal(definition.names[0].type,String);assert.equal(definition.nested[0].nums[0].type,Number);});
 await check('array string casts and normalizes values',()=>{const M=model({names:[{type:String,lowercase:true}]});assert.deepEqual(Array.from(new M({names:['HELLO',42]}).names),['HELLO','42']);});break;
case 8:
 await check('document update returns actual Query',()=>{const M=model({s:String}),d=new M({s:'value'});assert(d.update() instanceof mongoose.Query);});
 await check('document update preserves receiver arguments callback and result',()=>{const M=model({s:String}),d=new M({s:'value'}),operation={$set:{s:'next'}},options={multi:false},callback=()=>{},sentinel={result:1};let args;M.update=function(...a){assert.equal(this,M);args=a;return sentinel;};assert.equal(d.update(operation,options,callback),sentinel);assert.equal(String(args[0]._id),String(d._id));assert.equal(args[1],operation);assert.equal(args[2],options);assert.equal(args[3],callback);});break;
case 9:
 await check('nested subdocument object setter replaces intended branch',()=>{const M=model({ratings:[{description:{source:{url:String,time:Date}}}]}),d=new M({ratings:[{description:{source:{url:'old',time:new Date(1000)}}}]});d.ratings[0].description.source={url:'next'};assert.equal(d.ratings[0].description.source.url,'next');assert.equal(d.ratings[0].description.source.time,undefined);assert.equal(d.get('ratings.0.description.source.url'),'next');});
 await check('direct subdocument set merge retains sibling',()=>{const M=model({ratings:[{description:{source:{url:String,time:Date}}}]}),d=new M({ratings:[{description:{source:{url:'old'}}}]});d.ratings[0].set('description.source.time',new Date(2000),{merge:true});assert.equal(d.ratings[0].description.source.url,'old');assert.equal(+d.ratings[0].description.source.time,2000);});break;
case 10:
 await check('document array forwards transform false',()=>{const sub=new Schema({title:String});sub.set('toObject',{transform:(doc,ret)=>{ret.changed=123;return ret;}});const M=model({docs:[sub]}),m=new M({docs:[{title:'hello'}]});assert.equal(m.docs.toObject({transform:false})[0].changed,undefined);});
 await check('default document array transform remains active',()=>{const sub=new Schema({title:String});sub.set('toObject',{transform:(doc,ret)=>{ret.changed=123;return ret;}});const M=model({docs:[sub]}),m=new M({docs:[{title:'hello'}]});assert.equal(m.docs.toObject()[0].changed,123);});
 await check('empty document array returns empty list',()=>{const M=model({docs:[{title:String}]});assert.deepEqual(new M().docs.toObject({transform:false}),[]);});break;
case 11:
 for(const slice of [2,-2,[1,2]])await check('forced inclusion retains slice '+JSON.stringify(slice),()=>{const M=model({many:{type:[String],select:false},label:String}),q=M.findOne().select('+many').where('many').slice(slice);q._applyPaths();assert.deepEqual(q._fields.many,{$slice:slice});assert(!('+many'in q._fields));});
 await check('default exclusion retained',()=>{const M=model({many:{type:[String],select:false}}),q=M.findOne();q._applyPaths();assert.equal(q._fields.many,0);});break;
case 15:
 for(const value of ['im',{toString(){return'img';}},null])await check('regex options string coercion '+String(value),()=>{const M=model({tags:[String]}),q=M.find(),ret=q.cast(M,{tags:{$regex:/a/,$options:value}});assert.equal(ret.tags.$options,String(value));assert.equal(String(ret.tags.$regex),'/a/');});
 await check('other array operator cast retained',()=>{const M=model({tags:[String]}),ret=M.find().cast(M,{tags:{$in:[1,2]}});assert.deepEqual(ret.tags.$in,['1','2']);});break;
case 20:
 await check('recursive JSON conversion uses child schema getters',()=>{const sub=new Schema({name:String});sub.virtual('hello').get(function(){return'Hello '+this.name;});sub.set('toJSON',{getters:true});const M=model({children:[sub]}),m=new M({children:[{name:'Ada'}]});assert.equal(m.toJSON().children[0].hello,'Hello Ada');});
 await check('explicit direct JSON option override retained',()=>{const s=new Schema({name:String});s.virtual('hello').get(function(){return'Hello '+this.name;});s.set('toJSON',{getters:true});const M=model(s),m=new M({name:'Ada'});assert.equal(m.toJSON({getters:false}).hello,undefined);assert.equal(m.toJSON().hello,'Hello Ada');});
 await check('JSON.stringify array still serializes documents',()=>{const M=model({name:String});assert.equal(JSON.parse(JSON.stringify([new M({name:'Ada'})]))[0].name,'Ada');});break;
case 21:
 for(const fields of [{stations:0},{'stations.start':0}])await check('parent field exclusion suppresses nested defaults '+JSON.stringify(fields),()=>{const M=model({stations:{start:{loc:[Number]},end:{loc:[Number]}},name:{type:String,default:'given'}}),m=new M({},fields);assert.equal(m.get(fields.stations===0?'stations':'stations.start'),undefined);assert.equal(m.name,'given');if(!('stations'in fields))assert.deepEqual(Array.from(m.stations.end.loc),[]);});
 await check('no projection retains nested defaults',()=>{const M=model({stations:{start:{loc:[Number]}}}),m=new M();assert.deepEqual(Array.from(m.stations.start.loc),[]);});break;
case 25:
 await check('minimization preserves dates',()=>{const M=model({date:Date,mixed:{type:Schema.Types.Mixed}}),d=new M({date:new Date(1234),mixed:{date:new Date(5678),empty:{},items:[{}]}}),o=d.toObject({getters:true});assert(o.date instanceof Date);assert.equal(+o.date,1234);assert(o.mixed.date instanceof Date);assert.equal(+o.mixed.date,5678);assert.equal(o.mixed.empty,undefined);assert.equal(o.mixed.items.length,1);});
 await check('minimize false preserves empty objects',()=>{const M=model({mixed:{type:Schema.Types.Mixed}}),o=new M({mixed:{empty:{}}}).toObject({minimize:false});assert.deepEqual(o.mixed.empty,{});});break;
case 26:
 await check('enum configuration does not leak global message',()=>{delete global.errorMessage;new Schema({name:{type:String,enum:{values:['one'],message:'private-control'}}});assert.equal(typeof global.errorMessage,'undefined');});
 await check('enum validator and custom message remain installed',()=>{const s=new Schema({name:{type:String,enum:{values:['one'],message:'custom'}}}),p=s.path('name');assert(p.enumValidator('one'));assert(!p.enumValidator('two'));assert.equal(p.validators.find(x=>x[2]==='enum')[1],'custom');});
 await check('enum disable remains chainable',()=>{const p=new Schema({name:String}).path('name');assert.equal(p.enum(false),p);assert.equal(p.enumValidator,undefined);});break;
case 27:
 for(const event of ['save','remove'])await check('removed child emits once after parent '+event,async()=>{const M=model({children:[{name:String}]}),p=new M({children:[{name:'Ada'}]}),sub=p.children[0];let hits=0;sub.on('remove',value=>{assert.equal(value,sub);hits++;});sub.remove();await new Promise(setImmediate);assert.equal(hits,0);assert.equal(p.children.length,0);p.emit(event,p);await new Promise(setImmediate);assert.equal(hits,1);p.emit('save',p);p.emit('remove',p);assert.equal(hits,1);});
 await check('unremoved child does not emit remove on save',()=>{const M=model({children:[{name:String}]}),p=new M({children:[{name:'Ada'}]});let hits=0;p.children[0].on('remove',()=>hits++);p.emit('save',p);assert.equal(hits,0);});break;
case 28:
 await check('save notification supplies each actual child',()=>{const M=model({children:[{name:String}]}),p=new M({children:[{name:'Ada'},{name:'Bob'}]});const hits=[];for(const sub of p.children)sub.on('save',value=>hits.push(value===sub));p.emit('save',p);assert.deepEqual(hits,[true,true]);});
 await check('other notification payload retained',()=>{const M=model({children:[{name:String}]}),p=new M({children:[{name:'Ada'}]});const payload={marker:1};let received;p.children[0].on('custom',v=>received=v);p.children.notify('custom')(payload);assert.equal(received,payload);});break;
case 29:
 await check('validation gathers both asynchronous child errors',async()=>{const food=new Schema({name:{type:String,required:true,enum:['bacon','eggs']}}),M=model({foods:[food]}),d=new M({foods:[{name:'tofu'},{name:'waffles'}]});const error=await new Promise(resolve=>d.validate(resolve));assert(error?.errors['foods.0.name']);assert(error?.errors['foods.1.name']);});
 await check('sparse validation completes without ReferenceError',async()=>{const sub=new Schema({name:String}),M=model({foods:[sub]}),d=new M({foods:[null]});const error=await new Promise(resolve=>d.validate(resolve));assert.equal(error,null);});break;
default:throw Error('unassigned '+number);
}
fs.writeFileSync(path.join(root,stage+'-source-controls.json'),JSON.stringify({number:+number,stage,runtime:process.version,version:mongoose.version,observations,total:observations.length,failed:observations.filter(x=>!x.pass).length},null,2)+'\n');
})().catch(error=>{fs.writeFileSync(path.join(root,stage+'-source-controls.json'),JSON.stringify({number:+number,stage,fatal:{name:error.name,message:error.message},observations},null,2)+'\n');process.exitCode=2;});
