#!/usr/bin/env node
// Single-turn writer calls for the note-restatement experiment. README.md pre-registers the protocol.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { GIT_ENV_VARS, JUDGE_ISOLATION, JUDGE_READ_ONLY } from '../../../../gate-engine/judge/judge-isolation.mts';
import { controls, DIR, loadKindSet, loadRunSet, MIN_CONFIRMED_W, MODELS, readJsonl, render, rowKey, sha256, skillSection } from './score.mjs';

const TIMEOUT_MS = 300_000;
const MAX_ATTEMPTS = 3;
const FROZEN = ['cases.jsonl', 'kind-cases.jsonl', 'rater2-labels.jsonl', 'writer-prompt.txt', 'kind-prompt.txt', 'skill-notes-section.md', 'score.mjs', 'writer.mjs'];

/** The planned (phase, model, rep, item) cells; probe takes the first E, the N and the first confirmed W. */
function plan(phase, models) {
  const reps = phase === 'decisive' ? [1, 2, 3] : [1];
  const run = loadRunSet();
  const probe = [run.items.find((i) => i.sampleLabel === 'E'), run.items.find((i) => i.sampleLabel === 'N'), run.items.find((i) => i.w)];
  const items = phase === 'kind' ? loadKindSet() : phase === 'probe' ? probe : run.items;
  const template = readFileSync(join(DIR, phase === 'kind' ? 'kind-prompt.txt' : 'writer-prompt.txt'), 'utf8');
  const skill = skillSection();
  return models.flatMap((model) =>
    reps.flatMap((rep) =>
      items.map((it) => ({ phase, model, rep, id: it.id, caseSha256: it.caseSha256, prompt: render(template, { SKILL: skill, SLUG: it.slug, RULING: it.ruling, NOTE: it.note }) })),
    ),
  );
}

/** Refuses any call before the pre-registered preconditions hold. */
function preflight(phase) {
  const dirty = execFileSync('git', ['-C', DIR, 'status', '--porcelain', '--', ...FROZEN], { encoding: 'utf8' }).trim();
  if (dirty) throw new Error(`frozen inputs are not committed:\n${dirty}`);
  const run = loadRunSet();
  if (!run.confirmed) throw new Error('rater2-labels.jsonl is missing: the second rater confirms W items before any call');
  if (run.confirmedW < MIN_CONFIRMED_W) throw new Error(`INCONCLUSIVE: ${run.confirmedW} confirmed W items, ${MIN_CONFIRMED_W} needed; no call is made`);
  if (!controls(run).ok) throw new Error('controls fail: run `node score.mjs --controls`');
  if (phase === 'decisive' && readJsonl(join(DIR, 'runs', 'probe.jsonl')).length === 0) throw new Error('run the probe first');
}

/** One isolated `claude -p` call from a fresh temp cwd; the recorded argv replaces the prompt by its hash. */
function callWriter(model, prompt) {
  const cwd = mkdtempSync(join(tmpdir(), 'note-restatement-'));
  const argv = ['-p', '--model', model, ...JUDGE_READ_ONLY, ...JUDGE_ISOLATION, prompt];
  const env = { ...process.env, DEVKIT_NO_TELEMETRY: '1' };
  for (const k of GIT_ENV_VARS) delete env[k];
  const t0 = Date.now();
  const startedAt = new Date(t0).toISOString();
  return new Promise((resolve) => {
    const child = spawn('claude', argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    const finish = (exitCode, signal) => {
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
      const recorded = [...argv.slice(0, -1), `<prompt sha256:${sha256(prompt)}>`];
      resolve({ argv: recorded, cwd, startedAt, ms: Date.now() - t0, exitCode, signal, stdout, stderrTail: stderr.slice(-500) });
    };
    child.on('error', (e) => {
      stderr += String(e);
      finish(null, null);
    });
    child.on('close', finish);
  });
}

/** Every attempt is an appended row; a cell stops at its first success or after MAX_ATTEMPTS. */
async function runCell(cell, out, meta) {
  const { prompt, prior, ...rest } = cell;
  for (let attempt = prior + 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const r = await callWriter(cell.model, prompt);
    const ok = r.exitCode === 0 && r.stdout.trim() !== '';
    appendFileSync(out, `${JSON.stringify({ ...rest, attempt, promptSha256: sha256(prompt), ...meta, ...r, ok })}\n`);
    if (ok) return;
  }
}

async function drain(queue, out, meta) {
  for (let cell = queue.shift(); cell; cell = queue.shift()) await runCell(cell, out, meta);
}

async function main() {
  const { values } = parseArgs({ options: { phase: { type: 'string' }, model: { type: 'string', multiple: true }, concurrency: { type: 'string', default: '2' } } });
  if (!['probe', 'decisive', 'kind'].includes(values.phase)) throw new Error('--phase probe|decisive|kind');
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('--concurrency takes a positive integer');
  preflight(values.phase);
  mkdirSync(join(DIR, 'runs'), { recursive: true });
  const out = join(DIR, 'runs', `${values.phase}.jsonl`);
  const tries = new Map();
  for (const r of readJsonl(out)) tries.set(rowKey(r), r.ok ? MAX_ATTEMPTS : (tries.get(rowKey(r)) ?? 0) + 1);
  const todo = plan(values.phase, values.model ?? MODELS)
    .map((c) => ({ ...c, prior: tries.get(rowKey(c)) ?? 0 }))
    .filter((c) => c.prior < MAX_ATTEMPTS);
  const meta = {
    headSha: execFileSync('git', ['-C', DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    cliVersion: spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim(),
    node: process.version,
    icu: process.versions.icu,
  };
  console.log(`${values.phase}: ${todo.length} cells to call → ${out}`);
  await Promise.all(Array.from({ length: concurrency }, () => drain(todo, out, meta)));
}

main().catch((e) => {
  console.error(`writer: ${e.message}`);
  process.exitCode = 1;
});
