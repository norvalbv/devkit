/** Pure AACR-Bench boundary: Code Defect references in, lens issues out, recall per context level. */
import { extractRanges, resolveToStaged } from '../../scale/labels.mts';
import { type CheckpointRow, isTerminal } from '../../scale/lens-run.mts';

export interface AacrComment {
  note: string;
  path: string;
  side: string | null;
  from_line: number | null;
  to_line: number | null;
  category: string;
  context: string;
  source_model: string;
}
export interface AacrSample {
  project_main_language: string;
  source_commit: string;
  target_commit: string;
  githubPrUrl: string;
  change_line_count: number;
  comments: AacrComment[];
}
export interface AacrRef {
  path: string;
  text: string;
  start_line: number | null;
  end_line: number | null;
  side: string | null;
  level: string;
  /** Who wrote the label: the audit's self-preference split. */
  family: 'claude' | 'other';
}
export interface AacrInstance {
  instanceId: string;
  repo: string;
  prUrl: string;
  base: string;
  head: string;
  changeLines: number;
  refs: AacrRef[];
  /** Left-side references: the upstream judge hardcodes generated findings to the right side, so
   * these can never match and leave the denominator (counted). */
  excludedLeft: number;
}

const PR_RE = /github\.com\/([^/]+\/[^/]+)\/pull\/\d+/;

/** Upstream converter's id: owner__name@<target_commit[:7]>, so results land where it looks. */
/** A scoring dir is reusable only if the evaluator exited in LLM mode after writing every round. */
export function evaluatorFinished(log: string | null, roundFiles: number, rounds: number): boolean {
  return log !== null && log.includes('LLM') && !log.includes('Mock') && roundFiles >= rounds;
}

export function aacrInstanceId(repo: string, head: string): string {
  return `${repo.replace('/', '__')}@${head.slice(0, 7)}`;
}

export function selectAacr(
  samples: readonly AacrSample[],
  o: { languages: ReadonlySet<string>; category: string },
): AacrInstance[] {
  const out: AacrInstance[] = [];
  for (const s of samples) {
    if (!o.languages.has(s.project_main_language)) continue;
    const repo = s.githubPrUrl.match(PR_RE)?.[1];
    if (!repo) continue;
    const wanted = s.comments.filter((c) => c.category === o.category && c.path && c.note.trim());
    if (wanted.length === 0) continue;
    const right = wanted.filter((c) => c.side !== 'left');
    out.push({
      instanceId: aacrInstanceId(repo, s.target_commit),
      repo,
      prUrl: s.githubPrUrl,
      base: s.source_commit,
      head: s.target_commit,
      changeLines: s.change_line_count,
      refs: right.map((c) => ({
        path: c.path,
        text: c.note.trim(),
        start_line: c.from_line,
        end_line: c.to_line,
        side: c.side,
        level: c.context,
        family: /claude/i.test(c.source_model) ? 'claude' : 'other',
      })),
      excludedLeft: wanted.length - right.length,
    });
  }
  return out;
}

/** The upstream evaluator's ReviewInstance JSONL; reference order is preserved so its per-reference
 * verdicts map back to `refs[i].level`. */
export function toStandardJsonl(instances: readonly AacrInstance[]): string {
  return instances
    .map((i) =>
      JSON.stringify({
        instance_id: i.instanceId,
        repo: i.repo,
        base_commit: i.base,
        head_commit: i.head,
        reference_comments: i.refs.map(({ level: _level, family: _family, ...r }) => r),
      }),
    )
    .join('\n')
    .concat('\n');
}

export interface AacrFinding {
  file: string;
  start_line: number;
  end_line: number;
  summary: string;
  description: string;
}

/** One result file in upstream's "codex" shape (keeps `file:a-b` ranges). Unlocated findings are
 * withheld (upstream matches them to every reference); no finished task returns undefined. */
