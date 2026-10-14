#!/usr/bin/env node
// UserPromptSubmit: a one-line restatement of the i-have-adhd rules that decay first.
//
// WHY a per-turn line when SessionStart already injects the whole skill. The full body enters the
// context once and then sits at a fixed early position while the conversation grows — measured here
// at up to 30 user turns and ~1M tokens between re-assertions. Instruction adherence falls with that
// distance (MMMT-IF, arXiv 2409.18216: 0.81 → 0.64 over 20 turns), and the fix with direct evidence
// behind it is proximity to the point of generation, not a higher-privilege channel: re-stating the
// constraint near the end of context recovered +22.3 points there. This lands immediately before
// each response.
//
// WHY it stays one line. Redundant reinforcement is not free — repetition that reinforces one
// instruction measurably degrades adherence to others (arXiv 2602.04294). So this restates only the
// rules that actually decay, and never the whole body.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

// Same durable off switch as the SessionStart hook — one file turns the whole component off.
if (existsSync(join(projectDir, '.devkit', 'adhd-off'))) process.exit(0);

// Say nothing unless the skill is actually installed. A hook script can outlive its component (a
// stale copy, a reclaim that left the registration behind), and an anchor for a style whose body
// never loaded would shape output against instructions the model was never given.
if (!existsSync(join(projectDir, '.devkit', 'vendored-skills', 'i-have-adhd', 'SKILL.md'))) {
  process.exit(0);
}

// devkit's own compression of the skill, not a quote from it: the vendored SKILL.md must stay
// byte-identical to its pinned upstream, so anything devkit authors lives here. The closing clause
// is load-bearing — without it a terse anchor pulls explanatory answers short, which is the one
// failure mode the skill itself calls out as worth breaking its rules for.
const ANCHOR =
  'ADHD MODE ACTIVE. Open with the next action, not context. Number multi-step work; ' +
  'restate step N of M. No preamble/recap/closer. End with ONE concrete next action. ' +
  'If asked to explain: full length, headers, still no preamble.';

// No systemMessage: this fires on every prompt, and a per-turn notice would be pure UI noise.
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ANCHOR },
  }),
);
