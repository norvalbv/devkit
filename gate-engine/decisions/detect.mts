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

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveGuardConfig } from '../config.mts';
import { splitDiffByFile } from '../judge/diff-focus.mts';
import { emitGateEvent } from '../judge/gate-events.mts';
import { JUDGE_ISOLATION, JUDGE_READ_ONLY } from '../judge/judge-isolation.mts';
import { execJudge } from '../judge/run-judge.mts';
import { composeTranscript, saveTranscript } from '../judge/transcript-store.mts';
import { hasVerdict, saveVerdict, verdictKey } from './verdict-cache.mts';

// 'cached' = staged vs HEAD (the gate); 'working' = whole tree vs HEAD (the Stop reminder).
type DiffMode = 'cached' | 'working';

// One changed-file record parsed from `git diff --numstat/--name-status` (renames/copies excluded
// by the caller). For dep-change the depKeys carry the changed dependency NAMES.
interface DiffEntry {
  status: string;
  path: string;
  added: number;
  deleted: number;
  depChanged?: boolean;
  depKeys?: string[];
}

// A (smell label, contributing-file) pair — the file that CAUSES the smell, not the whole diff.
interface SmellSource {
  label: string;
  path: string;
}

// The dependency sections of a parsed package.json (name → version spec). External JSON boundary.
type DepMap = Record<string, string>;
interface PackageManifest {
  dependencies?: DepMap;
  devDependencies?: DepMap;
  peerDependencies?: DepMap;
  optionalDependencies?: DepMap;
}

const LOCKFILE_RE = /(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;
const PKG_RE = /(^|\/)package\.json$/;
const DEP_KEYS: (keyof PackageManifest)[] = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
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
  'existing direction (that is a cheap note, not a new decision, and is not gated). ' +
  'Stdin carries the FULL changed-file list, then EVIDENCE: the diff of only the files that ' +
  'tripped the smell (other files appear in the list alone; evidence may be capped). If the ' +
  'evidence is not enough to confidently rule ROUTINE, reply DECISION. Reply with exactly one ' +
  'word: DECISION or ROUTINE.';

// Match any staged file under the consumer's decision-log dir (relative to cwd). Built per-run
// from cfg.decisionsDir so a consumer that relocates the log still has its records counted.
function decisionFileRe(decisionsRel: string): RegExp {
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
 * @param entries Pure renames/copies (status R/C) must already be excluded by the caller (move noise).
 * @param boundaries Cross-trust-boundary prefixes (cfg.boundaries). A change touching ≥2
 *   of these smells like a cross-boundary architectural move. Default [] → the smell never fires.
 */
// Reason: the branches ARE the smell taxonomy — each block is one independent architectural-smell
// predicate yielding its contributing paths; extracting them scatters a cohesive predicate set
// fallow-ignore-next-line complexity
export function smellSources(entries: DiffEntry[], boundaries: string[] = []): SmellSource[] {
  const real = entries.filter((e) => !LOCKFILE_RE.test(e.path));
  if (real.length === 0) return []; // lockfile-only churn is never a decision
  const sources: SmellSource[] = [];

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

/** The distinct smell labels (derived from {@link smellSources} — one source of truth). */
export function detectSmells(entries: DiffEntry[], boundaries: string[] = []): string[] {
  return [...new Set(smellSources(entries, boundaries).map((s) => s.label))];
}

/** Pure gate decision. 0 = pass, 1 = block. */
export function gateVerdict(s: {
  bypass: boolean;
  decisionStaged: boolean;
  smells: string[];
}): number {
  if (s.bypass) return 0;
  if (s.smells.length === 0) return 0;
  if (s.decisionStaged) return 0;
  return 1;
}

// ─── git I/O wrappers (thin; run in the CONSUMER cwd) ────────────────────────────

// argv-based on purpose: staged FILENAMES (e.g. a nested package.json path) ride some of
// these calls, and a shell string lets a crafted path expand before git runs.
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// Pure: the dependency NAMES whose spec differs between two parsed package.json objects. Exported
// for tests — the seen-set's dep-change identity (distinct decisions vs the same bump) rides on it.
export function depChangedKeys(oldJson: PackageManifest, newJson: PackageManifest): string[] {
  const names = new Set<string>();
  for (const k of DEP_KEYS) {
    const a = oldJson?.[k] ?? {};
    const b = newJson?.[k] ?? {};
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)]))
      if (JSON.stringify(a[name]) !== JSON.stringify(b[name])) names.add(name);
  }
  return [...names];
}

