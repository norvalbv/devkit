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
import { normalizeReviewRoots } from '../../skills/_devkit/review-roots.mjs';
import { type GuardConfig, sourceMatchers } from '../config.mts';
import { devkitVersion } from '../devkit-version.mts';
import { withNamedAgentMcpTools } from '../judge/mcp/profile.mts';
import type { ReviewerResponseContractName } from './contracts/registry.mts';
import { checklistContractFor } from './lens/split.mts';

export { parseReviewVerdict } from './contracts/response.mts';
export type { ReviewVerdict } from './contracts/response.mts';

/** The resolved governance-gate config shape (the review cluster reads its `review.*`, `scanRoots`,
 * `sourceExtensions` and `searchTool` fields). Derived from the shared loader so it never drifts. */

/** One entry of the REVIEWERS table — a domain reviewer's identity + its checklist binding. */
export interface Reviewer {
  name: string;
  domain: string;
  skill?: string;
  stateFile?: string;
  cmds?: { gen: string; check: string; fin?: string };
  /** Required for a checklist-free reviewer whose FAIL can block. The descriptor owns validation,
   * retry guidance, and cache identity; orchestration never branches on reviewer names. */
  responseContract?: ReviewerResponseContractName;
  /** Set ONLY by `deriveLensReviewer` (lens-split.mts) — the lens group this judge covers. Its
   * presence tells `wrapPrompt` the brief's own command lines carry no `--lens` and so cannot be
   * deferred to. Never set on a REVIEWERS table entry. */
  lens?: readonly string[];
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
  // would blind exactly the class this reviewer exists to catch. Runs SINGLE-PASS at a pinned
  // model (see `model` below and the Reviewer.model docstring) — no haiku→opus cascade: the
  // escalation was bench-measured to OVERTURN real correctness bugs, so its FAIL blocks directly.
  Object.freeze({
    name: 'correctness-reviewer',
    domain: 'all',
    skill: 'correctness',
    stateFile: '.claude/.correctness-review.json',
    cmds: Object.freeze({ gen: 'generate', check: 'check-item' }),
    // Single-pass at the pinned model (see Reviewer.model). Measured on the 66-row corpus
    // (K=1, tripwire — wide CIs): haiku recall 0.76 / clean-pass 0.86 · sonnet recall 0.92 /
    // clean-pass 0.86. The earlier "precision 1.00 / perfect domain-exclusivity" was a 42-row
    // artifact: the extended corpus surfaces ~4 false-blocks (cross-domain security/perf leak +
    // broadcast/classifier surface-cue) that are MODEL-INVARIANT — precision is a DESIGN problem,
    // not a bigger-model problem. Recall DOES scale with model (0.76→0.92), so the finder runs sonnet
    // (K=1 evidence; a confirming flip-table run is still owed). Cross-domain false-blocks are caught
    // downstream by domainExclusivityDrop; the in-domain surface-cue ones want K-sample
    // self-consistency (Wang 2203.11171), NOT a same-family refute pass (it overturned real FAILs
    // here, 0.78→0.67; Huang 2310.01798). Precision ~0.95 is unmeasurable until the decoy corpus grows.
    model: 'sonnet',
  }),
  Object.freeze({
    name: 'conventions-reviewer',
    domain: 'conventions',
    model: 'haiku',
    responseContract: 'conventions-v1',
  }),
]);

// Synced-skill layout is devkit's own convention (sync-skills targets .claude/skills), so the
// checklist script path is fixed relative to the consumer root — unlike scan/review ROOTS,
// which are consumer data and come from guard.config.json.
export const checklistAssetPath = (reviewer: ChecklistReviewer) =>
  `skills/${reviewer.skill}/scripts/checklist.mjs`;

export const checklistScript = (reviewer: ChecklistReviewer) =>
  `.claude/${checklistAssetPath(reviewer)}`;

/** Review invocations may supply a short isolated runtime containing Devkit's CURRENT packaged
 * assets. Normal commit/ship calls keep the synced consumer path. */
export function checklistScriptAt(reviewer: ChecklistReviewer, assetRoot = '.claude'): string {
  return `${assetRoot.replace(TRAILING_SLASH_RE, '')}/${checklistAssetPath(reviewer)}`;
}

