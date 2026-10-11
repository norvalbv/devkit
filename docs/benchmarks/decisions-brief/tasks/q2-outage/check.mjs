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
const { classifyJudgeOutage } = await import(target);
let a, b, u;
try { a = classifyJudgeOutage('HTTP 401 unauthorized'); b = classifyJudgeOutage('sh: codex: command not found'); u = classifyJudgeOutage('segmentation fault (core dumped)'); } catch { done(2); }
if (!/unauth/i.test(a?.kind ?? '') || !/absent/i.test(b?.kind ?? '') || !u) done(2);
done(u.permanent === false ? 0 : 1);
