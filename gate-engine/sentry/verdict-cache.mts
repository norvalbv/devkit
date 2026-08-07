/**
 * Verdict cache for the sentry commit-msg judge — the one gate that used to re-bill its 3-sample
 * haiku vote on EVERY commit attempt, including a byte-identical retry after ITS OWN hard block.
 *
 * Unlike the decisions cache (decisions/verdict-cache.mts, non-blocking verdicts only), this store
 * caches BOTH verdicts by design: SKIP replays the pass, and a confident MONITOR replays the block
 * instantly — the author is mid-fix-loop and an identical retry cannot flip a majority vote worth
 * re-paying for. Anything unearned (outage, ambiguous/tied vote, no-LLM run) is never cached.
 * DIFF TIER ONLY (the caller gates this): caching a MONITOR is sound only because adding the
 * demanded capture changes the focused-diff evidence and so the key — on the message/names tiers
 * the fix can't move the evidence and a cached block would replay forever. Escape hatch for a
 * wedged entry: `rm .devkit/sentry-verdict-cache.json` (documented in docs/troubleshooting.md).
 *
 * Key = sha256 over the judge's EXACT inputs plus its identity: devkit version (an upgrade may
 * change parsing), model, sample count (a 1-sample warn verdict must never replay as a 3-sample
 * hard block, and vice versa), the prompt bytes (edits invalidate even between releases), and the
 * full stdin payload (message + focused error-hunk evidence). Any restage that changes the
 * error-hunks — including adding the demanded capture — re-judges.
 *
 * Storage/atomicity/failure direction: shared judge/verdict-store (`.devkit/sentry-verdict-cache
 * .json`, main-checkout anchored, corrupt → re-judge, failed write → verdict stands, unremembered).
 */

import { createHash } from 'node:crypto';
import { verdictKey } from '../decisions/verdict-cache.mts';
import { emitCacheHit, emitGateEvent } from '../judge/gate-events.mts';
import { devkitDataFile, loadEntries, saveEntries } from '../judge/verdict-store.mts';

const STORE_FILE = 'sentry-verdict-cache.json';
const CACHEABLE = new Set(['MONITOR', 'SKIP']);

/** The judge result shape shared with check-sentry (kept structural to avoid a cyclic import). */
export interface CachedSentryVerdict {
  verdict: string | null;
  evidence: string;
}

/** Identity inputs the key must cover beyond the stdin payload itself. */
export interface SentryJudgeIdentity {
  model: string;
  samples: number;
  prompt: string;
}

/** Stable cache key over the judge's exact inputs + identity. Built on the decisions cache's
 * `verdictKey` (NUL-separated parts + devkit-version salt) so the two stores' key formulas cannot
 * drift; the prompt rides as its own sha256 to keep the key line-length sane. */
export function sentryVerdictKey(input: string, { model, samples, prompt }: SentryJudgeIdentity) {
  const promptDigest = createHash('sha256').update(prompt).digest('hex');
  return verdictKey('sentry', model, samples, promptDigest, input);
}

/**
 * Judge `input` through the cache: an earned verdict for these exact inputs replays without a
 * judge call; a miss runs `judgeFn` and remembers a confident MONITOR/SKIP (best-effort — a failed
 * write leaves the verdict standing for this run). Callers on a bypass path (NO_SENTRY_JUDGE,
 * SENTRY_NO_LLM) must not reach this at all: a bypassed run earns nothing and must not replay a
 * cached block the owner explicitly softened.
 */
export function judgeSentryWithCache(
  cwd: string,
  input: string,
  identity: SentryJudgeIdentity,
  judgeFn: () => CachedSentryVerdict | null,
): CachedSentryVerdict | null {
  const file = devkitDataFile(cwd, STORE_FILE);
  const key = sentryVerdictKey(input, identity);
  const hit = loadEntries(file)[key];
  if (hit && typeof hit.verdict === 'string' && CACHEABLE.has(hit.verdict)) {
    console.error(`sentry-judge: cached ${hit.verdict} (identical message + error-hunk evidence)`);
    emitCacheHit('sentry-advisory', hit.model, hit.duration_ms);
    return { verdict: hit.verdict, evidence: String(hit.evidence ?? '') };
  }
  const started = Date.now();
  const result = judgeFn();
  if (result?.verdict && CACHEABLE.has(result.verdict)) {
    const saved = saveEntries(file, {
      [key]: {
        at: new Date().toISOString(),
        verdict: result.verdict,
        evidence: result.evidence,
        model: identity.model,
        samples: identity.samples,
        duration_ms: Math.max(0, Date.now() - started),
      },
    });
    if (!saved) {
      // The verdict stands for this run; it just isn't remembered. Name it (gate-telemetry-self-
      // describing): a silently lost write would read as a judge that keeps re-billing for no reason.
      console.error('sentry-judge: verdict earned but NOT cached (store write failed)');
      emitGateEvent({ type: 'cache_write_failed', judge: 'sentry-advisory' });
    }
  }
  return result;
}