export function exportAacrResult(
  rows: readonly CheckpointRow[],
  staged: readonly string[],
): { review_output: AacrFinding[]; withheld: number; multiFile: number } | undefined {
  const terminal = rows.filter(isTerminal);
  if (terminal.length === 0) return undefined;
  const review_output: AacrFinding[] = [];
  let withheld = 0;
  let multiFile = 0;
  for (const issue of terminal.flatMap((r) => r.issues)) {
    const locs = extractRanges(issue.text).map((l) => ({
      ...l,
      file: resolveToStaged(l.file, staged),
    }));
    if (new Set(locs.map((l) => l.file).filter(Boolean)).size >= 2) multiFile++;
    const loc = locs.find((l) => l.file !== undefined && l.line !== null);
    if (!loc?.file || loc.line === null || loc.endLine === null) {
      withheld++;
      continue;
    }
    review_output.push({
      file: loc.file,
      start_line: loc.line,
      end_line: loc.endLine,
      summary: `[${issue.lens}] ${issue.text}`,
      description: '',
    });
  }
  return { review_output, withheld, multiFile };
}

export interface RefVerdict {
  /** `<instanceId>#<reference index>`: aligns one reference across runs and rounds. */
  key: string;
  /** The key of the first reference on the same PR with the same text: duplicates share it. */
  dupKey: string;
  instanceId: string;
  path: string;
  repo: string;
  level: string;
  family: 'claude' | 'other';
  caught: boolean;
  lineOnly: boolean;
}
interface EvaluatedRef {
  semantic_match: boolean;
  line_match: boolean;
}

/** One verdict per reference from the upstream metrics' `eval_res`, for clustered resampling.
 * Instances the evaluator reported missing are absent from eval_res and yield nothing. */
export function refVerdicts(
  evalRes: ReadonlyArray<{
    instance_id: string;
    comments: readonly EvaluatedRef[];
  }>,
  instances: readonly AacrInstance[],
): RefVerdict[] {
  const byId = new Map(instances.map((i) => [i.instanceId, i]));
  return evalRes.flatMap((r) => {
    const inst = byId.get(r.instance_id);
    if (!inst || inst.refs.length !== r.comments.length)
      throw new Error(`${r.instance_id}: evaluator references do not align with the selection`);
    return r.comments.map((c, i) => ({
      key: `${inst.instanceId}#${i}`,
      dupKey: `${inst.instanceId}#${inst.refs.findIndex((x) => x.text === inst.refs[i].text)}`,
      instanceId: inst.instanceId,
      path: inst.refs[i].path,
      repo: inst.repo,
      level: inst.refs[i].level,
      family: inst.refs[i].family,
      caught: c.semantic_match,
      lineOnly: !c.semantic_match && c.line_match,
    }));
  });
}

export interface CellStat {
  refs: number;
  /** Caught references per (run, round) cell, in run then round order. */
  caught: number[];
  lineOnly: number[];
  /** Distinct reference texts per PR, and per cell how many had any duplicate caught. */
  distinct: number;
  distinctCaught: number[];
  /** References whose majority-of-rounds outcome differs between the first two runs. */
  flipped: number | null;
}

const majority = (rounds: readonly RefVerdict[][], i: number): boolean =>
  rounds.filter((r) => r[i].caught).length * 2 > rounds.length;

/** Counts for one stratum. `runs[run][round]` are aligned verdict lists from refVerdicts. */
export function cellStat(
  runs: ReadonlyArray<ReadonlyArray<RefVerdict[]>>,
  keep: (v: RefVerdict) => boolean,
): CellStat {
  const idx = runs[0][0].flatMap((v, i) => (keep(v) ? [i] : []));
  const count = (pick: (v: RefVerdict) => boolean): number[] =>
    runs.flatMap((rounds) => rounds.map((r) => idx.filter((i) => pick(r[i])).length));
  const dups = (pick: (v: RefVerdict) => boolean): number[] =>
    runs.flatMap((rounds) =>
      rounds.map((r) => new Set(idx.filter((i) => pick(r[i])).map((i) => r[i].dupKey)).size),
    );
  return {
    refs: idx.length,
    caught: count((v) => v.caught),
    lineOnly: count((v) => v.lineOnly),
    distinct: dups(() => true)[0],
    distinctCaught: dups((v) => v.caught),
    flipped:
      runs.length < 2
        ? null
        : idx.filter((i) => majority(runs[0], i) !== majority(runs[1], i)).length,
  };
}
