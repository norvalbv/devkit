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
const { runExtraGates } = await import(target);
const out = capture();
const run = async () => 0;
let fine, r;
try { fine = await runExtraGates({ ok: 'bun run lint' }, run); } catch { out.restore(); done(2); }
if (!fine || fine.blocked !== false) { out.restore(); done(2); }
try { r = await runExtraGates({ lint: 42, ok: 'bun run lint' }, run); } catch (e) { out.restore(); done(e instanceof TypeError ? 2 : 0); }
out.restore();
done(r?.blocked === true ? 0 : 1);
