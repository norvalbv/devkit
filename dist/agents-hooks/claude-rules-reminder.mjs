#!/usr/bin/env node
// UserPromptSubmit nudge: prompt a self-check of the consumer's CLAUDE.md numbered rules
// WITHOUT restating them. Restating would make "do you remember them?" trivially yes; the
// point is to catch the case where the rules have fallen out of context (e.g. after
// compaction). If the agent cannot recall all of them verbatim, it should STOP and tell the
// user rather than work from a partial memory.
//
// Portable (W-3): reads CLAUDE.md from the CONSUMER cwd (CLAUDE_PROJECT_DIR). MUST self-skip
// silently when no CLAUDE.md exists, or when it has no numbered `<rule id=` markers — so a
// repo without that convention is never nagged.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

let count = 0;
try {
  const claudeMd = readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8');
  count = (claudeMd.match(/<rule id=/g) ?? []).length;
} catch {
  process.exit(0); // no CLAUDE.md here — say nothing
}
if (count === 0) process.exit(0); // CLAUDE.md present but no numbered rules — nothing to guard

const reminder =
  `Reminder: CLAUDE.md defines ${count} numbered rules. Before substantive work, ` +
  `self-check that you can recall ALL ${count} verbatim. If you cannot, they have likely ` +
  `been lost from context (compaction) — STOP and tell the user so they can reload CLAUDE.md, ` +
  `rather than proceeding on a partial memory of the rules.`;

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: reminder },
  }),
);
