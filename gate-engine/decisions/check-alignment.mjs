#!/usr/bin/env node

/**
 * Decision-alignment gate (does the code still match the recorded Target?).
 *
 * Each epic Target may declare a `**Scope:**` glob (the files/area it governs). At commit, for every
 * Target whose scope DETERMINISTICALLY matches a staged file, an AGENTIC judge (`claude -p` with
 * read-only tools: Read/Grep/Glob/`git diff`) investigates the staged changes itself — pulling the
 * hunks it needs and reading surrounding code — then rules ALIGN / CONTRADICT / UNCLEAR with a
 * rationale and a final `VERDICT:` line. Tool-equipped judges beat stuffed-context single-shot ones
 * on code (Agent-as-a-Judge, arXiv:2410.10934; context-length hurts verification, arXiv:2602.03053),
 * and exploration removes the truncated-diff blind spot.
 *
 * CASCADE (arXiv:2511.07396 shape): haiku judges every scoped commit (cheap, one call). ONLY a haiku
 * CONTRADICT escalates to opus, which gets haiku's full transcript (the evidence, not a lossy
 * summary) plus the same tools, and independently confirms or overturns. A block requires an
 * opus-confirmed CONTRADICT — opus latency is paid only when a block is already on the table.
 *
 * Separate from detect.mjs (which BLOCKS on an *unrecorded* decision and PASSES when one is staged);
 * this gate never touches that branch.
 *
 * Also runs a WARN-ONLY depth pass: for every staged decision *.md, the current Target block is
 * judged for RATIONALE DEPTH (Context not circular · each rejected road paired with its losing
 * criterion · the Negative concrete) → PASS / THIN. A THIN warns; it does NOT block unless
 * GUARD_DEPTH_HARD=1.
 *
 * Contract:
 *   --gate : exit 1 = a confident CONTRADICT (or a confident THIN under GUARD_DEPTH_HARD) ·
 *            exit 0 = aligned / unclear / no-scope-match / depth-warn / no-claude / opted-out ·
 *            exit 2 = could-not-run (git error) → fail-open
 *   scan   : print {target, matched files} pairs, exit 0
 *
 * Knobs: GUARD_NO_LOG=1 (skip — same bypass as the decision gate) · GUARD_DECISION_NO_LLM=1 (skip —
 * can't judge without the LLM) · GUARD_DEPTH_HARD=1 (escalate a confident THIN to a block) ·
 * no `claude` binary → skip (fail-open, silent no-op). FRINK_* aliases honoured for back-compat.
 *
 * ── W-3 (portability invariant) ──────────────────────────────────────────────────
 * The decisions dir + the noLog/noLlm knobs come from resolveGuardConfig(cwd); git runs in the
 * CONSUMER cwd. Nothing anchors to the package dir. Run from a consumer's node_modules, this gate
 * judges THAT repo's staged changes against THAT repo's decision log.
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveFromCwd, resolveGuardConfig } from '../config.mjs';
import { JUDGE_ISOLATION, JUDGE_READ_ONLY } from '../judge/judge-isolation.mjs';
import { execJudge } from '../judge/run-judge.mjs';
import { currentTarget, parseDecision } from './decisions.mjs';

// glob → regex literals. ** = any incl. `/`; * = any non-slash; ? = one non-slash.
const GLOB_ESC_RE = /[.+^${}()|[\]\\]/g;
const GLOB_STARS_RE = /\*\*|\*|\?/g; // wildcards in ONE pass (** before *; ? is single-char, no placeholder)
const ALIGN_RE = { CONTRADICT: /\bCONTRADICT\b/, ALIGN: /\bALIGN\b/, UNCLEAR: /\bUNCLEAR\b/ };
// Tolerates markdown dressing (bold/bullet/heading) around the line — a judge that formats its
// verdict must not silently fall through to the ambiguous-word fallback and lose a block.
const VERDICT_LINE_RE = /^[\s*#>-]*VERDICT:\s*\**\s*(ALIGN|CONTRADICT|UNCLEAR)\b/gim;
const DEPTH_RE = { PASS: /\bPASS\b/, THIN: /\bTHIN\b/ };

// Read-only investigation surface for the judge. `git diff` (pattern-scoped Bash) is how it reads
// STAGED hunks — worktree Reads alone would miss partial staging.
const JUDGE_TOOLS = 'Read,Grep,Glob,Bash(git diff:*)';
const HAIKU_TIMEOUT_MS = 120000;
const OPUS_TIMEOUT_MS = 240000; // escalation only fires pre-block; cold-start headroom

const ALIGN_PROMPT = (ruling, vision, files) =>
  'You are judging whether STAGED code changes contradict a recorded architectural decision.\n' +
  `Target ruling: ${ruling}\n` +
  `Target vision: ${vision}\n` +
  `Staged files in this target's scope: ${files.join(', ')}\n` +
  'A diffstat is on stdin. INVESTIGATE before judging: run `git diff --cached -- <file>` to read the ' +
  'actual staged hunks, and Read surrounding code where a hunk alone is ambiguous.\n' +
  'Does the change CONTRADICT this target (move the code away from the ruling/vision), ALIGN with it ' +
  '(advance or stay within it), or is it UNCLEAR? A normal implementation step toward the target is ' +
  'ALIGN, not CONTRADICT.\n' +
  'Reply with 2-4 sentences of rationale citing file:line evidence, then END with exactly one line:\n' +
  'VERDICT: ALIGN | CONTRADICT | UNCLEAR';

const ESCALATE_PROMPT = (ruling, vision, files, firstPass) =>
  `${ALIGN_PROMPT(ruling, vision, files)}\n\n` +
  'A first-pass reviewer (smaller model) judged CONTRADICT. Its full notes:\n' +
  '─────\n' +
  `${firstPass}\n` +
  '─────\n' +
  'Independently verify its evidence with your own investigation — confirm or overturn. ' +
  'Your verdict is final; a CONTRADICT blocks the commit.';

// The depth rubric — a SOFT lint. Judges the *content* of an already-recorded Target, since the
// schema already requires the fields (a non-empty field can still be shallow). Warn-only by default.
const DEPTH_PROMPT =
  'A decision-log Target block (on stdin) records an architectural decision. Judge its RATIONALE DEPTH:\n' +
  '1. Does Context state a forcing COST/failure that made the status quo untenable — NOT merely restate a prior ruling or the new mechanism (circular)?\n' +
  '2. Is each rejected alternative paired with the concrete CRITERION it loses on, not just named?\n' +
  '3. Is the Negative consequence concrete and specific, NOT a platitude?\n' +
  'Reply THIN if ANY check fails, else PASS. Reply with exactly one word: PASS or THIN.';

// ─── Env helper for alignment-only knobs (GUARD_* with FRINK_* back-compat alias) ─
// The shared config owns noLog/noLlm; GUARD_DEPTH_HARD is alignment-specific, so it lives here,
// mirroring config's alias semantics (GUARD_* wins, FRINK_* is the legacy fallback).
function envFlag(name) {
  const v = process.env[`GUARD_${name}`] ?? process.env[`FRINK_${name}`];
  if (v === undefined) return false;
  const t = String(v).trim().toLowerCase();
  return !(t === '' || t === '0' || t === 'false' || t === 'no');
}

// ─── Pure logic (testable without git/claude) ───────────────────────────────────

function globToRe(glob) {
  const re = glob
    .trim()
    .replace(GLOB_ESC_RE, '\\$&')
    .replace(GLOB_STARS_RE, (m) => (m === '**' ? '.*' : m === '*' ? '[^/]*' : '[^/]'));
  return new RegExp(`^${re}$`);
}

/** Deterministic: does any changed file match any of the Target's scope globs? */
export function matchScope(files, globs) {
  const res = globs.map(globToRe);
  return files.some((f) => res.some((re) => re.test(f)));
}

