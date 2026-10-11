/** decisions-brief scoring: metrics, cells and floorsMet from run rows, and the before/after contrast
 * `report` prints. Pure: no claude, no git. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProgress } from '../checkpoint.mts';
import { mcnemarMidP, wilson } from '../compare.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CORPUS = path.resolve(here, '../../../../docs/benchmarks/decisions-brief');
/** Only effects of about 15 points or more: the Wilson-95 half-width of a 40-run cell at p=0.5. */
export const NOISE_FLOOR = 0.15;

export type Arm = 'none' | 'brief-only' | 'read-on';
type Role = 'clause' | 'floor' | 'probe';
export type Specs = Record<string, { role: Role; cluster: string }>;
export const ARMS = {
  clause: ['none', 'brief-only', 'read-on'],
  floor: ['none', 'brief-only'],
  probe: ['none', 'brief-only', 'read-on'],
} satisfies Record<Role, Arm[]>;
export type Job = { task: string; arm: Arm; rep: number };
export interface Run extends Job {
  id: string;
  got: 0 | 1 | 2 | 'NULL';
  editedTarget: boolean;
  briefed: boolean;
  outageNotice: boolean;
  clauseShown: boolean;
  agentReads: number;
  model: string;
  claudeVersion: string;
}
type Cell = { kept: number; broken: number; notDone: number; n: number } & Identity;
type Identity = { model: string; claudeVersion: string };
type Metric = { id: string; label: string; k: number; n: number; noiseFloor: number };
export type Baseline = { metrics: Metric[]; rows: Record<string, Cell>; floorsMet: boolean };

const kept = (run: Run) => run.got === 0;
const METRICS = [
  {
    id: 'clause-kept-brief-only',
    label: 'Rule kept: brief only, agent cannot read on (best-case tasks)',
    role: 'clause',
    arm: 'brief-only',
    hit: kept,
    clustered: true,
  },
  {
    id: 'clause-kept-read-on',
    label: 'Rule kept: brief, agent may read on (best-case tasks)',
    role: 'clause',
    arm: 'read-on',
    hit: kept,
    clustered: true,
  },
  {
    id: 'floor-good-brief-only',
    label: 'Edit still correct where no clause binds: brief only (best-case tasks)',
    role: 'floor',
    arm: 'brief-only',
    hit: kept,
    clustered: false,
  },
  {
    id: 'clause-shown-brief-only',
    label: 'Binding clause inside the delivered brief',
    role: 'clause',
    arm: 'brief-only',
    hit: (run: Run) => run.clauseShown,
    clustered: false,
  },
];

export const manifest = (corpus = CORPUS): Specs =>
  JSON.parse(readFileSync(path.join(corpus, 'tasks.json'), 'utf8'));
export const rowId = (job: Job) => `${job.task}@${job.arm}#${job.rep}`;
const ratio = (k: number, n: number) => `${k}/${n}`;

/** The default plan omits probe tasks; `only` names any task, probes included. */
export function planJobs(specs: Specs, k: number, only?: string[], arms?: string[]): Job[] {
  const jobs: Job[] = [];
  const tasks = Object.entries(specs).sort(([a], [b]) => a.localeCompare(b));
  for (let rep = 0; rep < k; rep += 1)
    for (const [task, { role }] of tasks) {
      if (only ? !only.includes(task) : role === 'probe') continue;
      for (const arm of ARMS[role]) if (!arms || arms.includes(arm)) jobs.push({ task, arm, rep });
    }
  return jobs;
}

function cellOf(runs: Run[]): Cell {
  const join = (values: string[]) => [...new Set(values)].join(',');
  return {
    kept: runs.filter(kept).length,
    broken: runs.filter((run) => run.got === 1).length,
    notDone: runs.filter((run) => run.got === 2).length,
    n: runs.length,
    model: join(runs.map((run) => run.model)),
    claudeVersion: join(runs.map((run) => run.claudeVersion)),
  };
}

/** Metrics, one cell per task@arm with no `ok` (a 5-run majority flips by chance), and floorsMet. */
export function summarize(runs: Run[], k: number, specs = manifest()) {
  const roleOf = (run: Run) => specs[run.task]?.role;
  const planned = runs.filter(
    (r) => r.got !== 'NULL' && r.rep < k && roleOf(r) && roleOf(r) !== 'probe',
  );
  const pick = (role: string, arm: string) =>
    planned.filter((run) => roleOf(run) === role && run.arm === arm);
  const rows: Record<string, Cell> = {};
  for (const { task, arm } of planJobs(specs, 1))
    rows[`${task}@${arm}`] = cellOf(planned.filter((run) => run.task === task && run.arm === arm));
  const metrics = METRICS.map(({ id, label, role, arm, hit }) => {
    const cell = pick(role, arm);
    return { id, label, k: cell.filter(hit).length, n: cell.length, noiseFloor: NOISE_FLOOR };
  });
  const rate = (cell: Run[]) => cell.filter(kept).length / Math.max(1, cell.length);
  const hooked = planned.filter((run) => run.arm !== 'none');
  const failures = [
    Object.values(rows).some((cell) => cell.n !== k) && `a cell has fewer than K=${k} scored runs`,
    hooked.some((run) => run.editedTarget && !run.briefed) &&
      'a hook-arm edit of the task file got no brief naming the target',
    hooked.some((run) => run.outageNotice) && 'a hook-arm run got the retrieval-outage notice',
    rate(pick('clause', 'none')) > 0.1 && 'none-arm screen: clause kept above 10%',
    rate(pick('floor', 'none')) < 0.9 && 'none-arm screen: floor good below 90%',
    new Set(planned.map((run) => `${run.model}|${run.claudeVersion}`)).size > 1 &&
      'rows span more than one model or claude version',
  ].filter((failure): failure is string => Boolean(failure));
  const baseline: Baseline = { metrics, rows, floorsMet: failures.length === 0 };
  return { baseline, failures };
}

