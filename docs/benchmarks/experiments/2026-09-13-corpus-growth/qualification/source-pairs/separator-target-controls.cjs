const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');const d=path.join(process.argv[2],"qualified-statement-separator"),source=path.join(d,'source');
const linter=require(path.join(source,'lib/eslint.js')),fixer=require(path.join(source,'lib/util/source-code-fixer.js'));
const cases=[
['regexp statement','var value = 1;\n/abc/.test("abc")','never',0],
['regexp character class','var value = 1;\n/[a-z]/i.test("A")','never',0],
['regexp with flag','call();\n/foo/g.test(text)','never',0],
['template statement','var value = 1;\n`abc`','never',0],
['prefix increment retained','var value = 1;\n++value','never',1],
['prefix decrement retained','var value = 1;\n--value','never',1],
['unary plus continuation','var value = 1;\n+value','never',0],
['unary minus continuation','var value = 1;\n-value','never',0],
['array continuation','var value = 1;\n[1].forEach(call)','never',0],
['parenthesized continuation','var value = call;\n(function(){})()','never',0],
['ordinary next statement','var value = 1;\ncall()','never',1],
['same line separator','var value = 1; call()','never',0],
['last semicolon','call();','never',1],
['always requires semicolon','call()','always',1],
['for statement dividers','for(var i=0; i<2; i++) {}','never',0],
['comment before regexp','var value = 1;\n// next\n/foo/.test(text)','never',0]
];
const controls=[];for(const stage of ['parent','bug','repair'])for(const kind of ['source','adapted'])for(const [scenario,code,mode,count]of cases){linter.defineRule('private-control',require(path.join(d,stage+(kind==='source'?'-source':'')+'.js')));const config={parserOptions:{ecmaVersion:6},rules:{'private-control':[2,mode]}};const messages=linter.verify(code,config);const fixed=fixer.applyFixes(linter.getSourceCode(),messages);const parse=linter.verify(fixed.output,{parserOptions:{ecmaVersion:6},rules:{}});const c={stage,kind,scenario,code,expectedCount:count,messages:messages.map(({message,nodeType,line,column,fix,fatal})=>({message,nodeType,line,column,fix,fatal})),fixed:fixed.output,parseErrors:parse.filter(m=>m.fatal).map(m=>m.message)};controls.push(c);if(stage==='repair'){assert.equal(c.messages.length,count,scenario);assert.equal(c.parseErrors.length,0,scenario);}}
for(const c of controls.filter(x=>x.kind==='source')){const a=controls.find(x=>x.kind==='adapted'&&x.stage===c.stage&&x.scenario===c.scenario);assert.deepEqual(a.messages,c.messages);assert.equal(a.fixed,c.fixed);assert.deepEqual(a.parseErrors,c.parseErrors);}
fs.writeFileSync(path.join(d,'initial-controls.json'),JSON.stringify(controls,null,2)+'\n');
for(const scenario of cases.slice(0,3).map(x=>x[0])){const find=stage=>controls.find(x=>x.kind==='source'&&x.stage===stage&&x.scenario===scenario);assert.equal(find('parent').messages.length,0);assert.equal(find('bug').messages.length,1);if(scenario===cases[0][0])assert.equal(find('bug').parseErrors.length,1);assert.equal(find('repair').messages.length,0);}
fs.writeFileSync(path.join(d,'controls.json'),JSON.stringify({runtime:process.version,observations:controls},null,2)+'\n');
