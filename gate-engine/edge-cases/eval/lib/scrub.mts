/**
 * Secret/PII scrubbing shared by finalize.mts (applies it) and cases.test.mts (enforces it) —
 * one PATTERNS source so the gate and the scrubber cannot drift.
 *
 * Limits (stated in README): regexes catch MODELED shapes only. Proprietary-code exposure is
 * handled by the repo excerpt allowlist in schema.mts, not here; a manual grep review before
 * commit covers what patterns can't.
 */

export const PATTERNS = [
  { kind: 'anthropic-key', re: /sk-ant-[\w-]{10,}/g },
  { kind: 'generic-sk-key', re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'github-pat', re: /\bgithub_pat_[\w]{20,}\b/g },
  { kind: 'slack-token', re: /\bxox[baprs]-[\w-]{10,}\b/g },
  { kind: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'jwt', re: /\beyJ[\w-]{20,}\.[\w-]{10,}\.[\w-]{10,}\b/g },
  { kind: 'credentialed-url', re: /https?:\/\/[^/\s:@]+:[^@\s]+@/g },
  {
    kind: 'secret-assignment',
    re: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\s*[=:]\s*["'][^"']{8,}["']/gi,
  },
];

const HOME_RE = /\/Users\/benji\.norval/g;
const TMP_WORKTREE_RE = /\/private\/tmp\/claude-\d+\/[\w./-]+/g;
const EMAIL_RE = /\b[\w.+-]+@(?:gmail|slice|anthropic)\.[\w.]+\b/gi;

/** Redact secrets and normalize machine-specific paths. Replacement keeps the kind visible. */
export const scrub = (text) => {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const { kind, re } of PATTERNS) out = out.replace(re, `[REDACTED:${kind}]`);
  return out
    .replace(HOME_RE, '~')
    .replace(TMP_WORKTREE_RE, '<worktree>')
    .replace(EMAIL_RE, '[REDACTED:email]');
};

const ANY_HOME_RE = /\/Users\//;

/** Gate check: returns the kinds still present (should be none after scrub). */
export const findLeaks = (text) => {
  if (typeof text !== 'string' || !text) return [];
  const leaks = PATTERNS.filter(({ re }) => new RegExp(re.source, re.flags).test(text)).map(
    ({ kind }) => kind,
  );
  if (ANY_HOME_RE.test(text)) leaks.push('home-path');
  return leaks;
};

/** Deep-scrub every string field of a case object (returns a new object). */
export const scrubDeep = (value) => {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v)]));
  return value;
};
