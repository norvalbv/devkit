/** Reduces judge output to the pre-registered counts: introduced correctness/reliability golden TPs
 * the matcher covered, by size band and context. Counts only — no text, no paths. */

export const CATCH_CATEGORIES = ['correctness', 'reliability'] as const;

export interface GoldenFinding {
  file: string;
  tp_fp: 'tp' | 'fp';
  category: string;
  scope?: string;
  context_required?: string;
  /** Who wrote the label, e.g. `llm_review:claude-sonnet-4.6`; drives the family split. */
  producer?: string;
}

export interface DetailFinding {
  file: string;
  message: string;
  status: 'matched_tp' | 'matched_fp' | 'novel_tp' | 'novel_fp';
  covered_golden_indices: number[];
}

/** One PR in one run: the adapter's run-summary row joined to the judge's details. */
export interface ScoredPr {
  key: string;
  loc: number;
  files: number;
  withheldNoFile: number;
  withheldFileNoLine: number;
  /** What the grammar without the approximate-line `~` tolerance would have withheld. */
  withheldFileNoLineStrict: number;
  /** Exported findings naming two or more staged files; a same-file matcher credits only one. */
  crossFile: number;
  tasks: number;
  inconclusive: number;
  /** Staged paths the reviewer held in scope; absent => the in-scope partition is not reported. */
  scopePaths?: string[];
  fullyShown?: boolean;
  golden: GoldenFinding[];
  candidates: DetailFinding[];
}

export const lineBand = (loc: number): string =>
  loc < 200 ? '<200' : loc < 1000 ? '200-999' : loc < 3000 ? '1000-2999' : '>=3000';
export const fileBand = (n: number): string =>
  n < 5 ? '<5' : n < 15 ? '5-14' : n < 40 ? '15-39' : '>=40';

interface Label {
  pr: string;
  /** Position in the PR's golden file: the same label across runs. */
  index: number;
  caught: boolean;
  /** Missed, yet a finding located in another file names this label's file: a cross-file claim
   * the benchmark's same-file matcher cannot credit. Reported beside recall, never as a catch. */
  namedElsewhere: boolean;
  strata: string[];
}

const ISSUE_CEILING = 12;
const baseName = (file: string): string => file.slice(file.lastIndexOf('/') + 1);

const familyOf = (g: GoldenFinding): string =>
  /claude/i.test(g.producer ?? '') ? 'claude' : 'non-claude';

const qualifies = (g: GoldenFinding): boolean =>
  g.tp_fp === 'tp' &&
  g.scope === 'introduced-by-pr' &&
  CATCH_CATEGORIES.some((c) => c === g.category);

/** Every qualifying golden on the PR, tagged with the strata it is reported under. */
export function labelsOf(pr: ScoredPr): Label[] {
  const covered = new Set(pr.candidates.flatMap((c) => c.covered_golden_indices));
  const scope = pr.scopePaths ? new Set(pr.scopePaths) : undefined;
  // A PR carrying labels from both families gives a family gap that is not confounded with PR.
  const qualifying = pr.golden.filter(qualifies);
  const mixed = new Set(qualifying.map(familyOf)).size === 2;
  // Whole-diff output is capped at 3 issues per lens, so a PR with more labels cannot be fully caught.
  const load = qualifying.length > ISSUE_CEILING ? '>12' : '<=12';
  return pr.golden.flatMap((g, i) => {
    if (!qualifies(g)) return [];
    const seen = !scope
      ? 'unknown'
      : !scope.has(g.file)
        ? 'not-in-scope'
        : pr.fullyShown
          ? 'shown-in-full'
          : 'cap-omitted-or-truncated';
    const strata = [
      'all',
      `category:${g.category}`,
      `lines:${lineBand(pr.loc)}`,
      `files:${fileBand(pr.files)}`,
      `context:${g.context_required ?? 'untagged'}`,
      `evidence:${seen}`,
      ...(pr.fullyShown === undefined ? [] : [`cap:${pr.fullyShown ? 'within' : 'over'}`]),
      `label-load:${load}`,
      ...(mixed ? ['mixed-family-prs'] : []),
    ];
    // Every number is reported again per label-writer family: only the non-Claude figure is an
    // absolute recall for a Claude reviewer; the gap is the measured self-preference.
    return [
      {
        pr: pr.key,
        index: i,
        caught: covered.has(i),
        namedElsewhere:
          !covered.has(i) &&
          pr.candidates.some((c) => c.file !== g.file && c.message.includes(baseName(g.file))),
        strata: [...strata, ...strata.map((st) => `${st}|family:${familyOf(g)}`)],
      },
    ];
  });
}

/** The equal-cost control for a chunked arm: two whole-diff runs pooled, so a label counts as
 * caught when either run caught it. PRs missing from either run are dropped. */
export function unionRuns(a: ScoredPr[], b: ScoredPr[]): ScoredPr[] {
  const other = new Map(b.map((pr) => [pr.key, pr]));
  return a.flatMap((pr) => {
    const twin = other.get(pr.key);
    return twin ? [{ ...pr, candidates: [...pr.candidates, ...twin.candidates] }] : [];
  });
}

export interface JudgeAgreement {
  both: number;
  onlyFirst: number;
  onlySecond: number;
  neither: number;
}

/** Label-level agreement between two judges on the SAME reviewer run: how often they agree a
 * qualifying label was caught. Measures judge dependence; never a recall. */
