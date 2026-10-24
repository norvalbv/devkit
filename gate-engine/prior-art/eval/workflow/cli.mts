// prior-art workflow tier — `node bench.mts workflow <coverage | --dev | --baseline>`. Snapshots
// are verified and the plan printed before anything is spent; no session spawns without --yes.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { BenchAbort } from '../../../decisions/eval/bench.mts';
import type { AgentSource } from '../../../review/reviewers.mts';
import { mapPool, projectResponse, runMatcher } from '../matcher.mts';
import { loadAgent } from '../run-agent.mts';
import { loadFamilies, type Member, type Snapshot } from './families.mts';
import {
  claudeVersion,
  executionId,
  runnerClosureHash,
  scorerHash,
  userInstructionsHash,
} from './identity.mts';
import {
  type MaterializeOptions,
  materializeWorkspace,
  snapshotDir,
  snapshotFile,
} from './materialize.mts';
import {
  buildArgs,
  buildDirective,
  CONDITIONS,
  initFault,
  type Condition,
  type RunSessionOptions,
  runSession,
  SESSION_BUDGET_USD,
} from './run.mts';
import { type ReadFile, scoreRun } from './score.mts';
import {
  aggregateCase,
  type CaseResult,
  type CaseRows,
  type ScoredRun,
  summarise,
  type WorkflowResults,
} from './summary.mts';
import { parseTrace } from './trace.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const checkpointPath = path.join(here, '..', 'workflow-checkpoint.jsonl');
const resultsPath = path.join(here, 'results.json');

const envInt = (name: string, fallback: number) =>
  Math.max(1, Number.parseInt(process.env[name] ?? '', 10) || fallback);

const bankEntrySchema = z.strictObject({
  executionId: z.string(),
  member: z.string(),
  condition: z.enum(['search', 'supplied']),
  run: z.number().int(),
  wsRoot: z.string(),
  stream: z.string(),
});
type BankEntry = z.infer<typeof bankEntrySchema>;

export interface WorkflowDeps {
  spawnFn?: RunSessionOptions['spawnFn'];
  matcher?: typeof runMatcher;
  materialize?: MaterializeOptions;
  version?: () => string;
  log?: (line: string) => void;
  /** Test seams: a fixture corpus and a scratch bank instead of the committed ones. */
  families?: Member[];
  checkpoint?: string;
  results?: string;
}

interface WorkItem {
  member: Member;
  condition: Condition;
  run: number;
}

/** Everything one paid pass needs, resolved once. */
interface RunContext {
  deps: WorkflowDeps;
  log: (line: string) => void;
  agent: AgentSource;
  identity: { version: string; userInstructions: string; runnerClosure: string };
  read: ReadFile;
  bank: Map<string, BankEntry>;
  checkpoint: string;
  /** `<member>/<condition>#<run>` → the stream that answered it, banked or fresh. */
  answered: Map<string, BankEntry>;
  outages: Map<string, number>;
}

const USAGE =
  'usage: node bench.mts workflow <coverage | --dev | --baseline> [--only <id[,id…]>] [--yes]\n' +
  '  coverage    lint the families and print the session plan (no LLM calls, no network)\n' +
  '  --dev       materialise + verify snapshots, print the plan; with --yes, run and score\n' +
  '  --baseline  as --dev, then write workflow/results.json';

export function workflowPlan(members: Member[], runs: number): string {
  const families = new Set(members.map((member) => member.caseId)).size;
  const sessions = members.length * CONDITIONS.length * runs;
  return (
    `prior-art workflow: ${families} families · ${members.length} tasks · ${CONDITIONS.length} ` +
    `conditions · K=${runs} → ${sessions} sessions · cap $${SESSION_BUDGET_USD}/session ` +
    `(worst case $${sessions * SESSION_BUDGET_USD})`
  );
}

function selectMembers(members: Member[], only: string | undefined): Member[] {
  if (only === undefined) return members;
  const ids = only
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const unknown = ids.filter((id) => !members.some((member) => member.id === id));
  if (!ids.length || unknown.length)
    throw new BenchAbort(2, `prior-art workflow: unknown or empty --only: ${unknown.join(',')}`);
  return members.filter((member) => ids.includes(member.id));
}

