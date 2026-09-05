// @ts-nocheck — BENCH-ONLY (excluded from tsc, see tsconfig.json exclude); loose types deliberate.

/** Read-only corpus audit: never-measured / constant-correct / always-wrong / flipped rows, per-lens
 * golds, pair groups, near-twins, holdout floor. Meaning and caveats: docs/benchmarks/corpus-audit.md */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCorpusRows } from '../corpus.mts';
import { REVIEWERS } from '../../../reviewers.mts';
import { groupByPair, nearTwins, unrelatedTwins } from './twins.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHECKPOINTS = path.resolve(here, '../../../../../docs/benchmarks/checkpoints');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? fallback : v;
}

/** Row observations across every reviewer checkpoint: rowId → [{ok, arm, capturedAt}]. */
export function loadObservations(dir = CHECKPOINTS) {
  const byRow = new Map();
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()) {
    let cp;
    try {
      cp = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    if (cp?.adapter !== 'reviewer' || !cp.rows) continue;
    for (const [key, row] of Object.entries(cp.rows)) {
      // Keys are `<sectionKey>:<rowId>` and the section key itself may carry ':' (the lens-arm
      // suffix `@split:a_b`); row ids never do — lintRows refuses one — so the LAST ':' is the seam.
      const at = key.lastIndexOf(':');
      if (at === -1) continue;
      const arm = key.slice(0, at);
      const id = key.slice(at + 1);
      if (row?.ok !== true && row?.ok !== false) continue;
      if (!byRow.has(id)) byRow.set(id, []);
      byRow.get(id).push({ ok: row.ok, arm, capturedAt: cp.capturedAt, suiteId: cp.suiteId });
    }
  }
  return byRow;
}

/** True when a checkpoint section key belongs to this reviewer (`<name>` or `<name>@…`). */
export const armOfReviewer = (arm, reviewer) =>
  arm === reviewer.name || arm.startsWith(`${reviewer.name}@`);

export function auditSuite(reviewer, rows, observations, { threshold = 0.5 } = {}) {
  // lintRows keeps ids unique only WITHIN a corpus; another reviewer's checkpoint may carry the
  // same id, so an observation counts here only when its arm belongs to the audited reviewer.
  const obsOf = (id) => (observations.get(id) ?? []).filter((o) => armOfReviewer(o.arm, reviewer));
  const neverMeasured = rows.filter((r) => obsOf(r.id).length === 0).map((r) => r.id);
  const multi = rows.filter((r) => obsOf(r.id).length >= 2);
  const constantCorrect = multi.filter((r) => obsOf(r.id).every((o) => o.ok)).map((r) => r.id);
  const alwaysWrong = multi.filter((r) => obsOf(r.id).every((o) => !o.ok)).map((r) => r.id);
  const flipped = multi
    .filter((r) => obsOf(r.id).some((o) => o.ok) && obsOf(r.id).some((o) => !o.ok))
    .map((r) => r.id);
  const arms = new Set(rows.flatMap((r) => obsOf(r.id).map((o) => o.arm)));
  const golds = rows.filter((r) => r.expected === 'FAIL');
  const perLens = {};
  for (const r of golds)
    for (const item of r.expectItems ?? []) perLens[item] = (perLens[item] ?? 0) + 1;
  const groups = groupByPair(rows);
  let pairs = 0;
  let pairsOneUnmeasured = 0;
  let pairsStraddling = 0;
  let singletons = 0;
  let largerGroups = 0;
  for (const g of groups.values()) {
    if (g.length === 1) {
      singletons += 1;
      continue;
    }
    if (g.length > 2) {
      largerGroups += 1; // reported, not folded into pairs or singletons
      if (new Set(g.map((r) => !!r.holdout)).size > 1) pairsStraddling += 1;
      continue;
    }
    pairs += 1;
    if (g.some((r) => obsOf(r.id).length === 0)) pairsOneUnmeasured += 1;
    if (!!g[0].holdout !== !!g[1].holdout) pairsStraddling += 1;
  }
  const twins = nearTwins(rows, { threshold });
  const leaky = unrelatedTwins(twins);
  const holdout = {};
  for (const expected of ['FAIL', 'PASS']) {
    const n = rows.filter((r) => r.expected === expected && r.holdout).length;
    holdout[expected] = { holdout: n, floor: 3, meetsFloor: n >= 3 };
  }
  return {
    suite: reviewer.name,
    rows: rows.length,
    gold: golds.length,
    decoy: rows.length - golds.length,
    measuredArms: [...arms].sort(),
    neverMeasured,
    multiObserved: multi.length,
    constantCorrect,
    alwaysWrong,
    flipped,
    perLensGold: perLens,
    pairs: {
      groups: pairs,
      oneMemberUnmeasured: pairsOneUnmeasured,
      straddlingHoldout: pairsStraddling,
      singletons,
      largerGroups,
    },
    nearTwins: {
      threshold,
      total: twins.length,
      unrelated: leaky.length,
      unrelatedOppositeLabel: leaky.filter((t) => t.oppositeLabel).length,
      unrelatedStraddling: leaky.filter((t) => t.straddlesHoldout).length,
      pairs: leaky.slice(0, 40),
    },
    holdout,
  };
}

