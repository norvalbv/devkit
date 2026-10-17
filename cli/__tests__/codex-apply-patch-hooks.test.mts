/** The edit hooks against Codex `apply_patch` payloads: the patch text names the files, never a
 * file_path. Hooks are installed the way codexCommand runs them: no CLAUDE_PROJECT_DIR, cwd = session. */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { decide } from '../../agents-hooks/decision-edit-guard.mjs';
import { patchTargets } from '../../agents-hooks/edit-targets-lib.mjs';
import {
  EDIT_TARGETS_LIB,
  hookScriptsFor,
} from '../lib/install/hook-registration-ledger/selection.mts';
import { rootRegistry } from './_helpers.mts';

const HOOKS = fileURLToPath(new URL('../../agents-hooks/', import.meta.url));
const SCOPED_TARGETS = fileURLToPath(
  new URL('../../gate-engine/decisions/scoped-targets.mts', import.meta.url),
);
const CAPTURED = JSON.parse(
  readFileSync(new URL('./fixtures/codex/apply-patch.json', import.meta.url), 'utf8'),
).payload;
const BASH = existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const { HOME, PATH } = process.env;

const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

/** A repo shaped like the capture (session in pkg/, records at the root), with a space in its path. */
function codexRepo() {
  const root = realpathSync(mkTmp('codex patch-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const files = { 'pkg/src/b.ts': 'export const b = 1;\n', 'docs/decisions/x.md': '# x\n' };
  for (const [rel, body] of Object.entries(files)) write(root, rel, body);
  return root;
}

function write(root: string, rel: string, body: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

/** The captured patch's effect on disk, as PostToolUse sees it: c.ts deleted, m.ts moved to n.ts. */
function applyCapturedPatch(root: string) {
  write(root, 'pkg/src/a.test.ts', "import { vi } from 'vitest';\nvi.mock('./b');\n");
  write(root, 'pkg/src/b.ts', 'export const b = 2;\n');
  write(root, 'pkg/src/n.ts', 'n\n');
}

function install(root: string, ...names: string[]) {
  mkdirSync(join(root, '.codex', 'hooks'), { recursive: true });
  for (const name of names) copyFileSync(join(HOOKS, name), join(root, '.codex', 'hooks', name));
  return (name: string) => join(root, '.codex', 'hooks', name);
}

const codexPayload = (root: string, event: string, command = CAPTURED.tool_input.command) => ({
  ...CAPTURED,
  hook_event_name: event,
  tool_input: { command },
  cwd: join(root, 'pkg'),
  session_id: `codex-${Math.random().toString(36).slice(2)}`,
});

/** A hook payload: Codex sends the patch as tool_input.command, Claude sends a file_path. */
interface HookPayload {
  tool_name: string;
  tool_input: Record<string, string>;
}

function runHook(file: string, payload: HookPayload, cwd: string, env: NodeJS.ProcessEnv = {}) {
  const runner = file.endsWith('.sh') ? BASH : process.execPath;
  return spawnSync(runner, [file], {
    cwd,
    encoding: 'utf8',
    env: { HOME, PATH, ...env },
    input: JSON.stringify(payload),
  });
}

function stubBin(root: string, name: string, script: string) {
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(root, 'node_modules', '.bin', name), `#!/bin/sh\n${script}`, { mode: 0o755 });
}

const patch = (...lines: string[]) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');

describe('patchTargets', () => {
  it('resolves every header of the captured patch against the session cwd', () => {
    const root = codexRepo();
    const src = join(root, 'pkg', 'src');
    expect(patchTargets(codexPayload(root, 'PreToolUse'))).toEqual(
      ['a.test.ts', 'b.ts', 'c.ts', 'm.ts', 'n.ts'].map((f) => join(src, f)),
    );
  });

  it('reads both wire shapes, CRLF headers and absolute paths, and never a hunk line', () => {
    const text = patch(
      '*** Update File: /abs/x.ts\r',
      '@@',
      ' *** Add File: hunk.ts',
      '+*** Delete File: y',
    );
    for (const toolInput of [{ command: text }, { input: text }, text])
      expect(patchTargets({ tool_name: 'apply_patch', tool_input: toolInput, cwd: '/' })).toEqual([
        '/abs/x.ts',
      ]);
  });

  it('returns nothing for other tools and for text that is not a patch', () => {
    expect(
      patchTargets({ tool_name: 'Edit', tool_input: { command: patch('*** Add File: a') } }),
    ).toEqual([]);
    expect(
      patchTargets({ tool_name: 'apply_patch', tool_input: { command: '*** Add File: a' } }),
    ).toEqual([]);
  });

  it('spells paths physically when the session cwd is reached through a symlink', () => {
    const root = codexRepo();
    const link = join(mkTmp('codex-link-'), 'repo');
    symlinkSync(root, link);
    const input = { tool_name: 'apply_patch', tool_input: patch('*** Add File: a.ts'), cwd: link };
    expect(patchTargets(input)).toEqual([join(root, 'a.ts')]);
  });

  it('prints one single-file payload per target in --payloads mode', () => {
    const root = codexRepo();
    const run = spawnSync(process.execPath, [join(HOOKS, EDIT_TARGETS_LIB), '--payloads'], {
      encoding: 'utf8',
      input: JSON.stringify(codexPayload(root, 'PostToolUse')),
    });
    const lines = run.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines.map((p) => p.tool_input)).toContainEqual({
      file_path: join(root, 'pkg/src/n.ts'),
    });
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatchObject({ tool_name: 'apply_patch', hook_event_name: 'PostToolUse' });
  });
});

describe('decision-edit-guard on apply_patch', () => {
  it.each([
    ['an update', patch('*** Update File: ../docs/decisions/x.md', '@@', '+y')],
    ['a delete', patch('*** Delete File: ../docs/decisions/x.md')],
    [
      'a move out of the log',
      patch('*** Update File: ../docs/decisions/x.md', '*** Move to: x.md'),
    ],
  ])('denies %s of a decision record', (_, command) => {
    const root = codexRepo();
    expect(decide(codexPayload(root, 'PreToolUse', command), root)).toContain('docs/decisions');
  });

  it('allows a patch whose hunk merely contains a header-like line', () => {
    const root = codexRepo();
    const command = patch(
      '*** Update File: README.md',
      '@@',
      ' *** Update File: docs/decisions/x.md',
    );
    expect(decide(codexPayload(root, 'PreToolUse', command), root)).toBeNull();
  });

  it('denies from a subdirectory session with no CLAUDE_PROJECT_DIR, as Codex runs it', () => {
    const root = codexRepo();
    const guard = install(
      root,
      'decision-edit-guard.mjs',
      EDIT_TARGETS_LIB,
    )('decision-edit-guard.mjs');
    const command = patch('*** Update File: ../docs/decisions/x.md', '@@', '+y');
    const run = runHook(guard, codexPayload(root, 'PreToolUse', command), join(root, 'pkg'));
    expect(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('still denies a Claude edit when the lib is missing from the hook dir', () => {
    const root = codexRepo();
    const guard = install(root, 'decision-edit-guard.mjs')('decision-edit-guard.mjs');
    const edit = {
      tool_name: 'Edit',
      tool_input: { file_path: join(root, 'docs/decisions/x.md') },
    };
    const run = runHook(guard, edit, root, { CLAUDE_PROJECT_DIR: root });
    expect(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('PostToolUse shell hooks on the captured patch', () => {
  it('anti-slop-preflight checks the added test and blocks on its verdict', () => {
    const root = codexRepo();
    applyCapturedPatch(root);
    write(root, '.devkit/anti-slop/manifest.json', '{}\n');
    const log = join(root, 'argv.log');
    stubBin(
      root,
      'devkit',
      `printf '%s\\n' "$@" >> '${log}'\necho 'ERROR anti-slop/no-module-mocking pkg/src/a.test.ts:2:1'\necho 'anti-slop: FAIL — 1 new error finding(s)' >&2\nexit 1\n`,
    );
    const hook = install(
      root,
      'anti-slop-preflight.sh',
      EDIT_TARGETS_LIB,
    )('anti-slop-preflight.sh');
    const run = runHook(hook, codexPayload(root, 'PostToolUse'), join(root, 'pkg'));
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('anti-slop/no-module-mocking');
    const checked = readFileSync(log, 'utf8');
    expect(checked).toContain('pkg/src/a.test.ts');
    expect(checked).not.toContain('c.ts');
  });

  // Frink delivers the Claude-installed hooks to Codex with CLAUDE_PROJECT_DIR set; devkit's own
  // .codex projection leaves it unset.
  it.each([
    ['as devkit projects it', false],
    ['as Frink delivers it', true],
  ])('format-after-edit records every surviving file in the session ledger (%s)', (_, frink) => {
    const root = codexRepo();
    applyCapturedPatch(root);
    const tmp = mkTmp('codex-ledger-');
    const hook = install(
      root,
      'format-after-edit.sh',
      'session-edits-lib.sh',
      EDIT_TARGETS_LIB,
    )('format-after-edit.sh');
    const env = { TMPDIR: tmp, ...(frink && { CLAUDE_PROJECT_DIR: root }) };
    const run = runHook(hook, codexPayload(root, 'PostToolUse'), join(root, 'pkg'), env);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe('{}');
    const [ledger] = readdirSync(join(tmp, 'devkit-session-edits'));
    const recorded = readFileSync(join(tmp, 'devkit-session-edits', ledger), 'utf8')
      .trim()
      .split('\n');
    expect(recorded.sort()).toEqual(['pkg/src/a.test.ts', 'pkg/src/b.ts', 'pkg/src/n.ts']);
  });

  it('format-after-edit blocks when eslint fails on any patched file', () => {
    const root = codexRepo();
    applyCapturedPatch(root);
    write(root, 'guard.config.json', JSON.stringify({ scanRoots: ['pkg'] }));
    stubBin(root, 'eslint', 'echo ESLINT_RAN >&2\nexit 1\n');
    const hook = install(
      root,
      'format-after-edit.sh',
      'session-edits-lib.sh',
      EDIT_TARGETS_LIB,
    )('format-after-edit.sh');
    const run = runHook(hook, codexPayload(root, 'PostToolUse'), join(root, 'pkg'), {
      TMPDIR: mkTmp('codex-ledger-'),
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(`ESLint violation in ${join(root, 'pkg/src/a.test.ts')}`);
    expect(run.stdout).toBe('');
  });

  it('format-after-edit leaves a patched file outside the workspace alone', () => {
    const root = codexRepo();
    const outside = join(realpathSync(mkTmp('codex-sibling-')), 'x.ts');
    writeFileSync(outside, 'x\n');
    const tmp = mkTmp('codex-ledger-');
    const hook = install(
      root,
      'format-after-edit.sh',
      'session-edits-lib.sh',
      EDIT_TARGETS_LIB,
    )('format-after-edit.sh');
    const payload = codexPayload(root, 'PostToolUse', patch(`*** Update File: ${outside}`));
    const run = runHook(hook, payload, join(root, 'pkg'), { TMPDIR: tmp });
    expect(run.stdout.trim()).toBe('{}');
    expect(existsSync(join(tmp, 'devkit-session-edits'))).toBe(false);
  });
});

describe('advisory hooks on the captured patch', () => {
  it('comment-budget-preflight checks each surviving source file and advises once', () => {
    const root = codexRepo();
    applyCapturedPatch(root);
    const log = join(root, 'argv.log');
    const result = {
      items: [{ key: 'k1', line: 'pkg/src/b.ts:1 — a comment' }],
      remedy: 'Fix it.',
    };
    stubBin(root, 'guard-comments', `echo "$*" >> '${log}'\necho '${JSON.stringify(result)}'\n`);
    const run = runHook(
      join(HOOKS, 'comment-budget-preflight.mjs'),
      codexPayload(root, 'PostToolUse'),
      root,
    );
    expect(readFileSync(log, 'utf8').trim().split('\n').sort()).toEqual([
      'check pkg/src/a.test.ts',
      'check pkg/src/b.ts',
      'check pkg/src/n.ts',
    ]);
    const context = JSON.parse(run.stdout).hookSpecificOutput.additionalContext;
    expect(context).toContain('a comment');
    expect(context.split('Fix it.')).toHaveLength(2);
  });

  it('decision-scope-brief briefs every patched file in one hook result', () => {
    const root = codexRepo();
    const log = join(root, 'argv.log');
    const governed = JSON.stringify([{ slug: 'axis', ruling: 'Settled.', scope: 'pkg/**' }]);
    stubBin(root, 'guard-decisions', `echo "$*" >> '${log}'\necho '${governed}'\n`);
    const run = runHook(
      join(HOOKS, 'decision-scope-brief.mjs'),
      codexPayload(root, 'PreToolUse'),
      root,
      {
        CLAUDE_PROJECT_DIR: root,
      },
    );
    const context = JSON.parse(run.stdout).hookSpecificOutput.additionalContext;
    expect(context).toContain('pkg/src/a.test.ts');
    expect(context).toContain('pkg/src/n.ts');
    expect(readFileSync(log, 'utf8')).toContain('--brief apply_patch,3,320');
  });

  it('decision-scope-brief retrieves for at most five files of a large patch', () => {
    const root = codexRepo();
    const log = join(root, 'argv.log');
    stubBin(root, 'guard-decisions', `echo "$*" >> '${log}'\necho '[]'\n`);
    const files = ['1', '2', '3', '4', '5', '6'].map((n) => `*** Add File: f${n}.ts`);
    runHook(
      join(HOOKS, 'decision-scope-brief.mjs'),
      codexPayload(root, 'PreToolUse', patch(...files)),
      root,
      { CLAUDE_PROJECT_DIR: root },
    );
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls).toHaveLength(5);
    expect(calls.join('\n')).not.toContain('f6.ts');
  });

  it('base-drift-brief asks base-status about every patched path', () => {
    const root = codexRepo();
    const log = join(root, 'argv.log');
    stubBin(root, 'devkit', `printf '%s\\n' "$@" >> '${log}'\nexit 1\n`);
    runHook(join(HOOKS, 'base-drift-brief.mjs'), codexPayload(root, 'PreToolUse'), root, {
      CLAUDE_PROJECT_DIR: root,
    });
    expect(readFileSync(log, 'utf8')).toContain(join(root, 'pkg/src/m.ts'));
  });

  it('scoped-targets records brief telemetry for the apply_patch tool name', () => {
    const sink = join(mkTmp('codex-events-'), 'events.jsonl');
    spawnSync(
      process.execPath,
      [SCOPED_TARGETS, '--files', 'a.ts', '--brief-again', 'apply_patch,5'],
      {
        env: { ...process.env, DEVKIT_GATE_EVENTS: sink },
      },
    );
    expect(JSON.parse(readFileSync(sink, 'utf8'))).toMatchObject({
      type: 'brief_edited_again',
      tool: 'apply_patch',
    });
  });
});

describe('edit-targets-lib ownership', () => {
  it('ships with every component whose edit hooks import it, comments included', () => {
    const none = {
      agentHooks: false,
      decisions: false,
      fallow: false,
      adhd: false,
      priorArtGate: false,
    };
    expect(hookScriptsFor({ ...none, comments: true })).toContain(EDIT_TARGETS_LIB);
    expect(hookScriptsFor({ ...none, agentHooks: true })).toContain(EDIT_TARGETS_LIB);
    expect(hookScriptsFor({ ...none, fallow: true, adhd: true })).not.toContain(EDIT_TARGETS_LIB);
  });
});
