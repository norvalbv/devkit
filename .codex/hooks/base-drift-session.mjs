#!/usr/bin/env node
/**
 * SessionStart brief: has origin/<base> moved under this worktree since it was cut?
 *
 * THIS IS THE PRIMARY SURFACE, and the timing is the point. sc-2297's loss was booked at READ
 * time — an agent ran `git show HEAD:drizzle/meta/_journal.json` against a stale HEAD, concluded
 * migration 0091 did not exist, and told the user a correct completeness finding was a
 * hallucination, hours before any gate ran. A per-edit hook cannot reach that: it fires on path
 * overlap, and work built on a stale read very often produces NEW files, which by construction
 * never overlap the base. Task start is when the mental model is formed, so that is where the
 * whole-repo picture belongs.
 *
 * It is also the delivery channel this repo has actually verified end to end (adhd-session-start
 * .mjs and its test). PreToolUse additionalContext is documented inconsistently upstream — see
 * docs/decisions/decision-log-informs-before-work.md — so the companion pre-edit advisory is built
 * to be a silent no-op if the platform ignores it, and this hook is what must still work.
 *
 * `compact` is in the matcher for the same reason the adhd hook lists it: the drift picture is
 * context, and a compaction drops it.
 */
import { claimed, commitClaim, emit, fetchReport, projectRoot, readInput } from './base-drift-lib.mjs';

export function main() {
  try {
    const input = readInput();
    const root = projectRoot();
    // maxAgeMs 0: once per session, at the one moment worth paying the network for unconditionally.
    const report = fetchReport(root, { maxAgeMs: 0 });
    if (!report) return;
    const brief = report.rendered?.session;
    if (!brief) return;
    // Keyed on the base SHA *and* the event source. The SHA re-arms when the base moves again; the
    // source re-arms on compact/clear, which DROP this brief from context — the reason those events
    // are in the matcher at all. Without it the stamp from startup would permanently silence the
    // re-assertion each compaction is supposed to trigger.
    const source = input?.source?.trim?.() || 'unknown';
    const sha = report.base?.kind === 'resolved' ? report.base.sha : 'unresolved';
    // compact and clear REMOVE this brief from the context window — re-asserting is the entire
    // reason they are in the matcher — so they are never deduped, however often they fire. Only
    // startup and resume, which keep what is already there, claim a stamp.
    const retainsContext = source === 'startup' || source === 'resume';
    const token = `session-${sha}`;
    if (retainsContext && claimed('devkit-base-drift-session', input?.session_id, token)) return;
    if (!emit(input, 'SessionStart', brief)) return;
    if (retainsContext) commitClaim('devkit-base-drift-session', input?.session_id, token);
  } catch {
    // An advisory must never be the reason a session fails to start.
  }
}

main();