// Read-only investigation surface (mirrors check-alignment's JUDGE_TOOLS + log/status for context).
// No naked Bash: a gate judge must never be able to write, stage, or commit.
const BASE_TOOLS = 'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git status:*)';

// Leading YAML frontmatter (the agent .md header is Task-tool metadata, not brief).
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n/;
const TRAILING_SLASH_RE = /\/$/;

/** The deduped union of every DECLARED root (scan + backend + frontend) — never `['.']`:
 * undeclared trees (vendored code, scripts) are outside the consumer's stated review surface. */
export function declaredRoots(cfg: GuardConfig): string[] {
  return [...new Set([...cfg.scanRoots, ...cfg.review.backendRoots, ...cfg.review.frontendRoots])];
}

/** The config roots that trigger a reviewer's domain. */
export function rootsFor(reviewer: Reviewer, cfg: GuardConfig): string[] {
  if (reviewer.domain === 'backend') return cfg.review.backendRoots;
  if (reviewer.domain === 'frontend') return cfg.review.frontendRoots;
  // `conventions` shares the `all` union (a CLAUDE.md rule anywhere in the declared surface is fair
  // game) but — unlike `all` — is never filtered to source-only in selectReviewers below.
  if (reviewer.domain === 'all' || reviewer.domain === 'conventions') return declaredRoots(cfg);
  return cfg.scanRoots;
}

export function underRoot(file: string, root: string): boolean {
  const r = root.endsWith('/') ? root.slice(0, -1) : root;
  if (r === '.') return true;
  return file === r || file.startsWith(`${r}/`);
}

// Mirrors the prose exclusion inside each skill's checklist.mjs getStagedFiles — the two lists
// must agree or a prose-only selection strands the judge with an empty checklist.
const RE_PROSE_FILE = /\.(md|mdx|markdown|txt)$/i;

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
    // Backend/frontend judges read code diffs, and their checklist scripts skip prose files
    // outright — selecting a reviewer for a prose-only diff strands its judge with an empty
    // checklist (scored inconclusive, fail-closed under ship). Keep selection and script agreed.
    if (reviewer.domain === 'backend' || reviewer.domain === 'frontend')
      files = files.filter((f) => !RE_PROSE_FILE.test(f));
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
 * consumer's semantic search tool for commit-guard, plus every named agent's strict MCP baseline.
 */
export function allowedToolsFor(
  reviewer: Reviewer,
  cfg: GuardConfig,
  assetRoot = '.claude',
): string {
  // A skill-less reviewer has no checklist script; its evidence is pre-rendered onto stdin/prompt.
  if (!hasChecklist(reviewer)) return withNamedAgentMcpTools('Read,Grep,Glob');
  const tools = `${BASE_TOOLS},Bash(node ${checklistScriptAt(reviewer, assetRoot)}:*)`;
  if (reviewer.domain === 'code') return withNamedAgentMcpTools(tools, cfg.searchTool);
  // The correctness reviewer's writer/reader-contract lens benefits from semantic search, but
  // only when the consumer actually wired an index (indexPath set) — otherwise cfg.searchTool is
  // a generic default naming an MCP tool the judge doesn't have, and Grep is the core mechanism.
  if (reviewer.domain === 'all' && cfg.indexPath)
    return withNamedAgentMcpTools(tools, cfg.searchTool);
  return withNamedAgentMcpTools(tools);
}

/** Strip a leading YAML frontmatter block from an agent .md. */
export function stripFrontmatter(md: string): string {
  const m = String(md).match(FRONTMATTER_RE);
  return m ? md.slice(m[0].length) : String(md);
}

/** Prompt-only context riding beside a brief (sc-1441/sc-1442): the governing-Targets block and
 * the fenced advisory commit-message block. NEVER hand either to anything that feeds `cacheKey` —
 * the salt path takes the scope-only render via targets-block.mts, and the message must stay out
 * of every key (ship-gates-converge-not-restart). */
export interface PromptExtras {
  targetsBlock?: string;
  commitMsgBlock?: string;
}