export function judgeAgreement(a: ScoredPr[], b: ScoredPr[]): JudgeAgreement {
  const second = new Map(b.flatMap(labelsOf).map((l) => [`${l.pr}#${l.index}`, l.caught]));
  const out: JudgeAgreement = { both: 0, onlyFirst: 0, onlySecond: 0, neither: 0 };
  for (const l of a.flatMap(labelsOf)) {
    const other = second.get(`${l.pr}#${l.index}`);
    if (other === undefined) continue;
    if (l.caught) out[other ? 'both' : 'onlyFirst'] += 1;
    else out[other ? 'onlySecond' : 'neither'] += 1;
  }
  return out;
}

export interface RunCounts {
  recall: Record<string, { caught: number; labels: number }>;
  namedElsewhere: Record<string, number>;
  findings: Record<
    | DetailFinding['status']
    | 'withheldNoFile'
    | 'withheldFileNoLine'
    | 'withheldFileNoLineStrict'
    | 'crossFile'
    | 'exported',
    number
  >;
  inconclusiveRate: number;
  failedOnProtocol: boolean;
}

export function reduceRun(prs: ScoredPr[]): RunCounts {
  const recall: RunCounts['recall'] = {};
  const namedElsewhere: RunCounts['namedElsewhere'] = {};
  for (const l of prs.flatMap(labelsOf))
    for (const s of l.strata) {
      const cell = (recall[s] ??= { caught: 0, labels: 0 });
      cell.labels += 1;
      cell.caught += Number(l.caught);
      namedElsewhere[s] = (namedElsewhere[s] ?? 0) + Number(l.namedElsewhere);
    }
  const findings: RunCounts['findings'] = {
    matched_tp: 0,
    matched_fp: 0,
    novel_tp: 0,
    novel_fp: 0,
    withheldNoFile: 0,
    withheldFileNoLine: 0,
    withheldFileNoLineStrict: 0,
    crossFile: 0,
    exported: 0,
  };
  for (const pr of prs) {
    findings.withheldNoFile += pr.withheldNoFile;
    findings.withheldFileNoLine += pr.withheldFileNoLine;
    findings.withheldFileNoLineStrict += pr.withheldFileNoLineStrict;
    findings.crossFile += pr.crossFile;
    findings.exported += pr.candidates.length;
    for (const c of pr.candidates) findings[c.status] += 1;
  }
  const tasks = prs.reduce((n, p) => n + p.tasks, 0);
  const inconclusiveRate = tasks ? prs.reduce((n, p) => n + p.inconclusive, 0) / tasks : 0;
  return {
    recall,
    namedElsewhere,
    findings,
    inconclusiveRate,
    failedOnProtocol: inconclusiveRate > 0.1,
  };
}

/** Deterministic PRNG so a re-run of the report reproduces the same interval. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapUnit {
  cluster: string;
  /** Which repeat the unit came from; set it to have runs resampled along with clusters. */
  run?: number;
  hits: number;
  n: number;
}

/** The labels of one stratum across runs, one unit per label per run, clustered by PR. */
export function stratumUnits(runs: ScoredPr[][], stratum: string): BootstrapUnit[] {
  return runs.flatMap((prs, run) =>
    prs
      .flatMap(labelsOf)
      .filter((l) => l.strata.includes(stratum))
      .map((l) => ({ cluster: l.pr, run, hits: Number(l.caught), n: 1 })),
  );
}

/** Share of a stratum's labels whose caught/missed outcome differs between the first two runs,
 * over the labels both runs scored. This is the test-retest floor every delta is read against. */
export function flipRate(
  runs: ScoredPr[][],
  stratum: string,
): { flipped: number; labels: number } | null {
  if (runs.length < 2) return null;
  const outcome = (prs: ScoredPr[]): Map<string, boolean> =>
    new Map(
      prs
        .flatMap(labelsOf)
        .filter((l) => l.strata.includes(stratum))
        .map((l) => [`${l.pr}#${l.index}`, l.caught]),
    );
  const [a, b] = [outcome(runs[0]), outcome(runs[1])];
  const shared = [...a.keys()].filter((k) => b.has(k));
  return { flipped: shared.filter((k) => a.get(k) !== b.get(k)).length, labels: shared.length };
}

/** Clustered bootstrap 95% CI of pooled hits/n. Clusters are resampled with replacement and every
 * unit in a drawn cluster comes along; when units carry `run`, runs are resampled first. */
export function clusterBootstrap(
  units: BootstrapUnit[],
  { iters = 2000, seed = 1 }: { iters?: number; seed?: number } = {},
): { lo: number; hi: number } | null {
  const runIds = [...new Set(units.map((u) => u.run ?? 0))];
  const byCluster = new Map<string, Map<number, { hits: number; n: number }>>();
  for (const u of units) {
    const perRun = byCluster.get(u.cluster) ?? new Map<number, { hits: number; n: number }>();
    const cell = perRun.get(u.run ?? 0) ?? { hits: 0, n: 0 };
    cell.hits += u.hits;
    cell.n += u.n;
    perRun.set(u.run ?? 0, cell);
    byCluster.set(u.cluster, perRun);
  }
  const clusters = [...byCluster.values()];
  if (clusters.length === 0) return null;
  const rand = mulberry32(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const draws: number[] = [];
  for (let i = 0; i < iters; i++) {
    const drawnRuns = runIds.map(() => pick(runIds));
    let hits = 0;
    let n = 0;
    for (let j = 0; j < clusters.length; j++) {
      const perRun = pick(clusters);
      for (const run of drawnRuns) {
        hits += perRun.get(run)?.hits ?? 0;
        n += perRun.get(run)?.n ?? 0;
      }
    }
    draws.push(n ? hits / n : 0);
  }
  draws.sort((a, b) => a - b);
  return { lo: draws[Math.floor(0.025 * iters)], hi: draws[Math.ceil(0.975 * iters) - 1] };
}
