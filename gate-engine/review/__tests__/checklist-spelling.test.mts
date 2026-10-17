import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveGuardConfig } from '../../config.mts';
import {
  CHECKLIST_SPELLING_RULE,
  checklistContractFor,
  deriveLensReviewer,
  gateBrief,
} from '../lens/split.mts';
import {
  allowedToolsFor,
  checklistScriptAt,
  hasChecklist,
  REVIEWERS,
  wrapPrompt,
} from '../reviewers.mts';

const cfg = resolveGuardConfig('/nonexistent-cwd-defaults-only');
const checklistReviewers = REVIEWERS.filter(hasChecklist);
const brief = (name: string) =>
  readFileSync(new URL(`../../../agents/${name}.md`, import.meta.url), 'utf8');
const ROOTS = ['.', '.claude', '.agents', '/opt/devkit pkg'];
// Every `node …checklist.mjs` spelling a prompt prints, quoted or bare.
const PRINTED_SCRIPT_RE = /node "[^"]*checklist\.mjs"|node [^\s`"]*checklist\.mjs/g;
// Interactive-only setup a gate judge must never see: each piece is a spelling the grant refuses.
const REFUSED_RE = /\$SCRIPT|\$SKILL_DIR|SCRIPT=|for candidate|interactive-only/;
const CASES = checklistReviewers.flatMap((reviewer) =>
  ROOTS.flatMap((root) => [
    { reviewer, root, reviewRoot: undefined, mode: 'commit' },
    { reviewer, root, reviewRoot: '/tmp/review assets', mode: 'review' },
  ]),
);

describe('a gate judge is shown only the checklist spelling its grant allows', () => {
  it.each(CASES)('$reviewer.name under $root ($mode mode)', ({ reviewer, root, reviewRoot }) => {
    const prompt = wrapPrompt(
      brief(reviewer.name),
      reviewer,
      ['src/a.ts'],
      reviewRoot,
      undefined,
      {},
      root,
    );
    const [, granted] = /Bash\((.*):\*\)/.exec(allowedToolsFor(reviewer, cfg, root)) ?? [];
    expect(prompt).not.toMatch(REFUSED_RE);
    expect(new Set(prompt.match(PRINTED_SCRIPT_RE))).toEqual(new Set([granted]));
    expect(prompt).toContain(CHECKLIST_SPELLING_RULE);
  });
});

describe('checklist spelling', () => {
  const [reviewer] = checklistReviewers;

  it('quotes a script path with a space in both the grant and the printed command', () => {
    const script = checklistScriptAt(reviewer, '/opt/devkit pkg');
    expect(allowedToolsFor(reviewer, cfg, '/opt/devkit pkg')).toContain(`Bash(node "${script}":*)`);
    expect(checklistContractFor(reviewer, script)).toContain(
      `\`node "${script}" ${reviewer.cmds.gen}\``,
    );
  });

  it('puts the spelling rule in every contract branch', () => {
    const script = checklistScriptAt(reviewer);
    for (const contract of [
      checklistContractFor(reviewer, script),
      checklistContractFor(reviewer, script, '/tmp/assets'),
      checklistContractFor(deriveLensReviewer(reviewer, ['state-transitions']), script),
    ])
      expect(contract).toContain(CHECKLIST_SPELLING_RULE);
  });

  it('prints a path holding replacement-pattern characters byte for byte', () => {
    const script = '/tmp/$&x/skills/correctness/scripts/checklist.mjs';
    const out = gateBrief('node $SCRIPT generate\nRead $SKILL_DIR/SKILL.md', script);
    expect(out).toBe(`node ${script} generate\nRead /tmp/$&x/skills/correctness/SKILL.md`);
  });
});