// Changed dep names of a package.json vs HEAD: staged (index) for 'cached', on-disk for 'working'.
function readDepChangedKeys(cwd: string, relPath: string, mode: DiffMode): string[] {
  let cur: PackageManifest;
  try {
    cur = JSON.parse(
      mode === 'working'
        ? readFileSync(path.join(cwd, relPath), 'utf8')
        : git(cwd, ['show', `:${relPath}`]),
    );
  } catch {
    return [];
  }
  let head: PackageManifest;
  try {
    head = JSON.parse(git(cwd, ['show', `HEAD:${relPath}`]));
  } catch {
    head = {};
  }
  return depChangedKeys(head, cur);
}

/** mode 'cached' = staged vs HEAD (the gate); 'working' = whole tree vs HEAD (the Stop reminder). */
// Reason: the branches ARE the git-diff parse algorithm: two passes over numstat/name-status, each line classifying status (rename/copy/add/del) and binary ('-') vs numeric churn; extracting the per-line tiers hides the diff-decoding logic
// fallow-ignore-next-line complexity
export function gatherEntries(cwd: string, mode: DiffMode = 'cached'): DiffEntry[] {
  const range = mode === 'working' ? 'HEAD' : '--cached';
  const counts = new Map<string, { added: number; deleted: number }>();
  for (const line of git(cwd, ['diff', range, '--numstat', '-M']).split('\n')) {
    if (!line.trim()) continue;
    const [add, del, ...p] = line.split('\t');
    const file = p.join('\t');
    if (file.includes('=>')) continue; // rename notation — renames excluded
    counts.set(file, {
      added: add === '-' ? 0 : Number.parseInt(add, 10) || 0,
      deleted: del === '-' ? 0 : Number.parseInt(del, 10) || 0,
    });
  }
  const entries: DiffEntry[] = [];
  for (const line of git(cwd, ['diff', range, '--name-status', '-M']).split('\n')) {
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

// Evidence caps: one smelled file's segment may not evict a second (per-segment), the whole
// evidence pack stays far under the model's degradation zone (total — a HARD ceiling: the last
// segment is trimmed to the remaining room, never pushed past it), and the file-list header is
// line-capped so header + evidence + labels always fit inside runDetectJudge's 12000 slice.
// Values sit in the focused-context sweet spot the length literature measures (accuracy declines
// from ~3k TOKENS of input regardless of filler — arXiv:2402.14848, 2409.01666).
const SMELL_SEGMENT_CAP = 4000;
const EVIDENCE_TOTAL_CAP = 8000;
const HEADER_MAX_FILES = 60;

// A smelled path is located in a segment's HEADER LINE by containment, not by parsing the a/ b/
// prefixes — `diff.noprefix=true` / `diff.mnemonicPrefix=true` in a CONSUMER's git config change
// the prefix format (W-3: the gate runs against the consumer's config, which devkit does not
// control), and a prefix-parsing regex extracted ZERO evidence there. `/path` or ` path` bounds
// the match so `a.ts` never matches `data.ts`.
function segmentMatches(segment: string, smellPaths: Set<string>): boolean {
  const nl = segment.indexOf('\n');
  const firstLine = nl === -1 ? segment : segment.slice(0, nl);
  for (const p of smellPaths)
    if (firstLine.includes(`/${p}`) || firstLine.includes(` ${p}`)) return true;
  return false;
}

/**
 * Judge stdin — deterministic EVIDENCE EXTRACTION, not truncation. A naive `git diff` prefix on a
 * big commit is all routine churn while the decision decider sits past any slice point (a false
 * ROUTINE downgrade), and length itself degrades judgment: accuracy falls from ~3k tokens even
 * with benign filler, with binary-label bias and instruction drift ("Same Task, More Tokens"
 * arXiv:2402.14848; Context Rot; irrelevant context hurts + removing it restores accuracy,
 * arXiv:2302.00093). The smell detector already KNOWS which files fired — a decision in a
 * non-smelled file would not have triggered the gate at all — so the filter has perfect recall
 * by construction (the one case where full context beats focused context, retrieval misses,
 * cannot occur — arXiv:2407.16833).
 *
 * Input = (a) the changed-file list from entries (line-capped at HEADER_MAX_FILES with an explicit
 * "+N more" line — the judge always knows the commit's whole shape), then (b) ONLY the
 * smell-contributing files' diff segments (per-segment + hard total caps), then (c) explicit
 * omission accounting that DISTINGUISHES routine-file omissions from cap-dropped SMELL evidence —
 * the judge must never believe the evidence is complete when a smelled segment was dropped (that
 * case names itself INCOMPLETE, engaging the prompt's insufficient-evidence → DECISION fail-safe).
 * Routine churn never reaches the model. Pure (exported for eval/bench.mjs + tests);
 * runDetectJudge's 12000 slice stays as belt-and-braces and can no longer bite by construction.
 * A git-quoted path (spaces/unicode) the header-line match misses just isn't extracted — it stays
 * visible in the file list and the same fail-safe covers it.
 */
export function buildDetectJudgeInput(
  fullDiff: string,
  entries: DiffEntry[],
  boundaries: string[] = [],
): string {
  const smellPaths = new Set<string>();
  for (const s of smellSources(entries, boundaries))
    if (s.label !== 'dep-change') smellPaths.add(s.path); // dep-change "path" is a dep NAME, not a file
  const adds = entries.filter((e) => e.status === 'A');
  for (const e of entries) {
    if (LOCKFILE_RE.test(e.path)) continue; // lockfile churn is never evidence (mirrors smellSources)
    if (PKG_RE.test(e.path) && (e.depChanged || (e.depKeys?.length ?? 0) > 0))
      smellPaths.add(e.path);
    // A module-replace smell points at the ADDED file; ONLY its same-basename/different-dir
    // deletion counterpart is evidence (mirrors the smellSources predicate — an unrelated big
    // deletion must not eat the evidence budget unless it is itself a legacy-deletion smell,
    // which smellSources already contributes).
    if (
      e.status === 'D' &&
      e.deleted > MODULE_REPLACE_LINES &&
      adds.some(
        (a) =>
          path.basename(a.path) === path.basename(e.path) &&
          path.dirname(a.path) !== path.dirname(e.path),
      )
    )
      smellPaths.add(e.path);
  }
  const headerLines = entries.map((e) => `${e.status}\t${e.path}\t+${e.added}/-${e.deleted}`);
  const header =
    headerLines.length > HEADER_MAX_FILES
      ? `${headerLines.slice(0, HEADER_MAX_FILES).join('\n')}\n…and ${headerLines.length - HEADER_MAX_FILES} more changed files`
      : headerLines.join('\n');
  const evidence: string[] = [];
  let evidenceChars = 0;
  let omittedRoutine = 0;
  let droppedSmell = 0;
  for (const seg of splitDiffByFile(fullDiff)) {
    if (!segmentMatches(seg, smellPaths)) {
      omittedRoutine += 1;
      continue;
    }
    const room = EVIDENCE_TOTAL_CAP - evidenceChars;
    if (room <= 0) {
      droppedSmell += 1;
      continue;
    }
    const capped = seg.slice(0, Math.min(SMELL_SEGMENT_CAP, room));
    evidence.push(capped);
    evidenceChars += capped.length;
  }
  const accounting =
    `[${omittedRoutine} routine changed-file segment(s) omitted — see the file list above]` +
    (droppedSmell > 0
      ? `\n[WARNING: ${droppedSmell} SMELL-file segment(s) dropped by the evidence cap — the evidence below is INCOMPLETE]`
      : '') +
    (evidence.length === 0
      ? '\n[WARNING: no evidence segments could be extracted — treat the evidence as insufficient]'
      : '');
  return (
    `CHANGED FILES (status\tpath\t+added/-deleted):\n${header}\n\n` +
    `EVIDENCE (diff of the smell-tripping files ONLY, may be capped):\n${evidence.join('')}\n` +
    accounting
  );
}

// Parse the LLM verdict. Only a confident ROUTINE clears; anything ambiguous ("ROUTINE but
// also a DECISION"), unknown, or empty → null → the block stands (fail-safe toward recording).
export function parseVerdict(raw: string): 'ROUTINE' | 'DECISION' | null {
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
export function runDetectJudge(cwd: string, diff: string, model: string = 'haiku'): string | null {
  return execJudge({
    label: 'decision-smell',
    args: ['-p', '--model', model, ...JUDGE_READ_ONLY, ...JUDGE_ISOLATION, CLAUDE_PROMPT],
    input: String(diff).slice(0, 12000),
    timeout: 30000,
    cwd,
  });
}

// LLM downgrade: a confident ROUTINE clears a regex block; DECISION / error → the block stands.
// Never escalates. An outage is surfaced as 'OUTAGE' (distinct from a judged DECISION) so the
// gate can say WHY the block stood — a dark judge must never read as a confirmed smell verdict.
// Returns the raw judge transcript alongside the verdict so the caller can persist it (fetchable
// evidence for the dashboard); raw is null when the judge did not run (noLlm/empty) or on outage.
function judgeWithClaude(
  cwd: string,
  noLlm: boolean,
  diff: string,
): { verdict: 'ROUTINE' | 'DECISION' | 'OUTAGE' | null; raw: string | null } {
  if (noLlm || !diff) return { verdict: null, raw: null };
  const raw = runDetectJudge(cwd, diff);
  if (raw === null) return { verdict: 'OUTAGE', raw: null };
  return { verdict: parseVerdict(raw), raw };
}

// GUARD_AI_STRICT/FRINK_AI_STRICT truthy check (ship-only strict mode). Local copy on
// purpose for now — the shared hoist is tracked (envFlag consolidation).
function strictShip() {
  const v = process.env.GUARD_AI_STRICT ?? process.env.FRINK_AI_STRICT;
  if (v === undefined) return false;
  const t = String(v).trim().toLowerCase();
  return !(t === '' || t === '0' || t === 'false' || t === 'no');
}

function decisionStaged(cwd: string, decisionFileMatcher: RegExp): boolean {
  const names = git(cwd, ['diff', '--cached', '--name-only']);
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
    const entries = gatherEntries(cwd);
    const smells = detectSmells(entries, cfg.boundaries);
    const staged = decisionStaged(cwd, decisionMatcher);
    const verdict = gateVerdict({ bypass: cfg.noLog, decisionStaged: staged, smells });
    if (verdict === 0) {
      // Announce the pass (parity with the reviewer gate, which prints a line per reviewer) so a
      // clean run is visibly RUN, not silently absent — under the hook's "🧭 Decision-log gate…"
      // header, and as a telemetry pass event the dashboard can surface.
      const detail = cfg.noLog
        ? 'bypassed (GUARD_NO_LOG)'
        : smells.length === 0
          ? 'no architectural smell — routine ✓'
          : `decision recorded ✓ (${smells.join(', ')})`;
      console.error(`decision-gate: ${detail}`);
      emitGateEvent({ type: 'gate_result', gate: 'decisions', status: 'pass', detail });
      process.exit(0);
    }
    // Regex says block — let the LLM try to clear a false positive (dep bump, sync, etc.).
    // Evidence-only input: the smelled files' hunks, never the whole diff (see buildDetectJudgeInput).
    // Prefixes forced OFF-config: a consumer's diff.noprefix/mnemonicPrefix must not change the
    // segment-header format the extractor matches against (W-3: consumer git config is theirs).
    const input = buildDetectJudgeInput(
      git(cwd, [
        '-c',
        'diff.noprefix=false',
        '-c',
        'diff.mnemonicPrefix=false',
        'diff',
        '--cached',
      ]),
      entries,
      cfg.boundaries,
    );
    // An earned ROUTINE is cached on the exact evidence bytes: an identical re-run (a ship
    // retry after an unrelated gate/timeout failure) clears without re-spending the judge.
    const key = verdictKey('detect', input);
    if (hasVerdict(cwd, key)) {
      const detail = 'cached ROUTINE (identical evidence) — cleared';
      console.error(`decision-gate: ${detail}`);
      emitGateEvent({ type: 'gate_result', gate: 'decisions', status: 'pass', detail });
      process.exit(0);
    }
    const { verdict: judged, raw } = judgeWithClaude(cwd, cfg.noLlm, input);
    // Persist the judge's evidence (the diff) + its verdict as a fetchable transcript (no-op off-run).
    const transcriptRef =
      raw !== null
        ? saveTranscript('decisions', composeTranscript(input, `VERDICT: ${judged}\n${raw}`))
        : null;
    const ref = transcriptRef ? { transcript_ref: transcriptRef } : {};
    if (judged === 'ROUTINE') {
      saveVerdict(cwd, key);
      const detail = `judge cleared as ROUTINE ✓ (was: ${smells.join(', ')})`;
      console.error(`decision-gate: ${detail}`);
      emitGateEvent({ type: 'gate_result', gate: 'decisions', status: 'pass', detail, ...ref });
      process.exit(0);
    }
    if (judged === 'OUTAGE') {
      // Fail-closed toward recording, but say so honestly: the smell below was NOT judge-confirmed.
      console.error(
        'decision-gate: judge unavailable — the regex block below stands UNVERIFIED. If it looks',
      );
      console.error(
        '   like a false positive: fix `claude` CLI auth/quota and retry, or bypass a non-decision',
      );
      console.error('   with GUARD_NO_LOG=1.');
      if (strictShip()) {
        // Strict ship contract: an outage is exit 3 (judge-unavailable, failed closed), never
        // exit 1 — the hook must not render a dark judge as a confirmed decision smell.
        console.error(`decision smells (unverified): ${smells.join(', ')}`);
        emitGateEvent({
          type: 'gate_result',
          gate: 'decisions',
          status: 'fail',
          detail: smells.join(', '),
          ...ref,
        });
        process.exit(3);
      }
    }
    console.error(`decision smells: ${smells.join(', ')}`);
    emitGateEvent({
      type: 'gate_result',
      gate: 'decisions',
      status: 'fail',
      detail: smells.join(', '),
      ...ref,
    });
    process.exit(1);
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`decision-gate: could not run — ${reason}`);
    process.exit(2); // fail-open
  }
}

function runScan(mode: DiffMode): void {
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
