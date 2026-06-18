// Shared exec + catch-and-warn for every `claude -p` gate judge (the judge-gate factory and any
// thin caller built on it: vision / sentry / critique / decisions in the consumer repo).
//
// WHY this exists: each gate used to wrap its `claude` call in `try { … } catch { return null }` with
// NO log. So when the judge could not run (binary absent / offline / quota-exhausted / timeout) the
// gate failed open SILENTLY — the maintainer never learned the LLM check had gone dark. On a drainable
// per-user credit pool a mid-month outage is a real, recurring failure class. This helper makes that
// outage VISIBLE (one stderr line) without changing any exit code — the gate's own fail-open/block
// decision is untouched.
//
// It owns ONLY the exec + catch-and-warn. Argv composition stays in each caller because the flag sets
// genuinely diverge (read-only `--disallowedTools *` vs investigating `--allowedTools`, prompt
// position, model, timeout, stdin slicing). The caller builds `args`; the helper runs it.
//
// The warning states the OUTAGE only ("judgement skipped") — NOT the gate outcome, because that
// diverges: a warn-by-default gate fails open (commit proceeds) while a deterministic-floor gate's
// regex floor still blocks. Each caller describes its own consequence where it differs.

import { execFileSync } from 'node:child_process';

/**
 * Run one `claude` judge invocation. Returns raw stdout on success, or `null` (after emitting ONE
 * stderr warning) when the judge could not run — a throw (ENOENT / non-zero exit / timeout) or an
 * empty/whitespace stdout (ran but said nothing). A judge that runs and returns real text — including
 * a clean verdict — returns that text and warns nothing; verdict parsing stays in the caller.
 *
 * @param {{ label: string, args: string[], input?: string, timeout?: number, cwd?: string }} opts
 * @returns {string|null}
 */
export function execJudge({ label, args, input, timeout, cwd }) {
  try {
    const out = execFileSync('claude', args, {
      cwd,
      input,
      encoding: 'utf8',
      timeout,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    if (!out || !String(out).trim()) {
      // Ran (exit 0) but emitted nothing — a soft outage the parser would silently read as "no
      // verdict". Surface it so this variant of a dark judge is not silent either.
      console.error(`⚠️  ${label}: claude judge returned no output — judgement skipped`);
      return null;
    }
    return out;
  } catch (e) {
    const reason = e?.code ?? (e?.status != null ? `exit ${e.status}` : (e?.message ?? 'unknown'));
    console.error(
      `⚠️  ${label}: claude judge unavailable (${reason}; offline/quota/absent) — judgement skipped`,
    );
    return null;
  }
}
