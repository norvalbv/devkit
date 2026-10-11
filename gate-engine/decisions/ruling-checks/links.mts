/**
 * What a decision record's live Target links as its Check. Apart from enforce.mts so a commit whose
 * records hold no Check note never loads the markdown parser this module needs.
 */
import { currentTarget, parseDecision } from '../decision-format.mts';
import { lastTaggedNote } from '../recall/note-relations.mts';
import { axisEntries, liveRulingIdOf, SCOPE_NOTE_RE } from '../recall/retrieval.mts';

// The note `enforce link` writes: `- <date> — **Check:** <cmd> — <reason>`; `none` unlinks.
const CHECK_NOTE_RE = /^\*\*Check:\*\*\s*(.+?)(?:\s+—\s+.+)?$/;

export interface LiveLink {
  /** The newest Check note under the live Target; '' when there is none or it is `none`. */
  cmd: string;
  globs: string[];
  ruling: string;
}

/** The live Target's Check, effective Scope and Ruling, from one read of its section. */
export function liveLink(text: string): LiveLink | null {
  const { body } = parseDecision(text);
  const target = currentTarget(body);
  if (!target) return null;
  const entries = axisEntries(body, liveRulingIdOf(body, true));
  const cmd = lastTaggedNote(entries, CHECK_NOTE_RE) ?? '';
  const globs = (lastTaggedNote(entries, SCOPE_NOTE_RE) ?? target.scope)
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
  return { cmd: cmd === 'none' ? '' : cmd, globs, ruling: target.ruling };
}
