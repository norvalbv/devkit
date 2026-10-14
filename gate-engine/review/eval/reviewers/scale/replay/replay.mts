#!/usr/bin/env node
/** Re-judge one archived ship diff with ONE reviewer, optionally A/B against an edited `--brief`.
 * Bench-only: runs the cascade directly, so no review cache or telemetry sink is touched. */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { resolveGuardConfig, type GuardConfig } from '../../../../../config.mts';
import { reviewAgentsDir, reviewBriefPath } from '../../../../cascade/consumer-assets.mts';
import { runCascade } from '../../../../cascade/reviewer.mts';
import { execJudgeAsync } from '../../../../../judge/run-judge.mts';
import { parseReviewVerdict } from '../../../../contracts/response.mts';
import { loadReviewerContext } from '../../../../evidence/commit-message.mts';
import { stagedFiles } from '../../../../evidence/staged-git.mts';
import { gateJudgeEnv, withStagedFiles, type ReviewOutcome } from '../../../../runtime.mts';
import type { PromptExtras, ReviewerSelection } from '../../../../reviewers.mts';
import { selectRepositoryReviewers } from '../../../../scope/repository.mts';
import { makeSpyExec } from '../../corpus/row.mts';
import { arg, argInt, argOr, silenceBenchTelemetry } from '../bench-args.mts';
import { materialize, researchOutputDirectory } from '../materialize.mts';
import { resolveReplayInput, type ReplayInput } from './resolve.mts';

export interface ReplayOpts {
  ref: string;
  reviewer: string;
  repo: string;
  base?: string;
  brief?: string;
  runs: number;
  dryRun?: boolean;
  sink?: string;
  log?: (line: string) => void;
}

interface FailedItem {
  id: string;
  issues: string[];
}

export interface ReplayPass {
  label: 'first' | 'retry' | 'escalate';
  model: string | null;
  verdict: string | null;
  ms: number;
  failed: FailedItem[];
}

export interface ReplayRun {
  arm: 'control' | 'treatment';
  briefSha: string;
  status: ReviewOutcome['status'];
  escalated: boolean;
  secs: number;
  passes: ReplayPass[];
  degraded: string | null;
}

interface SpyCapture {
  label: string;
  out?: string;
  ms: number;
  snapshot: unknown;
  model?: string | null;
}

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

const checklistRow = z.object({
  path: z.string().optional(),
  name: z.string().optional(),
  status: z.string(),
  issues: z.array(z.string()).default([]),
});
/** commit-guard keys its checklist rows by `files[].path`, the domain reviewers by `items[].name`. */
const checklistSnapshot = z.object({
  files: z.array(checklistRow).default([]),
  items: z.array(checklistRow).default([]),
});

export function failedItems(snapshot: z.infer<typeof checklistSnapshot>): FailedItem[] {
  return [...snapshot.files, ...snapshot.items]
    .filter((row) => row.status === 'fail')
    .map((row) => ({ id: row.path ?? row.name ?? '?', issues: row.issues }));
}

function toPasses(capture: SpyCapture[]): ReplayPass[] {
  let firstSeen = false;
  return capture.map((entry) => {
    const escalate = entry.label.endsWith(':escalate');
    const label = escalate ? 'escalate' : firstSeen ? 'retry' : 'first';
    if (!escalate) firstSeen = true;
    return {
      label,
      model: entry.model ?? null,
      verdict: parseReviewVerdict(entry.out ?? '').verdict,
      ms: entry.ms,
      failed: failedItems(
        checklistSnapshot.safeParse(entry.snapshot).data ?? { files: [], items: [] },
      ),
    };
  });
}

/** Write the arm's brief bytes (null = absent) where the resolver reads it; return the sha it resolves. */
function projectBrief(wt: string, cfg: GuardConfig, name: string, bytes: Buffer | null): string {
  const slot = path.join(reviewAgentsDir(wt, cfg), `${name}.md`);
  if (bytes === null) rmSync(slot, { force: true });
  else {
    mkdirSync(path.dirname(slot), { recursive: true });
    writeFileSync(slot, bytes);
  }
  return sha256(readFileSync(reviewBriefPath(wt, cfg, name)));
}

