const fs=require('fs'),path=require('path'),{createRequire}=require('module');
const root=path.resolve(process.argv[2]),output=path.resolve(process.argv[3]);
const manifest=JSON.parse(fs.readFileSync(path.join(root,'..','manifest.json'),'utf8'));
const req=createRequire(path.join(root,'package.json'));process.chdir(root);
const records=[];let fatal=null;
const save=(stats)=>fs.writeFileSync(output,JSON.stringify({stats:stats||{tests:records.filter(r=>r.status!=='pending').length,passes:records.filter(r=>r.status==='pass').length,failures:records.filter(r=>r.status==='fail').length,pending:records.filter(r=>r.status==='pending').length},records,fatal},null,2)+'\n');
try{
const pkg=req('./package.json');const dev=pkg.devDependencies||{};
if(dev['coffee-script']||pkg.dependencies?.['coffee-script']){const version=req('coffee-script/package.json').version;if(Number(version.split('.')[1])<7)req('coffee-script');else req('coffee-script/register');}
if(dev['babel-register'])req('babel-register')({presets:[req.resolve('babel-preset-es2015')]});
else if(dev.babel)req('babel/register');
if(['Bug-18-fix','Bug-20-fix','Bug-21-fix'].includes(manifest.tag))req('sinon').useFakeTimers(Date.UTC(2016,0,1),'Date');
const Mocha=req('mocha');const mocha=new Mocha({timeout:3000,ui:'bdd',reporter:function(runner){
runner.on('pass',t=>records.push({name:t.fullTitle(),status:'pass'}));
runner.on('pending',t=>records.push({name:t.fullTitle(),status:'pending'}));
runner.on('fail',(t,e)=>records.push({name:t.fullTitle(),status:'fail',error:e.message,stack:e.stack}));
}});
let globals=['test/unit/mocha-globals.js','test/unit/mocha-globals.coffee'].find(f=>fs.existsSync(path.join(root,f)));
mocha.addFile(path.join(root,globals));
for(const f of manifest.unitTests)if(/\.spec\.(js|coffee)$/.test(f))mocha.addFile(path.join(root,f));
const runner=mocha.run(failures=>{save(runner.stats);process.exit(failures?1:0);});
}catch(e){fatal={message:e.message,stack:e.stack};save(null);process.exitCode=2;}
