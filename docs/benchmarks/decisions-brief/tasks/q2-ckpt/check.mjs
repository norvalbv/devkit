import { writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
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
const { loadCheckpoint } = await import(target);
const d = mkdtempSync(path.join(os.tmpdir(), 'ck-'));
const run = { config: 'haiku/K1', gateHash: 'g1', corpusHash: 'c1', model: 'haiku', K: 1, cascade: false };
const row = (id, verdict) => JSON.stringify({ id, verdict, inputChars: 10, rawChars: 10, judged: 1, outage: false, ...run }) + '\n';
const rows = row('row-1', 'PASS') + row('row-2', 'FAIL');
const clean = path.join(d, 'progress-a.jsonl'), torn = path.join(d, 'progress-b.jsonl');
writeFileSync(clean, rows); writeFileSync(torn, rows + row('row-3', 'PASS').slice(0, 30));
const ids = (r) => (Array.isArray(r) ? r : [...(r?.values?.() ?? [])]).map((x) => x?.id).filter(Boolean).sort().join();
let a;
try { a = await loadCheckpoint(clean, run, run.gateHash, run.corpusHash); } catch { done(2); }
if (ids(a) !== 'row-1,row-2') done(2);
let b;
try { b = await loadCheckpoint(torn, run, run.gateHash, run.corpusHash); } catch { done(1); }
done(ids(b) === 'row-1,row-2' ? 0 : 1);
