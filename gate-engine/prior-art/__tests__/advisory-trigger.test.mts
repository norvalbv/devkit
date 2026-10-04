import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { REVIEWERS } from '../../review/reviewers.mts';
import { runReviewGate } from '../../review/run-review.mts';
import { parseClaudeArgv } from '../../judge/codex/result.mts';

let cwd: string;
const exec = vi.fn<NonNullable<Parameters<typeof runReviewGate>[1]>['exec']>(async () => null);

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.test',
    },
  });
}

function stage(text: string, file = 'session.ts'): void {
  writeFileSync(join(cwd, file), text);
  git('add', '--', file);
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'prior-art-trigger-'));
  git('init', '-q');
  writeFileSync(join(cwd, 'guard.config.json'), JSON.stringify({ scanRoots: ['.'] }));
  stage('export const value = 0;\n');
  git('commit', '-qm', 'initial');
  vi.stubEnv('GUARD_PRIOR_ART', '1');
  vi.stubEnv('GUARD_NO_REVIEW', '0');
  vi.stubEnv('GUARD_DECISION_NO_LLM', '0');
  vi.stubEnv('GUARD_REVIEW_SKIP', REVIEWERS.map(({ name }) => name).join(','));
  vi.stubEnv('DEVKIT_RUN_MODE', '');
  exec.mockReset();
  exec.mockResolvedValue(null);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(cwd, { recursive: true, force: true });
});

it('ignores a staged recovery addition outside the configured scan roots', async () => {
  writeFileSync(join(cwd, 'guard.config.json'), JSON.stringify({ scanRoots: ['src'] }));
  stage('export const retryCount = 3;\n');
  expect(await runReviewGate(cwd, { exec })).toBe(0);
  expect(exec).not.toHaveBeenCalled();
});

it('automatically invokes prior-art from a staged recovery addition and remains advisory', async () => {
  stage('export const retryCount = 3;\n');
  expect(await runReviewGate(cwd, { exec })).toBe(0);
  expect(exec).toHaveBeenCalledOnce();
  expect(exec.mock.calls[0]?.[0]).toMatchObject({ label: 'prior-art', cwd, codexReadOnly: true });
  expect(exec.mock.calls[0]?.[0].mcpProfile).toMatchObject({ kind: 'named-agent' });
  expect(exec.mock.calls[0]?.[0].input).toContain('recovery_addition');
  expect(parseClaudeArgv(exec.mock.calls[0]![0].args).prompt).toContain(
    'Validate the underlying problem',
  );
  expect(
    parseClaudeArgv(['-p', 'investigate', '--model', 'gpt-fixture', '--tools', 'Read']).prompt,
  ).toBe('investigate');
});

it('distinguishes the causal upstream choice from the recommended alternative', async () => {
  stage('export const retryCount = 3;\n');
  exec.mockResolvedValue(
    JSON.stringify({
      schemaVersion: 1,
      kind: 'prior_art',
      phase: 'problem',
      status: 'reviewed',
      problem: {
        statement: 'Output lost at restart.',
        restatedFrame: 'Assumes per-turn restart.',
        assumedConstraints: ['restart every turn'],
      },
      verdict: 'DISSOLVE_FRAME',
      confidence: 'high',
      legs: [
        {
          leg: 'local',
          status: 'unavailable',
          detail: 'No declared checkout.',
          declaredCheckouts: 0,
          resolvedCheckouts: 0,
        },
        { leg: 'github', status: 'unavailable', detail: 'No CLI.' },
        { leg: 'web', status: 'reached', detail: 'Read upstream session docs.' },
        { leg: 'papers', status: 'unavailable', detail: 'No relevant paper reached.' },
        { leg: 'deep-research', status: 'unavailable', detail: 'Not configured.' },
      ],
      frameChallenge: {
        framing: 'DISSOLVES',
        upstreamChoice: 'Per-turn restart',
        boundaryMustExist: 'no',
      },
      questions: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'].map((id) => ({
        id,
        status: 'ANSWERED',
        finding: 'Native session mode exists.',
      })),
      evidence: [
        {
          kind: 'upstream',
          source: 'https://example.org/sdk/session',
          repoRoot: null,
          claim: 'Sessions can stay open.',
          quote: 'Use session-lifetime operation.',
        },
      ],
      suggestedNextStep: { kind: 'reframe', detail: 'Keep the session open across turns.' },
      routing: null,
      summary: 'Use native session lifetime.',
      researchReferences: [],
    }),
  );
  expect(await runReviewGate(cwd, { exec })).toBe(0);
  const output = vi.mocked(console.error).mock.calls.flat().join('\n');
  expect(output).toContain('Upstream choice: Per-turn restart');
  expect(output).toContain('Keep the session open across turns.');
  expect(output).not.toContain('Alternative: Per-turn restart');
});

it('runs for a repeated fix chain even without a recovery keyword', async () => {
  for (let n = 1; n <= 3; n += 1) {
    stage(`export const value = ${n};\n`);
    git('commit', '-qm', `fix(session): adjust value ${n}`);
    stage(`export const value = ${n + 1};\n`);
    expect(await runReviewGate(cwd, { exec })).toBe(0);
    expect(exec).toHaveBeenCalledTimes(n === 3 ? 1 : 0);
  }
  expect(exec).toHaveBeenCalledOnce();
  expect(exec.mock.calls[0]?.[0].input).toContain('fix_chain');
});

