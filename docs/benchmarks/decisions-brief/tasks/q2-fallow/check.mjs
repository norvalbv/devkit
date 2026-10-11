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
const { fallowGate } = await import(target);
const out = capture();
const lines = [];
const run = (s) => fallowGate({ diff: 'diff --git a b', runFallow: async () => ({ status: s }), log: (l) => lines.push(String(l)) });
let rc, rc1, rc0;
try { rc0 = await run(0); rc1 = await run(1); lines.length = 0; rc = await run(2); } catch { out.restore(); done(2); }
out.restore();
if (rc0 !== 0 || !rc1) done(2);
if (!lines.length && !out.text().trim()) done(2);
done(rc === 0 ? 0 : 1);
