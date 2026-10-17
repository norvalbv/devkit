/** The shadow readout: each PR's first printed merge verdict set against what then happened to the
 * PR. Pure: the gh reads live in readout-cli.mts. */
import { TEST_PATH } from '../../../../../gate-engine/coverage/gate-shared.mts';
import { wilsonScoreInterval } from '../../../../../gate-engine/eval/statistics.mts';
import { readEvidenceBlock } from '../../evidence/block.mts';
import { VERDICT_REASONS, type Verdict } from '../verdict.mts';

/** CI at one sha. A superseded run is cancelled, never red, though it still posts a red `required`. */
export type Ci = 'green' | 'red' | 'cancelled' | 'absent';

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  completed_at: string | null;
}

export interface VerdictPull {
  number: number;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  title: string;
  headRefName: string;
  /** The PR's final head: the merged head once merged. */
  headRefOid: string;
  mergedAt: string | null;
  mergeOid: string | null;
  files: string[];
  /** Every body the PR has had, oldest first. */
  bodies: string[];
}

export interface MergedPull {
  number: number;
  title: string;
  body: string;
  mergedAt: string;
  files: string[];
}

export interface FirstVerdict {
  verdict: Verdict;
  reasons: string[];
  headSha: string;
  status: string;
}

export interface FollowUp {
  pull: number;
  title: string;
  context: string;
}

export interface Row {
  pull: number;
  first: FirstVerdict;
  outcome: 'open' | 'merged' | 'closed';
  headMoved: boolean;
  /** Merged less than the follow-up window ago, so a revert or fix may still come. */
  windowOpen: boolean;
  ci: Ci;
  reverted: boolean;
  followUps: FollowUp[];
}

export interface Readout {
  rows: Row[];
  noVerdict: number[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const FIX_TYPE = /^fix(?:\([^)]*\))?!?:/i;
const BRANCH_STORY = /(?:^|\/)sc-(\d+)(?:\/|-|$)/i;
const CONTEXT_CHARS = 60;
const CLASSES: Verdict[] = ['auto-merge-eligible', 'human-review', 'policy'];

/** The verdict an auto-merge would have acted on: the earliest body that carried one. */
export function firstVerdict(bodies: string[]): FirstVerdict | undefined {
  for (const body of bodies) {
    const outcome = readEvidenceBlock(body, '');
    const verdict = CLASSES.find((name) => name === outcome?.mergeVerdict?.verdict);
    if (!outcome?.mergeVerdict || !verdict) continue;
    return {
      verdict,
      reasons: outcome.mergeVerdict.reasons.map((reason) => reason.code),
      headSha: outcome.headSha,
      status: outcome.status,
    };
  }
  return undefined;
}

const latestConclusion = (runs: CheckRun[], name: string): string | null | undefined =>
  runs
    .filter((run) => run.name === name && run.status === 'completed')
    .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''))[0]?.conclusion;

/** CI from devkit's aggregate `required` check and the `gate` job it needs, nothing else. */
export function ciAt(runs: CheckRun[]): Ci {
  const gate = latestConclusion(runs, 'gate');
  if (gate === 'cancelled') return 'cancelled';
  const required = latestConclusion(runs, 'required');
  if (required === 'success') return 'green';
  return required === 'failure' || gate === 'failure' || gate === 'timed_out' ? 'red' : 'absent';
}

// `#N` not inside a word, a path or an HTML entity, or the story id named by the PR's branch.
function citation(pull: VerdictPull, text: string): string | undefined {
  const story = BRANCH_STORY.exec(pull.headRefName)?.[1];
  const patterns = [
    `(?<![\\w/&])#${pull.number}(?!\\d)`,
    ...(story ? [`\\bsc-${story}(?!\\d)`] : []),
  ];
  for (const pattern of patterns) {
    const match = new RegExp(pattern, 'i').exec(text);
    if (!match) continue;
    const start = Math.max(0, match.index - CONTEXT_CHARS);
    return text.slice(start, match.index + match[0].length + CONTEXT_CHARS).replace(/\s+/g, ' ');
  }
  return undefined;
}

const sourceFiles = (files: string[]): Set<string> =>
  new Set(files.filter((file) => !TEST_PATH.test(file)));

function inWindow(pull: VerdictPull, later: MergedPull, days: number): boolean {
  if (!pull.mergedAt || later.number === pull.number) return false;
  const gap = Date.parse(later.mergedAt) - Date.parse(pull.mergedAt);
  return gap > 0 && gap <= days * DAY_MS;
}

const REVERTS_LINE = /\bReverts ([\w.-]+\/[\w.-]+)#(\d+)\b/g;

/** GitHub's revert button writes both the title and the `Reverts owner/repo#N` line. */
function reverts(pull: VerdictPull, later: MergedPull, repo: string): boolean {
  return (
    later.title === `Revert "${pull.title}"` ||
    [...later.body.matchAll(REVERTS_LINE)].some(
      ([, named, n]) => named === repo && Number(n) === pull.number,
    ) ||
    (pull.mergeOid !== null && later.body.includes(`This reverts commit ${pull.mergeOid}`))
  );
}

