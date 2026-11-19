import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertNoNewGateLogHeaders,
  REPO_ROOT,
  readGateLogHeaders,
} from '../../vitest.global-setup.mjs';

// The suite-end guard: a test hook run from the real checkout rewrites its commit gate log.

const HEADER = '=== devkit pre-commit gates · feat/x · attempt none · 2026-10-14T21:42:50Z';
const roots: string[] = [];

function repoWithLogs(logs: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'dk-gate-log-guard-'));
  roots.push(root);
  mkdirSync(join(root, '.devkit'));
  for (const [name, body] of Object.entries(logs)) writeFileSync(join(root, '.devkit', name), body);
  return root;
}

const write = (root: string, name: string, body: string) =>
  writeFileSync(join(root, '.devkit', name), body);

const check = (before: Map<string, string[]>, root: string) => () =>
  assertNoNewGateLogHeaders(before, readGateLogHeaders(root));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('commit gate log guard', () => {
  it('passes a live commit appending its own output to its log', () => {
    const root = repoWithLogs({ 'last-commit-gates-feat-x.log': `${HEADER}\n🚧 gates...\n` });
    const before = readGateLogHeaders(root);
    write(root, 'last-commit-gates-feat-x.log', `${HEADER}\n🚧 gates...\nrelated-tests: 3\n`);
    expect(check(before, root)).not.toThrow();
  });

  it('flags a log truncated and rewritten under a new header', () => {
    const root = repoWithLogs({ 'last-commit-gates-feat-x.log': `${HEADER}\n` });
    const before = readGateLogHeaders(root);
    const rewritten = HEADER.replace('21:42:50Z', '21:43:07Z');
    write(
      root,
      'last-commit-gates-feat-x.log',
      `${rewritten}\n   guard-review: judge unavailable\n`,
    );
    expect(check(before, root)).toThrow(`last-commit-gates-feat-x.log: ${rewritten}`);
  });

  it('flags a log that appeared during the run, and ignores other .devkit files', () => {
    const root = repoWithLogs({});
    const before = readGateLogHeaders(root);
    write(root, 'last-commit-gates-main.log', `${HEADER}\n`);
    write(root, 'config.json', `${HEADER}\n`);
    expect([...readGateLogHeaders(root).keys()]).toEqual(['last-commit-gates-main.log']);
    expect(check(before, root)).toThrow(`last-commit-gates-main.log: ${HEADER}`);
  });

  it('reads a repository without .devkit as holding no logs', () => {
    const root = mkdtempSync(join(tmpdir(), 'dk-gate-log-guard-'));
    roots.push(root);
    expect(readGateLogHeaders(root)).toEqual(new Map());
  });

  // Moved out of the repo root, the guard would read some other .devkit and never fire.
  it('watches the directory the hook writes to: the git toplevel', () => {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    expect(realpathSync(REPO_ROOT)).toBe(realpathSync(top));
  });
});