/**
 * Bounded verdict: the LAST `VERDICT:` line wins (the prompt asks for rationale first, so the body
 * may mention several verdict words). No VERDICT line → fall back to the strict exactly-one-word
 * scan. Ambiguity / unknown / empty → null (→ pass).
 */
export function parseAlignVerdict(raw) {
  const out = String(raw).toUpperCase();
  const lines = [...out.matchAll(VERDICT_LINE_RE)];
  if (lines.length > 0) return lines[lines.length - 1][1];
  const hits = ['CONTRADICT', 'ALIGN', 'UNCLEAR'].filter((v) => ALIGN_RE[v].test(out));
  return hits.length === 1 ? hits[0] : null;
}

/** Block ONLY on a confident CONTRADICT. Everything else passes (fail-safe toward not blocking). */
export function gateExit(verdict) {
  return verdict === 'CONTRADICT' ? 1 : 0;
}

/** Bounded one-word depth verdict; ambiguity / unknown / empty → null (→ no warn). */
export function parseDepthVerdict(raw) {
  const out = String(raw).toUpperCase();
  const hits = ['PASS', 'THIN'].filter((v) => DEPTH_RE[v].test(out));
  return hits.length === 1 ? hits[0] : null;
}

// ─── git + fs + claude I/O (thin; run in the CONSUMER cwd) ───────────────────────