/** The pass-rule checks a reader needs beside the metrics: briefs delivered, pointer followed. */
export function diagnostics(runs: Run[]): string[] {
  const hooked = runs.filter((run) => run.arm !== 'none' && run.got !== 'NULL');
  const edited = hooked.filter((run) => run.editedTarget);
  const readOn = hooked.filter((run) => run.arm === 'read-on');
  const briefed = ratio(edited.filter((run) => run.briefed).length, edited.length);
  const followed = ratio(readOn.filter((run) => run.agentReads > 0).length, readOn.length);
  const outages = runs.filter((run) => run.got === 'NULL').length;
  return [
    `hook-arm edits of the task file briefed with the target: ${briefed}`,
    `outage notices: ${hooked.filter((run) => run.outageNotice).length}; outage rows: ${outages}`,
    `read-on runs where the agent ran show or query: ${followed}`,
  ];
}

const identityOf = ({ rows }: Baseline) => {
  const cell = Object.values(rows).find((row) => row.n > 0);
  return `${cell?.model} on claude ${cell?.claudeVersion}`;
};
const clauseClusters = (specs: Specs) => [
  ...new Set(
    Object.values(specs).flatMap((spec) => (spec.role === 'clause' ? [spec.cluster] : [])),
  ),
];

/** [kept, n] pooled over a clause cluster's tasks in one arm. */
function clusterCell(
  baseline: Baseline,
  specs: Specs,
  cluster: string,
  arm: string,
): [number, number] {
  let k = 0;
  let n = 0;
  for (const [id, spec] of Object.entries(specs)) {
    const cell = baseline.rows[`${id}@${arm}`];
    if (spec.role !== 'clause' || spec.cluster !== cluster || !cell) continue;
    k += cell.kept;
    n += cell.n;
  }
  return [k, n];
}

/** improved: Δ > +15 points and, for kept metrics, cluster mid-p < .05; regressed: Δ < −15. */
export function contrast(base: Baseline, head: Baseline, specs = manifest()) {
  if (identityOf(base) !== identityOf(head))
    throw new Error(
      `model or CLI differs (base ${identityOf(base)}, head ${identityOf(head)}): re-run the ` +
        'plan at base in a worktree on this CLI and pass --base <its progress file>',
    );
  const clusters = clauseClusters(specs);
  return METRICS.flatMap(({ id, arm, clustered }) => {
    const before = base.metrics.find((metric) => metric.id === id);
    const after = head.metrics.find((metric) => metric.id === id);
    if (!before?.n || !after?.n) return [];
    const delta = after.k / after.n - before.k / before.n;
    const rateIn = (b: Baseline, c: string) => {
      const [k, n] = clusterCell(b, specs, c, arm);
      return k / Math.max(1, n);
    };
    const moves = clustered ? clusters.map((c) => rateIn(head, c) - rateIn(base, c)) : [];
    const up = moves.filter((move) => move > 0).length;
    const down = moves.filter((move) => move < 0).length;
    const midP = moves.length ? mcnemarMidP(down, up) : null;
    const improved = delta > NOISE_FLOOR && (midP === null || midP < 0.05);
    const verdict = delta < -NOISE_FLOOR ? 'regressed' : improved ? 'improved' : 'flat';
    return [{ id, before, after, delta, up, down, midP, verdict }];
  });
}

/** Latest non-outage row per id. Head rows must carry the current hashes; a --base file its own. */
export function progressRows(file: string, hashes?: { gateHash: string; corpusHash: string }) {
  const lines = readProgress(file).filter((line) => line.sub === 'brief');
  const want = hashes ?? lines.at(-1);
  const latest = new Map<string, Run>();
  for (const { gateHash, corpusHash, res } of lines)
    if (gateHash === want?.gateHash && corpusHash === want?.corpusHash && res.got !== 'NULL')
      latest.set(res.id, res);
  return [...latest.values()];
}

function interval(k: number, n: number) {
  const { lo, hi } = wilson(k, n);
  return `${ratio(k, n)} [${Math.round(lo * 100)}-${Math.round(hi * 100)}%]`;
}

export function reportLines(head: Baseline, base: Baseline | null, specs = manifest()): string[] {
  const lines = [
    `head: ${identityOf(head)}`,
    `${'clause cluster'.padEnd(26)}${ARMS.clause.join('  ')}`,
  ];
  for (const cluster of clauseClusters(specs)) {
    const cells = ARMS.clause.map((arm) => ratio(...clusterCell(head, specs, cluster, arm)));
    lines.push(
      `${cluster.padEnd(26)}${cells.map((cell, i) => cell.padEnd(ARMS.clause[i].length + 2)).join('')}`,
    );
  }
  if (!base)
    return [...lines, ...head.metrics.map((m) => `${m.id.padEnd(26)}${interval(m.k, m.n)}`)];
  for (const row of contrast(base, head, specs)) {
    const delta = `Δ ${(row.delta * 100).toFixed(1)} pts`;
    const clusters =
      row.midP === null ? '' : `, clusters +${row.up}/−${row.down}, mid-p ${row.midP.toFixed(3)}`;
    const span = `${interval(row.before.k, row.before.n)} → ${interval(row.after.k, row.after.n)}`;
    lines.push(`${row.id.padEnd(26)}${span}, ${delta}${clusters}: ${row.verdict}`);
  }
  return lines;
}
