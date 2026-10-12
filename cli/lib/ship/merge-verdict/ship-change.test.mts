import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { notRun } from '../evidence/outcome.mts';
import { numstat, printVerdict } from './ship-change.mts';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'ship-change-'));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    }).trim();
  git('init', '-q', '-b', 'main');
  const commit = (files: Record<string, string | Buffer>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    git('add', '-A');
    git('commit', '-qm', 'c', '--allow-empty');
    return git('rev-parse', 'HEAD');
  };
  return { root, git, commit };
}

const lines = (n: number) => 'x\n'.repeat(n);
const policy = (limit: number) =>
  JSON.stringify({ mergeVerdict: { limits: { default: { maxSourceLines: limit } } } });

function shipEnv(shipId: string) {
  const sink = join(mkdtempSync(join(tmpdir(), 'ship-change-sink-')), 'gate-events.jsonl');
  roots.push(dirname(sink));
  const row = (type: string, extra = {}) => JSON.stringify({ ship_id: shipId, type, ...extra });
  writeFileSync(sink, `${row('ship_attempt')}\n${row('ship_result', { exit_code: 0 })}\n`);
  return { DEVKIT_SHIP_ID: shipId, DEVKIT_GATE_EVENTS: sink };
}

function verdictFor(root: string, base: string, head: string, env: NodeJS.ProcessEnv = {}) {
  const outcome = notRun('no-test-change', 'x', head, base);
  return printVerdict({ cwd: root, head, baseRefOid: base, title: 'fix: x', outcome, env });
}

describe('numstat', () => {
  it('counts text lines, reads a binary file as null and keeps a path with spaces whole', () => {
    const { root, commit } = repo();
    const base = commit({ 'a.txt': 'one\n' });
    const head = commit({
      'a.txt': 'two\nthree\n',
      'dir with space/b.bin': Buffer.from([0, 1, 2, 0]),
    });
    expect(numstat(root, base, head)).toEqual([
      { path: 'a.txt', added: 2, deleted: 1 },
      { path: 'dir with space/b.bin', added: null, deleted: null },
    ]);
  });
});

describe('printVerdict', () => {
  it('prints the verdict at its head and keeps every reason', () => {
    const { root, commit } = repo();
    const base = commit({ 'guard.config.json': policy(10) });
    const head = commit({ 'src/fix.mts': lines(12) });
    const printed = verdictFor(root, base, head, shipEnv('s1'));
    expect(printed.line).toBe(
      `**Merge verdict:** human-review (over-size: 12/10 lines, 1/4 files, default limit) · advisory, at \`${head.slice(0, 12)}\``,
    );
    expect(printed.verdict?.reasons.map((r) => r.code)).toEqual(['over-size', 'no-captured-proof']);
  });

  it("judges by the base tree's policy, so a PR cannot loosen its own limits", () => {
    const { root, commit } = repo();
    const base = commit({ 'guard.config.json': policy(10) });
    const head = commit({ 'guard.config.json': policy(500), 'src/fix.mts': lines(12) });
    expect(verdictFor(root, base, head, shipEnv('s2')).verdict?.reasons).toContainEqual({
      code: 'over-size',
      detail: '12/10 lines, 1/4 files, default limit',
    });
  });

  it("reads the checkout's untracked policy when the base tree has none", () => {
    const { root, commit } = repo();
    const base = commit({ 'README.md': 'x\n' });
    const head = commit({ 'src/fix.mts': lines(12) });
    writeFileSync(join(root, 'guard.config.json'), policy(10));
    expect(verdictFor(root, base, head, shipEnv('s3')).verdict?.reasons[0].code).toBe('over-size');
  });

  it('reads the bypass record as unknown outside a ship', () => {
    const { root, commit } = repo();
    const base = commit({ 'README.md': 'x\n' });
    const head = commit({ 'src/fix.mts': lines(1) });
    expect(verdictFor(root, base, head).line).toContain(
      'human-review (bypass-unknown: no devkit ship gate run)',
    );
  });

  it('says the verdict is unavailable, and why, when a fact cannot be read', () => {
    const { root, commit } = repo();
    const head = commit({ 'src/fix.mts': lines(1) });
    const printed = verdictFor(root, 'f'.repeat(40), head);
    expect(printed.verdict).toBeUndefined();
    expect(printed.line).toMatch(/^\*\*Merge verdict:\*\* unavailable \(.+\)$/s);
    const untitled = printVerdict({
      cwd: root,
      head,
      baseRefOid: head,
      title: undefined,
      outcome: notRun('docs-only', 'x', head, null),
      env: {},
    });
    expect(untitled).toEqual({
      line: '**Merge verdict:** unavailable (the PR title was not read)',
    });
  });
});