function sh(cwd, cmd) {
  return execSync(cmd, { cwd, encoding: 'utf8' });
}

function stagedFiles(cwd) {
  return sh(cwd, 'git diff --cached --name-only')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Every axis whose CURRENT Target declares a Scope → {slug, ruling, vision, scopeGlobs}. */
export function loadScopedTargets(dir) {
  const target = dir ?? resolveFromCwd(resolveGuardConfig(process.cwd()), 'decisionsDir');
  if (!existsSync(target)) return [];
  const out = [];
  for (const f of readdirSync(target)) {
    if (!f.endsWith('.md') || f === 'INDEX.md') continue;
    const t = currentTarget(parseDecision(readFileSync(path.join(target, f), 'utf8')).body);
    if (!t?.scope) continue;
    out.push({
      slug: f.slice(0, -3),
      ruling: t.ruling,
      vision: t.fields['vision-fit'] ?? t.fields.context ?? '',
      scopeGlobs: t.scope
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    });
  }
  return out;
}

/**
 * One agentic judge run; raw transcript or null (claude absent / offline / timeout → no block;
 * execJudge warns once on stderr). JUDGE_ISOLATION silences host hooks + keeps the run off the
 * session store; NO JUDGE_READ_ONLY — this judge must investigate. Argv order matters:
 * `--allowedTools` is VARIADIC — anything after it (incl. a positional prompt) is swallowed into
 * the tools list, silently leaving stdin as the prompt. Prompt first, tools last.
 */
function runJudge(cwd, model, prompt, stdinText, timeout) {
  return execJudge({
    label: 'decision-alignment',
    args: ['-p', prompt, '--model', model, ...JUDGE_ISOLATION, '--allowedTools', JUDGE_TOOLS],
    input: stdinText,
    timeout,
    cwd,
  });
}

/**
 * Cascade with full observability: haiku investigates every scoped commit; ONLY its CONTRADICT
 * escalates to opus (unless `escalate` is off), which re-investigates with haiku's full transcript
 * as the handoff. Fail-open at both steps. Returns null on the noLlm/no-files guard, else
 * `{firstRaw, firstVerdict, finalRaw, finalVerdict, escalated}` — the gate consumes finalVerdict
 * via judge(); eval/bench.mjs consumes the intermediate fields to score haiku-alone vs cascade.
 * The opts exist for the bench; the gate never passes them, so gate semantics are the defaults.
 */
export function judgeDetailed(
  files,
  target,
  cwd = process.cwd(),
  { firstModel = 'haiku', escalateModel = 'opus', escalate = true } = {},
) {
  const cfg = resolveGuardConfig(cwd);
  if (cfg.noLlm || files.length === 0) return null;
  const stat = sh(
    cwd,
    `git diff --cached --stat -- ${files.map((f) => JSON.stringify(f)).join(' ')}`,
  );
  const first = runJudge(
    cwd,
    firstModel,
    ALIGN_PROMPT(target.ruling, target.vision, files),
    stat,
    HAIKU_TIMEOUT_MS,
  );
  if (first === null)
    return {
      firstRaw: null,
      firstVerdict: null,
      finalRaw: null,
      finalVerdict: null,
      escalated: false,
    };
  const firstVerdict = parseAlignVerdict(first);
  if (firstVerdict !== 'CONTRADICT' || !escalate)
    return {
      firstRaw: first,
      firstVerdict,
      finalRaw: first,
      finalVerdict: firstVerdict,
      escalated: false,
    };
  const second = runJudge(
    cwd,
    escalateModel,
    ESCALATE_PROMPT(target.ruling, target.vision, files, first),
    stat,
    OPUS_TIMEOUT_MS,
  );
  return {
    firstRaw: first,
    firstVerdict,
    finalRaw: second,
    finalVerdict: second === null ? null : parseAlignVerdict(second),
    escalated: true,
  };
}

/** Block = opus-confirmed CONTRADICT; every guard/outage path stays null (fail-open). */
export function judge(files, target, cwd = process.cwd()) {
  const d = judgeDetailed(files, target, cwd);
  return d === null ? null : d.finalVerdict;
}

/**
 * cwd-relative path of the decisions dir, robust to the /tmp↔/private/tmp symlink (macOS) and to
 * an absolute env-configured dir: both endpoints are realpath-canonicalised before relativising, so
 * the staged-file prefix filter below compares like for like. Returns '' if the dir is outside cwd.
 */
function decisionsDirRel(cwd, cfg) {
  const abs = resolveFromCwd(cfg, 'decisionsDir');
  const canon = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p; // dir may not exist yet — fall back to the literal path
    }
  };
  const rel = path.relative(canon(cwd), canon(abs));
  return rel.startsWith('..') ? '' : rel;
}

