#!/usr/bin/env node
/** decisions-brief: what the shipped pre-edit brief changes in an editing agent's edit, on frozen
 * tasks with only guard-decisions stubbed. Method, cost and the before/after protocol: README.md. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { packageDir } from '../../../../cli/lib/fs-helpers.mts';
import { HOOK_REGISTRATIONS } from '../../../../cli/lib/install/hook-registration-ledger/registrations.mts';
import { hookScriptsFor } from '../../../../cli/lib/install/hook-registration-ledger/selection.mts';
import { cleanBenchEnv } from '../bench-env.mts';
import { openCheckpoint, progressFile, readProgress } from '../checkpoint.mts';
import {
  type Arm,
  CORPUS,
  diagnostics,
  type Job,
  manifest,
  planJobs,
  progressRows,
  reportLines,
  rowId,
  type Run,
  summarize,
} from './score.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(here, 'results.baseline.json');
const TAP = path.join(here, 'tap.mts');
const STUB = path.join(here, 'stub.mts');
export const MODEL = 'claude-haiku-5-5';
const TIMEOUT_MS = 240_000;
const STOP_AFTER_OUTAGES = 3;
const USD_PER_SESSION = 0.0065;
const FLAGS = [
  ...['--permission-mode', 'acceptEdits', '--setting-sources', 'project', '--strict-mcp-config'],
  ...['--no-session-persistence', '--output-format', 'json'],
];
/** The read-on regime: the agent may run guard-decisions (the stub, first on PATH) and head/tail. */
export const READ_ON_TOOLS = [
  'Bash(guard-decisions:*)',
  'Bash(./node_modules/.bin/guard-decisions:*)',
  'Bash(node_modules/.bin/guard-decisions:*)',
  'Bash(npx guard-decisions:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
];

type Task = {
  id: string;
  dir: string;
  slug: string;
  file: string;
  prompt: string;
  bindingText: string;
};
type AgentOut = { code: number | null; json: any; timedOut: boolean; stderr?: string };
type Options = { [flag: string]: string | boolean | undefined };

const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const shq = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
const option = (values: Options, key: string) => {
  const value = values[key];
  return value === undefined || value === true || value === false ? undefined : value;
};
export function loadTask(id: string, corpus = CORPUS): Task {
  const dir = path.join(corpus, 'tasks', id);
  return { ...readJson(path.join(dir, 'task.json')), dir };
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  cleanBenchEnv(env);
  return env;
}

function git(cwd: string, ...args: string[]) {
  const env = cleanEnv();
  const run = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${run.stderr}`);
}

export const decisionHookScripts = () =>
  hookScriptsFor({
    agentHooks: false,
    decisions: true,
    fallow: false,
    adhd: false,
    priorArtGate: false,
  });

/** Settings hooks: HOOK_REGISTRATIONS.decisions, each command run unchanged through the tap. */
export function tappedHooks(registrations = HOOK_REGISTRATIONS.decisions) {
  const byEvent: Record<string, { matcher: string; hooks: { type: string; command: string }[] }[]> =
    {};
  for (const { event, matcher, registrationId, command } of registrations) {
    const tapped = `node ${shq(TAP)} ${shq(registrationId)} ${shq(command)}`;
    (byEvent[event] ??= []).push({ matcher, hooks: [{ type: 'command', command: tapped }] });
  }
  return byEvent;
}

/** A committed scratch repo from the task with the stub first on PATH and, for hook arms, the
 * shipped decision hooks registered. node_modules/ and .claude/ stay out of git status. */
export function setupScratch(taskDir: string, hooks: boolean, overlay?: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'decisions-brief-')));
  cpSync(path.join(taskDir, 'repo'), dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  const author = ['-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid'];
  git(dir, ...author, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'seed');
  appendFileSync(path.join(dir, '.git', 'info', 'exclude'), 'node_modules/\n.claude/\n');
  const bin = path.join(dir, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'guard-decisions'), `#!/bin/sh\nexec node ${shq(STUB)} "$@"\n`, {
    mode: 0o755,
  });
  if (hooks) {
    const hookDir = path.join(dir, '.claude', 'hooks');
    mkdirSync(hookDir, { recursive: true });
    for (const name of decisionHookScripts())
      copyFileSync(path.join(packageDir(), 'agents-hooks', name), path.join(hookDir, name));
    const settings = JSON.stringify({ hooks: tappedHooks() }, null, 2);
    writeFileSync(path.join(dir, '.claude', 'settings.json'), settings);
  }
  if (overlay) cpSync(path.join(taskDir, overlay), dir, { recursive: true });
  return dir;
}

export function childEnv(scratch: string, stampDir: string, taskDir: string, parent = process.env) {
  const env = { ...parent };
  cleanBenchEnv(env);
  delete env.BENCH_CALLER;
  return {
    ...env,
    PATH: `${path.join(scratch, 'node_modules', '.bin')}${path.delimiter}${parent.PATH ?? ''}`,
    CLAUDE_PROJECT_DIR: scratch,
    DEVKIT_NO_TELEMETRY: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    BENCH_TASK_DIR: taskDir,
    BENCH_STAMP_DIR: stampDir,
  };
}