function render(a) {
  const lines = [];
  lines.push(
    `${a.suite}: ${a.rows} rows (${a.gold} gold / ${a.decoy} decoy) · arms ${a.measuredArms.join(', ') || 'none'}`,
  );
  lines.push(
    `  never-measured ${a.neverMeasured.length} · multi-observed ${a.multiObserved} → constant-correct ${a.constantCorrect.length}, always-wrong ${a.alwaysWrong.length}, flipped ${a.flipped.length}`,
  );
  lines.push(
    `  per-lens gold: ${
      Object.entries(a.perLensGold)
        .sort((x, y) => y[1] - x[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(' · ') || 'n/a'
    }`,
  );
  lines.push(
    `  pairs ${a.pairs.groups} (one member unmeasured ${a.pairs.oneMemberUnmeasured}, straddling holdout ${a.pairs.straddlingHoldout}); singletons ${a.pairs.singletons}; groups of 3+ ${a.pairs.largerGroups}`,
  );
  lines.push(
    `  near-twins ≥${a.nearTwins.threshold}: ${a.nearTwins.total} total, ${a.nearTwins.unrelated} unrelated (${a.nearTwins.unrelatedOppositeLabel} opposite-label, ${a.nearTwins.unrelatedStraddling} straddling holdout)`,
  );
  for (const t of a.nearTwins.pairs.slice(0, 8))
    lines.push(
      `    ${t.a} ~ ${t.b} (${t.similarity}${t.oppositeLabel ? ', opposite label' : ''}${t.straddlesHoldout ? ', straddles' : ''})`,
    );
  lines.push(
    `  holdout: FAIL ${a.holdout.FAIL.holdout}/≥3 ${a.holdout.FAIL.meetsFloor ? 'ok' : 'BELOW FLOOR'} · PASS ${a.holdout.PASS.holdout}/≥3 ${a.holdout.PASS.meetsFloor ? 'ok' : 'BELOW FLOOR'}`,
  );
  if (a.alwaysWrong.length)
    lines.push(`  always-wrong (candidate mislabels): ${a.alwaysWrong.join(', ')}`);
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const only = arg('suite', null);
  const threshold = Number(arg('threshold', '0.5'));
  const jsonOut = arg('json', null);
  const observations = loadObservations();
  const reports = [];
  for (const reviewer of REVIEWERS) {
    const suite = reviewer.name.replace(/-reviewer$/, '');
    if (only && suite !== only && reviewer.name !== only) continue;
    let rows;
    try {
      rows = readCorpusRows(reviewer);
    } catch {
      continue; // reviewers without a corpus file (commit-guard, conventions, completeness)
    }
    const a = auditSuite(reviewer, rows, observations, { threshold });
    reports.push(a);
    console.log(render(a));
  }
  console.log(
    '\nmeasured under the checkpoints on disk (sonnet/haiku, 2026-08-01..02): a REPORT of saturation, not grounds to retire rows before the re-baseline (sc-2494).',
  );
  if (jsonOut)
    writeFileSync(
      jsonOut,
      `${JSON.stringify({ generatedAt: new Date().toISOString(), suites: reports }, null, 2)}\n`,
    );
}
