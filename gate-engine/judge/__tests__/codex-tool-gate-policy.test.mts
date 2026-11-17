import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { judgeToolCall } from '../codex/tool-gate-policy.mts';

const GRANTS = [
  './skills/correctness/scripts/checklist.mjs',
  './skills/backend-performance/scripts/checklist.mjs',
  './skills/commit-guard/scripts/checklist.mjs',
  './skills/api-security/scripts/checklist.mjs',
];

// Every command codex gate judges ran in recorded devkit reviews (codex-cli 0.162.1, Oct 2026),
// taken from the telemetry `*.commands.txt` transcripts with the checkout path replaced.
const RECORDED: string[] = JSON.parse(
  readFileSync(new URL('./fixtures/codex-judge-commands.json', import.meta.url), 'utf8'),
);

const SCOPE = { grants: GRANTS, repoRoot: '/work/repo' };
const bash = (command: string) => judgeToolCall('Bash', command, SCOPE);

describe('judgeToolCall: what a real codex judge runs stays allowed', () => {
  it.each(RECORDED)('%s', (command) => {
    expect(bash(command)).toEqual({ allow: true });
  });

  it.each([
    'rg -n x . 2>/dev/null | head -5',
    "rg -n 'x' f || true",
    'cd /work/repo && git status --short',
    'git -C /work/repo --no-pager log --oneline -5',
    "rg -n 'a|b' --glob '*.mts' .",
    'node skills/correctness/scripts/checklist.mjs status',
    "find . -name '*.mts' -type f",
    'sort -u a.txt | uniq -c',
    "printf $'a\\tb\\n'",
    'cd /work/repo/ && pwd',
    'git diff --no-ext-diff --cached',
  ])('%s', (command) => {
    expect(bash(command)).toEqual({ allow: true });
  });

  it('runs a packaged checklist only by the absolute path the grant names', () => {
    const packaged = '/opt/node_modules/@norvalbv/devkit/skills/x/scripts/checklist.mjs';
    expect(judgeToolCall('Bash', `node ${packaged} generate`, { grants: [packaged] })).toEqual({
      allow: true,
    });
  });

  it('allows MCP tools and the plan tool, which run no shell', () => {
    expect(judgeToolCall('mcp__codebase__searchCode', undefined, { grants: [] })).toEqual({
      allow: true,
    });
    expect(judgeToolCall('update_plan', undefined, { grants: [] })).toEqual({ allow: true });
  });
});

describe('judgeToolCall: anything that runs tests or writes is refused', () => {
  it.each([
    'bun test',
    'npm test',
    'bunx vitest run',
    'node node_modules/vitest/vitest.mjs run',
    'CI=1 bun test',
    'bun test 2>&1 | tail',
    "sed -n '1,2p' a\nbun test",
    'cat "$(bun test)"',
    'cat `npm test`',
    'cat $X',
    "sh -c 'bun test'",
    "zsh -lc 'bun test'",
    'bash',
    'xargs bun test',
    'find . -exec bun test {} +',
    'find . -delete',
    'rg --pre=sh x',
    'rg -nz x',
    'rg --hostname-bin=node_modules/.bin/vitest x',
    'sort --compress-program=sh README.md',
    'sort -uo out in',
    'sort -o/tmp/x in',
    'sort --outp=x in',
    'git diff --outp=x',
    'git diff --ext-d',
    'rg --hostname=node_modules/.bin/vitest x',
    'cd /tmp',
    'cd',
    // A file the reviewed diff adds named `--output=x` would turn these globs into a write flag.
    'sort *',
    'git diff *',
    'cat src/?.mts',
    'ls [a-z]*',
    'ls ^foo',
    'git -C /tmp log',
    'uniq in out',
    "sed -i 's/a/b/' f",
    "sed -n '1e bun test' f",
    'git -c core.pager=sh log',
    'git diff --output=x',
    'git diff --ext-diff',
    'git push origin main',
    'cat a > f',
    'cat a >> f',
    'cat a &',
    'echo a &| bun test',
    'cat x;;bun test',
    "cat package.json(e:'bun test':)",
    'cat x =(bun test) y',
    'ls | sort {bun test}',
    'cat <(bun test)',
    '(bun test)',
    '{ bun test; }',
    'for f in a; do bun test; done',
    'if true; then bun test; fi',
    'node -e "require(\'child_process\')"',
    'node scratch/scripts/evil.mjs',
    '',
  ])('%j', (command) => {
    expect(bash(command).allow).toBe(false);
  });

  // The checked-out tree holds the diff under review, so a script it adds at a lookalike path is
  // consumer code; only the exact granted path is the checklist.
  it.each([
    'node staged/skills/correctness/scripts/checklist.mjs generate',
    'node /work/repo/evil/skills/correctness/scripts/checklist.mjs generate',
    'node ./skills/other/scripts/checklist.mjs generate',
    'cd staged && node ./skills/correctness/scripts/checklist.mjs generate',
    'cd /work/repo/evil && node skills/correctness/scripts/checklist.mjs generate',
  ])('denies a script that only resembles the grant: %s', (command) => {
    expect(bash(command).allow).toBe(false);
  });

  it.each(['apply_patch', 'spawn_agent', 'computer_use', ''])('denies the %j tool', (tool) => {
    expect(judgeToolCall(tool, 'cat a', SCOPE).allow).toBe(false);
  });

  it('tells the judge how to recover', () => {
    const decision = judgeToolCall('Bash', 'node $SCRIPT generate', {
      grants: ['.claude/skills/x/scripts/checklist.mjs'],
    });
    expect(decision).toMatchObject({ allow: false });
    expect(decision.allow || decision.reason).toContain(
      'node .claude/skills/x/scripts/checklist.mjs',
    );
    const test = bash('bun test');
    expect(test.allow || test.reason).toContain('tests belong to the pre-push suite');
  });
});
