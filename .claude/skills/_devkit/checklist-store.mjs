/**
 * Shared checklist lifecycle for the ITEM-BASED reviewer skills (api-security, backend-performance,
 * correctness, frontend-accessibility, frontend-performance, frontend-security).
 *
 * Each of those six carried its own byte-identical copy of load/save/status/check-item/finalize/
 * cleanup — differing only in the checklist path and the display label. fallow reported it as clone
 * groups spanning all six files; this is the "extract into a shared directory" its clone-family
 * report asks for, and the same move `review-roots.mjs` already made for root validation.
 *
 * What is deliberately NOT here: `generate()`. Every reviewer detects a different thing, so the
 * detector and its skip message stay in the skill that owns them. This module owns only the parts
 * that were provably identical.
 *
 * commit-guard is deliberately EXCLUDED even though it looks similar. Its checklist is keyed on
 * `data.files` (per-file status) rather than `data.items` (per-item), so `status`/`finalize` mean
 * something different there. Folding it in would be a behaviour change wearing a refactor's clothes
 * — the exact trap a clone report invites you into. It keeps its own lifecycle.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Build the lifecycle for one reviewer's checklist.
 *
 * @param {object} opts
 * @param {string | (() => string)} opts.path  Where the checklist JSON lives (e.g.
 *   `.claude/.api-security-review.json`). A THUNK is accepted because the path is not always fixed
 *   at construction: correctness resolves its file from a `--lens` argument at dispatch, AFTER
 *   module top-level runs, so a captured string would pin every lensed run to the unlensed file.
 *   Five reviewers pass a constant; correctness passes `() => ACTIVE_PATH`. Resolved per call, never
 *   cached — that is the whole point.
 * @param {string} opts.label     Display name in progress/summary lines (e.g. `API Security`).
 * @param {string} [opts.cleanupLabel]  Mid-sentence form for the removal line, defaulting to
 *   `label.toLowerCase()`. Explicit because the two are NOT mechanically related: api-security says
 *   "Removed API security checklist" — keeping API capitalised — which lowercasing the display label
 *   would quietly turn into "api security". Five of the six round-trip; that one does not, and a
 *   refactor has no business editing anyone's output.
 * @param {(...args: unknown[]) => void} [opts.log]   Sink for user-facing output; defaults to console.log.
 * @param {(code: number) => never} [opts.exit]       Process terminator; injectable so the behaviour
 *   can be tested without killing the test runner. Defaults to process.exit.
 */
export function createChecklistStore({
  path,
  label,
  cleanupLabel = label.toLowerCase(),
  log = console.log,
  exit = process.exit,
}) {
  // Resolve on EVERY call. Caching this would silently reintroduce the bug the thunk exists to
  // prevent: correctness rebinds its path at dispatch, so a value read once at construction is the
  // unlensed file forever.
  const filePath = () => (typeof path === 'function' ? path() : path);

  const load = () => {
    const p = filePath();
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null;
  };

  const save = (data) => {
    const p = filePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(data, null, 2));
  };

  /** Load, or terminate with the caller's message. Every mutating command needs a checklist. */
  const loadOrExit = (missingMessage) => {
    const data = load();
    if (!data) {
      log(missingMessage);
      exit(1);
      return null; // unreachable in production; lets an injected non-throwing `exit` unwind in tests
    }
    return data;
  };

  const status = () => {
    const data = loadOrExit('❌ No checklist. Run: generate');
    if (!data) return;
    const done = data.items.filter((i) => i.status !== 'pending').length;
    const failed = data.items.filter((i) => i.status === 'fail');
    log(`📋 ${label}: ${done}/${data.items.length} | Failed: ${failed.length}`);
    if (failed.length > 0) {
      log('Issues:');
      for (const item of failed)
        for (const issue of item.issues) log(`  - [${item.name}] ${issue}`);
    }
  };

  const checkItem = (name, pass, failReason) => {
    const data = loadOrExit('❌ No checklist');
    if (!data) return;
    const item = data.items.find((i) => i.name === name);
    if (!item) {
      log(`❌ Item not found: ${name}`);
      log('Available:', data.items.map((i) => i.name).join(', '));
      exit(1);
      return;
    }
    item.status = pass ? 'pass' : 'fail';
    if (pass) item.issues = []; // a recovery pass clears the stale failure trail
    if (!pass && failReason) item.issues.push(failReason);
    save(data);
    log(`✓ ${name}: ${item.status}${failReason ? ` (${failReason})` : ''}`);
  };

  const finalize = () => {
    const data = loadOrExit('❌ No checklist');
    if (!data) return;
    const pending = data.items.filter((i) => i.status === 'pending');
    const failed = data.items.filter((i) => i.status === 'fail');
    const allIssues = data.items.flatMap((i) => i.issues);
    if (pending.length > 0) {
      log(`❌ Incomplete: ${pending.length} items pending`);
      log('Pending:', pending.map((i) => i.name).join(', '));
      exit(1);
      return;
    }
    if (failed.length > 0 || allIssues.length > 0) {
      log(`❌ Failed: ${allIssues.length} issues`);
      for (const issue of allIssues) log(`  - ${issue}`);
      exit(1);
      return;
    }
    log(`✅ ${label}: All checks passed`);
  };

  // Review mode keeps the checklist: the ephemeral review worktree is discarded wholesale, and the
  // file is the evidence a reader may still want. Only a real commit cleans up after itself.
  const cleanup = () => {
    if (process.env.DEVKIT_RUN_MODE === 'review') return;
    const p = filePath();
    if (existsSync(p)) {
      unlinkSync(p);
      log(`🗑️  Removed ${cleanupLabel} checklist`);
    }
  };

  return { load, save, status, checkItem, finalize, cleanup };
}