/** A later fix that cites the PR and touches one of its source files: a candidate, never a verdict. */
function followUp(pull: VerdictPull, later: MergedPull): FollowUp | undefined {
  if (!FIX_TYPE.test(later.title)) return undefined;
  const own = sourceFiles(pull.files);
  if (!later.files.some((file) => own.has(file))) return undefined;
  const context = citation(pull, `${later.title}\n${later.body}`);
  return context ? { pull: later.number, title: later.title, context } : undefined;
}

export function scorePulls(
  pulls: VerdictPull[],
  merged: MergedPull[],
  ciFor: (sha: string) => Ci,
  repo: string,
  days: number,
  now: number,
): Readout {
  const rows: Row[] = [];
  const noVerdict: number[] = [];
  for (const pull of pulls) {
    const first = firstVerdict(pull.bodies);
    if (!first) {
      noVerdict.push(pull.number);
      continue;
    }
    const outcome = pull.state === 'OPEN' ? 'open' : pull.state === 'MERGED' ? 'merged' : 'closed';
    const later = merged.filter((candidate) => inWindow(pull, candidate, days));
    rows.push({
      pull: pull.number,
      first,
      outcome,
      headMoved: pull.headRefOid !== first.headSha,
      windowOpen: pull.mergedAt !== null && now - Date.parse(pull.mergedAt) < days * DAY_MS,
      ci: outcome === 'open' ? 'absent' : ciFor(first.headSha),
      reverted: later.some((candidate) => reverts(pull, candidate, repo)),
      followUps: later.flatMap((candidate) => followUp(pull, candidate) ?? []),
    });
  }
  return { rows, noVerdict };
}

/** Anything that says merging at the verdict's head was wrong; unlabelled candidates and a cancelled run do not. */
const problem = (row: Row): boolean =>
  row.outcome === 'closed' || row.headMoved || row.ci === 'red' || row.reverted;

const pct = (value: number): string => `${Math.round(value * 100)}%`;

function rate(k: number, n: number): string {
  if (!n) return 'n/a';
  const { lower, upper } = wilsonScoreInterval(k, n);
  return `${k}/${n} = ${pct(k / n)} [${pct(lower)}, ${pct(upper)}]`;
}

function line(label: string, rows: Row[]): string {
  const decided = rows.filter((row) => row.outcome !== 'open');
  const count = (test: (row: Row) => boolean) => decided.filter(test).length;
  const cells = [
    label,
    decided.length,
    rows.length - decided.length,
    count((row) => row.outcome === 'merged' && !row.headMoved),
    count((row) => row.headMoved),
    count((row) => row.outcome === 'closed'),
    count((row) => row.ci === 'red'),
    count((row) => row.ci === 'cancelled'),
    count((row) => row.reverted),
    count((row) => row.followUps.length > 0),
    rate(count(problem), decided.length),
  ];
  return `| ${cells.join(' | ')} |`;
}

function table(title: string, groups: [string, Row[]][]): string[] {
  return [
    `| ${title} | decided | open | merged unchanged | head moved | closed | CI red | CI cancelled | revert | follow-up candidates | problem, candidates excluded (95% CI) |`,
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...groups.filter(([, rows]) => rows.length).map(([label, rows]) => line(label, rows)),
    '',
  ];
}

export function renderReadout({ rows, noVerdict }: Readout): string {
  const codes = Object.keys(VERDICT_REASONS);
  const status = new Map<string, number>();
  for (const row of rows) status.set(row.first.status, (status.get(row.first.status) ?? 0) + 1);
  const candidates = rows.flatMap((row) =>
    row.followUps.map((next) => `- #${row.pull} → #${next.pull} ${next.title}: …${next.context}…`),
  );
  const open = rows.filter((row) => row.windowOpen).length;
  const window = open
    ? [
        `${open} merged PR${open === 1 ? ' is' : 's are'} still inside ${open === 1 ? 'its' : 'their'} follow-up window, so revert and follow-up counts can still grow.`,
      ]
    : [];
  return [
    `Scored at each PR's first printed verdict: ${rows.length} PRs; ${noVerdict.length} carry no verdict.`,
    `Evidence status at that verdict: ${[...status].map(([name, n]) => `${name} ${n}`).join(', ')}.`,
    ...window,
    '',
    ...table(
      'verdict',
      CLASSES.map((name) => [name, rows.filter((row) => row.first.verdict === name)]),
    ),
    ...table(
      'deciding reason',
      codes.map((code) => [code, rows.filter((row) => row.first.reasons[0] === code)]),
    ),
    ...table(
      'fired reason',
      codes.map((code) => [code, rows.filter((row) => row.first.reasons.includes(code))]),
    ),
    '#### Follow-up candidates',
    ...(candidates.length ? candidates : ['none']),
    '',
  ].join('\n');
}
