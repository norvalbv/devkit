// The devkit-owned Reviewer notes block: PASS reviewers' non-blocking advisories, read from this
// ship's gate events. An append re-ship judged only its delta, so it adds notes and never drops one.
import { homedir } from 'node:os';
import { dirname, sep } from 'node:path';
import type { GateEvent } from '../digest/gate-digest.mts';
import { findOwned, ownedBegin, ownedEnd, plain, upsertOwned } from './block.mts';

export const NOTES = 'reviewer-notes';
const HEADER = ['## Reviewer notes', 'Non-blocking advisories from the devkit ship reviewers.'];
const REVIEW_GATE = 'review:';
const AT_SHA = / at `[0-9a-f]+`:/;

/** The home directory as a whole path prefix; a root home would rewrite every absolute path. */
const homePrefix = (home: string): string | null =>
  dirname(home) === home ? null : `${home}${sep}`;

/** One bullet per `review:*` advisory row of the newest attempt (an inherited ship id spans several). */
export function noteLines(events: readonly GateEvent[], sha: string): string[] {
  const opened = events.map((e) => e.type).lastIndexOf('ship_attempt');
  const home = homePrefix(homedir());
  return events.slice(Math.max(opened, 0)).flatMap((e) => {
    const gate = `${e.gate ?? ''}`;
    if (e.type !== 'advisory_result' || !gate.startsWith(REVIEW_GATE)) return [];
    const detail = `${e.detail ?? ''}`;
    const text = plain(home ? detail.replaceAll(home, `~${sep}`) : detail);
    const reviewer = plain(gate.slice(REVIEW_GATE.length));
    return text ? [`- **${reviewer}** at \`${sha.slice(0, 12)}\`: ${text}`] : [];
  });
}

/** A cached PASS replays the same advisory under a later commit: one note, the first sha kept. */
const noteKey = (line: string): string => line.replace(AT_SHA, ':');

const bulletsOf = (block: string | undefined): string[] =>
  (block ?? '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith('- '));

/** Add `lines` to the PR's current notes, or replace them on a history rewrite; none is a no-op. */
export function upsertNotes(body: string, lines: readonly string[], replace: boolean): string {
  const seen = new Set<string>();
  const merged = [...(replace ? [] : bulletsOf(findOwned(NOTES, body))), ...lines].filter(
    (line) => !seen.has(noteKey(line)) && Boolean(seen.add(noteKey(line))),
  );
  if (!merged.length) return body;
  const block = [ownedBegin(NOTES), ...HEADER, ...merged, ownedEnd(NOTES)].join('\n');
  return upsertOwned(NOTES, body, block);
}
