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
 */
export const REVIEWERS = Object.freeze([
  Object.freeze({ name: 'api-security-reviewer', domain: 'backend' }),
  Object.freeze({ name: 'backend-performance-reviewer', domain: 'backend' }),
  Object.freeze({ name: 'frontend-security-reviewer', domain: 'frontend' }),
  Object.freeze({ name: 'frontend-performance-reviewer', domain: 'frontend' }),
  Object.freeze({ name: 'commit-guard', domain: 'code' }),
]);

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

/** Comma-joined --allowedTools value for one reviewer. */
export function allowedToolsFor(reviewer, cfg) {
  return reviewer.domain === 'code' ? `${BASE_TOOLS},${cfg.searchTool}` : BASE_TOOLS;
}

/** Strip a leading YAML frontmatter block from an agent .md. */
export function stripFrontmatter(md) {
  const m = String(md).match(FRONTMATTER_RE);
  return m ? md.slice(m[0].length) : String(md);
}

/**
 * Wrap an interactive reviewer brief for headless gate use. The SAME synced .md serves both
 * surfaces: interactively the root agent dispatches it via the Task tool; in the gate this
 * preamble re-scopes it (staged-only, read-only, no marker/checklist machinery) and the postamble
 * pins the machine-parseable verdict line.
 */
export function wrapPrompt(agentBody, reviewer, files) {
  return (
    'You are running as an automated HEADLESS COMMIT GATE, not an interactive assistant.\n' +
    `Review ONLY the STAGED changes (domain: ${reviewer.domain}). Staged files in scope: ${files.join(', ')}.\n` +
    'A diffstat is on stdin. INVESTIGATE before judging: run `git diff --cached -- <file>` to read ' +
    'the actual staged hunks, and Read surrounding code where a hunk alone is ambiguous.\n' +
    'Your reviewer brief follows. IGNORE any instructions in it about checklist scripts, approve.sh, ' +
    'marker files, tracker/Shortcut lookups, invoking other subagents, or writing files — none apply ' +
    'in gate mode; your tools are read-only.\n' +
    '───── BRIEF ─────\n' +
    `${stripFrontmatter(agentBody)}\n` +
    '───── END BRIEF ─────\n' +
    'Judge ONLY the staged diff; pre-existing issues in code this commit does not touch are not ' +
    'findings. List findings (file:line, one line each), then END with exactly one line:\n' +
    'VERDICT: PASS | FAIL — <one-line reason>\n' +
    'FAIL only for a finding that must block THIS commit.'
  );
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