function removeWorktree(repo: string, ctx: string, wt: string | undefined): void {
  if (wt)
    try {
      execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: repo, stdio: 'ignore' });
    } catch {
      // already gone — the prune below clears a stale registration
    }
  rmSync(ctx, { recursive: true, force: true });
  execFileSync('git', ['worktree', 'prune'], { cwd: repo, stdio: 'ignore' });
}

function summarize(runs: ReplayRun[], arm: ReplayRun['arm']): string {
  const own = runs.filter((r) => r.arm === arm);
  const counts = new Map<string, number>();
  for (const r of own) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const tally = [...counts].map(([status, n]) => `${status} ${n}/${own.length}`).join(', ');
  return `${arm} brief ${own[0].briefSha.slice(0, 12)}: ${tally}`;
}

export interface ReplayDeps {
  executeCascade?: typeof runCascade;
  judge?: typeof execJudgeAsync;
}

interface ReplayTarget {
  wt: string;
  cfg: GuardConfig;
  sel: ReviewerSelection;
  promptExtras: PromptExtras;
  control: Buffer | null;
}

/** The reviewer selection, prompt context and control-brief bytes of the materialized worktree. */
async function loadTarget(wt: string, reviewer: string): Promise<ReplayTarget> {
  const cfg = resolveGuardConfig(wt);
  const staged = stagedFiles(wt);
  const sel = selectRepositoryReviewers(staged, cfg).find((s) => s.reviewer.name === reviewer);
  if (!sel || sel.files.length === 0)
    throw new Error(`replay: ${reviewer} is not selected for this diff under the repo's config`);
  const { promptExtras } = await loadReviewerContext(wt, staged);
  const controlPath = path.join(reviewAgentsDir(wt, cfg), `${reviewer}.md`);
  const control = existsSync(controlPath) ? readFileSync(controlPath) : null;
  return { wt, cfg, sel, promptExtras, control };
}

async function judgeOnce(
  t: ReplayTarget,
  arm: ReplayRun['arm'],
  briefSha: string,
  { executeCascade, judge }: Required<ReplayDeps>,
): Promise<{ run: ReplayRun; result: ReviewOutcome; raw: SpyCapture[] }> {
  const raw: SpyCapture[] = [];
  const started = Date.now();
  const result = await executeCascade(t.sel, {
    cwd: t.wt,
    cfg: t.cfg,
    exec: makeSpyExec(raw, { reviewer: t.sel.reviewer, cascade: true, delegate: judge }),
    judgeEnv: withStagedFiles(gateJudgeEnv(false, t.cfg), t.sel.reviewer, t.sel.files),
    promptExtras: t.promptExtras,
    recovery: 'final',
    fullItems: true,
  });
  const run: ReplayRun = {
    arm,
    briefSha,
    status: result.status,
    escalated: result.escalated,
    secs: Math.round((Date.now() - started) / 1000),
    passes: toPasses(raw),
    degraded: result.degraded?.cause ?? result.mcpDegraded?.cause ?? null,
  };
  return { run, result, raw };
}

function logRun(log: (line: string) => void, index: number, run: ReplayRun): void {
  const escalated = run.escalated ? ' (escalated)' : '';
  const degraded = run.degraded ? ` · degraded: ${run.degraded}` : '';
  log(
    `run ${index} ${run.arm} brief ${run.briefSha.slice(0, 12)} → ${run.status}${escalated} ${run.secs}s${degraded}`,
  );
  for (const pass of run.passes) {
    log(
      `  ${pass.label} ${pass.model ?? '?'} ${pass.verdict ?? 'no verdict'} ${Math.round(pass.ms / 1000)}s`,
    );
    for (const item of pass.failed) log(`    ✗ ${item.id}: ${item.issues.join(' | ')}`);
  }
}

function logFooter(
  log: (line: string) => void,
  input: ReplayInput,
  reviewer: string,
  runs: ReplayRun[],
): void {
  const original = input.original;
  if (original)
    log(
      `original run: ${original.status} by ${original.model ?? '?'} items ${JSON.stringify(original.itemTally ?? {})} prompt ${input.promptIdentity?.slice(0, 12) ?? '?'}`,
    );
  if (new Set(runs.map((r) => r.degraded)).size > 1)
    log('warning: retrieval degradation differs across runs — the arms are not comparable on it');
  const arms = [...new Set(runs.map((r) => r.arm))];
  log(
    `summary: replay ${input.diffSha.slice(0, 12)} ${reviewer} · ${arms.map((a) => summarize(runs, a)).join(' · ')}`,
  );
}

