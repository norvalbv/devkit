import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HOOK = fileURLToPath(new URL('../../agents-hooks/placement-brief.mjs', import.meta.url));
// No global devkit bins: only the stubs a test writes into node_modules/.bin can answer.
const PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'placement-brief-')));
  writeFileSync(join(root, 'guard.config.json'), '{}');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A preflight stub that logs `<cwd> <argv>` to calls.log, prints `stdout` and exits `status`. */
function stub(dir: string, name: string, stdout: string, status: number) {
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  const script = `#!/bin/sh\necho "$(pwd) $*" >> '${join(root, 'calls.log')}'\nprintf '%s' '${stdout}'\nexit ${status}\n`;
  writeFileSync(join(dir, 'node_modules', '.bin', name), script, { mode: 0o755 });
}

function calls() {
  const log = join(root, 'calls.log');
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
}

function run(toolInput: Record<string, string>, extra: { cursor_version?: string } = {}) {
  const input = JSON.stringify({ tool_name: 'Write', tool_input: toolInput, ...extra });
  const r = spawnSync(process.execPath, [HOOK], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH, CLAUDE_PROJECT_DIR: root },
    input,
  });
  return r.stdout.trim();
}

describe('placement-brief', () => {
  it('forwards a blocking structure preflight as advice, never a permission decision', () => {
    stub(root, 'guard-structure', 'src/helpers.ts — blocks: Allowed names = index.ts', 1);
    const out = JSON.parse(run({ file_path: join(root, 'src/helpers.ts') }));
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('`src/helpers.ts` is a new file');
    expect(out.hookSpecificOutput.additionalContext).toContain('Allowed names = index.ts');
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(calls()).toEqual([`${root} preflight -- src/helpers.ts`]);
  });

  it('answers a Cursor payload with agent_message', () => {
    stub(root, 'guard-structure', 'blocks: Allowed names = index.ts', 1);
    const out = JSON.parse(run({ target_file: 'src/helpers.ts' }, { cursor_version: '1.7' }));
    expect(out.agent_message).toContain('Allowed names = index.ts');
  });

  it.each([0, 2])('stays silent when the preflight exits %i', (status) => {
    stub(root, 'guard-structure', 'whatever', status);
    expect(run({ file_path: 'src/helpers.ts' })).toBe('');
  });

  it('does not spawn anything for a file that already exists', () => {
    stub(root, 'guard-structure', 'blocks', 1);
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/old.ts'), '');
    expect(run({ file_path: 'src/old.ts' })).toBe('');
    expect(calls()).toEqual([]);
  });

  it('ignores tools other than Write', () => {
    stub(root, 'guard-structure', 'blocks', 1);
    const r = spawnSync(process.execPath, [HOOK], {
      encoding: 'utf8',
      env: { ...process.env, PATH, CLAUDE_PROJECT_DIR: root },
      input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'src/new.ts' } }),
    });
    expect(r.stdout).toBe('');
    expect(calls()).toEqual([]);
  });

  it('runs the preflight from the nearest package config, with a package-relative path', () => {
    const pkg = join(root, 'packages', 'a');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'guard.config.json'), '{}');
    stub(pkg, 'guard-structure', 'blocks', 1);
    run({ file_path: 'packages/a/src/bad.ts' });
    expect(calls()).toEqual([`${pkg} preflight -- src/bad.ts`]);
  });

  it('stays silent outside the project or when no guard.config.json governs the path', () => {
    stub(root, 'guard-structure', 'blocks', 1);
    rmSync(join(root, 'guard.config.json'));
    expect(run({ file_path: 'src/new.ts' })).toBe('');
    expect(run({ file_path: join(tmpdir(), 'elsewhere.ts') })).toBe('');
    expect(calls()).toEqual([]);
  });
});