/** Staged decision *.md → [{slug, block}] (the STAGED blob, so partial staging is honoured). */
function stagedDecisionTargets(cwd, changed, decisionsRel) {
  const out = [];
  for (const f of changed) {
    if (!f.endsWith('.md') || path.basename(f) === 'INDEX.md') continue;
    if (decisionsRel && !f.startsWith(`${decisionsRel}/`)) continue;
    let content;
    try {
      content = sh(cwd, `git show ${JSON.stringify(`:${f}`)}`);
    } catch {
      continue; // not in the index (e.g. a pure deletion) → nothing to judge
    }
    const t = currentTarget(parseDecision(content).body);
    if (t?.block) out.push({ slug: path.basename(f, '.md'), block: t.block });
  }
  return out;
}

/**
 * One depth-judge run → raw transcript, or null on outage (execJudge warns once). Pure-text judge:
 * READ_ONLY before ISOLATION (variadic bounding), positional prompt last. Exported so eval/bench.mjs
 * exercises the exact prompt/argv/truncation/timeout the gate runs — and can distinguish outage
 * (raw null) from parse-null, which judgeDepth below deliberately conflates.
 */
export function runDepthJudge(cwd, block, model = 'haiku') {
  return execJudge({
    label: 'decision-depth',
    args: ['-p', '--model', model, ...JUDGE_READ_ONLY, ...JUDGE_ISOLATION, DEPTH_PROMPT],
    input: String(block).slice(0, 12000),
    timeout: 120000,
    cwd,
  });
}

