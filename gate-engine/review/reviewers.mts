/**
 * Pure logic for the review gate (guard-review) — no fs/git/claude I/O, so every rule here is
 * unit-testable: the reviewer table, domain selection, prompt wrapping, verdict parsing, tool
 * allowlists and cache keys. Orchestration (spawning judges, git, the cache file) lives in
 * run-review.mjs / cache.mjs.
 *
 * The reviewer TABLE is the generator and ships here; the PATHS it triggers on are consumer data
 * (guard.config.json `review.backendRoots` / `review.frontendRoots` / `scanRoots`) — ship the
 * generator, never the data.
 */

import { createHash } from 'node:crypto';
import { type GuardConfig, sourceMatchers } from '../config.mts';

/** The resolved governance-gate config shape (the review cluster reads its `review.*`, `scanRoots`,
 * `sourceExtensions` and `searchTool` fields). Derived from the shared loader so it never drifts. */

/** One entry of the REVIEWERS table — a domain reviewer's identity + its checklist binding. */
export interface Reviewer {
  name: string;
  domain: string;
  /** Absent for a SKILL-LESS reviewer (e.g. conventions-reviewer): no checklist.mjs binding, no
   * Bash grant beyond the read-only base, no verifyChecklist call — its PASS is trusted directly,
   * the same trust level completeness.mts already uses for its own straight verdict. Present for
   * every checklist-driven reviewer, whose skill/stateFile/cmds always travel together. */
  skill?: string;
  stateFile?: string;
  cmds?: { gen: string; check: string };
  /** When set, the reviewer runs SINGLE-PASS at this model — no sonnet→opus cascade, its FAIL
   * blocks directly. Used by the correctness reviewer: the reviewer-eval bench measured that the
   * opus escalation OVERTURNS real correctness bugs (a "confirm or overturn" opus, handed a subtle
   * race/contract bug, tends to overturn), dropping gold recall from 0.78 first-pass to 0.67
   * end-to-end. A cascade also cannot fix a first-pass MISS. So this lens gets one strong-enough
   * pass and no second-guessing. Domain reviewers leave it unset — the cascade HELPS them (opus
   * overturns their false-FAILs on decoys). Also used by conventions-reviewer, per the ticket's
   * own haiku mandate.
   */
  model?: string;
}

/** A checklist-driven reviewer — skill/stateFile/cmds always travel together (see Reviewer.skill
 * docstring); this is the type `hasChecklist` proves at compile time so `wrapPrompt`/checklist
 * helpers never need a runtime null-check for an invariant the table itself already guarantees. */
export type ChecklistReviewer = Reviewer & Required<Pick<Reviewer, 'skill' | 'stateFile' | 'cmds'>>;

/** Type guard: does this REVIEWERS entry use the checklist workflow? Skill-less reviewers (e.g.
 * conventions-reviewer) don't — see Reviewer.skill docstring. */
export function hasChecklist(reviewer: Reviewer): reviewer is ChecklistReviewer {
  return reviewer.skill !== undefined;
}

/** A selected reviewer paired with the staged files under its roots that triggered it. */
export interface ReviewerSelection {
  reviewer: Reviewer;
  files: string[];
}

/** One row of a reviewer's checklist artifact (domain reviewers use `items[]`, commit-guard `files[]`). */
export interface ChecklistItem {
  status?: string;
  name?: string;
  path?: string;
}

/** Parsed checklist state-file artifact the judge's workflow leaves behind. */
export interface ChecklistState {
  items?: ChecklistItem[];
  files?: ChecklistItem[];
}

/** A parsed VERDICT line: the token (null when no VERDICT line) + its markdown-stripped reason. */
export interface ReviewVerdict {
  verdict: string | null;
  reason: string;
}

/**
 * The domain reviewers the gate can run, in display order. `domain` picks which config roots
 * trigger the reviewer; commit-guard additionally gets the consumer's semantic search tool
 * (its brief is duplicate-detection — Read/Grep alone cannot see semantic twins).
 *
 * `skill`/`stateFile`/`cmds` bind each reviewer to its CHECKLIST workflow (the synced
 * `.claude/skills/<skill>/scripts/checklist.mjs`): the script deterministically enumerates
 * review items (per staged FILE for commit-guard, per detected pattern CATEGORY for the domain
 * reviewers) and its finalize refuses pending items — the benchmarked mechanism that stops a
 * reviewer from hallucinating coverage. The judge RUNS that workflow; the gate then verifies
 * the state-file artifact independently (verifyChecklist) so a skipped checklist can never PASS.
 */
