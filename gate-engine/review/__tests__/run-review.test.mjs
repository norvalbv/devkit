import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCache } from '../cache.mjs';
import { runCompleteness } from '../completeness.mjs';
import { runReviewGate } from '../run-review.mjs';

// Env hygiene: the gate reads GUARD_*/FRINK_* — a developer's real env must not steer assertions.
const ENV_KEYS = [
  'GUARD_NO_REVIEW',
  'FRINK_NO_REVIEW',
  'GUARD_REVIEW_MODEL',
  'FRINK_REVIEW_MODEL',
  'GUARD_NO_COMPLETENESS',
  'FRINK_NO_COMPLETENESS',
  'GUARD_COMPLETENESS_HARD',
  'FRINK_COMPLETENESS_HARD',
  'GUARD_NO_LOG',
  'FRINK_NO_LOG',
  'GUARD_DECISION_NO_LLM',
  'FRINK_DECISION_NO_LLM',
];
const saved = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

// A consumer repo with a backend/frontend topology, synced agent briefs, and one staged file
// per requested domain. Returns its root.
function consumerRepo({ backend = false, frontend = false } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'guard-review-gate-'));
  dirs.push(repo);
  execSync('git init -q', { cwd: repo });
  writeFileSync(
    join(repo, 'guard.config.json'),
    JSON.stringify({
      scanRoots: ['src'],
      review: { backendRoots: ['src/main'], frontendRoots: ['src/renderer'] },
    }),
  );
  const agents = join(repo, '.claude', 'agents');
  mkdirSync(agents, { recursive: true });
  for (const name of [
    'api-security-reviewer',
    'backend-performance-reviewer',
    'frontend-security-reviewer',
    'frontend-performance-reviewer',
    'commit-guard',
    'feature-completeness-reviewer',
  ]) {
    writeFileSync(join(agents, `${name}.md`), `---\nname: ${name}\n---\nBrief for ${name}.`);
  }
  if (backend) {
    mkdirSync(join(repo, 'src', 'main'), { recursive: true });
    writeFileSync(join(repo, 'src', 'main', 'db.ts'), 'export const q = 1;\n');
  }
  if (frontend) {
    mkdirSync(join(repo, 'src', 'renderer'), { recursive: true });
    writeFileSync(join(repo, 'src', 'renderer', 'App.tsx'), 'export const A = 1;\n');
  }
  execSync('git add .', { cwd: repo });
  return repo;
}

// Fake judge runners. Each returns a Promise<string|null> like execJudgeAsync.
const alwaysPass = vi.fn(async () => 'looks fine\nVERDICT: PASS');
const mkExec = (impl) => vi.fn(impl);

