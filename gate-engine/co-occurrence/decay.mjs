/**
 * Shared decay math for the co-occurrence allowlist.
 *
 * Every allowlist entry (symbol `pair` or token `clone`) carries `date` (ISO
 * yyyy-mm-dd, when it was approved) + `decayDays`; it expires that many days
 * after approval. Day-granular — times are zeroed so decay flips at local
 * midnight, not on a rolling 24h clock.
 *
 * Single source of truth for both consumers: the allowlist CRUD CLI (prune/list/
 * check) and matcher.mjs (`scan --new` — treats expired entries as no longer
 * covering, so a lapsed approval re-surfaces).
 */

const DAY_MS = 86_400_000;
const DEFAULT_DECAY_DAYS = 7;

function expiresAt(entry) {
  const decay = entry.decayDays ?? DEFAULT_DECAY_DAYS;
  const approved = new Date(entry.date);
  approved.setHours(0, 0, 0, 0);
  return approved.getTime() + decay * DAY_MS;
}

function startOfToday() {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return t.getTime();
}

export function isExpired(entry) {
  return expiresAt(entry) <= startOfToday();
}

export function daysRemaining(entry) {
  return Math.ceil((expiresAt(entry) - startOfToday()) / DAY_MS);
}
