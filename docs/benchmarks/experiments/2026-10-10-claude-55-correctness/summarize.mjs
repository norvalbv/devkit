import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const SOL_CHECKPOINT =
  '../../checkpoints/462cd5e99ad1147c3897521ef9ff02c0b7624093e547f13aa4d86d2bb8ec6fc8.json';

const results = read('results.json');
const sol = Object.fromEntries(
  Object.entries(read(SOL_CHECKPOINT).rows).map(([key, row]) => [key.split(':').at(-1), row]),
);
assert.equal(Object.keys(sol).length, results.corpus.rows);

const choose = (n, k) => {
  let c = 1n;
  for (let i = 1n; i <= BigInt(k); i += 1n) c = (c * (BigInt(n) - i + 1n)) / i;
  return c;
};

/** Exact two-sided McNemar p over the discordant pairs. */
function mcnemar(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  let tail = 0n;
  for (let i = 0; i <= Math.min(b, c); i += 1) tail += choose(n, i);
  return Math.min(1, Number(tail * 2n * 1_000_000n / 2n ** BigInt(n)) / 1_000_000);
}

const tally = (rows, ids) => ({ k: ids.filter((id) => rows[id].okFirst).length, n: ids.length });

/** Rows both sides measured on identical behaviour, split by label. */
function paired(a, b, label) {
  const ids = Object.keys(a).filter(
    (id) => b[id] && a[id].behaviorHash === b[id].behaviorHash && a[id].expected === label,
  );
  const aOnly = ids.filter((id) => a[id].okFirst && !b[id].okFirst);
  const bOnly = ids.filter((id) => b[id].okFirst && !a[id].okFirst);
  return {
    rows: ids.length,
    a: tally(a, ids),
    b: tally(b, ids),
    aOnly: aOnly.length,
    bOnly: bOnly.length,
    p: mcnemar(aOnly.length, bOnly.length),
    aOnlyIds: aOnly.sort(),
  };
}

const models = Object.keys(results.runs);
const summary = { schemaVersion: 1, solCheckpoint: path.basename(SOL_CHECKPOINT), models: {} };
for (const model of models) {
  const { rows, notMeasured } = results.runs[model];
  const ids = Object.keys(rows);
  const of = (label, holdout) =>
    ids.filter(
      (id) => rows[id].expected === label && (holdout === undefined || rows[id].holdout === holdout),
    );
  summary.models[model] = {
    measuredRows: ids.length,
    notMeasured,
    bugsCaught: tally(rows, of('FAIL')),
    cleanPassed: tally(rows, of('PASS')),
    development: { bugsCaught: tally(rows, of('FAIL', false)), cleanPassed: tally(rows, of('PASS', false)) },
    holdout: { bugsCaught: tally(rows, of('FAIL', true)), cleanPassed: tally(rows, of('PASS', true)) },
    versusSol: { bugs: paired(sol, rows, 'FAIL'), clean: paired(sol, rows, 'PASS') },
  };
}

const [sonnet, haiku] = models.map((model) => results.runs[model].rows);
summary.haikuVersusSonnet = { bugs: paired(haiku, sonnet, 'FAIL'), clean: paired(haiku, sonnet, 'PASS') };
const bugIds = Object.keys(haiku).filter((id) => haiku[id].expected === 'FAIL' && sonnet[id]);
const missedByBothClaude = bugIds.filter((id) => !haiku[id].okFirst && !sonnet[id].okFirst);
summary.missedByBothClaudeCaughtBySol = missedByBothClaude.filter((id) => sol[id].okFirst).sort();
summary.missedByAllThree = missedByBothClaude.filter((id) => !sol[id].okFirst).sort();

fs.writeFileSync(path.join(root, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