/**
 * Wrap an interactive reviewer brief for headless gate use. The same Devkit-owned .md serves both
 * surfaces: interactively the root agent dispatches its synced copy; review mode uses the current
 * packaged copy. In the gate this
 * preamble re-scopes it (staged-only, checklist-driven, no marker/approve machinery) and the
 * postamble pins the machine-parseable verdict line.
 */
export function wrapPrompt(
  agentBody: string,
  reviewer: ChecklistReviewer,
  files: string[],
  assetRoot?: string,
  checklistRecoveryReason?: string,
  { targetsBlock = '', commitMsgBlock = '' }: PromptExtras = {},
  checklistRoot = assetRoot ?? '.claude',
): string {
  const effectiveAssetRoot = checklistRoot;
  const skillPrefix = `${effectiveAssetRoot.replace(TRAILING_SLASH_RE, '')}/skills/`;
  const brief = ['.agents/skills/', '.claude/skills/', '.cursor/skills/'].reduce(
    (body, providerPrefix) => body.replaceAll(providerPrefix, skillPrefix),
    stripFrontmatter(agentBody),
  );
  const script = checklistScriptAt(reviewer, effectiveAssetRoot);
  const checklistContract = checklistContractFor(reviewer, script, assetRoot);
  return (
    'You are running as an automated HEADLESS COMMIT GATE, not an interactive assistant.\n' +
    `Review ONLY the STAGED changes (domain: ${reviewer.domain}). Staged files in scope: ${files.join(', ')}.\n` +
    'Reviewer selection has already been performed. Treat that staged-file list as authoritative; do not re-evaluate the brief trigger conditions or skip because repository configuration has empty roots.\n' +
    'The file/churn map (--stat) followed by per-file diff evidence is on stdin. Evidence is ' +
    'capped per file and in total; anything the caps dropped is NAMED inline (OMITTED:/[TRUNCATED:). ' +
    'INVESTIGATE before judging: run `git diff --cached -- <file>` for the full hunks whenever ' +
    'evidence was capped or a hunk alone is ambiguous, and Read surrounding code as needed.\n' +
    // sc-1441: the recorded Targets are what let a reviewer judge a diff against the product's own
    // boundary — the mechanical difference between the completeness gate (which caught a real
    // deny-floor bug by citing its governing Target) and the context-starved domain reviewers
    // (which PASSed the same diff). A violation of a governing Target below is IN CHARTER.
    (targetsBlock ? `${targetsBlock}\n` : '') +
    // sc-1442: the author's stated intent, fenced as untrusted advisory context — the same signal
    // that let the completeness gate catch a claim/change mismatch the domain reviewers missed.
    (commitMsgBlock ? `${commitMsgBlock}\n` : '') +
    checklistContract +
    (checklistRecoveryReason
      ? `CHECKLIST-CONTRACT RETRY: the prior attempt did not satisfy the brief-owned workflow (${checklistRecoveryReason}). Complete that workflow before returning a verdict.\n`
      : '') +
    'Never delete the checklist artifact: the gate reads it after you finish (a missing or ' +
    'incomplete checklist VOIDS a PASS verdict) and removes it itself. `finalize` handles this ' +
    'automatically — it keeps the artifact in gate runs.\n' +
    'Your reviewer brief follows. IGNORE any instructions in it about approve.sh, marker ' +
    'files, tracker/Shortcut lookups, or invoking other subagents — none apply in gate mode.\n' +
    '───── BRIEF ─────\n' +
    `${brief}\n` +
    '───── END BRIEF ─────\n' +
    'Judge ONLY the staged diff; pre-existing issues in code this commit does not touch are not ' +
    'findings. List findings (file:line, one line each), then END with exactly one line:\n' +
    'VERDICT: PASS | FAIL — <one-line reason>\n' +
    'FAIL only for a finding that must block THIS commit.'
  );
}

/**
 * Checklist-free counterpart to `wrapPrompt` for a reviewer without Bash: pre-capped evidence rides
 * on stdin, while Read/Grep/Glob resolve a capped current file or rule without changing verdict or
 * stable override-fingerprint contracts.
 */