it.each(['disabled', 'no-llm', 'ordinary', 'removed', 'unstaged', 'unrelated-history'])(
  'does not invoke for %s',
  async (scenario) => {
    if (scenario === 'removed') {
      stage('export const retryCount = 1;\n');
      git('commit', '-qm', 'feat: retries');
    }
    if (scenario === 'unrelated-history') {
      for (let n = 1; n <= 3; n += 1) {
        stage(`export const value = ${n};\n`, 'other.ts');
        git('commit', '-qm', `fix: unrelated ${n}`);
      }
    }
    stage(
      scenario === 'disabled' || scenario === 'no-llm'
        ? 'export const retryCount = 3;\n'
        : 'export const value = 99;\n',
    );
    if (scenario === 'disabled') vi.stubEnv('GUARD_PRIOR_ART', '0');
    if (scenario === 'no-llm') vi.stubEnv('GUARD_DECISION_NO_LLM', '1');
    if (scenario === 'unstaged')
      writeFileSync(join(cwd, 'session.ts'), 'export const retryCount = 9;\n');
    expect(await runReviewGate(cwd, { exec })).toBe(0);
    expect(exec).not.toHaveBeenCalled();
  },
);

it('suppresses repeated attempts even on outage, but a changed diff buys another attempt', async () => {
  stage('export const retryCount = 1;\n');
  expect(await runReviewGate(cwd, { exec })).toBe(0);
  expect(await runReviewGate(cwd, { exec })).toBe(0);
  expect(exec).toHaveBeenCalledOnce();
  stage('export const retryCount = 2;\n');
  expect(await runReviewGate(cwd, { exec })).toBe(0);
  expect(exec).toHaveBeenCalledTimes(2);
});

it('downweights three old fixes even within the twelve-commit window', async () => {
  for (let n = 1; n <= 3; n += 1) {
    stage(`export const value = ${n};\n`);
    git('commit', '-qm', `fix: adjust ${n}`);
  }
  for (let n = 0; n < 9; n += 1) git('commit', '--allow-empty', '-qm', `feat: unrelated ${n}`);
  stage('export const value = 100;\n');
  expect(await runReviewGate(cwd, { exec })).toBe(0);
  expect(exec).not.toHaveBeenCalled();
});

it.each(['invalid', 'outage'])('keeps %s responses advisory and quiet', async (result) => {
  stage('export const retryCount = 3;\n');
  if (result === 'invalid') exec.mockResolvedValue('{}');
  else exec.mockRejectedValue(new Error('test outage'));
  expect(await runReviewGate(cwd, { exec })).toBe(0);
  expect(exec).toHaveBeenCalledOnce();
  expect(vi.mocked(console.error).mock.calls.flat().join('\n')).not.toContain('prior-art:');
});

it('treats pathspec-shaped filenames literally and ignores oversized evidence', async () => {
  stage('export const retryCount = 3;\n', 'odd [*] name.ts');
  expect(await runReviewGate(cwd, { exec })).toBe(0);
  expect(exec.mock.calls[0]?.[0].input).toContain('odd [*] name.ts');
  exec.mockClear();
  stage(`export const retryText = '${'x'.repeat(130 * 1024)}';\n`);
  expect(await runReviewGate(cwd, { exec })).toBe(0);
  expect(exec).not.toHaveBeenCalled();
});

it.each(['fix(): empty', 'fix( ): blank', 'fix((api)): nested'])(
  'does not count malformed scopes: %s',
  async (subject) => {
    for (let n = 1; n <= 3; n += 1) {
      stage(`export const value = ${n};\n`);
      git('commit', '-qm', subject);
    }
    stage('export const value = 9;\n');
    expect(await runReviewGate(cwd, { exec })).toBe(0);
    expect(exec).not.toHaveBeenCalled();
  },
);

function worker(code: string, args: string[]) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code, ...args], {
    cwd,
    env: process.env,
    stdio: 'pipe',
  });
  return { child, done: once(child, 'exit') };
}

it('claims identical attempts once when concurrent consumers both wait for the store', async () => {
  stage('export const retryCount = 1;\n');
  const store = join(cwd, '.devkit', 'prior-art-attempts.json');
  const ready = join(cwd, 'holder-ready');
  const release = join(cwd, 'holder-release');
  const fired = join(cwd, 'judge-spawns');
  const holder = worker(
    `
    import { existsSync, writeFileSync } from 'node:fs';
    const [url, store, ready, release] = process.argv.slice(1);
    const { withStoreLock } = await import(url);
    withStoreLock(store, {}, () => {
      writeFileSync(ready, 'ready');
      const end = Date.now() + 10000;
      while (!existsSync(release) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    });
  `,
    [
      new URL('../../judge/verdict-store.mts', import.meta.url).href,
      `${store}.claim`,
      ready,
      release,
    ],
  );
  const clients: ReturnType<typeof worker>[] = [];
  try {
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 4000 });
    for (let n = 0; n < 2; n += 1)
      clients.push(
        worker(
          `
      import { appendFileSync } from 'node:fs';
      const [url, cwd, fired] = process.argv.slice(1);
      const { runPriorArtAdvisory } = await import(url);
      await runPriorArtAdvisory(cwd, { scanRoots: ['.'], sourceExtensions: ['ts'], noLlm: false, review: { agentsDir: '.claude/agents' } }, async () => { appendFileSync(fired, 'judge\\n'); return null; });
    `,
          [new URL('../advisory.mts', import.meta.url).href, cwd, fired],
        ),
      );
    await vi.waitFor(
      () =>
        expect(
          readdirSync(join(cwd, '.devkit')).filter((name) => name.includes('.lock.candidate.'))
            .length,
        ).toBe(2),
      { timeout: 4000 },
    );
    writeFileSync(release, 'go');
    for (const client of [holder, ...clients]) expect((await client.done)[0]).toBe(0);
    expect(readFileSync(fired, 'utf8')).toBe('judge\n');
  } finally {
    writeFileSync(release, 'go');
    await Promise.all([holder, ...clients].map(({ done }) => done));
  }
});