describe('runReviewGate — cascade + exit contract', () => {
  it('all reviewers PASS on first pass → exit 0, verdicts cached, no escalation', async () => {
    const repo = consumerRepo({ backend: true });
    alwaysPass.mockClear();
    expect(await runReviewGate(repo, { exec: alwaysPass })).toBe(0);
    // backend pair + commit-guard, one sonnet call each, no opus escalation
    expect(alwaysPass).toHaveBeenCalledTimes(3);
    for (const call of alwaysPass.mock.calls) {
      expect(call[0].args).toContain('sonnet');
      expect(call[0].args.join(' ')).not.toContain('opus');
    }
    expect(Object.keys(loadCache(repo)).length).toBe(3);
  });

  it('identical diff re-run hits the cache — zero judge spawns', async () => {
    const repo = consumerRepo({ backend: true });
    await runReviewGate(repo, { exec: alwaysPass });
    const exec = mkExec(async () => 'VERDICT: PASS');
    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(exec).not.toHaveBeenCalled();
  });

  it('sonnet FAIL → opus overturn → exit 0 and the PASS is cached', async () => {
    const repo = consumerRepo({ backend: true });
    const exec = mkExec(async ({ label }) =>
      label.endsWith(':escalate') ? 'overturned\nVERDICT: PASS' : 'sus\nVERDICT: FAIL — maybe',
    );
    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(Object.keys(loadCache(repo)).length).toBe(3);
  });

  it('sonnet FAIL → opus confirm → exit 1 with the reviewer named; FAIL is never cached', async () => {
    const repo = consumerRepo({ backend: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec(async ({ label }) =>
      label.startsWith('review:api-security-reviewer')
        ? 'bad\nVERDICT: FAIL — raw SQL concat'
        : 'VERDICT: PASS',
    );
    expect(await runReviewGate(repo, { exec })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('api-security-reviewer FAILED');
    // the two passers are cached; the failer is not
    expect(Object.keys(loadCache(repo)).length).toBe(2);
  });

  it('judge outage (null) → exit 2 fail-open', async () => {
    const repo = consumerRepo({ backend: true });
    expect(await runReviewGate(repo, { exec: mkExec(async () => null) })).toBe(2);
  });

  it('review prose without a VERDICT line → inconclusive → exit 2, not a block', async () => {
    const repo = consumerRepo({ backend: true });
    const exec = mkExec(async () => 'these tests pass, that check could fail — all good overall');
    expect(await runReviewGate(repo, { exec })).toBe(2);
  });

  it('GUARD_NO_REVIEW=1 skips before any spawn', async () => {
    const repo = consumerRepo({ backend: true });
    process.env.GUARD_NO_REVIEW = '1';
    const exec = mkExec(async () => 'VERDICT: PASS');
    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(exec).not.toHaveBeenCalled();
  });

  it('nothing staged in any domain → exit 0, no spawns', async () => {
    const repo = consumerRepo();
    writeFileSync(join(repo, 'README.md'), 'docs only');
    execSync('git add .', { cwd: repo });
    const exec = mkExec(async () => 'VERDICT: PASS');
    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(exec).not.toHaveBeenCalled();
  });

  it('frontend-only staged → frontend reviewers spawn, backend ones do not', async () => {
    const repo = consumerRepo({ frontend: true });
    const seen = [];
    const exec = mkExec(async ({ label }) => {
      seen.push(label);
      return 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(seen.sort()).toEqual([
      'review:commit-guard',
      'review:frontend-performance-reviewer',
      'review:frontend-security-reviewer',
    ]);
  });

  it('the wrapped prompt reaches the judge with brief + verdict pin; the diffstat rides stdin', async () => {
    const repo = consumerRepo({ backend: true });
    let captured;
    const exec = mkExec(async (opts) => {
      if (opts.label === 'review:api-security-reviewer') captured = opts;
      return 'VERDICT: PASS';
    });
    await runReviewGate(repo, { exec });
    const prompt = captured.args[1];
    expect(prompt).toContain('Brief for api-security-reviewer.');
    expect(prompt).toContain('HEADLESS COMMIT GATE');
    expect(prompt).not.toContain('name: api-security-reviewer'); // frontmatter stripped
    expect(captured.input).toContain('db.ts');
    expect(captured.args).toContain('--no-session-persistence'); // isolated
  });
});

describe('runCompleteness — warn-by-default commit-msg gate', () => {
  const msg = (repo, text) => {
    const f = join(repo, '.git', 'COMMIT_EDITMSG_TEST');
    writeFileSync(f, text);
    return f;
  };

  it('FAIL without HARD → warn, exit 0', async () => {
    const repo = consumerRepo({ backend: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec(async () => 'gap: no error handling\nVERDICT: FAIL — misleading scope');
    expect(await runCompleteness(msg(repo, 'feat: add db layer'), repo, { exec })).toBe(0);
    expect(err.mock.calls.flat().join('\n')).toContain('WARN-only');
  });

  it('FAIL + GUARD_COMPLETENESS_HARD=1 → exit 1', async () => {
    const repo = consumerRepo({ backend: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_COMPLETENESS_HARD = '1';
    const exec = mkExec(async () => 'VERDICT: FAIL — half-shipped');
    expect(await runCompleteness(msg(repo, 'feat: add db layer'), repo, { exec })).toBe(1);
  });

  it('PASS → exit 0; the prompt carries message, Targets block and brief', async () => {
    const repo = consumerRepo({ backend: true });
    let captured;
    const exec = mkExec(async (opts) => {
      captured = opts;
      return 'VERDICT: PASS';
    });
    expect(await runCompleteness(msg(repo, 'feat: add db layer'), repo, { exec })).toBe(0);
    expect(captured.args[1]).toContain('feat: add db layer');
    expect(captured.args[1]).toContain('RELEVANT RECORDED TARGETS');
    expect(captured.args[1]).toContain('Brief for feature-completeness-reviewer.');
    expect(captured.args).toContain('opus'); // straight opus, no cascade
  });

  it('GUARD_NO_COMPLETENESS=1 skips before any spawn', async () => {
    const repo = consumerRepo({ backend: true });
    process.env.GUARD_NO_COMPLETENESS = '1';
    const exec = mkExec(async () => 'VERDICT: PASS');
    expect(await runCompleteness(msg(repo, 'feat: x'), repo, { exec })).toBe(0);
    expect(exec).not.toHaveBeenCalled();
  });

  it('judge outage → exit 2 (fail-open)', async () => {
    const repo = consumerRepo({ backend: true });
    expect(
      await runCompleteness(msg(repo, 'feat: x'), repo, { exec: mkExec(async () => null) }),
    ).toBe(2);
  });

  it('missing agent brief → skip with a note, exit 0', async () => {
    const repo = consumerRepo({ backend: true });
    rmSync(join(repo, '.claude', 'agents', 'feature-completeness-reviewer.md'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec(async () => 'VERDICT: PASS');
    expect(await runCompleteness(msg(repo, 'feat: x'), repo, { exec })).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    expect(err.mock.calls.flat().join('\n')).toContain('completeness skipped');
  });
});