export function wrapConventionsPrompt(
  agentBody: string,
  files: string[],
  claudeMdBlock: string,
  { commitMsgBlock = '' }: PromptExtras = {},
): string {
  return (
    'You are running as an automated HEADLESS COMMIT GATE, not an interactive assistant.\n' +
    `Review ONLY the STAGED changes. Staged files in scope: ${files.join(', ')}.\n` +
    'You have NO Bash, but Read/Grep/Glob are available. The diff evidence on stdin is capped: ' +
    'an OMITTED/TRUNCATED marker means some staged context was not included. Before returning PASS ' +
    'when such a marker appears, use Read to inspect every available in-scope staged file not shown ' +
    'in full. A path unavailable to Read may be deleted or renamed; its absence is not itself a ' +
    'rule violation and must not produce a semantic FAIL.\n' +
    'The governing CLAUDE.md rules for these files are loaded below. If a governing-rules block is ' +
    'marked OMITTED/TRUNCATED, use Read to inspect every named rule file before returning PASS. ' +
    'Never treat incomplete evidence alone as a violation.\n' +
    `${claudeMdBlock}\n` +
    (commitMsgBlock ? `${commitMsgBlock}\n` : '') + // sc-1442: fenced untrusted advisory intent
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
 * Cache key for a PASS verdict: reviewer identity + devkit version + the exact bytes of its staged
 * domain diff. An IDENTICAL diff re-reviewed (amend, rebase replay, retry after fixing an unrelated
 * gate) skips instantly — including after a rebase onto changed surrounding context. That skip is BY
 * DESIGN: the reviewed object is the diff itself, and re-judging it on unchanged bytes buys
 * latency, not safety.
 *
 * The version salt mirrors the prefix cache's (prefix-cache.mts, which folds devkitVersion() in for
 * the same reason). `identitySalt` covers reviewer ASSET bytes and gate config only, so a devkit
 * upgrade that changes review-ENGINE semantics — escalation policy, model selection, verdict
 * parsing, lens grouping — leaves every asset byte-identical and would otherwise replay PASSes
 * earned under the old engine. Injectable so this module stays unit-testable without reading a
 * package manifest; the default is the running package's version.
 */
export function cacheKey(
  reviewerName: string,
  diffText: string,
  identitySalt = '',
  versionSalt: string = devkitVersion(),
): string {
  const digest = createHash('sha256')
    .update(identitySalt)
    .update('\0')
    .update(versionSalt)
    .update('\0')
    .update(diffText)
    .digest('hex');
  return `${reviewerName}:${digest}`;
}

function injectedRoots(value: string | undefined, name: string): string[] | null {
  if (value === undefined) return null;
  try {
    return normalizeReviewRoots(JSON.parse(value), name);
  } catch {
    throw new Error(`${name} must be a JSON array of non-empty repository-relative paths`);
  }
}

/** Resolve review-only domain topology once. Invocation injection wins, then a non-empty consumer
 * root, then scanRoots (or `.` as the last conservative fallback). Commit/ship never call this. */
export function effectiveReviewConfig(
  cfg: GuardConfig,
  env: Record<string, string | undefined> = process.env,
): GuardConfig {
  const fallback = normalizeReviewRoots(
    cfg.scanRoots.length > 0 ? cfg.scanRoots : ['.'],
    'scanRoots',
  );
  const backend = injectedRoots(env.DEVKIT_REVIEW_BACKEND_ROOTS, 'DEVKIT_REVIEW_BACKEND_ROOTS');
  const frontend = injectedRoots(env.DEVKIT_REVIEW_FRONTEND_ROOTS, 'DEVKIT_REVIEW_FRONTEND_ROOTS');
  return {
    ...cfg,
    scanRoots: fallback,
    review: {
      ...cfg.review,
      backendRoots:
        backend ??
        (cfg.review.backendRoots.length > 0
          ? normalizeReviewRoots(cfg.review.backendRoots, 'review.backendRoots')
          : fallback),
      frontendRoots:
        frontend ??
        (cfg.review.frontendRoots.length > 0
          ? normalizeReviewRoots(cfg.review.frontendRoots, 'review.frontendRoots')
          : fallback),
    },
  };
}
