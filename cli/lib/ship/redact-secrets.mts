/**
 * Redaction for ship telemetry text (the recorded command + PR body). The body is about to be
 * published on the PR anyway, but the durable sink must not be where a pasted secret outlives the
 * author's edit that removes it before pushing.
 */

const SECRET_RES = [
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\b[srp]k_(?:live|test)_[A-Za-z0-9]{8,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
  /\b[Bb]asic\s+[A-Za-z0-9+/]{16,}=*/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
];
// Separate because its replacement keeps the identifier + separator ($1$2): the identifier
// prefix/suffix runs match qualified names too (AWS_SECRET_ACCESS_KEY=…) — a bare \b(secret)\b
// never fires inside an underscore-joined identifier.
const ASSIGNMENT_RE =
  /([A-Za-z0-9_-]*(?:password|passwd|token|secret|api[_-]?key)[A-Za-z0-9_-]*)(\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|\S+)/gi;
const URL_USERINFO_RE = /(\/\/)[^\s@/:]+:[^\s@/]+@/g;
// Shell-safe quoting for the replayable command: a spaced path or a titled string must parse back
// as ONE argument, or the recorded command no longer reproduces the recorded ship.
const SAFE_ARG_RE = /^[A-Za-z0-9._/@:=-]+$/;
export const shQuote = (s: string): string =>
  SAFE_ARG_RE.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

export function redactSecrets(text: string): string {
  // Plain replacement strings, never a shared callback: replace() hands a zero-group regex's
  // callback (match, OFFSET, WHOLE STRING) — a "keep the key" branch keyed on argument presence
  // would splice the entire unredacted text back into the output.
  let out = text;
  for (const re of SECRET_RES) out = out.replace(re, '[REDACTED]');
  out = out.replace(URL_USERINFO_RE, '$1[REDACTED]@');
  return out.replace(ASSIGNMENT_RE, '$1$2[REDACTED]');
}
