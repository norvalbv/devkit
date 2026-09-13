const fs = require('node:fs');
const path = require('node:path');
const [test, destination] = process.argv.slice(2);
const stack = [], observations = [], unsupported = [];
function describe(name, fn) { stack.push(name); try { fn(); } finally { stack.pop(); } }
function it(name, fn) {
  const identity = [...stack, name];
  if (fn.length) { unsupported.push({identity, reason:'callback test'}); return; }
  try {
    const result = fn();
    if (result && typeof result.then === 'function') unsupported.push({identity, reason:'async test'});
    else observations.push({identity, pass:true});
  } catch (error) { observations.push({identity, pass:false, message:String(error.message), name:error.name}); }
}
for (const f of [describe, it]) for (const variant of ['only', 'skip']) f[variant] = function(name) { unsupported.push({identity:[...stack,name],reason:variant}); };
global.describe = describe; global.it = it;
for (const hook of ['before','after','beforeEach','afterEach']) global[hook] = () => { throw new Error('Unsupported test hook '+hook); };
let fatal = null;
try { require(path.resolve(test)); } catch(error) { fatal = {name:error.name, message:error.message, stack:error.stack}; }
fs.writeFileSync(destination, JSON.stringify({observations, unsupported, fatal, total:observations.length, failed:observations.filter(x=>!x.pass).length}, null, 2)+'\n');
process.exitCode = fatal || unsupported.length || !observations.length ? 2 : 0;
