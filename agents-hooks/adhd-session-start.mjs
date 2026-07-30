#!/usr/bin/env node
// SessionStart: re-assert the i-have-adhd output style so it is active from turn one.
//
// WHY a hook and not just the skill. The skill sets `disable-model-invocation: true`, so it can
// NEVER self-activate — without this it only ever runs when someone types /i-have-adhd. For a
// reading-accessibility preference that is backwards: the reader who needs it is the least likely
// to remember to ask for it every session. Selecting the component therefore means always-on.
//
// WHY the matcher includes `compact`. The skill body claims to apply "for the rest of the
// session", but that is instruction text, not enforcement — a compaction drops it and the shaping
// silently decays. Re-firing on compact/resume/clear restores it exactly when context pressure
// would have eroded it. Same mechanism frink's ponytail-frink plugin uses.
//
// Portable (W-3): reads the SYNCED skill from the consumer repo, never __dirname/packageDir, so a
// consumer who edits their copy gets THEIR copy injected. Self-skips silently whenever the skill
// is absent (skills deselected, or a surface that never received it) — a hook must never be the
// thing that breaks a session start.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

// The durable off switch. `stop adhd mode` turns the style off for the REST of a session, but a
// later compaction re-fires this hook and would silently turn it back on — so a reader who wants
// it off for good needs a signal that outlives the conversation. Absent = on (always-on default).
const OFF_FLAG = join(projectDir, '.devkit', 'adhd-off');
if (existsSync(OFF_FLAG)) process.exit(0);

const skillPath = join(projectDir, '.claude', 'skills', 'i-have-adhd', 'SKILL.md');
let body;
try {
  // Inject the BODY only: the YAML frontmatter is skill-loader metadata (name/description/license),
  // not instructions, and shipping it as context would just be noise.
  // \r?\n throughout: a Windows checkout (core.autocrlf) yields CRLF, and an LF-only pattern
  // would silently fail to match — leaking the YAML frontmatter into the injected context.
  body = readFileSync(skillPath, 'utf8')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    .trim();
} catch {
  process.exit(0); // skill not synced here — say nothing
}
if (!body) process.exit(0);

// devkit's own footer, appended rather than merged into the file: the vendored SKILL.md must stay
// byte-identical to its pinned upstream (cli/lib/install/vendored-skills.mts asserts its sha256),
// so anything devkit wants to add has to live here.
const footer =
  '\n\n---\ndevkit injected this automatically at session start (the `adhd` component is on). ' +
  'Saying "stop adhd mode" turns it off for the rest of THIS session; because this hook also ' +
  'runs after a compaction, make it stick by creating `.devkit/adhd-off` (delete it to re-enable), ' +
  'or remove the component with `devkit init --no-adhd`.';

process.stdout.write(
  JSON.stringify({
    systemMessage: 'i-have-adhd output style active',
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: body + footer },
  }),
);
