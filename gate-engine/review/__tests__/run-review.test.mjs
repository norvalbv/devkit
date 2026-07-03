import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCache } from '../cache.mjs';
import { runCompleteness } from '../completeness.mjs';
import { REVIEWERS } from '../reviewers.mjs';
import { runReviewGate } from '../run-review.mjs';

// Env hygiene: the gate reads GUARD_*/FRINK_* — a developer's real env must not steer assertions.
const ENV_KEYS = [
  'GUARD_NO_REVIEW',
  'FRINK_NO_REVIEW',
  'GUARD_AI_STRICT',
  'FRINK_AI_STRICT',
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
const mkExec = (impl) => vi.fn(impl);

// A real judge leaves a checklist state-file artifact behind (the anti-hallucination contract) —
// fake judges must too, or every PASS is voided to inconclusive. Reviewer identity rides the label.
const reviewerFromLabel = (label) =>
  REVIEWERS.find((r) => label === `review:${r.name}` || label === `review:${r.name}:escalate`);
function writeArtifact(repo, label, { pending = 0, failed = 0 } = {}) {
  const reviewer = reviewerFromLabel(label);
  if (!reviewer) return;
  const key = reviewer.name === 'commit-guard' ? 'files' : 'items';
  const mk = (status, i) =>
    reviewer.name === 'commit-guard'
      ? { path: `src/f${i}.ts`, status, issues: [] }
      : { name: `check-${status}-${i}`, category: 'X', status, issues: [] };
  const rows = [
    mk('pass', 0),
    ...Array.from({ length: pending }, (_, i) => mk('pending', i + 1)),
    ...Array.from({ length: failed }, (_, i) => mk('fail', i + 1)),
  ];
  writeFileSync(join(repo, reviewer.stateFile), JSON.stringify({ [key]: rows }));
}

// PASS judge that honours the checklist contract (writes a complete artifact).
const passWithArtifact = (repo) =>
  mkExec(async ({ label }) => {
    writeArtifact(repo, label);
    return 'looks fine\nVERDICT: PASS';
  });

describe('runReviewGate — cascade + exit contract', () => {
  it('all reviewers PASS on first pass → exit 0, verdicts cached, no escalation', async () => {
    const repo = consumerRepo({ backend: true });
    const exec = passWithArtifact(repo);
    expect(await runReviewGate(repo, { exec })).toBe(0);
    // backend pair + commit-guard, one sonnet call each, no opus escalation
    expect(exec).toHaveBeenCalledTimes(3);
    for (const call of exec.mock.calls) {
      expect(call[0].args).toContain('sonnet');
      expect(call[0].args.join(' ')).not.toContain('opus');
    }
    expect(Object.keys(loadCache(repo)).length).toBe(3);
  });

  it('identical diff re-run hits the cache — zero judge spawns', async () => {
    const repo = consumerRepo({ backend: true });
    await runReviewGate(repo, { exec: passWithArtifact(repo) });
    const exec = mkExec(async () => 'VERDICT: PASS');
    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(exec).not.toHaveBeenCalled();
  });

  it('sonnet FAIL → opus overturn → exit 0 and the PASS is cached', async () => {
    const repo = consumerRepo({ backend: true });
    const exec = mkExec(async ({ label }) => {
      if (!label.endsWith(':escalate')) return 'sus\nVERDICT: FAIL — maybe';
      writeArtifact(repo, label);
      return 'overturned\nVERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(Object.keys(loadCache(repo)).length).toBe(3);
  });

  it('sonnet FAIL → opus confirm → exit 1 with the reviewer named; FAIL is never cached', async () => {
    const repo = consumerRepo({ backend: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec(async ({ label }) => {
      if (label.startsWith('review:api-security-reviewer'))
        return 'bad\nVERDICT: FAIL — raw SQL concat';
      writeArtifact(repo, label);
      return 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('api-security-reviewer FAILED');
    // the two passers are cached; the failer is not
    expect(Object.keys(loadCache(repo)).length).toBe(2);
  });

  it('PASS verdict with NO checklist artifact → voided to inconclusive (exit 2), never cached', async () => {
    const repo = consumerRepo({ backend: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec(async () => 'all good I promise\nVERDICT: PASS'); // skipped the workflow
    expect(await runReviewGate(repo, { exec })).toBe(2);
    expect(Object.keys(loadCache(repo)).length).toBe(0);
    expect(err.mock.calls.flat().join('\n')).toContain('skipped the checklist workflow');
  });

  it('PASS verdict with pending checklist items → inconclusive, names the unresolved items', async () => {
    const repo = consumerRepo({ backend: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec(async ({ label }) => {
      writeArtifact(repo, label, { pending: 2 });
      return 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(2);
    expect(err.mock.calls.flat().join('\n')).toContain('2 item(s) never resolved');
  });

  it('PASS verdict but the checklist recorded FAILED items → inconclusive (mismatch), not cached', async () => {
    const repo = consumerRepo({ backend: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec(async ({ label }) => {
      writeArtifact(repo, label, { failed: 1 });
      return 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(2);
    expect(Object.keys(loadCache(repo)).length).toBe(0);
  });

  it('a STALE artifact from a previous session never satisfies the gate (pre-cleaned)', async () => {
    const repo = consumerRepo({ backend: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const r of REVIEWERS) writeArtifact(repo, `review:${r.name}`); // complete artifacts, pre-seeded
    const exec = mkExec(async () => 'VERDICT: PASS'); // judge writes nothing itself
    expect(await runReviewGate(repo, { exec })).toBe(2);
  });

  it('checklist artifacts are cleaned up after the run', async () => {
    const repo = consumerRepo({ backend: true });
    await runReviewGate(repo, { exec: passWithArtifact(repo) });
    for (const r of REVIEWERS) expect(existsSync(join(repo, r.stateFile))).toBe(false);
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
      writeArtifact(repo, label);
      return 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(seen.sort()).toEqual([
      'review:commit-guard',
      'review:frontend-performance-reviewer',
      'review:frontend-security-reviewer',
    ]);
  });

  it('the wrapped prompt reaches the judge with brief, checklist mandate + verdict pin; the diffstat rides stdin', async () => {
    const repo = consumerRepo({ backend: true });
    let captured;
    const exec = mkExec(async (opts) => {
      if (opts.label === 'review:api-security-reviewer') captured = opts;
      writeArtifact(repo, opts.label);
      return 'VERDICT: PASS';
    });
    await runReviewGate(repo, { exec });
    const prompt = captured.args[1];
    expect(prompt).toContain('Brief for api-security-reviewer.');
    expect(prompt).toContain('HEADLESS COMMIT GATE');
    expect(prompt).toContain('.claude/skills/api-security/scripts/checklist.mjs generate');
    expect(prompt).not.toContain('name: api-security-reviewer'); // frontmatter stripped
    expect(captured.input).toContain('db.ts');
    expect(captured.args).toContain('--no-session-persistence'); // isolated
  });
});

describe('runReviewGate — adversarial staged filenames (argv-git regression)', () => {
  it('a staged filename carrying $(…) never reaches a shell: no side effect, gate completes', async () => {
    const repo = consumerRepo({ backend: true });
    // Legal filename on disk; under the old shell-string git calls the $(…) would EXPAND
    // during the very review meant to catch it (CodeRabbit critical).
    writeFileSync(join(repo, 'src', 'main', 'db$(touch INJECTED).ts'), 'export const q = 2;\n');
    execSync('git add .', { cwd: repo });
    const exec = passWithArtifact(repo);
    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(existsSync(join(repo, 'INJECTED'))).toBe(false);
    expect(existsSync(join(repo, 'src', 'main', 'INJECTED'))).toBe(false);
    // the crafted file was actually REVIEWED (rode the domain diff), not silently dropped
    const stat = exec.mock.calls.find((c) => c[0].label === 'review:api-security-reviewer')[0]
      .input;
    expect(stat).toContain('INJECTED).ts');
  });
});

describe('runReviewGate — per-completion checkpoints', () => {
  it('a finished PASS is on disk BEFORE slower cascades resolve (checkpoint, not batch)', async () => {
    const repo = consumerRepo({ backend: true });
    let release;
    const blocked = new Promise((r) => {
      release = r;
    });
    const exec = mkExec(async ({ label }) => {
      if (!label.startsWith('review:api-security-reviewer')) await blocked;
      writeArtifact(repo, label);
      return 'VERDICT: PASS';
    });
    const done = runReviewGate(repo, { exec });
    // the fast reviewer's PASS lands in the cache while the other two are still pending
    await vi.waitFor(() => {
      expect(Object.keys(loadCache(repo)).length).toBe(1);
    });
    release();
    expect(await done).toBe(0);
    expect(Object.keys(loadCache(repo)).length).toBe(3);
  });

  it('one cascade throwing neither rejects the gate nor discards sibling checkpoints', async () => {
    const repo = consumerRepo({ backend: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec(async ({ label }) => {
      if (label.startsWith('review:backend-performance-reviewer')) throw new Error('boom');
      writeArtifact(repo, label);
      return 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(2); // inconclusive, never a crash
    expect(Object.keys(loadCache(repo)).length).toBe(2); // the two passers still checkpointed
    expect(err.mock.calls.flat().join('\n')).toContain('engine error: boom');
  });

  it('prints a per-reviewer completion heartbeat with elapsed seconds', async () => {
    const repo = consumerRepo({ backend: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runReviewGate(repo, { exec: passWithArtifact(repo) });
    expect(err.mock.calls.flat().join('\n')).toMatch(
      /guard-review: api-security-reviewer — PASS in \d+s \(checkpointed\)/,
    );
  });
});

describe('runReviewGate — strict ship mode (GUARD_AI_STRICT)', () => {
  it('outage: first pass retried once, then INCONCLUSIVE fails closed with exit 3 + remedy', async () => {
    const repo = consumerRepo({ backend: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_AI_STRICT = '1';
    const exec = mkExec(async () => null);
    expect(await runReviewGate(repo, { exec })).toBe(3);
    // 3 reviewers × (1 attempt + 1 retry), no escalation possible
    expect(exec).toHaveBeenCalledTimes(6);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('retrying once');
    expect(out).toContain('strict ship mode fails closed');
    expect(out).toContain('re-run devkit ship');
  });

  it('timeout outage is NOT retried (a re-run burns the same budget) — one attempt each, still exit 3', async () => {
    const repo = consumerRepo({ backend: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_AI_STRICT = '1';
    // A judge KILLED by its execFile timeout: null result + a 'timeout' outage signal — unlike the
    // transient/empty flakes above, which DO earn the one retry.
    const exec = mkExec(async (opts) => {
      opts.onOutage?.('timeout');
      return null;
    });
    expect(await runReviewGate(repo, { exec })).toBe(3);
    expect(exec).toHaveBeenCalledTimes(3); // one attempt per reviewer — NO retry on a timeout
    const out = err.mock.calls.flat().join('\n');
    expect(out).not.toContain('retrying once');
  });

  it('outage-then-success: the retry recovers and the gate passes clean', async () => {
    const repo = consumerRepo({ backend: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_AI_STRICT = '1';
    const failedOnce = new Set();
    const exec = mkExec(async ({ label }) => {
      if (!failedOnce.has(label)) {
        failedOnce.add(label);
        return null;
      }
      writeArtifact(repo, label);
      return 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(Object.keys(loadCache(repo)).length).toBe(3);
  });

  it('a dead first pass cannot poison the retry: stale checklist rows are cleared pre-retry', async () => {
    const repo = consumerRepo({ backend: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_AI_STRICT = '1';
    const failedOnce = new Set();
    const exec = mkExec(async ({ label }) => {
      if (!failedOnce.has(label)) {
        failedOnce.add(label);
        writeArtifact(repo, label, { failed: 1 }); // interrupted attempt leaves poison rows…
        return null; // …then dies
      }
      return 'VERDICT: PASS'; // retry recovers but writes NO artifact of its own
    });
    // If the poison rows survived the retry, verifyChecklist would read them as the retry's
    // state (mixed old/new). With pre-retry cleanup the PASS is voided for the RIGHT reason:
    // the retry itself skipped the checklist workflow → inconclusive → strict exit 3.
    expect(await runReviewGate(repo, { exec })).toBe(3);
    expect(Object.keys(loadCache(repo)).length).toBe(0); // nothing cached from mixed state
  });

  it('a hard opus-confirmed FAIL still exits 1 (never conflated with the fail-closed 3)', async () => {
    const repo = consumerRepo({ backend: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_AI_STRICT = '1';
    const exec = mkExec(async ({ label }) => {
      if (label.startsWith('review:api-security-reviewer')) return 'VERDICT: FAIL — injection';
      writeArtifact(repo, label);
      return 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(1);
  });

  it("without the flag, outage keeps today's fail-open exit 2 and never retries", async () => {
    const repo = consumerRepo({ backend: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec(async () => null);
    expect(await runReviewGate(repo, { exec })).toBe(2);
    expect(exec).toHaveBeenCalledTimes(3); // one attempt each, no retry
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
