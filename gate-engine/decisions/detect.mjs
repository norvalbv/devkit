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

import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveGuardConfig } from '../config.mjs';

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
 * @param {{status:string,path:string,added:number,deleted:number,depChanged?:boolean}[]} entries
 *   Pure renames/copies (status R/C) must already be excluded by the caller (move noise).
 * @param {string[]} boundaries Cross-trust-boundary prefixes (cfg.boundaries). A change touching
 *   ≥2 of these smells like a cross-boundary architectural move. Default [] → the smell never fires.
 * @returns {string[]} smell labels
 */
export function detectSmells(entries, boundaries = []) {
  const real = entries.filter((e) => !LOCKFILE_RE.test(e.path));
  if (real.length === 0) return []; // lockfile-only churn is never a decision
  const smells = new Set();

  if (real.some((e) => PKG_RE.test(e.path) && e.depChanged)) smells.add('dep-change');

  const boundariesHit = boundaries.filter((b) => real.some((e) => e.path.startsWith(b)));
  if (boundariesHit.length >= 2) smells.add('cross-boundary-move');

  if (real.some((e) => e.status === 'D' && e.deleted > LEGACY_DELETE_LINES))
    smells.add('legacy-deletion');

  const dels = real.filter((e) => e.status === 'D' && e.deleted > MODULE_REPLACE_LINES);
  const adds = real.filter((e) => e.status === 'A');
  const replaced = dels.some((d) =>
    adds.some(
      (a) =>
        path.basename(a.path) === path.basename(d.path) &&
        path.dirname(a.path) !== path.dirname(d.path),
    ),
  );
  if (replaced) smells.add('module-replace');

  return [...smells];
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

// Current content of a file: staged (index) for 'cached', on-disk for 'working'.
function depChanged(cwd, relPath, mode) {
  let cur;
  try {
    cur = JSON.parse(
      mode === 'working'
        ? readFileSync(path.join(cwd, relPath), 'utf8')
        : sh(cwd, `git show :${relPath}`),
    );
  } catch {
    return false;
  }
  let head;
  try {
    head = JSON.parse(sh(cwd, `git show HEAD:${relPath}`));
  } catch {
    head = {};
  }
  return DEP_KEYS.some((k) => JSON.stringify(cur[k] ?? {}) !== JSON.stringify(head[k] ?? {}));
}

/** mode 'cached' = staged vs HEAD (the gate); 'working' = whole tree vs HEAD (the Stop reminder). */
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
    entries.push({
      status,
      path: file,
      ...c,
      depChanged: PKG_RE.test(file) ? depChanged(cwd, file, mode) : false,
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

// LLM downgrade: a confident ROUTINE clears a regex block; DECISION / unavailable / error
// → null → the block stands. Never escalates. execFileSync (no shell) passes the prompt as a
// literal arg — injection-proof, no quoting fragility if the prompt is ever edited.
function judgeWithClaude(cwd, noLlm, diff) {
  if (noLlm || !diff) return null;
  try {
    return parseVerdict(
      execFileSync('claude', ['-p', '--model', 'haiku', CLAUDE_PROMPT], {
        cwd,
        input: diff.slice(0, 12000),
        encoding: 'utf8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return null; // claude CLI absent / offline / timeout → regex floor
  }
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
    if (judgeWithClaude(cwd, cfg.noLlm, sh(cwd, 'git diff --cached')) === 'ROUTINE') process.exit(0);
    console.error(`decision smells: ${smells.join(', ')}`);
    process.exit(1);
  } catch (e) {
    console.error(`decision-gate: could not run — ${e?.message ?? e}`);
    process.exit(2); // fail-open
  }
}

function runScan(mode) {
  const cwd = process.cwd();
  try {
    const cfg = resolveGuardConfig(cwd);
    const smells = detectSmells(gatherEntries(cwd, mode), cfg.boundaries);
    if (smells.length) console.log(smells.join('\n'));
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
    console.error('Usage: detect.mjs --gate | scan [--working]');
    process.exit(2);
  }
}