function readBank(file: string): Map<string, BankEntry> {
  const bank = new Map<string, BankEntry>();
  if (process.env.BENCH_NO_RESUME === '1' || !existsSync(file)) return bank;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = bankEntrySchema.safeParse(JSON.parse(line));
      if (entry.success) bank.set(`${entry.data.executionId}#${entry.data.run}`, entry.data);
    } catch {
      // A torn tail line from a killed run is expected; skip it.
    }
  }
  return bank;
}

function uniqueSnapshots(members: Member[]): Snapshot[] {
  const all = members.flatMap((member) => [
    ...(member.consumer ? [member.consumer] : []),
    ...member.refs,
  ]);
  return [...new Map(all.map((snapshot) => [snapshot.tree, snapshot])).values()];
}

/** Reuse the banked stream for this exact execution, or run a fresh session and bank it. */
async function execute(ctx: RunContext, { member, condition, run }: WorkItem): Promise<void> {
  const request = buildDirective(member, condition, ctx.read);
  const id = executionId({ agent: ctx.agent, member, condition, request, ...ctx.identity });
  const key = `${member.id}/${condition}`;
  const hit = ctx.bank.get(`${id}#${run}`);
  if (hit) {
    ctx.answered.set(`${key}#${run}`, hit);
    return;
  }
  const ws = materializeWorkspace(member, ctx.deps.materialize);
  try {
    const outcome = await runSession({
      args: buildArgs(ctx.agent, condition, ws),
      stdin: request,
      cwd: ws.consumer,
      spawnFn: ctx.deps.spawnFn,
    });
    // A session outside the frozen profile is not an agent result; banking it would replay it forever.
    const fault =
      'stream' in outcome ? initFault(parseTrace(outcome.stream).init, condition) : null;
    if ('outage' in outcome || fault) {
      ctx.outages.set(key, (ctx.outages.get(key) ?? 0) + 1);
      ctx.log(
        fault
          ? `harness fault ${key}#${run}: ${fault}`
          : `outage ${key}#${run}: ${'outage' in outcome ? outcome.outage.kind : ''}`,
      );
      return;
    }
    const entry = {
      executionId: id,
      member: member.id,
      condition,
      run,
      wsRoot: ws.root,
      stream: outcome.stream,
    };
    appendFileSync(ctx.checkpoint, `${JSON.stringify(entry)}\n`);
    ctx.answered.set(`${key}#${run}`, entry);
  } finally {
    ws.cleanup();
  }
}

async function decoysEndorsed(
  member: Member,
  response: string | null,
  matcher: typeof runMatcher,
  runs: number,
): Promise<Record<string, boolean>> {
  if (!response || !member.decoys.length) return {};
  const decoys = member.decoys.map(({ id, desc }) => ({ id, desc }));
  const outcomes = await matcher([], decoys, projectResponse(response), { runs });
  // A slot the matcher could not measure is left out, never scored as a clean decoy.
  const measured = outcomes.filter((outcome) => !outcome.outage);
  return Object.fromEntries(measured.map((outcome) => [outcome.slotId, outcome.match > 0]));
}

/** Score every run of one case from what was answered; a missing run counts as dark. */
async function scoreCase(
  ctx: RunContext,
  member: Member,
  condition: Condition,
  runs: number,
  matchRuns: number,
): Promise<CaseResult> {
  const scored: (ScoredRun | null)[] = [];
  for (let run = 0; run < runs; run += 1) {
    const entry = ctx.answered.get(`${member.id}/${condition}#${run}`);
    if (!entry) {
      scored.push(null);
      continue;
    }
    const score = scoreRun(member, condition, entry.stream, entry.wsRoot, ctx.read);
    const matcher = ctx.deps.matcher ?? runMatcher;
    const endorsed = score.valid
      ? await decoysEndorsed(member, score.response, matcher, matchRuns)
      : {};
    scored.push({ score, endorsed });
  }
  return aggregateCase(member, scored, ctx.outages.get(`${member.id}/${condition}`) ?? 0);
}

interface CliArgs {
  mode: string;
  only?: string;
  yes?: boolean;
}

function parseCli(argv: string[]): CliArgs {
  let values: { only?: string; yes?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        only: { type: 'string' },
        yes: { type: 'boolean' },
        dev: { type: 'boolean' },
        baseline: { type: 'boolean' },
      },
    }));
  } catch (error) {
    throw new BenchAbort(2, `${error instanceof Error ? error.message : error}\n${USAGE}`);
  }
  const mode = argv.find((arg) => ['coverage', '--dev', '--baseline'].includes(arg));
  if (!mode) throw new BenchAbort(2, USAGE);
  return { mode, ...values };
}