/** Identical in every arm; read-on only adds its allowedTools list. */
export function childArgv(arm: Arm, prompt: string, model = MODEL): string[] {
  const allowed = arm === 'read-on' ? ['--allowedTools', ...READ_ON_TOOLS] : [];
  return ['-p', prompt, '--model', model, ...FLAGS, ...allowed];
}

export const checkStatus = (taskDir: string, scratch: string) =>
  spawnSync('bash', [path.join(taskDir, 'check.sh')], {
    cwd: scratch,
    encoding: 'utf8',
    timeout: 60_000,
    env: cleanEnv(),
  }).status;

/** Zero-LLM fixture check in the scratch setup runs use: bad=1, good=0, seed=2; target briefed. */
export function validateTask(id: string, corpus = CORPUS): string[] {
  const task = loadTask(id, corpus);
  const problems: string[] = [];
  for (const [overlay, want] of [
    ['bad', 1],
    ['good', 0],
    [undefined, 2],
  ] as const) {
    const scratch = setupScratch(task.dir, true, overlay);
    const got = checkStatus(task.dir, scratch);
    rmSync(scratch, { recursive: true, force: true });
    if (got !== want) problems.push(`${overlay ?? 'seed'}=${got} want ${want}`);
  }
  const brief: { slug: string; ruling: string }[] = readJson(path.join(task.dir, 'brief.json'));
  const target = brief.slice(0, 3).find((axis) => axis.slug === task.slug);
  if (!target) problems.push(`${task.slug} is not in the first 3 brief entries`);
  else if (!target.ruling.includes(task.bindingText))
    problems.push('bindingText not in the ruling');
  return problems;
}

function validateAll(log: (line: string) => void): boolean {
  const ids = Object.keys(manifest());
  const invalid = ids.filter((id) => {
    const problems = validateTask(id);
    log(`${problems.length ? 'INVALID' : 'valid  '} ${id} ${problems.join('; ')}`);
    return problems.length > 0;
  });
  log(`validate: ${ids.length - invalid.length}/${ids.length} fixtures fail-to-pass`);
  return invalid.length === 0;
}

function hashFiles(root: string, files: string[]) {
  const hash = createHash('sha256');
  for (const file of files)
    hash.update(`${path.relative(root, file)}\0`).update(readFileSync(file));
  return hash;
}
export const gateFiles = () => [
  ...decisionHookScripts().map((name) => path.join(packageDir(), 'agents-hooks', name)),
  path.join(here, 'bench.mts'),
  TAP,
  STUB,
];
/** Replay key for checkpointed rows: hook scripts, decisions registrations and harness bytes. */
export const gateHash = (files = gateFiles(), registrations = HOOK_REGISTRATIONS.decisions) =>
  hashFiles(packageDir(), files).update(JSON.stringify(registrations)).digest('hex');
export function corpusHash(corpus = CORPUS) {
  const files = readdirSync(corpus, { recursive: true, encoding: 'utf8' })
    .map((rel) => path.join(corpus, rel))
    .filter((file) => statSync(file).isFile())
    .sort();
  return hashFiles(corpus, files).digest('hex');
}

function agent(spawnFn: typeof spawn, argv: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<AgentOut>((resolve) => {
    const child = spawnFn('claude', argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', (chunk) => (out += chunk));
    child.stderr?.on('data', (chunk) => (stderr = `${stderr}${chunk}`.slice(-400)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, TIMEOUT_MS);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, json: null, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let json = null;
      try {
        json = JSON.parse(out);
      } catch {}
      resolve({ code, json, timedOut, stderr });
    });
  });
}

/** An agent timeout, non-zero exit, unparseable output or is_error, or a killed check.sh (status
 * null), is an outage: NULL, never replayed. */
export function outcome(out: AgentOut, check: () => number | null): Run['got'] {
  if (out.timedOut || out.code !== 0 || !out.json || out.json.is_error) return 'NULL';
  const status = check();
  if (status === null) return 'NULL';
  return status === 0 || status === 1 ? status : 2;
}

async function runSession(job: Job, model: string, claudeVersion: string, spawnFn: typeof spawn) {
  const task = loadTask(job.task);
  const scratch = setupScratch(task.dir, job.arm !== 'none');
  const stamp = mkdtempSync(path.join(tmpdir(), 'decisions-brief-stamp-'));
  const started = Date.now();
  const env = childEnv(scratch, stamp, task.dir);
  const out = await agent(spawnFn, childArgv(job.arm, task.prompt, model), scratch, env);
  const taps = readProgress(path.join(stamp, 'tap.jsonl'));
  const reads = readProgress(path.join(stamp, 'stub.jsonl')).filter(
    (call) => call.caller === 'agent' && ['show', 'query'].includes(call.argv[0]),
  );
  return {
    ...job,
    id: rowId(job),
    got: outcome(out, () => checkStatus(task.dir, scratch)),
    editedTarget: taps.some((tap) => tap.rel === task.file),
    briefed: taps.some((tap) => tap.slugs.includes(task.slug)),
    outageNotice: taps.some((tap) => tap.outage),
    clauseShown: taps.some((tap) => tap.clauseShown),
    agentReads: reads.length,
    model,
    claudeVersion,
    turns: out.json?.num_turns,
    cost: out.json?.total_cost_usd,
    ms: Date.now() - started,
    tmp: scratch,
    result: String(out.json?.result ?? '').slice(0, 400),
    stderr: out.stderr,
  };
}

