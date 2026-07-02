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

import { execFile, execFileSync } from 'node:child_process';

// The two dark-judge warning shapes, shared by the sync and async runners so the outage stays
// visible with ONE wording (and the twin catch blocks don't diverge or trip the dup gate).
function warnNoOutput(label) {
  // Ran (exit 0) but emitted nothing — a soft outage the parser would silently read as "no
  // verdict". Surface it so this variant of a dark judge is not silent either.
  console.error(`⚠️  ${label}: claude judge returned no output — judgement skipped`);
}

function warnUnavailable(label, e) {
  const reason = e?.code ?? (e?.status != null ? `exit ${e.status}` : (e?.message ?? 'unknown'));
  console.error(
    `⚠️  ${label}: claude judge unavailable (${reason}; offline/quota/absent) — judgement skipped`,
  );
}

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
      warnNoOutput(label);
      return null;
    }
    return out;
  } catch (e) {
    warnUnavailable(label, e);
    return null;
  }
}

/**
 * Async twin of execJudge — same contract (raw stdout, or `null` after ONE stderr warning), but
 * non-blocking so a caller can run SEVERAL judges concurrently (the review gate fans out one judge
 * per domain reviewer; serialising them would multiply the commit's wall-clock by the reviewer
 * count). Callback-form execFile because the promisified variant cannot take stdin: the prompt's
 * evidence (diffstat) goes to the child's stdin by hand. maxBuffer is explicit — an investigating
 * judge's transcript (tool output included) can exceed the 1 MB default.
 *
 * @param {{ label: string, args: string[], input?: string, timeout?: number, cwd?: string }} opts
 * @returns {Promise<string|null>}
 */
export function execJudgeAsync({ label, args, input, timeout, cwd }) {
  return new Promise((resolve) => {
    const child = execFile(
      'claude',
      args,
      { cwd, encoding: 'utf8', timeout, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          warnUnavailable(label, err);
          resolve(null);
          return;
        }
        if (!stdout || !String(stdout).trim()) {
          warnNoOutput(label);
          resolve(null);
          return;
        }
        resolve(stdout);
      },
    );
    // EPIPE guard: claude may exit (ENOENT wrapper, early crash) before stdin is consumed.
    child.stdin?.on('error', () => {});
    if (input !== undefined) child.stdin?.write(input);
    child.stdin?.end();
  });
}
