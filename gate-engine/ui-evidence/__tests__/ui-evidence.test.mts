import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, summarise } from '../../../cli/lib/ship/digest/gate-digest.mts';
import { DEFAULT_UI_PATHS, symptomWord, uiEvidenceReason, uiPaths } from '../check.mts';

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

describe('symptomWord', () => {
  it.each([
    ['fix: price displays NaN on checkout', 'displays'],
    ['fix: modal flickers when the API is slow', 'flickers'],
    ['fix(ui): wrong total', 'ui'],
    ['fix: API returns empty list, so the screen is blank', 'screen'],
  ])('names the symptom in %j', (subject, word) => {
    expect(symptomWord(subject)).toBe(word);
  });

  it.each([
    'build: bump the guide for the queue',
    'fix(ui-kit): export map',
    'docs: synced assets stay layout-agnostic',
    'fix: retry on 503 from the billing API',
  ])('stays silent on %j', (subject) => {
    expect(symptomWord(subject)).toBeNull();
  });

  it('reads the subject only, never the body', () => {
    expect(
      symptomWord('fix: retry on 503\n\nThe dashboard displayed a spinner forever.'),
    ).toBeNull();
  });
});

describe('uiEvidenceReason', () => {
  it('names at most three UI files and counts the rest', () => {
    const staged = ['a.tsx', 'b.tsx', 'c.tsx', 'd.css', 'e.css'];
    expect(uiEvidenceReason(staged, 'feat: x', [])).toBe(
      'UI paths changed: a.tsx, b.tsx, c.tsx, +2 more',
    );
  });

  it('adds uiEvidence.paths to the extension defaults rather than replacing them', () => {
    expect(uiEvidenceReason(['src/api/price.ts'], 'fix: x', ['src/api/**'])).toBe(
      'UI paths changed: src/api/price.ts',
    );
    expect(uiEvidenceReason(['App.tsx'], 'fix: x', ['src/api/**'])).toBe(
      'UI paths changed: App.tsx',
    );
  });

  it('fires on a backend-only change whose subject names a visible symptom', () => {
    expect(uiEvidenceReason(['server/price.ts'], 'fix: checkout displays NaN', [])).toBe(
      'the commit subject names a visible symptom ("displays")',
    );
  });

  it('is silent for a backend-only change with a neutral subject', () => {
    expect(uiEvidenceReason(['server/price.ts'], 'fix: round half-even', [])).toBeNull();
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

function runGate(dir: string, subject: string | null, extra: Record<string, string> = {}) {
  const sink = path.join(dir, 'events.jsonl');
  const env = gitFreeEnv({ DEVKIT_GATE_EVENTS: sink, DEVKIT_SHIP_ID: 'ship-ui', ...extra });
  if (subject !== null) {
    env.DEVKIT_COMMIT_MSG_FILE = path.join(dir, 'msg.txt');
    writeFileSync(env.DEVKIT_COMMIT_MSG_FILE, `${subject}\n\nbody\n`);
  }
  const r = spawnSync(process.execPath, [CLI], { cwd: dir, env, encoding: 'utf8' });
  let events: { type: string; gate: string; status: string; detail: string }[] = [];
  try {
    events = readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
  } catch {
    // no sink file = the gate emitted nothing
  }
  return { code: r.status, stderr: r.stderr, events };
}

describe('guard-ui-evidence CLI', () => {
  it('at ship, a staged UI file prints the screenshot instruction and records an advisory row', () => {
    const r = runGate(stagedRepo({ 'src/Card.tsx': 'x' }), 'feat: card');
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('📸 ui-evidence: Add before (base branch) and after (this branch)');
    expect(r.stderr).toContain('— UI paths changed: src/Card.tsx');
    expect(r.events).toEqual([
      expect.objectContaining({ type: 'advisory_result', gate: 'ui-evidence', status: 'finding' }),
    ]);
    expect(r.events[0]).not.toHaveProperty('family');
  });

  it('the ship digest keeps where the screenshots go, even when it cuts the detail', () => {
    const many = Object.fromEntries(
      ['a', 'b', 'c', 'd'].map((n) => [`src/components/very-long-name-${n}/Panel.tsx`, 'x']),
    );
    const line = render(summarise(runGate(stagedRepo(many), 'feat: panels').events, 'ship-ui'));
    expect(line).toContain('ui-evidence — advisory, did NOT block this run');
    expect(line).toContain('to the PR description, or say there that nothing visible changed');
  });

  it('at ship, a backend-only change whose subject names a symptom gets the same advice', () => {
    const r = runGate(stagedRepo({ 'server/price.ts': 'x' }), 'fix: checkout displays NaN');
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('the commit subject names a visible symptom ("displays")');
  });

  it('at ship, a backend-only change with a neutral subject stays silent', () => {
    const r = runGate(stagedRepo({ 'server/price.ts': 'x' }), 'fix: round half-even');
    expect(r).toMatchObject({ code: 0, stderr: '', events: [] });
  });

  it('a plain git commit (no ship message) stays silent even with UI files staged', () => {
    const r = runGate(stagedRepo({ 'src/Card.tsx': 'x' }), null);
    expect(r).toMatchObject({ code: 0, stderr: '', events: [] });
  });

  it('devkit review stays silent even with UI files staged', () => {
    const r = runGate(stagedRepo({ 'src/Card.tsx': 'x' }), 'feat: card', {
      DEVKIT_RUN_MODE: 'review',
    });
    expect(r).toMatchObject({ code: 0, stderr: '', events: [] });
  });

  it('a stale message path is silent, never a crash', () => {
    const dir = stagedRepo({ 'src/Card.tsx': 'x' });
    const r = runGate(dir, null, { DEVKIT_COMMIT_MSG_FILE: path.join(dir, 'gone.txt') });
    expect(r).toMatchObject({ code: 0, stderr: '', events: [] });
  });

  it('reads uiEvidence.paths from guard.config.json', () => {
    const dir = stagedRepo({
      'guard.config.json': JSON.stringify({ uiEvidence: { paths: ['src/api/**'] } }),
      'src/api/price.ts': 'x',
    });
    expect(runGate(dir, 'fix: rounding').stderr).toContain('UI paths changed: src/api/price.ts');
  });
});
