#!/usr/bin/env node

/**
 * Decision-log smell gate (deterministic tripwire + optional LLM downgrade).
 *
 * Reads a diff and flags changes that *smell* like an architectural decision (the
 * road-not-taken criterion's cheap proxy). The regex tripwire is the deterministic floor;
 * at gate time an LLM (`claude -p`) may DOWNGRADE a false positive to a pass — it can only
 * relax the regex block, never escalate, so the worst case is the regex verdict.
 *
 * Contract:
 *   --gate : exit 1 = block (smell, no decision staged, not bypassed, LLM didn't clear it)
 *            exit 0 = clean / decision staged / noLog bypass / LLM judged ROUTINE
 *            exit 2 = could-not-run (no git / error) → fail-open
 *   scan [--working] : print smell labels, exit 0. --working scans the whole working tree
 *            (staged + unstaged vs HEAD) — used by a Stop-hook reminder.
 *
 * Bypass: GUARD_NO_LOG=1 (FRINK_NO_LOG=1 back-compat) skips the gate.
 *         GUARD_DECISION_NO_LLM=1 (FRINK_DECISION_NO_LLM=1 back-compat) forces pure-regex.
 *
 * ── W-3 (portability invariant) ──────────────────────────────────────────────────
 * Boundaries, the decisions dir, and the noLog/noLlm knobs come from
 * resolveGuardConfig(cwd); git runs in the CONSUMER cwd. Nothing is anchored to the
 * package dir (__dirname). Run from a consumer's node_modules, this gate reads THAT repo.
 */

import { execSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveGuardConfig } from '../config.mjs';
import { JUDGE_ISOLATION, JUDGE_READ_ONLY } from '../judge/judge-isolation.mjs';
import { execJudge } from '../judge/run-judge.mjs';