export const REVIEWERS = Object.freeze([
  Object.freeze({
    name: 'api-security-reviewer',
    domain: 'backend',
    skill: 'api-security',
    stateFile: '.claude/.api-security-review.json',
    cmds: Object.freeze({ gen: 'generate', check: 'check-item' }),
  }),
  Object.freeze({
    name: 'backend-performance-reviewer',
    domain: 'backend',
    skill: 'backend-performance',
    stateFile: '.claude/.backend-performance-review.json',
    cmds: Object.freeze({ gen: 'generate', check: 'check-item' }),
  }),
  Object.freeze({
    name: 'frontend-security-reviewer',
    domain: 'frontend',
    skill: 'frontend-security',
    stateFile: '.claude/.frontend-security-review.json',
    cmds: Object.freeze({ gen: 'generate', check: 'check-item' }),
  }),
  Object.freeze({
    name: 'frontend-performance-reviewer',
    domain: 'frontend',
    skill: 'frontend-performance',
    stateFile: '.claude/.frontend-performance-review.json',
    cmds: Object.freeze({ gen: 'generate', check: 'check-item' }),
  }),
  Object.freeze({
    name: 'commit-guard',
    domain: 'code',
    skill: 'commit-guard',
    stateFile: '.claude/.pre-commit-review.json',
    cmds: Object.freeze({ gen: 'init', check: 'check-file' }),
  }),
  // Correctness is NOT domain-sliceable: a writer in a backend root and its reader in a frontend
  // root are ONE finding, so this reviewer sees SOURCE files across the UNION of declared roots.
  // Four ALWAYS-ON lenses — a correctness bug has no reliable lexical signature, so a regex gate
  // would blind exactly the class this reviewer exists to catch. Runs the normal haiku→opus
  // cascade like the others; the real-findings bench decides whether the first pass holds.
  Object.freeze({
    name: 'correctness-reviewer',
    domain: 'all',
    skill: 'correctness',
    stateFile: '.claude/.correctness-review.json',
    cmds: Object.freeze({ gen: 'generate', check: 'check-item' }),
    // Single-pass haiku (see Reviewer.model): bench-measured held-out recall 0.73 / precision 1.00
    // with perfect domain-exclusivity — the cascade only subtracted here.
    model: 'haiku',
  }),
  // Checks a diff against the CONSUMER repo's own written CLAUDE.md rules — never devkit's own.
  // SKILL-LESS (no skill/stateFile/cmds — see Reviewer.skill docstring): its AC forbids Bash
  // entirely (Read/Grep/Glob only), so it cannot run the checklist.mjs workflow every other entry
  // depends on. Its anti-hallucination substitute is the AC's own contract: flag a violation ONLY
  // when it can quote both the exact rule and the exact offending line, else stay silent — no
  // artifact to verify, so a PASS is trusted directly (cascadeVerdict/runCascade branch on
  // `!reviewer.skill`). `domain: 'conventions'` reuses the 'all' root union (rootsFor) but is
  // exempt from selectReviewers' isSource/isTest filters — a CLAUDE.md rule can govern any staged
  // file type (docs, config, tests), not just source. Single-pass haiku per the ticket mandate: no
  // cascade, FAIL blocks directly, and joins the override valve (overrides.mts) like correctness.
  Object.freeze({
    name: 'conventions-reviewer',
    domain: 'conventions',
    model: 'haiku',
  }),
]);

// Synced-skill layout is devkit's own convention (sync-skills targets .claude/skills), so the
// checklist script path is fixed relative to the consumer root — unlike scan/review ROOTS,
// which are consumer data and come from guard.config.json.
export const checklistScript = (reviewer: ChecklistReviewer) =>
  `.claude/skills/${reviewer.skill}/scripts/checklist.mjs`;

// Read-only investigation surface (mirrors check-alignment's JUDGE_TOOLS + log/status for context).
// No naked Bash: a gate judge must never be able to write, stage, or commit.
const BASE_TOOLS = 'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git status:*)';

