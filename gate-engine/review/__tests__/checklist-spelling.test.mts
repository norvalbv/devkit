import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveGuardConfig } from '../../config.mts';
import {
  CHECKLIST_SPELLING_RULE,
  checklistContractFor,
  deriveLensReviewer,
  gateBrief,
  scriptCommand,
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
const ROOTS = ['.', '.claude', '.agents', '/opt/devkit pkg', "/opt/dev$k'it"];
// Each breaks a bare shell word: split, expansion, substitution, quoting, or a command separator.
const SHELL_CHARS = [' ', '$', '`', '"', "'", "''", '&', ';', '(', 'é'];
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
    // A brief line spliced with a raw root would leave a checklist.mjs the grant never names.
    expect(prompt).toContain(granted);
    expect(prompt.replaceAll(granted, '')).not.toContain('checklist.mjs');
    expect(prompt).toContain(CHECKLIST_SPELLING_RULE);
  });
});

describe('checklist spelling', () => {
  const [reviewer] = checklistReviewers;

  it.each(SHELL_CHARS)('prints and grants a root holding %j in one spelling', (c) => {
    const root = `/opt/dev${c}kit`;
    const cmd = scriptCommand(checklistScriptAt(reviewer, root));
    expect(cmd).toMatch(/^node '.*'$/);
    expect(allowedToolsFor(reviewer, cfg, root)).toContain(`,Bash(${cmd}:*)`);
    expect(checklistContractFor(reviewer, checklistScriptAt(reviewer, root))).toContain(
      `\`${cmd} ${reviewer.cmds.gen}\``,
    );
    expect(gateBrief('node $SCRIPT generate', checklistScriptAt(reviewer, root))).toBe(
      `${cmd} generate`,
    );
  });

  it.each(SHELL_CHARS)('the printed command for a root holding %j runs that script', (c) => {
    const root = path.join(mkdtempSync(path.join(tmpdir(), 'checklist-spelling-')), `dev${c}kit`);
    const script = checklistScriptAt(reviewer, root);
    mkdirSync(path.dirname(script), { recursive: true });
    writeFileSync(script, 'console.log(process.argv.slice(1).join("|"));\n');
    const out = execFileSync('sh', ['-c', `${scriptCommand(script)} generate`], {
      encoding: 'utf8',
    });
    expect(out.trim()).toBe(`${script}|generate`);
  });

  it('leaves a shell-plain path bare, a comma included', () => {
    expect(scriptCommand('.claude/skills/x/scripts/checklist.mjs')).toBe(
      'node .claude/skills/x/scripts/checklist.mjs',
    );
    // A bare comma survives the comma-joined --allowedTools merge byte for byte.
    expect(allowedToolsFor(reviewer, cfg, '/opt/dev,kit')).toContain(
      `,Bash(node ${checklistScriptAt(reviewer, '/opt/dev,kit')}:*)`,
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
    expect(out).toBe(`node '${script}' generate\nRead /tmp/$&x/skills/correctness/SKILL.md`);
  });
});