const LOCKFILE_RE = /(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;
const PKG_RE = /(^|\/)package\.json$/;
const DEP_KEYS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const LEGACY_DELETE_LINES = 100;
const MODULE_REPLACE_LINES = 50;
const CLAUDE_PROMPT =
  'A staged git diff (on stdin) tripped an architectural-decision smell. Decide if it makes an ' +
  'EPIC-ALTITUDE architectural decision that must be recorded in the decision log: a road-not-taken ' +
  'where a viable alternative was rejected, the rationale would still matter in 6 months, AND a ' +
  'product+eng team would treat the choice as its own epic (a durable, cross-cutting ' +
  'product/business/eng direction — not a local code detail). Reply ROUTINE for anything else: a ' +
  'dependency bump or version change, a behavior-preserving refactor, a generated-file sync, ' +
  'lockfile churn, a routine migration, OR a local implementation step that merely advances an ' +
  'existing direction (that is a cheap note, not a new decision, and is not gated). Reply with ' +
  'exactly one word: DECISION or ROUTINE.';

// Match any staged file under the consumer's decision-log dir (relative to cwd). Built per-run
// from cfg.decisionsDir so a consumer that relocates the log still has its records counted.
function decisionFileRe(decisionsRel) {
  const esc = decisionsRel.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|/)${esc}/.+\\.md$`);
}

// ─── Pure smell logic (testable without git) ────────────────────────────────────

/**
 * The (label, contributing-file) pairs that drive each smell — the file that *causes* the smell, not
 * the whole diff. A per-session seen-set keyed on these pairs re-arms only on a genuinely new
 * decision (a never-seen pair), so a growing single-decision footprint never re-nags. For dep-change
 * the "path" is the changed dependency NAME, so two distinct dep decisions yield distinct pairs and a
 * second unrelated bump is not collapsed into the first.
 *
 * @param {{status:string,path:string,added:number,deleted:number,depChanged?:boolean,depKeys?:string[]}[]} entries
 *   Pure renames/copies (status R/C) must already be excluded by the caller (move noise).
 * @param {string[]} boundaries Cross-trust-boundary prefixes (cfg.boundaries). A change touching ≥2
 *   of these smells like a cross-boundary architectural move. Default [] → the smell never fires.
 * @returns {{label:string,path:string}[]}
 */
// Reason: the branches ARE the smell taxonomy — each block is one independent architectural-smell
// predicate yielding its contributing paths; extracting them scatters a cohesive predicate set
// fallow-ignore-next-line complexity
export function smellSources(entries, boundaries = []) {
  const real = entries.filter((e) => !LOCKFILE_RE.test(e.path));
  if (real.length === 0) return []; // lockfile-only churn is never a decision
  const sources = [];

  for (const e of real)
    if (PKG_RE.test(e.path))
      for (const name of e.depKeys ?? (e.depChanged ? [e.path] : []))
        sources.push({ label: 'dep-change', path: name });

  const boundariesHit = boundaries.filter((b) => real.some((e) => e.path.startsWith(b)));
  if (boundariesHit.length >= 2)
    for (const e of real)
      if (boundariesHit.some((b) => e.path.startsWith(b)))
        sources.push({ label: 'cross-boundary-move', path: e.path });

  for (const e of real)
    if (e.status === 'D' && e.deleted > LEGACY_DELETE_LINES)
      sources.push({ label: 'legacy-deletion', path: e.path });

  const dels = real.filter((e) => e.status === 'D' && e.deleted > MODULE_REPLACE_LINES);
  for (const a of real.filter((e) => e.status === 'A'))
    if (
      dels.some(
        (d) =>
          path.basename(a.path) === path.basename(d.path) &&
          path.dirname(a.path) !== path.dirname(d.path),
      )
    )
      sources.push({ label: 'module-replace', path: a.path });

  return sources;
}

/**
 * @param {{status:string,path:string,added:number,deleted:number,depChanged?:boolean,depKeys?:string[]}[]} entries
 * @param {string[]} boundaries
 * @returns {string[]} the distinct smell labels (derived from {@link smellSources} — one source of truth)
 */
export function detectSmells(entries, boundaries = []) {
  return [...new Set(smellSources(entries, boundaries).map((s) => s.label))];
}

/**
 * Pure gate decision. 0 = pass, 1 = block.
 * @param {{bypass:boolean,decisionStaged:boolean,smells:string[]}} s
 */
export function gateVerdict(s) {
  if (s.bypass) return 0;
  if (s.smells.length === 0) return 0;
  if (s.decisionStaged) return 0;
  return 1;
}

// ─── git I/O wrappers (thin; run in the CONSUMER cwd) ────────────────────────────

function sh(cwd, cmd) {
  return execSync(cmd, { cwd, encoding: 'utf8' });
}

// Pure: the dependency NAMES whose spec differs between two parsed package.json objects. Exported
// for tests — the seen-set's dep-change identity (distinct decisions vs the same bump) rides on it.
export function depChangedKeys(oldJson, newJson) {
  const names = new Set();
  for (const k of DEP_KEYS) {
    const a = oldJson?.[k] ?? {};
    const b = newJson?.[k] ?? {};
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)]))
      if (JSON.stringify(a[name]) !== JSON.stringify(b[name])) names.add(name);
  }
  return [...names];
}

// Changed dep names of a package.json vs HEAD: staged (index) for 'cached', on-disk for 'working'.
function readDepChangedKeys(cwd, relPath, mode) {
  let cur;
  try {
    cur = JSON.parse(
      mode === 'working'
        ? readFileSync(path.join(cwd, relPath), 'utf8')
        : sh(cwd, `git show :${relPath}`),
    );
  } catch {
    return [];
  }
  let head;
  try {
    head = JSON.parse(sh(cwd, `git show HEAD:${relPath}`));
  } catch {
    head = {};
  }
  return depChangedKeys(head, cur);
}

/** mode 'cached' = staged vs HEAD (the gate); 'working' = whole tree vs HEAD (the Stop reminder). */
// Reason: the branches ARE the git-diff parse algorithm: two passes over numstat/name-status, each line classifying status (rename/copy/add/del) and binary ('-') vs numeric churn; extracting the per-line tiers hides the diff-decoding logic
// fallow-ignore-next-line complexity
export function gatherEntries(cwd, mode = 'cached') {
  const range = mode === 'working' ? 'HEAD' : '--cached';
  const counts = new Map();
  for (const line of sh(cwd, `git diff ${range} --numstat -M`).split('\n')) {
    if (!line.trim()) continue;
    const [add, del, ...p] = line.split('\t');
    const file = p.join('\t');
    if (file.includes('=>')) continue; // rename notation — renames excluded
    counts.set(file, {
      added: add === '-' ? 0 : Number.parseInt(add, 10) || 0,
      deleted: del === '-' ? 0 : Number.parseInt(del, 10) || 0,
    });
  }
  const entries = [];
  for (const line of sh(cwd, `git diff ${range} --name-status -M`).split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0][0];
    if (status === 'R' || status === 'C') continue; // pure rename/copy = move noise, excluded
    const file = parts[parts.length - 1];
    const c = counts.get(file) ?? { added: 0, deleted: 0 };
    const depKeys = PKG_RE.test(file) ? readDepChangedKeys(cwd, file, mode) : [];
    entries.push({
      status,
      path: file,
      ...c,
      depChanged: depKeys.length > 0,
      depKeys,
    });
  }
  return entries;
}

// Parse the LLM verdict. Only a confident ROUTINE clears; anything ambiguous ("ROUTINE but
// also a DECISION"), unknown, or empty → null → the block stands (fail-safe toward recording).
export function parseVerdict(raw) {
  const out = String(raw).trim().toUpperCase();
  if (out.includes('ROUTINE') && !out.includes('DECISION')) return 'ROUTINE';
  if (out.includes('DECISION')) return 'DECISION';
  return null;
}

/**
 * One smell-downgrade judge run → raw transcript, or null on outage (execJudge warns once).
 * Pure-text judge: JUDGE_READ_ONLY strips tools, JUDGE_ISOLATION silences host hooks and keeps the
 * run off the session store; READ_ONLY splices BEFORE ISOLATION so the variadic `--disallowedTools *`
 * is bounded by `--settings`, positional prompt last. Exported so eval/bench.mjs exercises the exact
 * prompt/argv/truncation/timeout the gate runs.
 */
export function runDetectJudge(cwd, diff, model = 'haiku') {
  return execJudge({
    label: 'decision-smell',
    args: ['-p', '--model', model, ...JUDGE_READ_ONLY, ...JUDGE_ISOLATION, CLAUDE_PROMPT],
    input: String(diff).slice(0, 12000),
    timeout: 30000,
    cwd,
  });
}

// LLM downgrade: a confident ROUTINE clears a regex block; DECISION / unavailable / error
// → null → the block stands. Never escalates.
function judgeWithClaude(cwd, noLlm, diff) {
  if (noLlm || !diff) return null;
  const raw = runDetectJudge(cwd, diff);
  return raw === null ? null : parseVerdict(raw);
}

function decisionStaged(cwd, decisionFileMatcher) {
  const names = sh(cwd, 'git diff --cached --name-only');
  return names.split('\n').some((n) => decisionFileMatcher.test(n.trim()));
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

function runGate() {
  const cwd = process.cwd();
  const cfg = resolveGuardConfig(cwd);
  // Whole body in the fail-open guard: ANY throw (git unavailable, a regression in the
  // pure logic, a git/fs read error) must exit 2, never 1 — infra must never brick a commit.
  try {
    const decisionMatcher = decisionFileRe(cfg.decisionsDir);
    const smells = detectSmells(gatherEntries(cwd), cfg.boundaries);
    const verdict = gateVerdict({
      bypass: cfg.noLog,
      decisionStaged: decisionStaged(cwd, decisionMatcher),
      smells,
    });
    if (verdict === 0) process.exit(0);
    // Regex says block — let the LLM try to clear a false positive (dep bump, sync, etc.).
    if (judgeWithClaude(cwd, cfg.noLlm, sh(cwd, 'git diff --cached')) === 'ROUTINE')
      process.exit(0);
    console.error(`decision smells: ${smells.join(', ')}`);
    process.exit(1);
  } catch (e) {
    console.error(`decision-gate: could not run — ${e?.message ?? e}`);
    process.exit(2); // fail-open
  }
}

function runScan(mode) {
  const cwd = process.cwd();
  // Reason: two independent decision-gate CLIs (alignment flip-flop vs architectural smell); the resolve-scan-exit shape rhymes but each scans a different thing; sharing would add the cross-engine dependency the engines avoid
  // fallow-ignore-next-line code-duplication
  try {
    const cfg = resolveGuardConfig(cwd);
    const entries = gatherEntries(cwd, mode);
    if (process.argv.includes('--files')) {
      // (label, contributing-file) pairs for the Stop-hook seen-set — sorted+deduped so membership
      // (grep -vxF) is stable: re-arm keys on a never-seen pair, not on the cumulative set changing.
      const pairs = [
        ...new Set(smellSources(entries, cfg.boundaries).map((s) => `${s.label}\t${s.path}`)),
      ].sort();
      if (pairs.length) console.log(pairs.join('\n'));
    } else {
      const smells = detectSmells(entries, cfg.boundaries);
      if (smells.length) console.log(smells.join('\n'));
    }
  } catch {
    // scan is informational — stay silent on error
  }
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  const cmd = process.argv[2];
  if (cmd === '--gate') runGate();
  else if (cmd === 'scan') runScan(process.argv.includes('--working') ? 'working' : 'cached');
  else {
    console.error('Usage: detect.mjs --gate | scan [--working] [--files]');
    process.exit(2);
  }
}