export async function runReplay(
  o: ReplayOpts,
  { executeCascade = runCascade, judge = execJudgeAsync }: ReplayDeps = {},
): Promise<{ runs: ReplayRun[]; outDir: string }> {
  const log = o.log ?? ((line: string) => console.log(line));
  if (o.reviewer === 'correctness-reviewer')
    throw new Error(
      'replay: correctness-reviewer is lens-split in production — use scale/scale-bench.mts',
    );
  silenceBenchTelemetry(process.env);
  for (const key of Object.keys(process.env))
    if (key.startsWith('OVERRIDE_')) delete process.env[key];
  const briefBytes = o.brief === undefined ? null : readFileSync(o.brief);
  const input = await resolveReplayInput(o);
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const root = path.join(os.homedir(), '.devkit', 'research', 'replay', stamp);
  const ctx = researchOutputDirectory(path.join(root, 'ctx'));
  const outDir = researchOutputDirectory(path.join(root, 'out'));
  let wt: string | undefined;
  // `finally` never runs on process.exit or SIGINT; the exit hook still removes the full checkout.
  const cleanup = (): void => removeWorktree(o.repo, ctx, wt);
  process.once('exit', cleanup);
  try {
    const materialized = materialize({
      repo: o.repo,
      branch: input.base,
      diffSha: input.diffSha,
      attemptTs: input.ts,
      diffText: input.diffText,
      researchRoot: ctx,
    });
    wt = materialized.wt;
    if (materialized.base !== input.base)
      throw new Error(
        `replay: diff does not apply at recorded base ${input.base.slice(0, 12)} — pass --base <sha>`,
      );
    const target = await loadTarget(wt, o.reviewer);
    const arms = briefBytes ? (['control', 'treatment'] as const) : (['control'] as const);
    const briefFor = (arm: ReplayRun['arm']) => (arm === 'control' ? target.control : briefBytes);
    log(
      `replay ${input.diffSha.slice(0, 12)} base ${input.base.slice(0, 12)} ${o.reviewer}: ${target.sel.files.length} file(s)`,
    );
    log('note: the commit message is not archived, so the replay prompt carries none');
    log(
      `plan: ${o.runs}×${arms.length} cascade(s), up to ${o.runs * arms.length * 2} judge calls (+1 per contract retry)`,
    );
    if (o.dryRun) {
      for (const arm of arms)
        log(
          `  ${arm} brief ${projectBrief(wt, target.cfg, o.reviewer, briefFor(arm)).slice(0, 12)}`,
        );
      return { runs: [], outDir };
    }
    const wantedSha = briefBytes && sha256(briefBytes);
    const runs: ReplayRun[] = [];
    for (let i = 0; i < o.runs; i += 1)
      for (const arm of arms) {
        const briefSha = projectBrief(wt, target.cfg, o.reviewer, briefFor(arm));
        if (arm === 'treatment' && briefSha !== wantedSha)
          throw new Error(
            'replay: the judge would not read the --brief file (resolver picked another)',
          );
        const judged = await judgeOnce(target, arm, briefSha, { executeCascade, judge });
        runs.push(judged.run);
        writeFileSync(
          path.join(outDir, `run-${i + 1}-${arm}.json`),
          JSON.stringify({ ...judged.run, result: judged.result, raw: judged.raw }, null, 2),
          { mode: 0o600, flag: 'wx' },
        );
        logRun(log, i + 1, judged.run);
      }
    logFooter(log, input, o.reviewer, runs);
    log(`raw output: ${outDir}`);
    return { runs, outDir };
  } finally {
    process.removeListener('exit', cleanup);
    cleanup();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ref = process.argv[2];
  const reviewer = arg('reviewer');
  if (!ref || ref.startsWith('--') || !reviewer) {
    console.error(
      'usage: replay.mts <diff-sha256|ship-id> --reviewer <name> [--brief <file>] [--runs N] [--base <sha>] [--repo <path>] [--dry-run]',
    );
    process.exit(2);
  }
  process.once('SIGINT', () => process.exit(130));
  try {
    await runReplay({
      ref,
      reviewer,
      repo: path.resolve(argOr('repo', process.cwd())),
      base: arg('base'),
      brief: arg('brief'),
      runs: argInt('runs', 1),
      dryRun: process.argv.includes('--dry-run'),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
