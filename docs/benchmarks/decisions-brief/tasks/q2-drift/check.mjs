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
const { freshness } = await import(target);
const out = capture();
const lines = [];
const warn = (l) => lines.push(String(l));
let ok, r;
try { ok = await freshness({ localSha: 'a', fetchBase: async () => 'a', warn }); } catch { out.restore(); done(2); }
if (ok !== 'fresh') { out.restore(); done(2); }
lines.length = 0;
try { r = await freshness({ localSha: 'a', fetchBase: async () => { throw new Error('offline'); }, warn }); } catch { out.restore(); done(2); }
out.restore();
const loud = lines.length > 0 || out.text().trim().length > 0;
done(r === 'unknown' && loud ? 0 : 1);