/** Spans whose file is missing from the pinned snapshot, or shorter than the span's last line. */
function absentSpans(members: Member[], read: ReadFile): string[] {
  return members.flatMap((member) =>
    [...member.gold, ...member.decoys]
      .flatMap((slot) => slot.spans)
      .filter(
        (span) => (read(member, span.root, span.path)?.split('\n').length ?? 0) < span.lines[1],
      )
      .map((span) => `${member.id} ${span.root}:${span.path}:${span.lines[0]}-${span.lines[1]}`),
  );
}

function resolveVersion(deps: WorkflowDeps): string {
  try {
    return (deps.version ?? claudeVersion)();
  } catch {
    throw new BenchAbort(2, 'prior-art workflow: `claude` CLI not available — cannot benchmark');
  }
}

async function scoreAll(
  ctx: RunContext,
  members: Member[],
  runs: number,
  total: number,
): Promise<WorkflowResults> {
  const matchRuns = envInt('BENCH_MATCH_RUNS', 3);
  const rows: CaseRows = {};
  for (const member of members)
    rows[member.id] = {
      search: await scoreCase(ctx, member, 'search', runs, matchRuns),
      supplied: await scoreCase(ctx, member, 'supplied', runs, matchRuns),
    };
  const meta = {
    model: ctx.agent.model,
    claudeVersion: ctx.identity.version,
    scorerHash: scorerHash(),
  };
  return summarise(members, rows, { ...meta, runs, matchRuns, total });
}

function report({ priorArtWorkflow: block }: WorkflowResults, log: (line: string) => void): void {
  const { paired } = block;
  log(
    `paired: ${paired.bothCorrect} both · ${paired.retrievalFailure} retrieval-failure · ` +
      `${paired.searchOnly} search-only · ${paired.interpretationFailure} interpretation-failure`,
  );
  for (const [id, byCondition] of Object.entries(block.rows))
    for (const condition of CONDITIONS) {
      const { verdictOk, verdict, valid } = byCondition[condition];
      log(
        `  ${id} [${condition}] ${verdictOk ? '✓' : '✗'} ${verdict} · valid ${valid.ok}/${valid.total}`,
      );
    }
}

export async function workflowMain(argv: string[], deps: WorkflowDeps = {}): Promise<number> {
  const log = deps.log ?? console.log;
  const cli = parseCli(argv);
  const runs = envInt('BENCH_RUNS', 1);
  const corpus = deps.families ?? loadFamilies();
  const members = selectMembers(corpus, cli.only);
  if (cli.mode === 'coverage') {
    log(workflowPlan(members, runs));
    return 0;
  }
  for (const snapshot of uniqueSnapshots(members)) snapshotDir(snapshot, deps.materialize);
  const read: ReadFile = (member, root, file) => snapshotFile(member, root, file, deps.materialize);
  const absent = absentSpans(members, read);
  if (absent.length)
    throw new BenchAbort(
      2,
      `prior-art workflow: labelled spans the pinned snapshots do not hold —\n  ${absent.join('\n  ')}`,
    );
  log(`snapshots verified · ${workflowPlan(members, runs)}`);
  if (!cli.yes) {
    log('dry run: nothing spawned (re-run with --yes to spend)');
    return 0;
  }

  const version = resolveVersion(deps);
  const checkpoint = deps.checkpoint ?? checkpointPath;
  const ctx: RunContext = {
    deps,
    log,
    agent: loadAgent(),
    identity: {
      version,
      userInstructions: userInstructionsHash(),
      runnerClosure: runnerClosureHash(),
    },
    read,
    bank: readBank(checkpoint),
    checkpoint,
    answered: new Map(),
    outages: new Map(),
  };
  const work = members.flatMap((member) =>
    CONDITIONS.flatMap((condition) =>
      Array.from({ length: runs }, (_, run) => ({ member, condition, run })),
    ),
  );
  await mapPool(work, envInt('BENCH_AGENT_CONCURRENCY', 3), (item) => execute(ctx, item));

  const summary = await scoreAll(ctx, members, runs, corpus.length * CONDITIONS.length);
  report(summary, log);
  if (cli.mode === '--baseline') {
    const results = deps.results ?? resultsPath;
    writeFileSync(results, `${JSON.stringify(summary, null, 2)}\n`);
    log(`wrote ${path.relative(process.cwd(), results)}`);
  }
  return 0;
}
