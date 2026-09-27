// sc-3400: a deletion-only review-root change must not fail closed. These drive the REAL
// commit-guard checklist script through runReviewGate, so the env→script wiring is under test.
import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REVIEWERS } from '../reviewers.mts';
import { runReviewGate } from '../run-review.mts';
import { withStagedFiles } from '../runtime.mts';
import {
  cleanupReviewFixtures,
  consumerRepo,
  mkExec,
  writeArtifact,
} from './run-review-fixtures.mts';

const ENV_KEYS = [
  'GUARD_AI_STRICT',
  'FRINK_AI_STRICT',
  'GUARD_REVIEW_SKIP',
  'FRINK_REVIEW_SKIP',
  'GUARD_NO_COMPLETENESS',
  'DEVKIT_RUN_MODE',
  'DEVKIT_REVIEW_ASSET_ROOT',
  'DEVKIT_REVIEW_STAGED_FILES',
  'DEVKIT_REVIEW_STAGED_FILES_PATH',
  'DEVKIT_GATE_EVENTS',
  'DEVKIT_SHIP_ID',
  'GUARD_CORRECTNESS_SPLIT',
  'SHIP_COMMIT_TIMEOUT',
  'DEVKIT_GATE_DEADLINE_MS',
  'GUARD_MASS_DELETION_OK',
  'FRINK_MASS_DELETION_OK',
  'GUARD_NO_REVIEW',
  'FRINK_NO_REVIEW',
  'GUARD_DECISION_NO_LLM',
  'FRINK_DECISION_NO_LLM',
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GUARD_CORRECTNESS_SPLIT = 'off';
});
afterEach(() => {
  cleanupReviewFixtures();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const REAL = (rel: string) => fileURLToPath(new URL(`../../../skills/${rel}`, import.meta.url));
const git = (repo: string, cmd: string) => execSync(`git ${cmd}`, { cwd: repo, encoding: 'utf8' });
function commitAll(repo: string): void {
  git(repo, 'add -A');
  git(repo, '-c user.email=d@e.test -c user.name=D -c commit.gpgsign=false commit -qm base');
}

/** Replace the fixture's canned commit-guard init with the shipped script + its shared module. */
function installRealCommitGuard(repo: string): void {
  const skills = join(repo, '.claude', 'skills');
  mkdirSync(join(skills, '_devkit'), { recursive: true });
  copyFileSync(REAL('_devkit/review-roots.mjs'), join(skills, '_devkit', 'review-roots.mjs'));
  copyFileSync(
    REAL('commit-guard/scripts/checklist.mjs'),
    join(skills, 'commit-guard', 'scripts', 'checklist.mjs'),
  );
}

/** Replace commit-guard's init with an arbitrary script body (logging/crashing probes). */
function installCommitGuardScript(repo: string, body: string): void {
  writeFileSync(join(repo, '.claude', 'skills', 'commit-guard', 'scripts', 'checklist.mjs'), body);
}

/** Every other reviewer honours the checklist contract; commit-guard's calls are recorded. */
function recordingPassExec(repo: string) {
  return mkExec(async ({ label }) => {
    writeArtifact(repo, label);
    return 'looks fine\nVERDICT: PASS';
  });
}
const labels = (exec: ReturnType<typeof mkExec>) => exec.mock.calls.map(([o]) => o.label);
const stderrOf = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.flat().join('\n');

/** The frink sc-3355 shape: one dead source file deleted, a config edit outside every review root. */
function deadFileRemovalRepo(): string {
  const repo = consumerRepo({ backend: true });
  installRealCommitGuard(repo);
  writeFileSync(join(repo, 'knip.json'), '{"ignore":["src/main/db.ts"]}\n');
  commitAll(repo);
  git(repo, 'rm -q src/main/db.ts');
  writeFileSync(join(repo, 'knip.json'), '{"ignore":[]}\n');
  git(repo, 'add knip.json');
  return repo;
}

describe('commit-guard on a deletion-only review-root change (sc-3400)', () => {
  it('strict ship passes with a named skip and never spawns a commit-guard judge', async () => {
    const repo = deadFileRemovalRepo();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_AI_STRICT = '1';
    const exec = recordingPassExec(repo);

    const rc = await runReviewGate(repo, { exec });
    expect(rc, stderrOf(err)).toBe(0);

    expect(labels(exec).filter((l) => l.startsWith('review:commit-guard'))).toEqual([]);
    const out = stderrOf(err);
    expect(out).toMatch(
      /guard-review: commit-guard — PASS in \d+s \(checkpointed\) — no reviewable files/,
    );
    expect(out).not.toContain('pure deletions');
    expect(out).not.toContain('INCONCLUSIVE');
  });

  it('a mixed set still reviews the surviving file — the deletion is filtered, not the reviewer', async () => {
    const repo = consumerRepo({ backend: true });
    installRealCommitGuard(repo);
    writeFileSync(join(repo, 'src', 'main', 'keep.ts'), 'export const k = 1;\n');
    commitAll(repo);
    git(repo, 'rm -q src/main/db.ts');
    writeFileSync(join(repo, 'src', 'main', 'keep.ts'), 'export const k = 2;\n');
    git(repo, 'add src/main/keep.ts');
    let seededAtSpawn: string[] | null = null;
    const exec = mkExec(async ({ label }) => {
      if (label === 'review:commit-guard') {
        const state = JSON.parse(
          readFileSync(join(repo, '.claude', '.pre-commit-review.json'), 'utf8'),
        );
        seededAtSpawn = state.files.map((f) => f.path);
      }
      writeArtifact(repo, label);
      return 'VERDICT: PASS';
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_AI_STRICT = '1';

    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(seededAtSpawn).toEqual(['src/main/keep.ts']);
  });

  it('the strict outage retry re-seeds with the gate list too (the second init call site)', async () => {
    const repo = consumerRepo({ backend: true });
    // Logs whether the gate's list reached THIS init call, then seeds a valid one-file artifact.
    installCommitGuardScript(
      repo,
      `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
appendFileSync('init-env.log', (process.env.DEVKIT_REVIEW_STAGED_FILES ?? 'UNSET') + '\\n');
mkdirSync('.claude', { recursive: true });
writeFileSync('.claude/.pre-commit-review.json', JSON.stringify({ files: [{ path: 'src/main/db.ts', status: 'pending', issues: [] }] }));
`,
    );
    let commitGuardCalls = 0;
    const exec = mkExec(async ({ label }) => {
      if (label === 'review:commit-guard' && commitGuardCalls++ === 0) return null; // transient
      writeArtifact(repo, label);
      return 'VERDICT: PASS';
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_AI_STRICT = '1';

    expect(await runReviewGate(repo, { exec })).toBe(0);
    const lines = readFileSync(join(repo, 'init-env.log'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(JSON.parse(line)).toEqual(['src/main/db.ts']);
  });

  it.each([
    ['the init script crashes', "console.error('kaboom'); process.exit(1);\n"],
    [
      'the init script enumerates nothing and names no reason',
      "import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('.claude', { recursive: true });\nwriteFileSync('.claude/.pre-commit-review.json', JSON.stringify({ files: [] }));\n",
    ],
  ])('an engine failure (%s) names an engine remedy, never auth/quota', async (_case, body) => {
    const repo = consumerRepo({ backend: true });
    installCommitGuardScript(repo, body);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_AI_STRICT = '1';

    expect(await runReviewGate(repo, { exec: recordingPassExec(repo) })).toBe(3);
    const line = stderrOf(err)
      .split('\n')
      .findIndex((l) => l.startsWith('guard-review: commit-guard INCONCLUSIVE'));
    expect(line).toBeGreaterThanOrEqual(0);
    const block = stderrOf(err)
      .split('\n')
      .slice(line, line + 2)
      .join('\n');
    expect(block).toContain('engine error');
    expect(block).toContain('NOT an auth/quota problem');
    expect(block).not.toMatch(/check `\w+` CLI auth\/quota/);
  });

  it('a deletion-only list too large for an env var still reaches the script (no ACM fallback)', async () => {
    const repo = consumerRepo({ backend: true });
    installRealCommitGuard(repo);
    // Few files, long paths: ~230 bytes per JSON entry × 600 is past the 100KB inline cap while
    // keeping the fixture's git work small.
    const segment = 'generated-dead-code-directory-with-a-deliberately-long-name';
    const dir = join(repo, 'src', 'main', segment, segment, segment);
    mkdirSync(dir, { recursive: true });
    const count = 600;
    for (let i = 0; i < count; i++)
      writeFileSync(
        join(dir, `module-${String(i).padStart(6, '0')}.ts`),
        `export const m${i} = ${i};\n`,
      );
    // Surviving tracked files keep the deletion a MINORITY of HEAD, so it tests the large-list
    // channel rather than tripping the gate's clobbered-index check (mass-deletion.mts).
    const keep = join(repo, 'src', 'keep');
    mkdirSync(keep, { recursive: true });
    for (let i = 0; i < 640; i++) writeFileSync(join(keep, `k${i}.ts`), '');
    commitAll(repo);
    git(repo, `rm -q -r ${JSON.stringify(dir)}`);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_AI_STRICT = '1';
    const exec = recordingPassExec(repo);

    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(labels(exec).filter((l) => l.startsWith('review:commit-guard'))).toEqual([]);
    const out = stderrOf(err);
    expect(out).toMatch(/commit-guard — PASS .* no reviewable files/);
    expect(out).not.toContain('falling back to script-side resolution');
  }, 60_000);
});

describe('withStagedFiles — the large-list channel (sc-3400)', () => {
  const commitGuard = REVIEWERS.find((r) => r.name === 'commit-guard');
  if (!commitGuard) throw new Error('commit-guard reviewer missing from the registry');
  const big = Array.from({ length: 3000 }, (_, i) => `src/deep/path/to/module-${i}.ts`);

  it('small lists stay inline', () => {
    const env = withStagedFiles({}, commitGuard, ['src/a.ts']);
    expect(env.DEVKIT_REVIEW_STAGED_FILES).toBe('["src/a.ts"]');
    expect(env.DEVKIT_REVIEW_STAGED_FILES_PATH).toBeUndefined();
  });

  it('large lists travel by file, and an inherited inline list cannot shadow it', () => {
    const env = withStagedFiles({ DEVKIT_REVIEW_STAGED_FILES: '["stale.ts"]' }, commitGuard, big);
    expect(env.DEVKIT_REVIEW_STAGED_FILES).toBeUndefined();
    const file = env.DEVKIT_REVIEW_STAGED_FILES_PATH;
    expect(file).toBeDefined();
    expect(JSON.parse(readFileSync(String(file), 'utf8'))).toEqual(big);
  });

  it('a small list clears an inherited path so a nested run cannot read a stale file', () => {
    const env = withStagedFiles(
      { DEVKIT_REVIEW_STAGED_FILES_PATH: '/tmp/stale.json' },
      commitGuard,
      ['src/a.ts'],
    );
    expect(env.DEVKIT_REVIEW_STAGED_FILES_PATH).toBeUndefined();
  });

  it('measures BYTES: a multi-byte list under 100k UTF-16 units still travels by file', () => {
    const cjk = Array.from({ length: 300 }, (_, i) => `src/${'漢'.repeat(300)}-${i}.ts`);
    expect(JSON.stringify(cjk).length).toBeLessThan(100_000);
    const env = withStagedFiles({}, commitGuard, cjk);
    expect(env.DEVKIT_REVIEW_STAGED_FILES).toBeUndefined();
    expect(env.DEVKIT_REVIEW_STAGED_FILES_PATH).toBeDefined();
  });

  it('a temp dir that refuses the write fails loudly instead of falling back', () => {
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = join(tmpdir(), 'devkit-no-such-dir', 'nested');
    try {
      expect(() => withStagedFiles({}, commitGuard, [...big, 'src/unique.ts'])).toThrow(
        /could not be written to the temp dir/,
      );
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });

  it('rewrites a pre-existing file at the content address whose bytes differ', () => {
    const first = withStagedFiles({}, commitGuard, big).DEVKIT_REVIEW_STAGED_FILES_PATH;
    writeFileSync(String(first), '["src/forged.ts"]');
    const again = withStagedFiles({}, commitGuard, big).DEVKIT_REVIEW_STAGED_FILES_PATH;
    expect(again).toBe(first);
    expect(JSON.parse(readFileSync(String(again), 'utf8'))).toEqual(big);
  });

  it('is content-addressed: concurrent reviewers with the same list share one file', () => {
    const a = withStagedFiles({}, commitGuard, big).DEVKIT_REVIEW_STAGED_FILES_PATH;
    const b = withStagedFiles({}, commitGuard, big).DEVKIT_REVIEW_STAGED_FILES_PATH;
    const c = withStagedFiles({}, commitGuard, [
      ...big,
      'src/extra.ts',
    ]).DEVKIT_REVIEW_STAGED_FILES_PATH;
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });
});

/** A consumer repo whose HEAD tracks `gen` files under src/main/gen plus `keep` under src/keep. */
function trackedTreeRepo(gen: number, keep = 0): string {
  const repo = consumerRepo({ backend: true });
  installRealCommitGuard(repo);
  for (const [dir, n] of [
    ['gen', gen],
    ['keep', keep],
  ] as const) {
    if (n === 0) continue;
    const abs = join(repo, 'src', dir === 'gen' ? 'main' : '', dir);
    mkdirSync(abs, { recursive: true });
    for (let i = 0; i < n; i++)
      writeFileSync(join(abs, `f${i}.ts`), `export const v${i} = ${i};\n`);
  }
  commitAll(repo);
  return repo;
}

describe('mass deletion — a clobbered index blocks at the review gate (sc-3400)', () => {
  const MASS = /guard-review: MASS DELETION/;

  it('a clobbered index (read-tree --empty, worktree intact) blocks a plain commit before any judge', async () => {
    const repo = trackedTreeRepo(60);
    git(repo, 'read-tree --empty');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = recordingPassExec(repo);

    expect(await runReviewGate(repo, { exec })).toBe(1);
    expect(labels(exec)).toEqual([]);
    const out = stderrOf(err);
    expect(out).toMatch(MASS);
    expect(out).toContain('git diff --cached --stat');
    expect(out).not.toMatch(/auth|quota/);
  });

  it('a whole-tree git rm blocks', async () => {
    const repo = trackedTreeRepo(60);
    git(repo, 'rm -r -q --cached .');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runReviewGate(repo, { exec: recordingPassExec(repo) })).toBe(1);
    expect(stderrOf(err)).toMatch(MASS);
  });

  it('a foreign index (whole-tree deletion plus a few foreign adds) blocks — additions do not mask it', async () => {
    const repo = trackedTreeRepo(60);
    git(repo, 'read-tree --empty');
    for (const n of ['a', 'b', 'c']) {
      writeFileSync(join(repo, `foreign-${n}.txt`), `${n}\n`);
      git(repo, `add foreign-${n}.txt`);
    }
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runReviewGate(repo, { exec: recordingPassExec(repo) })).toBe(1);
    expect(stderrOf(err)).toMatch(/deletes \d+ of the \d+ files HEAD tracks.*3 additions/s);
  });

  it('strict ship mode blocks with exit 1 (evidence), never the exit-3 outage code', async () => {
    const repo = trackedTreeRepo(60);
    git(repo, 'read-tree --empty');
    process.env.GUARD_AI_STRICT = '1';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runReviewGate(repo, { exec: recordingPassExec(repo) })).toBe(1);
  });

  it('a large MINORITY deletion (60 of ~220 tracked) is not a clobber — it reaches the reviewers', async () => {
    const repo = trackedTreeRepo(60, 150);
    git(repo, 'rm -r -q src/main/gen');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runReviewGate(repo, { exec: recordingPassExec(repo) }), stderrOf(err)).toBe(0);
    expect(stderrOf(err)).not.toMatch(MASS);
  });

  it('exactly half the tracked tree deleted blocks (the >= boundary)', async () => {
    // HEAD tracks the fixture's own files + 60 gen + keep; pick keep so gen is exactly half.
    const repo = trackedTreeRepo(60, 0);
    const tracked = git(repo, 'ls-files').trim().split('\n').length;
    const pad = 120 - tracked;
    const keep = join(repo, 'src', 'keep');
    mkdirSync(keep, { recursive: true });
    for (let i = 0; i < pad; i++)
      writeFileSync(join(keep, `p${i}.ts`), `export const p${i} = 0;\n`);
    commitAll(repo);
    expect(git(repo, 'ls-files').trim().split('\n')).toHaveLength(120);
    git(repo, 'rm -r -q --cached src/main/gen');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runReviewGate(repo, { exec: recordingPassExec(repo) })).toBe(1);

    // One more surviving tracked file tips it under half.
    git(repo, 'reset -q');
    writeFileSync(join(keep, 'extra.ts'), 'export const e = 0;\n');
    commitAll(repo);
    git(repo, 'rm -r -q --cached src/main/gen');
    expect(await runReviewGate(repo, { exec: recordingPassExec(repo) })).toBe(0);
  }, 60_000);

  it('a whole-tree MOVE is not a deletion — exact renames are detected, not counted as D', async () => {
    const repo = trackedTreeRepo(60);
    git(repo, 'mv src/main/gen src/main/moved');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runReviewGate(repo, { exec: recordingPassExec(repo) }), stderrOf(err)).toBe(0);
    expect(stderrOf(err)).not.toMatch(MASS);
  });

  it('a move rename detection gives up on (renameLimit) nets out as D+A pairs and still passes', async () => {
    const repo = trackedTreeRepo(60);
    git(repo, 'config diff.renameLimit 1');
    git(repo, 'mv src/main/gen src/main/moved');
    // Change every moved file so only INEXACT (limit-bound) rename detection could pair them.
    for (let i = 0; i < 60; i++)
      writeFileSync(
        join(repo, 'src', 'main', 'moved', `f${i}.ts`),
        `export const v${i} = ${i + 1};\n`,
      );
    git(repo, 'add -A src/main/moved');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runReviewGate(repo, { exec: recordingPassExec(repo) }), stderrOf(err)).toBe(0);
    expect(stderrOf(err)).not.toMatch(MASS);
  });

  it('paths with spaces, quotes, tabs and newlines are counted as one entry each (-z parsing)', async () => {
    const repo = consumerRepo({ backend: true });
    installRealCommitGuard(repo);
    const dir = join(repo, 'src', 'main', 'odd dir');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 60; i++) writeFileSync(join(dir, `a "q"\t${i}\nx.ts`), `export {};\n`);
    commitAll(repo);
    git(repo, 'read-tree --empty');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runReviewGate(repo, { exec: recordingPassExec(repo) })).toBe(1);
    const tracked = Number(/of the (\d+) files HEAD tracks/.exec(stderrOf(err))?.[1]);
    expect(tracked).toBe(
      git(repo, 'ls-tree -r -z --name-only HEAD').split('\0').filter(Boolean).length,
    );
  });

  it('GUARD_MASS_DELETION_OK=1 lets a deliberate mass deletion through, loudly, with a bypass event', async () => {
    const repo = trackedTreeRepo(60);
    git(repo, 'rm -r -q --cached .');
    const events = join(repo, '..', `events-${Date.now()}.jsonl`);
    process.env.DEVKIT_GATE_EVENTS = events;
    process.env.GUARD_MASS_DELETION_OK = '1';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runReviewGate(repo, { exec: recordingPassExec(repo) }), stderrOf(err)).not.toBe(1);
    expect(stderrOf(err)).toMatch(/mass-deletion check BYPASSED \(GUARD_MASS_DELETION_OK\)/);
    expect(readFileSync(events, 'utf8')).toContain('"bypass":"GUARD_MASS_DELETION_OK"');
  });

  it('the bypass knob is silent on an ordinary commit (no bypass line, no event)', async () => {
    const repo = deadFileRemovalRepo();
    process.env.GUARD_MASS_DELETION_OK = '1';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runReviewGate(repo, { exec: recordingPassExec(repo) })).toBe(0);
    expect(stderrOf(err)).not.toContain('BYPASSED');
  });

  it('noLlm (no model calls) still runs the check — it is git evidence, not a judge', async () => {
    const repo = trackedTreeRepo(60);
    git(repo, 'read-tree --empty');
    process.env.GUARD_DECISION_NO_LLM = '1';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runReviewGate(repo, { exec: recordingPassExec(repo) })).toBe(1);
    expect(stderrOf(err)).toMatch(MASS);
  });

  it('a block is attributed: every registered reviewer gets a review_skipped mass_deletion row', async () => {
    const repo = trackedTreeRepo(60);
    git(repo, 'read-tree --empty');
    const events = join(repo, '..', `events-attr-${Date.now()}.jsonl`);
    process.env.DEVKIT_GATE_EVENTS = events;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runReviewGate(repo, { exec: recordingPassExec(repo) })).toBe(1);
    const rows = readFileSync(events, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'review_skipped');
    expect(rows.map((r) => [r.reviewer, r.reason]).sort()).toEqual(
      REVIEWERS.map((r) => [r.name, 'mass_deletion']).sort(),
    );
  });

  it('a malformed guard.config.json cannot pre-empt the block into a fail-open exit 2', async () => {
    const repo = trackedTreeRepo(60);
    git(repo, 'read-tree --empty');
    writeFileSync(join(repo, 'guard.config.json'), '{ not json');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runReviewGate(repo, { exec: recordingPassExec(repo) })).toBe(1);
    expect(stderrOf(err)).toMatch(MASS);
  });

  it('noLlm: an index clobbered AFTER the check is still caught by the snapshot recheck', async () => {
    // A `git` shim clobbers the index right after the census's own read — i.e. after the snapshot.
    const repo = trackedTreeRepo(60);
    const bin = join(repo, '..', `git-shim-${Date.now()}`);
    mkdirSync(bin, { recursive: true });
    const realGit = execSync('command -v git', { encoding: 'utf8' }).trim();
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\n"${realGit}" "$@"; rc=$?\ncase " $* " in *" --name-status "*) "${realGit}" read-tree --empty;; esac\nexit $rc\n`,
      { mode: 0o755 },
    );
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    process.env.GUARD_DECISION_NO_LLM = '1';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await runReviewGate(repo, { exec: recordingPassExec(repo) })).toBe(1);
    } finally {
      process.env.PATH = path;
    }
    expect(stderrOf(err)).toMatch(/STAGED TREE CHANGED during the review gate/);
  });

  it('GUARD_NO_REVIEW disables it with the rest of the gate', async () => {
    const repo = trackedTreeRepo(60);
    git(repo, 'read-tree --empty');
    process.env.GUARD_NO_REVIEW = '1';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runReviewGate(repo, { exec: recordingPassExec(repo) })).toBe(0);
  });

  it('an unborn HEAD (first commit) never trips it', async () => {
    const repo = consumerRepo({ backend: true });
    installRealCommitGuard(repo);
    git(repo, 'add -A');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runReviewGate(repo, { exec: recordingPassExec(repo) });
    expect(stderrOf(err)).not.toMatch(MASS);
  });
});
