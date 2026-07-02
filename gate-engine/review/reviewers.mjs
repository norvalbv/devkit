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
import { sourceMatchers } from '../config.mjs';

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
]);

// Synced-skill layout is devkit's own convention (sync-skills targets .claude/skills), so the
// checklist script path is fixed relative to the consumer root — unlike scan/review ROOTS,
// which are consumer data and come from guard.config.json.
export const checklistScript = (reviewer) =>
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
export function rootsFor(reviewer, cfg) {
  if (reviewer.domain === 'backend') return cfg.review.backendRoots;
  if (reviewer.domain === 'frontend') return cfg.review.frontendRoots;
  return cfg.scanRoots;
}

function underRoot(file, root) {
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
export function selectReviewers(stagedFiles, cfg) {
  const { isSource } = sourceMatchers(cfg.sourceExtensions);
  return REVIEWERS.map((reviewer) => {
    const roots = rootsFor(reviewer, cfg);
    let files = stagedFiles.filter((f) => roots.some((r) => underRoot(f, r)));
    if (reviewer.domain === 'code') files = files.filter((f) => isSource(f.split('/').pop()));
    return { reviewer, files };
  }).filter((s) => s.files.length > 0);
}

/**
 * Comma-joined --allowedTools value for one reviewer: the read-only base, PLUS its own checklist
 * script (the one non-git Bash prefix a judge gets — scoped to that exact script path, so the
 * judge can drive its checklist but still cannot write files, stage, or commit), PLUS the
 * consumer's semantic search tool for commit-guard.
 */
export function allowedToolsFor(reviewer, cfg) {
  const tools = `${BASE_TOOLS},Bash(node ${checklistScript(reviewer)}:*)`;
  return reviewer.domain === 'code' ? `${tools},${cfg.searchTool}` : tools;
}

/** Strip a leading YAML frontmatter block from an agent .md. */
export function stripFrontmatter(md) {
  const m = String(md).match(FRONTMATTER_RE);
  return m ? md.slice(m[0].length) : String(md);
}

/**
 * Wrap an interactive reviewer brief for headless gate use. The SAME synced .md serves both
 * surfaces: interactively the root agent dispatches it via the Task tool; in the gate this
 * preamble re-scopes it (staged-only, checklist-driven, no marker/approve machinery) and the
 * postamble pins the machine-parseable verdict line.
 */
export function wrapPrompt(agentBody, reviewer, files) {
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

/**
 * Independent verification of the checklist artifact the judge's workflow left behind — the
 * gate-side half of the anti-hallucination contract. Returns null when the artifact is complete
 * and consistent with the verdict, else a human-readable reason (→ the cascade result becomes
 * inconclusive, never a PASS). A FAIL verdict needs no artifact scrutiny — it blocks regardless.
 *
 * @param {object|null} state parsed state-file JSON (null = missing/unreadable)
 * @param {'PASS'|'FAIL'} verdict the judge's parsed verdict
 * @returns {string|null}
 */
export function verifyChecklist(state, verdict) {
  if (verdict === 'FAIL') return null;
  const items = state?.items ?? state?.files; // domain reviewers use items[]; commit-guard files[]
  if (!Array.isArray(items) || items.length === 0)
    return 'checklist artifact missing — the judge skipped the checklist workflow';
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
export function escalatePrompt(wrappedPrompt, firstPass) {
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
export function parseReviewVerdict(raw) {
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
export function cacheKey(reviewerName, diffText) {
  return `${reviewerName}:${createHash('sha256').update(diffText).digest('hex')}`;
}
