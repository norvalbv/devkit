import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, summarise } from '../../../cli/lib/ship/digest/gate-digest.mts';
import { DEFAULT_UI_PATHS, uiPathReason, uiPaths } from '../check.mts';
import { parseUiVerdict } from '../judge.mts';

const CLI = path.resolve(import.meta.dirname, '../cli.mts');

describe('uiPaths', () => {
  it('matches UI extensions at any depth, including the repo root', () => {
    const staged = ['App.tsx', 'src/a/b/Card.vue', 'styles/site.scss', 'server/db.ts', 'README.md'];
    expect(uiPaths(staged, DEFAULT_UI_PATHS)).toEqual([
      'App.tsx',
      'src/a/b/Card.vue',
      'styles/site.scss',
    ]);
  });

  it('ignores tests, stories, snapshots, e2e and fixture files that carry UI extensions', () => {
    const staged = [
      'src/Button.test.tsx',
      'src/Button.spec.jsx',
      'src/Button.stories.tsx',
      'src/__tests__/x.tsx',
      'src/__snapshots__/x.html',
      'e2e/login.tsx',
      'tests/page.html',
      'src/fixtures/page.html',
    ];
    expect(uiPaths(staged, DEFAULT_UI_PATHS)).toEqual([]);
  });
});

describe('uiPathReason', () => {
  it('names at most three UI files and counts the rest', () => {
    const staged = ['a.tsx', 'b.tsx', 'c.tsx', 'd.css', 'e.css'];
    expect(uiPathReason(staged, [])).toBe('UI paths changed: a.tsx, b.tsx, c.tsx, +2 more');
  });

  it('adds uiEvidence.paths to the extension defaults rather than replacing them', () => {
    expect(uiPathReason(['src/api/price.ts'], ['src/api/**'])).toBe(
      'UI paths changed: src/api/price.ts',
    );
    expect(uiPathReason(['App.tsx'], ['src/api/**'])).toBe('UI paths changed: App.tsx');
    expect(uiPathReason(['server/price.ts'], [])).toBeNull();
  });
});

describe('parseUiVerdict', () => {
  it('reads the verdict from the first line and the why from the rest', () => {
    expect(parseUiVerdict('VISIBLE\nthe checkout total shows two decimals')).toEqual({
      visible: true,
      why: 'the checkout total shows two decimals',
    });
    expect(parseUiVerdict('NONE\nretry policy only')).toEqual({
      visible: false,
      why: 'retry policy only',
    });
  });

  it('is null when the reply names neither or both verdicts', () => {
    expect(parseUiVerdict('maybe')).toBeNull();
    expect(parseUiVerdict('VISIBLE or NONE')).toBeNull();
  });
});

/** A throwaway repo with `files` staged, and a clean environment for the gate. */
function stagedRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ui-evidence-'));
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, env: gitFreeEnv() });
  git('init', '-q');
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), body);
  }
  git('add', '-A');
  return dir;
}

function gitFreeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
  );
  delete env.DEVKIT_COMMIT_MSG_FILE;
  delete env.DEVKIT_RUN_MODE;
  return { ...env, ...extra };
}

/** A fake `claude` on PATH that counts its calls in `dir/calls` and runs `script`. */
function judgeStub(dir: string, script: string) {
  const bin = path.join(dir, 'stub-bin');
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, 'claude'),
    `#!/bin/sh\ncat >"${dir}/.git/judged"\necho x >> "${dir}/calls"\n${script}`,
  );
  chmodSync(path.join(bin, 'claude'), 0o755);
  // The repo default judge family is codex; pin a claude model so the stub is the one spawned.
  return { PATH: `${bin}:${process.env.PATH}`, GUARD_REVIEW_MODEL: 'haiku' };
}

const judgeCalls = (dir: string) =>
  existsSync(path.join(dir, 'calls'))
    ? readFileSync(path.join(dir, 'calls'), 'utf8').split('\n').length - 1
    : 0;

function runGate(dir: string, subject: string | null, extra: Record<string, string> = {}) {
  const sink = path.join(dir, '.git', 'events.jsonl');
  const env = gitFreeEnv({ DEVKIT_GATE_EVENTS: sink, DEVKIT_SHIP_ID: 'ship-ui', ...extra });
  if (subject !== null) {
    env.DEVKIT_COMMIT_MSG_FILE = path.join(dir, '.git', 'msg.txt');
    writeFileSync(env.DEVKIT_COMMIT_MSG_FILE, `${subject}\n\nbody\n`);
  }
  const r = spawnSync(process.execPath, [CLI], { cwd: dir, env, encoding: 'utf8' });
  let events: { type: string; gate: string; status: string; detail: string }[] = [];
  try {
    events = readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'advisory_result');
  } catch {
    // no sink file = the gate emitted nothing
  }
  return { code: r.status, stderr: r.stderr, events };
}

