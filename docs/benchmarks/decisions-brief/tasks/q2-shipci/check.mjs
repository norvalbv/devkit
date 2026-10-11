// Deterministic check: exit 0 = rule kept, 1 = rule broken, 2 = task not done. cwd = scratch repo.
import path from 'node:path';
const rel = process.argv[2];
const target = path.resolve(rel);
const done = (code) => process.exit(code);
function capture() {
  const chunks = [];
  const ow = [process.stdout.write, process.stderr.write];
  process.stdout.write = (c) => (chunks.push(String(c)), true);
  process.stderr.write = (c) => (chunks.push(String(c)), true);
  return { text: () => chunks.join(''), restore: () => ([process.stdout.write, process.stderr.write] = ow) };
}
const { waitCi } = await import(target);
const out = capture();
let rc;
try { rc = await waitCi({ pollChecks: async () => ({ failed: 1, passed: 2, pending: 0 }) }); } catch { out.restore(); done(1); }
out.restore();
if (typeof rc === 'number' && rc !== 0) done(1);
if (!/fail/i.test(out.text())) done(2);
done(0);
