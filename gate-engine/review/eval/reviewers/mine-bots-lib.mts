// @ts-nocheck — BENCH-ONLY (excluded from tsc, see tsconfig.json exclude); loose types deliberate.

/**
 * mine-bots-lib — pure helpers for mine-bots.mts, split out so they can be unit-tested without
 * touching the network (gh api) or sqlite3. Everything here takes plain data in, returns plain
 * data out; no execFileSync, no fs, no fetch.
 */

// ---------------------------------------------------------------------------------------------
// Legacy keyword categorizer (kept for continuity with the original `category` field).
// ---------------------------------------------------------------------------------------------

// Advisory keyword buckets, checked in order — first hit wins. Security before performance
// before correctness: a comment naming an injection is security even if it also says "slow".
export const CATEGORY_RULES = [
  ['security', /\b(inject|xss|csrf|sanitiz|credential|token|secret|auth[a-z]*|vulnerab|escap)/i],
  ['performance', /\b(n\+1|perform|slow|cache|memo|re-render|bundle|latency|pagination|O\(n)/i],
  ['error-handling', /\b(swallow|unhandled|catch|silently|error is (?:ignored|lost)|rejection)/i],
  [
    'correctness',
    /\b(race|concurren|CAS|overwrit|stale|dedup|double|rename|portab|BSD|JSON\.parse|falsy|off-by|incorrect|wrong|bug|breaks?|fails?)\b/i,
  ],
  ['docs', /\b(doc|readme|comment|typo|grammar|wording|markdown)\b/i],
  ['style', /\b(style|naming|convention|lint|format)\b/i],
];

export function categorize(body) {
  const text = String(body ?? '');
  for (const [cat, re] of CATEGORY_RULES) if (re.test(text)) return cat;
  return 'other';
}

// ---------------------------------------------------------------------------------------------
// CodeRabbit marker parsing.
// ---------------------------------------------------------------------------------------------

// e.g. "_Security_ | _🔴 Critical_" — category before the pipe, severity (emoji + word) after.
const CR_MARKER_RE = /_([^_|]{2,45})_ \| _(?:🔴|🟠|🟡|🔵)\s*([^_|]{2,20})_/u;
const EMOJI_RE = /(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|\u{FE0F})/gu;

export function parseCoderabbitMarker(body) {
  const text = String(body ?? '');
  const m = CR_MARKER_RE.exec(text);
  if (!m) return { crCategory: null, crSeverity: null };
  const crCategory = m[1].replace(EMOJI_RE, '').trim();
  const crSeverity = m[2].replace(EMOJI_RE, '').trim();
  return { crCategory: crCategory || null, crSeverity: crSeverity || null };
}

// ---------------------------------------------------------------------------------------------
// Addressed / withdrawal signal detection.
// ---------------------------------------------------------------------------------------------

const ADDRESSED_MARKER = 'review_comment_addressed';

// texts: plain string array (own body + full — not excerpted — reply bodies).
export function hasAddressedMarker(texts) {
  return (texts ?? []).some((t) => typeof t === 'string' && t.includes(ADDRESSED_MARKER));
}

const WITHDRAWAL_RE = /withdraw|does not apply|you're right|you are right|agreed[—,-]/i;
const CODERABBIT_LOGIN = 'coderabbitai[bot]';

// replies: [{author, body}] full (untruncated) bodies.
export function hasWithdrawal(replies) {
  return (replies ?? []).some(
    (r) => r?.author === CODERABBIT_LOGIN && WITHDRAWAL_RE.test(String(r?.body ?? '')),
  );
}

export function hasHumanReply(replies, botAuthors) {
  const bots = botAuthors ?? new Set([CODERABBIT_LOGIN, 'macroscopeapp[bot]']);
  return (replies ?? []).some((r) => r?.author && !bots.has(r.author));
}

// ---------------------------------------------------------------------------------------------
// Outcome classification — priority order, first match wins.
// ---------------------------------------------------------------------------------------------

export function classifyOutcome({
  addressedMarker,
  withdrawal,
  threadResolved,
  threadOutdated,
  lineTouchedLater,
  hasHumanReply: humanReplyPresent,
}) {
  if (addressedMarker) return { outcome: 'fixed', outcomeEvidence: 'addressed-marker' };
  if (withdrawal) return { outcome: 'rebutted', outcomeEvidence: 'bot-withdrawal' };
  if (threadResolved && lineTouchedLater) {
    return { outcome: 'fixed', outcomeEvidence: 'resolved+line-touched' };
  }
  if (threadResolved && humanReplyPresent && !lineTouchedLater) {
    return { outcome: 'rebutted', outcomeEvidence: 'human-rebuttal' };
  }
  if (threadOutdated) return { outcome: 'unresolved', outcomeEvidence: 'outdated-only' };
  return { outcome: 'unresolved', outcomeEvidence: null };
}

// ---------------------------------------------------------------------------------------------
// Line-touched-later — pure given precomputed per-commit file lists.
// ---------------------------------------------------------------------------------------------

// commits: [{sha, committedDate: ISOString, files: string[]}] — files already fetched by caller.
export function isLineTouchedLater(commits, commentPath, commentCreatedAt) {
  const commentTime = Date.parse(commentCreatedAt);
  if (!Number.isFinite(commentTime)) return false;
  for (const c of commits ?? []) {
    const t = Date.parse(c?.committedDate);
    if (!Number.isFinite(t) || t <= commentTime) continue;
    if (Array.isArray(c.files) && c.files.includes(commentPath)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Scope confirmation — membership decision over already-queried db rows.
// ---------------------------------------------------------------------------------------------

// Returns true/false/null (null = files_json missing or unparseable → skip this reviewer row).
export function isPathInFilesJson(filesJson, filePath) {
  if (filesJson === null || filesJson === undefined) return null;
  let files: unknown;
  try {
    files = JSON.parse(filesJson);
  } catch {
    return null;
  }
  if (!Array.isArray(files)) return null;
  return files.includes(filePath);
}

// scopeRows: [{reviewer, files_json}] already joined from commit_review_scope for this PR's ships.
export function computeScopeConfirmed(scopeRows, filePath) {
  if (!scopeRows || scopeRows.length === 0) {
    return { scopeConfirmed: 'unverifiable', scopedReviewers: [] };
  }
  const scopedReviewers = [];
  let anyParseable = false;
  for (const row of scopeRows) {
    const inScope = isPathInFilesJson(row?.files_json, filePath);
    if (inScope === null) continue;
    anyParseable = true;
    if (inScope) scopedReviewers.push(row.reviewer);
  }
  if (scopedReviewers.length > 0) return { scopeConfirmed: 'confirmed', scopedReviewers };
  if (anyParseable) return { scopeConfirmed: 'out-of-scope', scopedReviewers: [] };
  return { scopeConfirmed: 'unverifiable', scopedReviewers: [] };
}

// ---------------------------------------------------------------------------------------------
// sqlite string-literal escaping (single-quote doubling) — used by the caller to build SQL text
// for `sqlite3 -json`, since execFileSync has no place to bind parameters for that CLI.
// ---------------------------------------------------------------------------------------------

export function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
