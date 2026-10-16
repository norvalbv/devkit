import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CheckResult } from '../../gate-engine/comment-firewall/check.mts';

const HOOK = fileURLToPath(
  new URL('../../agents-hooks/comment-budget-preflight.mjs', import.meta.url),
);

let root: string;
let n = 0;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'comment-preflight-'));
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const item = (key: string, line: string) => ({ key, line });

/** The hook's contract with the CLI is only "check <rel> prints one JSON object"; argv is logged. */
function stubBin(result: CheckResult, status = 0) {
  const bin = join(root, 'node_modules', '.bin', 'guard-comments');
  const body = `#!/bin/sh\necho "$*" >> '${join(root, 'argv.log')}'\ncat <<'EOF'\n${JSON.stringify(result)}\nEOF\nexit ${status}\n`;
  writeFileSync(bin, body, { mode: 0o755 });
}

function run(filePath: string, session: string, toolName = 'Write', projectDir = root) {
  return spawnSync('node', [HOOK], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    input: JSON.stringify({
      tool_name: toolName,
      session_id: session,
      tool_input: { file_path: isAbsolute(filePath) ? filePath : join(root, filePath) },
    }),
  });
}

function context(stdout: string): string {
  return JSON.parse(stdout).hookSpecificOutput.additionalContext;
}

describe('comment-budget-preflight hook', () => {
  it('advises each finding once per session and never blocks', () => {
    n += 1;
    const session = `s${n}-${Date.now()}`;
    stubBin({ items: [item('aaa111', 'src/a.ts:1-3 — // x')], remedy: 'Shorten it.' });
    const first = run('src/a.ts', session);
    expect(first.status).toBe(0);
    const parsed = JSON.parse(first.stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(context(first.stdout)).toContain('  • src/a.ts:1-3 — // x');
    expect(context(first.stdout)).toContain('Shorten it.');
    expect(run('src/a.ts', session, 'Edit').stdout).toBe('');

    stubBin({
      items: [item('aaa111', 'src/a.ts:1-3 — // x'), item('bbb222', 'src/a.ts:9-11 — // y')],
      remedy: 'Shorten it.',
    });
    const again = context(run('src/a.ts', session).stdout);
    expect(again).toContain('src/a.ts:9-11');
    expect(again).not.toContain('src/a.ts:1-3');
  });

  it('runs check from the nearest guard.config.json with a path relative to it', () => {
    mkdirSync(join(root, 'packages/api/src'), { recursive: true });
    writeFileSync(join(root, 'packages/api/guard.config.json'), '{}\n');
    stubBin({ items: [], remedy: '' });
    expect(run('packages/api/src/a.ts', 'nested').stdout).toBe('');
    expect(readFileSync(join(root, 'argv.log'), 'utf8')).toBe('check src/a.ts\n');
  });

  it('checks a root file whose name merely starts with two dots', () => {
    stubBin({ items: [], remedy: '' });
    run('..helpers.ts', 'dots');
    expect(readFileSync(join(root, 'argv.log'), 'utf8')).toBe('check ..helpers.ts\n');
  });

  it('stays silent on a CLI without the verb, and never spawns it for a non-JS or outside file', () => {
    stubBin({ items: [item('ccc333', 'x')], remedy: '' }, 4);
    const old = run('src/a.ts', 'old-bin');
    expect(old.status).toBe(0);
    expect(old.stdout).toBe('');
    rmSync(join(root, 'argv.log'));
    expect(run('README.md', 'markdown').stdout).toBe('');
    expect(run(join(tmpdir(), 'elsewhere.ts'), 'outside').stdout).toBe('');
    expect(existsSync(join(root, 'argv.log'))).toBe(false);
  });

  it('keeps a large advisory under the 10,000-character context limit and shows the rest later', () => {
    const items = Array.from({ length: 60 }, (_, i) =>
      item(`k${i}`, `src/big.ts:${i * 4 + 1}-${i * 4 + 3} — ${'x'.repeat(160)}`),
    );
    stubBin({ items, remedy: 'Shorten it.' });
    const session = `big-${Date.now()}`;
    const first = context(run('src/big.ts', session).stdout);
    expect(first.length).toBeLessThan(10_000);
    expect(first).toContain('src/big.ts:1-3');
    expect(first).toContain('50 more');
    expect(first.endsWith('Shorten it.')).toBe(true);
    const second = context(run('src/big.ts', session).stdout);
    expect(second).toContain('src/big.ts:41-43');
    expect(second).not.toContain('src/big.ts:1-3');
    expect(second).toContain('40 more');
  });

  it('runs when the project dir and the edited path spell the checkout differently', () => {
    const link = `${root}-link`;
    symlinkSync(root, link);
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src/a.ts'), '// x\n');
      stubBin({ items: [item(`sym${Date.now()}`, 'src/a.ts:1-3 — // x')], remedy: '' });
      const out = run(join(realpathSync(root), 'src/a.ts'), `sym-${Date.now()}`, 'Write', link);
      expect(context(out.stdout)).toContain('src/a.ts:1-3');
    } finally {
      rmSync(link, { force: true });
    }
  });
});