function judgeDepth(cwd, noLlm, block) {
  if (noLlm || !block.trim()) return null;
  const raw = runDepthJudge(cwd, block);
  return raw === null ? null : parseDepthVerdict(raw);
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

// WARN-ONLY: flag THIN Targets among staged decision files (the schema already requires the fields;
// this judges whether they SAY anything). The author deepens the still-uncommitted block in place.
// Returns true only when GUARD_DEPTH_HARD must escalate a confident THIN to a block.
function depthPass(cwd, cfg, changed) {
  let block = false;
  // Staged file names are cwd-relative; the decisions dir may be configured absolute (env) or
  // relative (file). Compare both in cwd-relative form so the prefix filter actually matches.
  const decisionsRel = decisionsDirRel(cwd, cfg);
  for (const d of stagedDecisionTargets(cwd, changed, decisionsRel)) {
    if (judgeDepth(cwd, cfg.noLlm, d.block) !== 'THIN') continue;
    console.error(
      `decision-depth: target "${d.slug}" reads THIN — Context may restate the prior ruling, ` +
        'a rejected road may lack the criterion it loses on, or the Negative may be a platitude. ' +
        'Deepen the block before committing (it is still uncommitted).',
    );
    if (envFlag('DEPTH_HARD')) block = true;
  }
  return block;
}

// Blocks (process.exit 1) on a confident CONTRADICT of a scoped Target — the flip-flop guard.
function alignmentPass(cwd, cfg, changed) {
  const dir = resolveFromCwd(cfg, 'decisionsDir');
  for (const t of loadScopedTargets(dir)) {
    const matched = changed.filter((f) => matchScope([f], t.scopeGlobs));
    if (matched.length === 0) continue;
    if (gateExit(judge(matched, t, cwd)) !== 1) continue;
    console.error(
      `decision-alignment: code in ${matched.join(', ')} CONTRADICTS target "${t.slug}":`,
    );
    console.error(`  ${t.ruling}`);
    console.error(
      'Realign the code, or re-target if the evidence genuinely shifted:\n' +
        `  guard-decisions add ${t.slug} --target … --evidence-change "<what changed>"`,
    );
    process.exit(1);
  }
}

function runGate() {
  const cwd = process.cwd();
  const cfg = resolveGuardConfig(cwd);
  if (cfg.noLog) process.exit(0);
  try {
    const changed = stagedFiles(cwd);
    if (changed.length === 0) process.exit(0);
    const depthBlock = depthPass(cwd, cfg, changed); // warn-only (or block under GUARD_DEPTH_HARD)
    alignmentPass(cwd, cfg, changed); // exits 1 on a confident CONTRADICT
    process.exit(depthBlock ? 1 : 0);
  } catch (e) {
    console.error(`decision-alignment: could not run — ${e?.message ?? e}`);
    process.exit(2); // fail-open
  }
}

function runScan() {
  const cwd = process.cwd();
  // Reason: two independent decision-gate CLIs (alignment flip-flop vs architectural smell); the resolve-scan-exit shape rhymes but each scans a different thing; sharing would add the cross-engine dependency the engines avoid
  // fallow-ignore-next-line code-duplication
  try {
    const cfg = resolveGuardConfig(cwd);
    const dir = resolveFromCwd(cfg, 'decisionsDir');
    const changed = stagedFiles(cwd);
    for (const t of loadScopedTargets(dir)) {
      const matched = changed.filter((f) => matchScope([f], t.scopeGlobs));
      if (matched.length) console.log(`${t.slug}: ${matched.join(', ')}`);
    }
  } catch {
    // informational — silent on error
  }
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  const cmd = process.argv[2];
  if (cmd === '--gate') runGate();
  else if (cmd === 'scan') runScan();
  else {
    console.error('Usage: check-alignment.mjs --gate | scan');
    process.exit(2);
  }
}