// Tolerates markdown dressing around the verdict line; the LAST match wins (the body may discuss
// pass/fail while reasoning). Deliberately NO bare-word fallback — unlike ALIGN/CONTRADICT,
// "pass"/"fail" saturate ordinary review prose, so a missing VERDICT line must read as "no
// verdict" (null → no block, no cache), never be guessed from body words.
const VERDICT_LINE_RE = /^[\s*#>-]*VERDICT:\s*\**\s*(PASS|FAIL)\b\**\s*(?:[—–:-]+\s*)?(.*)$/gim;

// Leading YAML frontmatter (the agent .md header is Task-tool metadata, not brief).
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n/;

/** The config roots that trigger a reviewer's domain. */
export function rootsFor(reviewer: Reviewer, cfg: GuardConfig): string[] {
  if (reviewer.domain === 'backend') return cfg.review.backendRoots;
  if (reviewer.domain === 'frontend') return cfg.review.frontendRoots;
  // `all` = the deduped union of every DECLARED root (scan + backend + frontend) — never `['.']`:
  // undeclared trees (vendored code, scripts) are outside the consumer's stated review surface.
  // `conventions` shares this union (a CLAUDE.md rule anywhere in the declared surface is fair
  // game) but — unlike `all` — is never filtered to source-only in selectReviewers below.
  if (reviewer.domain === 'all' || reviewer.domain === 'conventions')
    return [
      ...new Set([...cfg.scanRoots, ...cfg.review.backendRoots, ...cfg.review.frontendRoots]),
    ];
  return cfg.scanRoots;
}

function underRoot(file: string, root: string): boolean {
  const r = root.endsWith('/') ? root.slice(0, -1) : root;
  return file === r || file.startsWith(`${r}/`);
}

/**
 * Which reviewers must run for this staged set → [{reviewer, files}]. Backend/frontend trigger on
 * ANY staged file under their roots (matching the old husky HAS_BACKEND/HAS_FRONTEND semantics);
 * commit-guard triggers only on source files under scanRoots (its brief is code duplication —
 * a staged JSON or doc under src/ is not its business). Empty roots (e.g. a repo with no
 * configured frontend) simply never select that domain.
 */
export function selectReviewers(stagedFiles: string[], cfg: GuardConfig): ReviewerSelection[] {
  const { isSource, isTest } = sourceMatchers(cfg.sourceExtensions);
  return REVIEWERS.map((reviewer) => {
    const roots = rootsFor(reviewer, cfg);
    let files = stagedFiles.filter((f) => roots.some((r) => underRoot(f, r)));
    // code + all trigger only on SOURCE files: a staged JSON/doc is neither a duplication nor a
    // correctness concern.
    if (reviewer.domain === 'code' || reviewer.domain === 'all')
      files = files.filter((f) => isSource(f.split('/').pop() ?? ''));
    // The correctness charter is RUNTIME defects — a test-only hunk cannot introduce one, and
    // test files are ~half a branch diff's bytes: excluding them keeps the judge inside its
    // timeout on a ship-sized diff. Test adequacy is the testing reviewer's charter.
    if (reviewer.domain === 'all') files = files.filter((f) => !isTest(f.split('/').pop() ?? ''));
    return { reviewer, files };
  }).filter((s) => s.files.length > 0);
}

/**
 * Comma-joined --allowedTools value for one reviewer: the read-only base, PLUS its own checklist
 * script (the one non-git Bash prefix a judge gets — scoped to that exact script path, so the
 * judge can drive its checklist but still cannot write files, stage, or commit), PLUS the
 * consumer's semantic search tool for commit-guard.
 */
export function allowedToolsFor(reviewer: Reviewer, cfg: GuardConfig): string {
  // A skill-less reviewer (e.g. conventions-reviewer) has no checklist script to grant Bash for,
  // and its AC forbids Bash entirely — Read/Grep/Glob only, full stop, no BASE_TOOLS git-diff Bash
  // either (its evidence is pre-rendered onto stdin/prompt instead — see wrapConventionsPrompt).
  if (!hasChecklist(reviewer)) return 'Read,Grep,Glob';
  const tools = `${BASE_TOOLS},Bash(node ${checklistScript(reviewer)}:*)`;
  if (reviewer.domain === 'code') return `${tools},${cfg.searchTool}`;
  // The correctness reviewer's writer/reader-contract lens benefits from semantic search, but
  // only when the consumer actually wired an index (indexPath set) — otherwise cfg.searchTool is
  // a generic default naming an MCP tool the judge doesn't have, and Grep is the core mechanism.
  if (reviewer.domain === 'all' && cfg.indexPath) return `${tools},${cfg.searchTool}`;
  return tools;
}

/** Strip a leading YAML frontmatter block from an agent .md. */
export function stripFrontmatter(md: string): string {
  const m = String(md).match(FRONTMATTER_RE);
  return m ? md.slice(m[0].length) : String(md);
}

/**
 * Wrap an interactive reviewer brief for headless gate use. The SAME synced .md serves both
 * surfaces: interactively the root agent dispatches it via the Task tool; in the gate this
 * preamble re-scopes it (staged-only, checklist-driven, no marker/approve machinery) and the
 * postamble pins the machine-parseable verdict line.
 */
export function wrapPrompt(
  agentBody: string,
  reviewer: ChecklistReviewer,
  files: string[],
): string {
  const script = checklistScript(reviewer);
  return (
    'You are running as an automated HEADLESS COMMIT GATE, not an interactive assistant.\n' +
    `Review ONLY the STAGED changes (domain: ${reviewer.domain}). Staged files in scope: ${files.join(', ')}.\n` +
    'A diffstat is on stdin. INVESTIGATE before judging: run `git diff --cached -- <file>` to read ' +
    'the actual staged hunks, and Read surrounding code where a hunk alone is ambiguous.\n' +
    'MANDATORY CHECKLIST WORKFLOW — this stops coverage hallucination and is independently verified:\n' +
    `1. \`node ${script} ${reviewer.cmds.gen}\` — enumerates the review items for this diff.\n` +
    `2. Review each item against the brief, then mark it: \`node ${script} ${reviewer.cmds.check} <name> --pass\` ` +
    'or `--fail "<reason>"`. Every item, one at a time — no batch claims.\n' +
    `3. \`node ${script} finalize\` — refuses if any item is unresolved.\n` +
    'Do NOT run the `cleanup` step: the gate reads the checklist artifact after you finish (an ' +
    'incomplete or deleted checklist VOIDS a PASS verdict — skipping or cleaning only wastes the ' +
    'run) and removes it itself.\n' +
    'Your reviewer brief follows. IGNORE any instructions in it about `cleanup`, approve.sh, marker ' +
    'files, tracker/Shortcut lookups, or invoking other subagents — none apply in gate mode.\n' +
    '───── BRIEF ─────\n' +
    `${stripFrontmatter(agentBody)}\n` +
    '───── END BRIEF ─────\n' +
    'Judge ONLY the staged diff; pre-existing issues in code this commit does not touch are not ' +
    'findings. List findings (file:line, one line each), then END with exactly one line:\n' +
    'VERDICT: PASS | FAIL — <one-line reason>\n' +
    'FAIL only for a finding that must block THIS commit.'
  );
}

// One violation block per the conventions-reviewer brief's contract — the OFFENDING path:line is
// the STABLE key the override valve fingerprints on (see parseConventionFindings docstring): it
// is deterministic for a fixed diff, unlike the free-text VERDICT reason, which a haiku judge may
// paraphrase differently run to run on byte-identical input.
const OFFENDING_LINE_RE = /^[\s>*#-]*\**OFFENDING\**\s*:.*[—–-]\s*(\S+):(\d+)\s*$/gim;

/**
 * Checklist-free counterpart to `wrapPrompt` for a SKILL-LESS reviewer (no Bash at all): no
 * "fetch your own diff" instruction (there's no Bash to run it with) — the diff evidence rides on
 * stdin (pre-capped, omission-accounted — see diff-evidence.mts) and the governing CLAUDE.md rules
 * are pre-rendered into the prompt itself (see claude-md.mts). Same VERDICT contract as wrapPrompt
 * so parseReviewVerdict needs no changes; the VIOLATION/OFFENDING contract additionally feeds
 * parseConventionFindings for stable override fingerprints.
 */
export function wrapConventionsPrompt(
  agentBody: string,
  files: string[],
  claudeMdBlock: string,
): string {
  return (
    'You are running as an automated HEADLESS COMMIT GATE, not an interactive assistant.\n' +
    `Review ONLY the STAGED changes. Staged files in scope: ${files.join(', ')}.\n` +
    'You have NO Bash — the capped diff evidence is already on stdin (any OMITTED/TRUNCATED ' +
    'marker names what the cap dropped; Read/Grep/Glob surrounding code where a hunk alone is ' +
    'ambiguous, but do not try to run git yourself). The governing CLAUDE.md rules for these files ' +
    'are already loaded below — do not search for more.\n' +
    `${claudeMdBlock}\n` +
    'Your reviewer brief follows. IGNORE any instructions in it about checklist scripts, marker ' +
    'files, tracker/Shortcut lookups, or invoking other subagents — none apply in gate mode.\n' +
    '───── BRIEF ─────\n' +
    `${stripFrontmatter(agentBody)}\n` +
    '───── END BRIEF ─────\n' +
    'Judge ONLY the staged diff against the governing rules above. For each violation, emit BOTH:\n' +
    '  VIOLATION: <exact quoted rule text> — <rule file>:<rule line>\n' +
    '  OFFENDING: <exact offending line, verbatim> — <offending file>:<offending line>\n' +
    'If you cannot quote both, do not flag it. No findings → say NO_VIOLATIONS. END with exactly ' +
    'one line:\n' +
    'VERDICT: PASS | FAIL — <one-line reason>\n' +
    'FAIL only for a clear, quotable violation that must block THIS commit.'
  );
}

/**
 * Parse the `OFFENDING: … — <path>:<line>` blocks from a conventions-reviewer transcript — used
 * ONLY to build the override valve's lens keys (never the free-text VERDICT reason: haiku's
 * one-line paraphrase of the SAME violation varies run-to-run on byte-identical input, which would
 * silently un-match a dev's already-committed waiver and re-block them; the offending path:line is
 * deterministic for a fixed diff, exactly like the checklist item names other reviewers key on).
 */
export function parseConventionFindings(
  raw: string,
): { offendingPath: string; offendingLine: number }[] {
  return [...String(raw).matchAll(OFFENDING_LINE_RE)].map((m) => ({
    offendingPath: m[1],
    offendingLine: Number(m[2]),
  }));
}

/**
 * Independent verification of the checklist artifact the judge's workflow left behind — the
 * gate-side half of the anti-hallucination contract. Returns null when the artifact is complete
 * and consistent with the verdict, else a human-readable reason (→ the cascade result becomes
 * inconclusive, never a PASS). A FAIL verdict needs no artifact scrutiny — it blocks regardless.
 *
 * @param state parsed state-file JSON (null = missing/unreadable)
 * @param verdict the judge's parsed verdict
 */
export function verifyChecklist(
  state: ChecklistState | null,
  verdict: 'PASS' | 'FAIL',
): string | null {
  if (verdict === 'FAIL') return null;
  const items = state?.items ?? state?.files; // domain reviewers use items[]; commit-guard files[]
  if (!Array.isArray(items) || items.length === 0)
    return (
      'checklist artifact missing — the judge skipped the checklist workflow (or its ' +
      'checklist script was never synced: devkit sync-skills)'
    );
  const pending = items.filter((i) => i.status === 'pending');
  if (pending.length > 0)
    return `checklist incomplete — ${pending.length} item(s) never resolved: ${pending
      .map((i) => i.name ?? i.path)
      .join(', ')}`;
  const failed = items.filter((i) => i.status === 'fail');
  if (failed.length > 0)
    return `checklist has ${failed.length} FAILED item(s) but the verdict says PASS: ${failed
      .map((i) => i.name ?? i.path)
      .join(', ')}`;
  return null;
}

/** Escalation prompt: opus independently re-verifies a first-pass FAIL (check-alignment shape). */
export function escalatePrompt(wrappedPrompt: string, firstPass: string): string {
  return (
    `${wrappedPrompt}\n\n` +
    'A first-pass reviewer (smaller model) judged FAIL. Its full notes:\n' +
    '─────\n' +
    `${firstPass}\n` +
    '─────\n' +
    'Independently verify its evidence with your own investigation — confirm or overturn. ' +
    'Your verdict is final; a FAIL blocks the commit.'
  );
}

/**
 * Bounded verdict: the LAST `VERDICT:` line wins. No VERDICT line → {verdict: null} (no block,
 * no cache — see VERDICT_LINE_RE note). The FAIL reason is the line's tail, markdown-stripped.
 */
export function parseReviewVerdict(raw: string): ReviewVerdict {
  const lines = [...String(raw).matchAll(VERDICT_LINE_RE)];
  if (lines.length === 0) return { verdict: null, reason: '' };
  const last = lines[lines.length - 1];
  return {
    verdict: last[1].toUpperCase(),
    reason: (last[2] ?? '').replace(/\*+/g, '').trim(),
  };
}

/**
 * Cache key for a PASS verdict: reviewer identity + the exact bytes of its staged domain diff.
 * An IDENTICAL diff re-reviewed (amend, rebase replay, retry after fixing an unrelated gate)
 * skips instantly — including after a rebase onto changed surrounding context. That skip is BY
 * DESIGN: the reviewed object is the diff itself, and re-judging it on unchanged bytes buys
 * latency, not safety.
 */
export function cacheKey(reviewerName: string, diffText: string): string {
  return `${reviewerName}:${createHash('sha256').update(diffText).digest('hex')}`;
}
