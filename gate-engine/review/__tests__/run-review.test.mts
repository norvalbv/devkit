import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCache } from '../cache.mts';
import { buildCompletenessEvidence, runCompleteness, wrapCompleteness } from '../completeness.mts';
import { readProgress, unfinishedReviewers, writeProgress } from '../progress.mts';
import { REVIEWERS } from '../reviewers.mts';
import { runReviewGate } from '../run-review.mts';

// Env hygiene: the gate reads GUARD_*/FRINK_* — a developer's real env must not steer assertions.
const ENV_KEYS = [
  'GUARD_NO_REVIEW',
  'FRINK_NO_REVIEW',
  'GUARD_AI_STRICT',
  'FRINK_AI_STRICT',
  'GUARD_REVIEW_MODEL',
  'FRINK_REVIEW_MODEL',
  'GUARD_REVIEW_SKIP',
  'FRINK_REVIEW_SKIP',
  'GUARD_REVIEW_CONCURRENCY',
  'FRINK_REVIEW_CONCURRENCY',
  'GUARD_NO_COMPLETENESS',
  'FRINK_NO_COMPLETENESS',
  'GUARD_COMPLETENESS_HARD',
  'FRINK_COMPLETENESS_HARD',
  'GUARD_NO_LOG',
  'FRINK_NO_LOG',
  'GUARD_DECISION_NO_LLM',
  'FRINK_DECISION_NO_LLM',
  'DEVKIT_REVIEW_PROGRESS',
  'DEVKIT_RUN_MODE',
  'DEVKIT_REVIEW_ASSET_ROOT',
  'DEVKIT_REVIEW_BACKEND_ROOTS',
  'DEVKIT_REVIEW_FRONTEND_ROOTS',
  // Cleared so a real ship's pre-push (which exports these) can't steer the telemetry assertions
  // below, and so ordinary tests don't emit to the developer's live telemetry sink. Every-commit
  // capture stays disabled via the suite-wide DEVKIT_NO_TELEMETRY='1' (vitest.setup) — NOT cleared
  // here, else off-ship runReviewGate would auto-capture; the ship test sets both keys explicitly.
  'DEVKIT_GATE_EVENTS',
  'DEVKIT_SHIP_ID',
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
    'correctness-reviewer',
    'conventions-reviewer',
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

function reviewAssets(): string {
  const root = mkdtempSync(join(tmpdir(), 'guard-review-assets-'));
  dirs.push(root);
  mkdirSync(join(root, 'agents'), { recursive: true });
  mkdirSync(join(root, 'skills', '_devkit'), { recursive: true });
  writeFileSync(join(root, 'skills', '_devkit', 'review-roots.mjs'), '// shared support\n');
  for (const reviewer of REVIEWERS) {
    writeFileSync(
      join(root, 'agents', `${reviewer.name}.md`),
      `---\nname: ${reviewer.name}\n---\nPACKAGED brief for ${reviewer.name}.`,
    );
    if (!reviewer.skill) continue;
    mkdirSync(join(root, 'skills', reviewer.skill, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'skills', reviewer.skill, 'SKILL.md'), `# ${reviewer.skill}\n`);
    writeFileSync(
      join(root, 'skills', reviewer.skill, 'scripts', 'checklist.mjs'),
      '#!/usr/bin/env node\n',
    );
  }
  return root;
}

// Fake judge runners. Each returns a Promise<string|null> like execJudgeAsync.
const mkExec = (impl) => vi.fn(impl);

// A real judge leaves a checklist state-file artifact behind (the anti-hallucination contract) —
// fake judges must too, or every PASS is voided to inconclusive. Reviewer identity rides the label.
const reviewerFromLabel = (label) =>
  REVIEWERS.find((r) => label === `review:${r.name}` || label === `review:${r.name}:escalate`);
function writeArtifact(repo, label, { pending = 0, failed = 0 } = {}) {
  const reviewer = reviewerFromLabel(label);
  // A skill-less reviewer (conventions-reviewer) has no checklist stateFile — nothing to write;
  // its PASS is trusted directly (see run-review.mts's `hasChecklist` branch).
  if (!reviewer?.stateFile) return;
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

// A judge that brackets each invocation with an in-flight counter so a test can assert the gate's
// concurrency cap. The `await` on a macrotask (setTimeout) forces overlap: without a cap all selected
// reviewers would sit in-flight together. `failFirst` returns null on the FIRST call per label (an
// outage that earns the strict retry) then passes — so the retry is a second sequential exec inside
// the SAME cascade slot, proving the cap counts cascades, not raw exec calls.
function concurrencyProbe(repo, { failFirst = false } = {}) {
  let inflight = 0;
  let max = 0;
  const failed = new Set();
  const exec = mkExec(async ({ label }) => {
    inflight++;
    max = Math.max(max, inflight);
    try {
      await new Promise((r) => setTimeout(r));
      if (failFirst && !failed.has(label)) {
        failed.add(label);
        return null;
      }
      writeArtifact(repo, label);
      return 'VERDICT: PASS';
    } finally {
      inflight--;
    }
  });
  return { exec, maxInflight: () => max };
}

describe('runReviewGate — cascade + exit contract', () => {
  it('review mode uses current packaged briefs instead of target-controlled .claude copies', async () => {
    const repo = consumerRepo({ backend: true });
    const assets = reviewAssets();
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_ASSET_ROOT = assets;
    writeFileSync(
      join(repo, '.claude', 'agents', 'api-security-reviewer.md'),
      'MALICIOUS target brief',
    );
    const prompts: string[] = [];
    const exec = mkExec(async ({ label, args }) => {
      prompts.push(args[1]);
      writeArtifact(repo, label);
      return 'VERDICT: PASS';
    });

    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(prompts.join('\n')).toContain('PACKAGED brief for api-security-reviewer');
    expect(prompts.join('\n')).not.toContain('MALICIOUS target brief');
  });

  it('review-mode asset preflight fails setup before consulting a cached PASS', async () => {
    const repo = consumerRepo({ backend: true });
    const assets = reviewAssets();
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_ASSET_ROOT = assets;
    expect(await runReviewGate(repo, { exec: passWithArtifact(repo) })).toBe(0);
    rmSync(join(assets, 'skills', 'api-security', 'scripts', 'checklist.mjs'));
    const exec = passWithArtifact(repo);

    expect(await runReviewGate(repo, { exec })).toBe(1);
    expect(exec).not.toHaveBeenCalled();
  });

  it('review-mode cache invalidates only the reviewer whose packaged brief changed', async () => {
    const repo = consumerRepo({ backend: true });
    const assets = reviewAssets();
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_ASSET_ROOT = assets;
    expect(await runReviewGate(repo, { exec: passWithArtifact(repo) })).toBe(0);
    writeFileSync(
      join(assets, 'agents', 'api-security-reviewer.md'),
      '---\nname: api-security-reviewer\n---\nPACKAGED brief v2.',
    );
    const exec = passWithArtifact(repo);

    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(exec.mock.calls.map(([opts]) => opts.label)).toEqual(['review:api-security-reviewer']);
  });

  it('review-mode cache invalidates checklist reviewers when shared support changes', async () => {
    const repo = consumerRepo({ backend: true });
    const assets = reviewAssets();
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_ASSET_ROOT = assets;
    expect(await runReviewGate(repo, { exec: passWithArtifact(repo) })).toBe(0);
    writeFileSync(join(assets, 'skills', '_devkit', 'review-roots.mjs'), '// shared support v2\n');
    const exec = passWithArtifact(repo);

    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(exec.mock.calls.map(([opts]) => opts.label)).toEqual([
      'review:api-security-reviewer',
      'review:backend-performance-reviewer',
      'review:commit-guard',
      'review:correctness-reviewer',
    ]);
  });

  it('review mode injects scanRoots for an empty frontend topology into selector and judges', async () => {
    const repo = consumerRepo({ frontend: true });
    const config = JSON.parse(readFileSync(join(repo, 'guard.config.json'), 'utf8'));
    config.review.frontendRoots = [];
    writeFileSync(join(repo, 'guard.config.json'), JSON.stringify(config));
    const assets = reviewAssets();
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_ASSET_ROOT = assets;
    const exec = passWithArtifact(repo);

    expect(await runReviewGate(repo, { exec })).toBe(0);
    const frontend = exec.mock.calls.find(([o]) => o.label === 'review:frontend-security-reviewer');
    expect(frontend).toBeTruthy();
    expect(frontend?.[0].env.DEVKIT_REVIEW_FRONTEND_ROOTS).toBe(JSON.stringify(['src']));
  });

  it('review mode retries a skipped checklist workflow once and caches only the verified retry', async () => {
    const repo = consumerRepo({ backend: true });
    const assets = reviewAssets();
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_ASSET_ROOT = assets;
    const attempts = new Map<string, number>();
    const exec = mkExec(async ({ label, args }) => {
      const attempt = (attempts.get(label) ?? 0) + 1;
      attempts.set(label, attempt);
      if (label === 'review:api-security-reviewer' && attempt === 1) return 'VERDICT: PASS';
      writeArtifact(repo, label);
      if (label === 'review:api-security-reviewer')
        expect(args[1]).toContain('CHECKLIST-CONTRACT RETRY');
      return 'VERDICT: PASS';
    });

    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(attempts.get('review:api-security-reviewer')).toBe(2);
    expect(Object.keys(loadCache(repo))).toHaveLength(5);
  });

  it('review mode reports a repeated checklist-contract violation as an error, never inconclusive', async () => {
    const repo = consumerRepo({ backend: true });
    const assets = reviewAssets();
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_ASSET_ROOT = assets;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec(async ({ label }) => {
      if (label === 'review:api-security-reviewer') return 'VERDICT: PASS';
      writeArtifact(repo, label);
      return 'VERDICT: PASS';
    });

    expect(await runReviewGate(repo, { exec })).toBe(1);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('api-security-reviewer REVIEW ERROR');
    expect(out).not.toContain('api-security-reviewer INCONCLUSIVE');
    expect(Object.keys(loadCache(repo))).toHaveLength(4);
  });

  it('all reviewers PASS on first pass → exit 0, verdicts cached, no escalation', async () => {
    const repo = consumerRepo({ backend: true });
    const exec = passWithArtifact(repo);
    expect(await runReviewGate(repo, { exec })).toBe(0);
    // backend pair + commit-guard + correctness + conventions, one call each, no opus escalation
    expect(exec).toHaveBeenCalledTimes(5);
    for (const call of exec.mock.calls) {
      const model = call[0].args[call[0].args.indexOf('--model') + 1];
      // Domain + conventions reviewers' first pass is haiku (default flipped sonnet→haiku, bench 6/6);
      // correctness is model-pinned to sonnet (bench recall 0.76→0.92). opus appears only on escalation.
      const pinnedSonnet = call[0].label?.includes('correctness-reviewer');
      expect(model).toBe(pinnedSonnet ? 'sonnet' : 'haiku');
      expect(call[0].args.join(' ')).not.toContain('opus');
    }
    expect(Object.keys(loadCache(repo)).length).toBe(5);
  });

  it('a PASS keeps the judge one-line reason + a fetchable transcript_ref under a ship', async () => {
    const repo = consumerRepo({ backend: true });
    const sink = join(repo, 'events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    process.env.DEVKIT_SHIP_ID = 'ship-1';
    const exec = mkExec(async ({ label }) => {
      writeArtifact(repo, label);
      return 'thorough check\nVERDICT: PASS — no correctness issues';
    });
    expect(await runReviewGate(repo, { exec })).toBe(0);
    const events = readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const reviewEvents = events.filter((e) => e.type === 'review_result');
    expect(reviewEvents.length).toBeGreaterThan(0);
    for (const e of reviewEvents) {
      expect(e.status).toBe('pass');
      expect(e.reason).toBe('no correctness issues'); // was '' before — the reason is no longer dropped
      expect(typeof e.transcript_ref).toBe('string');
      const abs = join(repo, e.transcript_ref); // ref is relative to the telemetry dir (= repo here)
      expect(existsSync(abs)).toBe(true);
      expect(readFileSync(abs, 'utf8')).toContain('thorough check'); // the full passing transcript
    }
  });

  it('telemetry + cache record the model that actually judged — a pin is never mislabeled as the cascade default', async () => {
    const repo = consumerRepo({ backend: true });
    const sink = join(repo, 'events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    process.env.DEVKIT_SHIP_ID = 'ship-model-label';
    expect(await runReviewGate(repo, { exec: passWithArtifact(repo) })).toBe(0);
    const byName = Object.fromEntries(
      readFileSync(sink, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .filter((e) => e.type === 'review_result')
        .map((e) => [e.reviewer, e]),
    );
    // correctness is Reviewer.model-pinned to sonnet — before this fix its events carried the
    // cascade default ('haiku'), sending dashboard readers chasing a downgrade that never happened.
    expect(byName['correctness-reviewer'].model).toBe('sonnet');
    expect(byName['conventions-reviewer'].model).toBe('haiku'); // pinned haiku — truthful by design, not by accident
    expect(byName['api-security-reviewer'].model).toBe('haiku'); // unpinned → cascade default, unchanged
    // The verdict cache records the same truth (it previously stored firstModel for every reviewer).
    const cache = loadCache(repo);
    const corrKey = Object.keys(cache).find((k) => k.includes('correctness'));
    expect(corrKey).toBeTruthy();
    expect(cache[corrKey].model).toBe('sonnet');
  });

  it('identical diff re-run hits the cache — zero judge spawns', async () => {
    const repo = consumerRepo({ backend: true });
    await runReviewGate(repo, { exec: passWithArtifact(repo) });
    const exec = mkExec(async () => 'VERDICT: PASS');
    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(exec).not.toHaveBeenCalled();
  });

  it('first-pass FAIL → opus overturn → exit 0 and the PASS is cached', async () => {
    const repo = consumerRepo({ backend: true });
    const exec = mkExec(async ({ label }) => {
      // correctness AND conventions are single-pass (no escalation to overturn) — hold both PASS
      // so this test isolates the DOMAIN cascade-overturn path it's about.
      if (label === 'review:correctness-reviewer' || label === 'review:conventions-reviewer') {
        writeArtifact(repo, label);
        return 'VERDICT: PASS';
      }
      if (!label.endsWith(':escalate')) return 'sus\nVERDICT: FAIL — maybe';
      writeArtifact(repo, label);
      return 'overturned\nVERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(Object.keys(loadCache(repo)).length).toBe(5);
  });

  it('single-pass FAIL blocks with an override affordance; an OVERRIDE_ env with a rationale waives it', async () => {
    const repo = consumerRepo({ backend: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec(async ({ label }) => {
      if (label === 'review:correctness-reviewer') {
        writeArtifact(repo, label, { failed: 1 }); // artifact carries a failed lens
        return 'race\nVERDICT: FAIL — CAS clobber';
      }
      writeArtifact(repo, label);
      return 'VERDICT: PASS';
    });
    // 1. blocks, and the block names a fingerprint + the exact override line
    expect(await runReviewGate(repo, { exec })).toBe(1);
    const out = err.mock.calls.flat().join('\n');
    const m = out.match(/OVERRIDE_([0-9a-f]{12})_RATIONALE/);
    expect(m).toBeTruthy();
    expect(out).toContain('un-overridden finding');
    // 2. waive that exact finding via env → it passes (domain reviewers cached from run 1)
    const key = `OVERRIDE_${(m as RegExpMatchArray)[1]}_RATIONALE`;
    process.env[key] = 'writer holds the shard lock the fixture omits — not a real race';
    try {
      expect(await runReviewGate(repo, { exec })).toBe(0);
    } finally {
      delete process.env[key];
    }
  });

  it('a model-pinned reviewer (correctness) runs SINGLE-PASS — its first-pass FAIL blocks, never escalates', async () => {
    const repo = consumerRepo({ backend: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec(async ({ label }) => {
      if (label === 'review:correctness-reviewer') return 'race found\nVERDICT: FAIL — CAS clobber';
      writeArtifact(repo, label); // domain reviewers pass
      return 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(1);
    // exactly one call for correctness (no :escalate), and it ran on its pinned sonnet
    const corrCalls = exec.mock.calls.filter(([o]) =>
      o.label.startsWith('review:correctness-reviewer'),
    );
    expect(corrCalls).toHaveLength(1);
    expect(corrCalls[0][0].args[corrCalls[0][0].args.indexOf('--model') + 1]).toBe('sonnet');
    expect(exec.mock.calls.some(([o]) => o.label === 'review:correctness-reviewer:escalate')).toBe(
      false,
    );
    expect(err.mock.calls.flat().join('\n')).toContain('CAS clobber');
  });

  it('first-pass FAIL → opus confirm → exit 1 with the reviewer named; FAIL is never cached', async () => {
    const repo = consumerRepo({ backend: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec(async ({ label }) => {
      if (label.startsWith('review:api-security-reviewer'))
        return 'bad\nVERDICT: FAIL — raw SQL concat';
      writeArtifact(repo, label);
      return 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(1);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('api-security-reviewer FAILED');
    // the judge's full findings are echoed — a block whose evidence was discarded is undebuggable
    expect(out).toContain('raw SQL concat');
    // the four passers are cached; the failer is not
    expect(Object.keys(loadCache(repo)).length).toBe(4);
  });

  it('GUARD_REVIEW_SKIP surgically drops a named reviewer (and says so); the rest still run', async () => {
    const repo = consumerRepo({ backend: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_REVIEW_SKIP = 'api-security-reviewer';
    const exec = passWithArtifact(repo);
    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(exec.mock.calls.map(([o]) => o.label)).not.toContain('review:api-security-reviewer');
    expect(exec).toHaveBeenCalledTimes(4); // backend-performance + commit-guard + correctness + conventions still ran
    expect(err.mock.calls.flat().join('\n')).toContain(
      'api-security-reviewer skipped (GUARD_REVIEW_SKIP)',
    );
  });

  it('missing agent brief → inconclusive with a sync nudge (exit 2), never judged on an empty brief', async () => {
    const repo = consumerRepo({ backend: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    rmSync(join(repo, '.claude', 'agents', 'api-security-reviewer.md'));
    const exec = passWithArtifact(repo);
    expect(await runReviewGate(repo, { exec })).toBe(2);
    expect(exec.mock.calls.map(([o]) => o.label)).not.toContain('review:api-security-reviewer');
    expect(err.mock.calls.flat().join('\n')).toContain('devkit sync-agents');
  });

  it('missing agent brief under strict ship → fail-closed exit 3 with the SYNC remedy (not auth/quota)', async () => {
    const repo = consumerRepo({ backend: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_AI_STRICT = '1';
    rmSync(join(repo, '.claude', 'agents', 'api-security-reviewer.md'));
    expect(await runReviewGate(repo, { exec: passWithArtifact(repo) })).toBe(3);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('strict ship mode fails closed');
    expect(out).toContain('devkit sync-agents'); // the cause-correct remedy…
    expect(out).not.toContain('auth/quota'); // …NOT the misleading generic one
  });

  it('PASS verdict with NO checklist artifact → voided to inconclusive (exit 2), never cached', async () => {
    const repo = consumerRepo({ backend: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec(async () => 'all good I promise\nVERDICT: PASS'); // skipped the workflow
    expect(await runReviewGate(repo, { exec })).toBe(2);
    // the 4 checklist-driven reviewers void to inconclusive; conventions-reviewer has no checklist
    // to skip in the first place — its PASS is trusted directly and DOES cache (the one entry).
    expect(Object.keys(loadCache(repo)).length).toBe(1);
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
    // conventions-reviewer has no checklist artifact to mismatch against — its PASS caches (1);
    // the 4 checklist-driven reviewers void to inconclusive on the FAILED-item mismatch.
    expect(Object.keys(loadCache(repo)).length).toBe(1);
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
    for (const r of REVIEWERS.filter((r) => r.stateFile))
      expect(existsSync(join(repo, r.stateFile))).toBe(false);
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
      'review:conventions-reviewer',
      'review:correctness-reviewer',
      'review:frontend-performance-reviewer',
      'review:frontend-security-reviewer',
    ]);
  });

  it('the wrapped prompt reaches the judge with brief, checklist mandate + verdict pin; the diffstat rides stdin', async () => {
    const repo = consumerRepo({ backend: true });
    let captured: { label: string; args: string[]; input?: string; timeout?: number };
    const exec = mkExec(async (opts) => {
      if (opts.label === 'review:api-security-reviewer') captured = opts;
      writeArtifact(repo, opts.label);
      return 'VERDICT: PASS';
    });
    await runReviewGate(repo, { exec });
    const prompt = captured.args[1];
    expect(prompt).toContain('Brief for api-security-reviewer.');
    expect(prompt).toContain('HEADLESS COMMIT GATE');
    expect(prompt).toContain('The reviewer brief owns checklist enumeration');
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

describe('runReviewGate — conventions-reviewer selected ALONE (non-source file, no other reviewer fires)', () => {
  // A file under a scanRoot but OUTSIDE any backendRoot/frontendRoot, with a NON-source
  // extension: backend/frontend reviewers never match (wrong root), commit-guard and correctness
  // both filter to source-only ('code'/'all' domains — see selectReviewers), and conventions
  // (no such filter, since a CLAUDE.md rule can govern any file type) is the ONLY one left. This
  // is the real differentiator the AC exists for, exercised standalone through the ACTUAL gate —
  // not alongside a source reviewer that happens to also be selected.
  it('a staged JSON config file selects conventions-reviewer and nothing else', async () => {
    const repo = consumerRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'config.json'), '{ "flag": false }\n');
    execSync('git add .', { cwd: repo });
    const exec = passWithArtifact(repo);
    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(exec.mock.calls.map(([o]) => o.label)).toEqual(['review:conventions-reviewer']);
  });

  it('the same standalone selection FAILS and blocks cleanly when the rule is violated — the full skill-less path, no other reviewer active to interfere', async () => {
    const repo = consumerRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'CLAUDE.md'), 'Every config file must set "flag": true.\n');
    writeFileSync(join(repo, 'src', 'config.json'), '{ "flag": false }\n');
    execSync('git add .', { cwd: repo });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec(
      async () =>
        'VIOLATION: Every config file must set "flag": true. — CLAUDE.md:1\nOFFENDING: { "flag": false } — src/config.json:1\nVERDICT: FAIL — flag is false\n',
    );
    expect(await runReviewGate(repo, { exec })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('conventions-reviewer FAILED');
  });
});

describe('runReviewGate — per-completion checkpoints', () => {
  it('a finished PASS is on disk BEFORE slower cascades resolve (checkpoint, not batch)', async () => {
    const repo = consumerRepo({ backend: true });
    let release: (value?: unknown) => void;
    const blocked = new Promise((r) => {
      release = r;
    });
    const exec = mkExec(async ({ label }) => {
      if (!label.startsWith('review:api-security-reviewer')) await blocked;
      writeArtifact(repo, label);
      return 'VERDICT: PASS';
    });
    const done = runReviewGate(repo, { exec });
    // the fast reviewer's PASS lands in the cache while the other three are still pending
    await vi.waitFor(() => {
      expect(Object.keys(loadCache(repo)).length).toBe(1);
    });
    release();
    expect(await done).toBe(0);
    expect(Object.keys(loadCache(repo)).length).toBe(5);
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
    expect(Object.keys(loadCache(repo)).length).toBe(4); // the four passers still checkpointed
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

describe('runReviewGate — bounded judge concurrency (sc-1050)', () => {
  // consumerRepo({backend, frontend}) stages one file per domain → all 7 reviewers selected
  // (backend pair, frontend pair, commit-guard, correctness, conventions).
  it('default cap 2: at most 2 judge cascades run at once, all still complete + cache', async () => {
    const repo = consumerRepo({ backend: true, frontend: true });
    const probe = concurrencyProbe(repo);
    expect(await runReviewGate(repo, { exec: probe.exec })).toBe(0);
    expect(probe.exec).toHaveBeenCalledTimes(7);
    expect(probe.maxInflight()).toBe(2);
    expect(Object.keys(loadCache(repo)).length).toBe(7);
  });

  it('GUARD_REVIEW_CONCURRENCY=1 fully serializes — never more than 1 in flight', async () => {
    const repo = consumerRepo({ backend: true, frontend: true });
    process.env.GUARD_REVIEW_CONCURRENCY = '1';
    const probe = concurrencyProbe(repo);
    expect(await runReviewGate(repo, { exec: probe.exec })).toBe(0);
    expect(probe.maxInflight()).toBe(1);
  });

  it('a cap ≥ reviewer count only BOUNDS, never pads — all 7 run at once', async () => {
    const repo = consumerRepo({ backend: true, frontend: true });
    process.env.GUARD_REVIEW_CONCURRENCY = '9';
    const probe = concurrencyProbe(repo);
    expect(await runReviewGate(repo, { exec: probe.exec })).toBe(0);
    expect(probe.maxInflight()).toBe(7);
  });

  it('strict ship: the cap holds even when each cascade runs first + retry (the production path)', async () => {
    const repo = consumerRepo({ backend: true, frontend: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_AI_STRICT = '1';
    const probe = concurrencyProbe(repo, { failFirst: true }); // first attempt null → one strict retry
    expect(await runReviewGate(repo, { exec: probe.exec })).toBe(0);
    expect(probe.exec).toHaveBeenCalledTimes(14); // 7 reviewers × (attempt + retry), sequential in-slot
    expect(probe.maxInflight()).toBeLessThanOrEqual(2);
  });

  it('a garbage / out-of-range cap falls back to the default of 2', async () => {
    for (const bad of ['', '0', '-3', 'abc', '2.9']) {
      const repo = consumerRepo({ backend: true, frontend: true });
      process.env.GUARD_REVIEW_CONCURRENCY = bad;
      const probe = concurrencyProbe(repo);
      expect(await runReviewGate(repo, { exec: probe.exec })).toBe(0);
      expect(probe.maxInflight()).toBe(2);
    }
  });
});

describe('runReviewGate — strict ship mode (GUARD_AI_STRICT)', () => {
  it('outage: first pass retried once, then INCONCLUSIVE fails closed with exit 3 + remedy', async () => {
    const repo = consumerRepo({ backend: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_AI_STRICT = '1';
    const exec = mkExec(async () => null);
    expect(await runReviewGate(repo, { exec })).toBe(3);
    // 5 reviewers × (1 attempt + 1 retry), no escalation possible
    expect(exec).toHaveBeenCalledTimes(10);
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
    expect(exec).toHaveBeenCalledTimes(5); // one attempt per reviewer — NO retry on a timeout
    const out = err.mock.calls.flat().join('\n');
    expect(out).not.toContain('retrying once');
  });

  it('strict first pass runs on the longer 420s cap (contention headroom); a normal commit keeps 300s', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Capture the FIRST-pass timeout the gate hands each judge. Fresh repo per run so the PASS cache
    // (keyed on reviewer + diff hash) can't skip the second run's exec calls.
    const capFor = async (repo) => {
      let seen: number | undefined;
      const probe = mkExec(async (opts) => {
        seen = opts.timeout;
        writeArtifact(repo, opts.label);
        return 'VERDICT: PASS';
      });
      expect(await runReviewGate(repo, { exec: probe })).toBe(0);
      return seen;
    };

    process.env.GUARD_AI_STRICT = '1';
    expect(await capFor(consumerRepo({ backend: true }))).toBe(1800000); // STRICT_FIRST_TIMEOUT_MS (30 min)

    delete process.env.GUARD_AI_STRICT;
    expect(await capFor(consumerRepo({ backend: true }))).toBe(1800000); // FIRST_TIMEOUT_MS (30 min)
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
    expect(Object.keys(loadCache(repo)).length).toBe(5);
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
    // the 4 checklist-driven reviewers cache nothing from the mixed state; conventions-reviewer
    // has no checklist to poison in the first place, so its retry PASS is trusted and DOES cache.
    expect(Object.keys(loadCache(repo)).length).toBe(1);
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
    expect(exec).toHaveBeenCalledTimes(5); // one attempt each, no retry
  });
});

describe('review progress JSON — the ship banner contract (engine → file → reader)', () => {
  it('writes the running set on start, appends each completion, and clears on clean finish', async () => {
    const repo = consumerRepo({ backend: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const pdir = mkdtempSync(join(tmpdir(), 'review-progress-'));
    dirs.push(pdir);
    const progressFile = join(pdir, 'p.json');
    process.env.DEVKIT_REVIEW_PROGRESS = progressFile;
    // Capture the `running` set the instant the engine wrote it (before any completion), by reading the
    // file inside the first judge invocation — proving the engine records the names the banner reads.
    let runningAtStart: string[] | undefined;
    const exec = mkExec(async (opts) => {
      if (!runningAtStart) runningAtStart = readProgress(progressFile)?.running;
      writeArtifact(repo, opts.label);
      return 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(0);
    // `running` = the reviewer names that actually ran (the same names the banner would name)…
    const ran = new Set(exec.mock.calls.map(([o]) => o.label.replace('review:', '')));
    expect(new Set(runningAtStart)).toEqual(ran);
    // …and a clean finish removes the file, so the banner reports nothing unfinished.
    expect(readProgress(progressFile)).toBeNull();
    expect(unfinishedReviewers(progressFile)).toEqual([]);
  });

  it('a partial file → unfinishedReviewers = running − completed (what the banner prints)', () => {
    const pdir = mkdtempSync(join(tmpdir(), 'review-progress-'));
    dirs.push(pdir);
    const progressFile = join(pdir, 'p.json');
    writeProgress(progressFile, {
      running: ['api-security-reviewer', 'backend-performance-reviewer', 'commit-guard'],
      completed: ['api-security-reviewer'],
    });
    expect(unfinishedReviewers(progressFile).sort()).toEqual([
      'backend-performance-reviewer',
      'commit-guard',
    ]);
  });

  it('no DEVKIT_REVIEW_PROGRESS → the gate runs clean without writing progress (non-ship commit)', async () => {
    const repo = consumerRepo({ backend: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.DEVKIT_REVIEW_PROGRESS;
    const exec = passWithArtifact(repo);
    expect(await runReviewGate(repo, { exec })).toBe(0); // must not throw for the missing env var
  });
});

describe('runCompleteness — hard-by-default commit-msg gate', () => {
  const msg = (repo, text) => {
    const f = join(repo, '.git', 'COMMIT_EDITMSG_TEST');
    writeFileSync(f, text);
    return f;
  };

  it('FAIL → exit 1 (hard by default, no env, no config key)', async () => {
    const repo = consumerRepo({ backend: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec(async () => 'gap: no error handling\nVERDICT: FAIL — misleading scope');
    expect(await runCompleteness(msg(repo, 'feat: add db layer'), repo, { exec })).toBe(1);
  });

  it('FAIL + GUARD_COMPLETENESS_HARD=0 → softened to warn for this run, exit 0', async () => {
    const repo = consumerRepo({ backend: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_COMPLETENESS_HARD = '0';
    const exec = mkExec(async () => 'VERDICT: FAIL — half-shipped');
    expect(await runCompleteness(msg(repo, 'feat: add db layer'), repo, { exec })).toBe(0);
    expect(err.mock.calls.flat().join('\n')).toContain('WARN-only');
  });

  it('FAIL + GUARD_COMPLETENESS_HARD=1 → still blocks (explicit harden is a no-op on the default)', async () => {
    const repo = consumerRepo({ backend: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_COMPLETENESS_HARD = '1';
    const exec = mkExec(async () => 'VERDICT: FAIL — half-shipped');
    expect(await runCompleteness(msg(repo, 'feat: add db layer'), repo, { exec })).toBe(1);
  });

  it('PASS → exit 0; the prompt carries message, Targets block and brief', async () => {
    const repo = consumerRepo({ backend: true });
    let captured: { label: string; args: string[]; input?: string; timeout?: number };
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

  it('judge outage under GUARD_AI_STRICT → exit 3 fail-closed (a silent skip is invisible to a headless ship)', async () => {
    const repo = consumerRepo({ backend: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_AI_STRICT = '1';
    expect(
      await runCompleteness(msg(repo, 'feat: x'), repo, { exec: mkExec(async () => null) }),
    ).toBe(3);
    expect(err.mock.calls.flat().join('\n')).toContain('strict ship mode fails closed');
  });

  it('stdin carries the FULL --stat map ahead of the capped diff', async () => {
    const repo = consumerRepo({ backend: true });
    let captured: { input?: string };
    const exec = mkExec(async (opts) => {
      captured = opts;
      return 'VERDICT: PASS';
    });
    expect(await runCompleteness(msg(repo, 'feat: x'), repo, { exec })).toBe(0);
    // --stat rows render as `<file> | <churn>`; the map precedes the diff body
    expect(captured.input).toMatch(/db\.ts\s+\|/);
    expect(captured.input.indexOf('|')).toBeLessThan(captured.input.indexOf('diff --git'));
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

describe('buildCompletenessEvidence — per-file caps + omission accounting (sc-1060)', () => {
  const seg = (p: string, bodyChars: number) =>
    `diff --git a/${p} b/${p}\nindex 000..111 100644\n--- a/${p}\n+++ b/${p}\n${'+x'.repeat(Math.ceil(bodyChars / 2))}\n`;
  const STAT = ' a.ts | 2 +-\n 1 file changed\n';

  it('a diff under the total budget passes through whole — byte-identical to the old contract', () => {
    const diff = seg('src/a.ts', 500) + seg('src/b.ts', 500);
    expect(buildCompletenessEvidence(diff, STAT)).toBe(`${STAT}\n${diff}`);
    expect(buildCompletenessEvidence(diff, STAT)).not.toContain('OMITTED');
  });

  it('one huge file cannot eat the budget: truncated at the segment cap, NAMED, later files still ride', () => {
    const out = buildCompletenessEvidence(
      seg('big/first.gen.ts', 70000) + seg('src/late.ts', 400),
      STAT,
    );
    expect(out).toContain('[TRUNCATED: big/first.gen.ts — 8000 of ');
    expect(out).toContain('git diff --cached -- big/first.gen.ts');
    expect(out).toContain('diff --git a/src/late.ts'); // the late file survives — the sc-1060 point
    expect(out).toContain('WARNING: 0 segment(s) OMITTED and 1 TRUNCATED');
  });

  it('budget exhaustion emits OMITTED pointer lines, never silence', () => {
    // 7 full 8KB caps + 1 truncated 4KB = 60KB budget gone; segments 9-10 must be NAMED.
    const parts = Array.from({ length: 10 }, (_, i) => seg(`src/f${i}.ts`, 9000));
    const out = buildCompletenessEvidence(parts.join(''), STAT);
    expect(out).toContain('OMITTED: src/f8.ts');
    expect(out).toContain('OMITTED: src/f9.ts');
    expect(out).toContain('git diff --cached -- src/f9.ts');
    expect(out).toMatch(
      /WARNING: 2 segment\(s\) OMITTED and \d+ TRUNCATED[\s\S]*Investigate EVERY OMITTED/,
    );
  });

  it('a long OMITTED list caps at 40 pointers and counts the rest (the --stat map is the full inventory)', () => {
    const parts = Array.from({ length: 50 }, (_, i) =>
      seg(`src/g${String(i).padStart(2, '0')}.ts`, 9000),
    );
    const out = buildCompletenessEvidence(parts.join(''), STAT);
    const pointers = out.match(/^OMITTED: /gm) ?? [];
    expect(pointers.length).toBe(40);
    expect(out).toMatch(/…and 2 more OMITTED segment\(s\)/);
  });

  it('the --stat map always rides first', () => {
    const out = buildCompletenessEvidence(seg('src/a.ts', 70000), STAT);
    expect(out.startsWith(STAT)).toBe(true);
  });

  it('the wrapper prompt pins the OMITTED/TRUNCATED investigate mandate', () => {
    const prompt = wrapCompleteness('brief', 'feat: x', ['a.ts'], 'targets');
    expect(prompt).toContain('OMITTED');
    expect(prompt).toContain('investigate EVERY OMITTED/TRUNCATED entry');
  });
});