/** Finished rows replay from progress-brief.jsonl; the plan stops after 3 consecutive outages. */
async function runPlan(jobs: Job[], model: string, values: Options, spawnFn: typeof spawn) {
  const version = spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout?.trim();
  const claudeVersion = version?.split(' ')[0];
  if (!claudeVersion) throw new Error('claude --version printed nothing: is claude on PATH?');
  const checkpoint = openCheckpoint('brief', {
    config: `${model}|${claudeVersion}`,
    gateHash: gateHash(),
    corpusHash: corpusHash(),
    fresh: values.fresh === true,
  });
  const rows: Run[] = [];
  let next = 0;
  let streak = 0;
  const worker = async () => {
    while (streak < STOP_AFTER_OUTAGES && next < jobs.length) {
      const job = jobs[next++];
      const replayed = checkpoint.take(rowId(job));
      const run = replayed ?? (await runSession(job, model, claudeVersion, spawnFn));
      rows.push(run);
      if (replayed) continue;
      checkpoint.record(run);
      streak = run.got === 'NULL' ? streak + 1 : 0;
      console.log(`${run.id}\tcheck=${run.got}\tbriefed=${run.briefed}\treads=${run.agentReads}`);
    }
  };
  await Promise.all(Array.from({ length: Number(option(values, 'concurrency') ?? 6) }, worker));
  return { rows, stopped: streak >= STOP_AFTER_OUTAGES };
}

export async function runCommand(values: Options, spawnFn = spawn, log = console.log) {
  const k = Number(option(values, 'k') ?? 5);
  const model = option(values, 'model') ?? MODEL;
  const only = option(values, 'only')?.split(',');
  const jobs = planJobs(manifest(), k, only, option(values, 'arms')?.split(','));
  const minutes = Math.ceil((jobs.length * 25) / Number(option(values, 'concurrency') ?? 6) / 60);
  const usd = (jobs.length * USD_PER_SESSION).toFixed(2);
  log(`plan: ${jobs.length} sessions (K=${k}) on ${model}, about $${usd} and ${minutes} min`);
  if (values.yes !== true) {
    log('dry run: nothing spawned. Add --yes to run; finished rows replay from the checkpoint.');
    return 0;
  }
  if (!validateAll(log)) return 1;
  const { rows, stopped } = await runPlan(jobs, model, values, spawnFn);
  for (const line of diagnostics(rows)) log(line);
  if (stopped) log(`stopped after ${STOP_AFTER_OUTAGES} consecutive outages: re-run to resume`);
  return stopped || rows.some((run) => run.got === 'NULL') ? 2 : 0;
}

function reportCommand(values: Options, log = console.log): number {
  const k = Number(option(values, 'k') ?? 5);
  const hashes = { gateHash: gateHash(), corpusHash: corpusHash() };
  const runs = progressRows(progressFile('brief'), hashes);
  const { baseline: head, failures } = summarize(runs, k);
  const baseFile = option(values, 'base');
  const committed = existsSync(BASELINE) ? readJson(BASELINE) : null;
  const base = baseFile ? summarize(progressRows(path.resolve(baseFile)), k).baseline : committed;
  try {
    for (const line of [...reportLines(head, base), ...diagnostics(runs)]) log(line);
  } catch (error) {
    log(`report refused: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
  log(`floorsMet: ${head.floorsMet}${failures.length ? ` (${failures.join('; ')})` : ''}`);
  if (values['write-baseline'] === true) {
    writeFileSync(BASELINE, `${JSON.stringify(head, null, 2)}\n`);
    log(`wrote ${path.relative(process.cwd(), BASELINE)}`);
  }
  return 0;
}

async function main(args: string[]): Promise<number> {
  const string = { type: 'string' } as const;
  const flag = { type: 'boolean' } as const;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      only: string,
      arms: string,
      k: string,
      model: string,
      concurrency: string,
      base: string,
      fresh: flag,
      yes: flag,
      'write-baseline': flag,
    },
  });
  if (positionals[0] === 'validate') return validateAll(console.log) ? 0 : 1;
  if (positionals[0] === 'run') return runCommand(values);
  if (positionals[0] === 'report') return reportCommand(values);
  console.error('usage: bench.mts validate | run [--k N] [--only ids] [--yes] | report [--base f]');
  return 2;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) process.exitCode = await main(process.argv.slice(2));