describe('guard-ui-evidence CLI', () => {
  it('a staged UI file prints the screenshot instruction without asking the judge', () => {
    const dir = stagedRepo({ 'src/Card.tsx': 'x' });
    const r = runGate(dir, 'feat: card', judgeStub(dir, 'echo VISIBLE'));
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('📸 ui-evidence: Add before (base branch) and after (this branch)');
    expect(r.stderr).toContain('— UI paths changed: src/Card.tsx');
    expect(r.events).toEqual([
      expect.objectContaining({ type: 'advisory_result', gate: 'ui-evidence', status: 'finding' }),
    ]);
    expect(judgeCalls(dir)).toBe(0);
  });

  it('a plain git commit (no ship message) speaks exactly as ship does', () => {
    const atShip = runGate(stagedRepo({ 'src/Card.tsx': 'x' }), 'feat: card');
    const atCommit = runGate(stagedRepo({ 'src/Card.tsx': 'x' }), null);
    expect(atCommit.stderr).toBe(atShip.stderr);
    expect(atCommit.events).toHaveLength(1);
  });

  it('the ship digest keeps where the screenshots go, even when it cuts the detail', () => {
    const many = Object.fromEntries(
      ['a', 'b', 'c', 'd'].map((n) => [`src/components/very-long-name-${n}/Panel.tsx`, 'x']),
    );
    const line = render(summarise(runGate(stagedRepo(many), 'feat: panels').events, 'ship-ui'));
    expect(line).toContain('ui-evidence — advisory, did NOT block this run');
    expect(line).toContain(
      'when you open or update the PR, or say there that nothing visible changed',
    );
  });

  it('a backend change the judge reads as visible gets the same advice, with its why', () => {
    const dir = stagedRepo({ 'server/price.ts': 'export const fmt = (n) => n.toFixed(2);' });
    const r = runGate(dir, null, judgeStub(dir, 'printf "VISIBLE\\nprices show two decimals\\n"'));
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(
      '— the staged diff could change what users see: prices show two decimals',
    );
    expect(r.events).toHaveLength(1);
    expect(readFileSync(path.join(dir, '.git', 'judged'), 'utf8')).toMatch(
      /^Changed files:\nserver\/price\.ts\n\ndiff --git a\/server\/price\.ts b\/server\/price\.ts\n/,
    );
  });

  it('a backend change the judge reads as invisible stays silent', () => {
    const dir = stagedRepo({ 'server/retry.ts': 'export const tries = 3;' });
    const r = runGate(dir, null, judgeStub(dir, 'echo NONE'));
    expect(r).toMatchObject({ code: 0, stderr: '', events: [] });
    expect(judgeCalls(dir)).toBe(1);
  });

  it('a second run over the same staged diff replays the verdict without a judge call', () => {
    const dir = stagedRepo({ 'server/price.ts': 'export const fmt = 2;' });
    const stub = judgeStub(dir, 'printf "VISIBLE\\nprices change\\n"');
    const first = runGate(dir, null, stub);
    const second = runGate(dir, 'fix: price', stub);
    expect(judgeCalls(dir)).toBe(1);
    expect(second.stderr).toBe(first.stderr);
  });

  it('a judge outage gives no advice and exits 0', () => {
    const dir = stagedRepo({ 'server/price.ts': 'export const fmt = 2;' });
    const r = runGate(dir, null, judgeStub(dir, 'echo "rate limited" >&2; exit 1'));
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain('📸');
    expect(r.events).toEqual([]);
  });

  it('a judge killed mid-call, as the timeout does, gives no advice and exits 0', () => {
    const dir = stagedRepo({ 'server/price.ts': 'export const fmt = 2;' });
    const r = runGate(dir, null, judgeStub(dir, 'kill -9 $$'));
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain('📸');
    expect(r.events).toEqual([]);
  });

  it('a diff of only docs, lockfiles and tests never asks the judge', () => {
    const dir = stagedRepo({ 'README.md': 'x', 'bun.lock': 'x', 'src/a.test.ts': 'x' });
    const r = runGate(dir, null, judgeStub(dir, 'echo VISIBLE'));
    expect(r).toMatchObject({ code: 0, stderr: '', events: [] });
    expect(judgeCalls(dir)).toBe(0);
  });

  it('devkit review stays silent even with UI files staged', () => {
    const r = runGate(stagedRepo({ 'src/Card.tsx': 'x' }), 'feat: card', {
      DEVKIT_RUN_MODE: 'review',
    });
    expect(r).toMatchObject({ code: 0, stderr: '', events: [] });
  });

  it('a dry-gates rehearsal speaks on a staged UI file', () => {
    const r = runGate(stagedRepo({ 'src/Card.tsx': 'x' }), null, { DEVKIT_RUN_MODE: 'dry-gates' });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('📸 ui-evidence: Add before (base branch) and after (this branch)');
    expect(r.events).toHaveLength(1);
  });

  it('a dry-gates rehearsal never asks the judge about non-UI code', () => {
    const dir = stagedRepo({ 'src/price.ts': 'x' });
    const r = runGate(dir, null, {
      ...judgeStub(dir, 'echo VISIBLE'),
      DEVKIT_RUN_MODE: 'dry-gates',
    });
    expect(r).toMatchObject({ code: 0, stderr: '', events: [] });
    expect(judgeCalls(dir)).toBe(0);
  });

  it('reads uiEvidence.paths from guard.config.json', () => {
    const dir = stagedRepo({
      'guard.config.json': JSON.stringify({ uiEvidence: { paths: ['src/api/**'] } }),
      'src/api/price.ts': 'x',
    });
    expect(runGate(dir, null).stderr).toContain('UI paths changed: src/api/price.ts');
  });
});
