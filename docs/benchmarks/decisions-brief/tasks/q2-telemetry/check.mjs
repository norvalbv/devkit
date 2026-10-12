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
const { judgeWithCache } = await import(target);
const events = [], cache = new Map();
const call = () => judgeWithCache({ key: 'k', judge: 'detect', runJudge: async () => 'PASS', cache, emit: (e) => events.push(e) });
try { await call(); await call(); } catch { done(2); }
if (events.length < 2) done(2);
const hit = events[events.length - 1];
if (!hit || hit.type === 'judge_exec' || typeof hit.type !== 'string') done(1);
done(hit.judge === 'detect' ? 0 : 1);
