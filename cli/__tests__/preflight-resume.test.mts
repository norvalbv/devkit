/** sc-2535 — a blocked guard-size / hook-source preflight still records, so `--resume` replays it.
 *  dist-integrity-resume.test.mts owns the dist-integrity case (sc-2389). */
import type { ExecFileSyncOptions } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { generationAt, NO_RECORD } from '../lib/ship/ship-intent-codec.mts';
import { readIntent, relIntentPath, writeIntent } from '../lib/ship/ship-intent.mts';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import {
  dirs,
  dropWorktree,
  NOTHING_RE,
  reshipScript,
  scriptPath,
  seedReshipRepo,
  seedShipRepo,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

const SIZE_RE = /exceed the line limit/;
const MISSING_RUNNER_RE = /missing \.husky\/_ in /;
const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';

type Seeded = {
  dir: string;
  env: NodeJS.ProcessEnv;
  git: (a: string[], o?: ExecFileSyncOptions) => string;
};

/** A 5-line cap committed at the base, so the base-aware size preflight has a ceiling to enforce. */
function capLines(seeded: Seeded, push?: string): void {
  writeFileSync(join(seeded.dir, 'guard.config.json'), '{"maxLines":5}\n');
  seeded.git(['add', 'guard.config.json'], { stdio: 'ignore' });
  seeded.git(['commit', '-qm', 'cap'], { stdio: 'ignore' });
  if (push) seeded.git(['push', '-qf', 'origin', `work:${push}`], { stdio: 'ignore' });
  mkdirSync(join(seeded.dir, 'src'), { recursive: true });
}

function recorded(dir: string, branch: string) {
  const r = readIntent(dir, branch);
  if (!('intent' in r)) throw new Error(`no intent recorded: ${r.reason}`);
  return { ...r.intent, body: Buffer.from(r.intent.bodyB64, 'base64').toString() };
}

const run = (script: string, s: Seeded, args: string[], env: NodeJS.ProcessEnv = {}, input = '') =>
  spawnSync('/bin/bash', [script, ...args], {
    cwd: s.dir,
    input,
    encoding: 'utf8',
    env: { ...s.env, SHIP_DRY_RUN: '1', ...env },
  });

/** Each blocking preflight: how to make it fail, and how to fix the cause before the retry. */
const PREFLIGHTS = [
  {
    name: 'guard-size',
    stderr: SIZE_RE,
    break: (s: Seeded) => writeFileSync(join(s.dir, 'src/big.ts'), lines(20)),
    fix: (s: Seeded) => writeFileSync(join(s.dir, 'src/big.ts'), lines(3)),
  },
  {
    name: 'hook source',
    stderr: MISSING_RUNNER_RE,
    break: (s: Seeded) => {
      writeFileSync(join(s.dir, 'src/big.ts'), lines(3));
      rmSync(join(s.dir, '.husky/_'), { recursive: true, force: true });
    },
    fix: (s: Seeded) => {
      mkdirSync(join(s.dir, '.husky/_'), { recursive: true });
      writeFileSync(join(s.dir, '.husky/_/pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    },
  },
];

describe.each(PREFLIGHTS)('ship-branch.sh — a blocking $name preflight is resumable', (pf) => {
  it('records title/body/paths, creates no branch, and --resume replays after the fix', () => {
    const s = seedShipRepo();
    capLines(s);
    pf.break(s);
    const branch = 'feat/pre-resume';

    const first = run(scriptPath, s, [branch, 'the title', '--', 'src/big.ts'], {}, 'pr body\n');

    expect(first.status, first.stderr).toBe(1);
    expect(first.stderr).toMatch(pf.stderr);
    expect(recorded(s.dir, branch)).toMatchObject({
      mode: 'ship',
      title: 'the title',
      paths: ['src/big.ts'],
      body: 'pr body',
    });
    expect(s.git(['branch', '--list', branch]).trim()).toBe('');
    expect(s.git(['worktree', 'list', '--porcelain'])).not.toContain('devkit-ship-');

    pf.fix(s);
    const retry = run(scriptPath, s, ['--resume', branch]);
    try {
      expect(retry.status, retry.stderr).toBe(0);
      expect(retry.stderr).toContain('Resuming recorded invocation');
    } finally {
      dropWorktree(s.git, retry.stderr);
    }
  });

  it('a --resume that is blocked AGAIN keeps the chain alive and merges the donated path', () => {
    const s = seedShipRepo();
    capLines(s);
    pf.break(s);
    writeFileSync(join(s.dir, 'src/other.ts'), lines(2));
    const branch = 'feat/pre-chain';

    expect(run(scriptPath, s, [branch, 't', '--', 'src/big.ts'], {}, 'b\n').status).toBe(1);
    const second = run(scriptPath, s, ['--resume', branch, '--', 'src/other.ts']);

    expect(second.status, second.stderr).toBe(1);
    expect(second.stderr).toMatch(pf.stderr);
    expect(recorded(s.dir, branch)).toMatchObject({
      paths: ['src/big.ts', 'src/other.ts'],
      body: 'b',
    });
    expect(second.stderr).not.toContain('NOT recorded');

    const third = run(scriptPath, s, ['--resume', branch]);
    expect(third.stderr).toContain('2 paths');
    expect(third.stderr).toContain('    src/other.ts\n');
  });

  it('--dry-gates never records, even when the preflight blocks', () => {
    const s = seedShipRepo();
    capLines(s);
    pf.break(s);
    const branch = 'feat/pre-dry-gates';

    const r = run(scriptPath, s, [branch, 't', '--dry-gates', '--', 'src/big.ts'], {
      SHIP_DRY_RUN: '',
    });

    expect(r.status, r.stderr).not.toBe(0);
    expect(readIntent(s.dir, branch)).not.toHaveProperty('intent');
  });
});

describe.each(PREFLIGHTS)('reship.sh — a blocking $name preflight is resumable', (pf) => {
  it('records a reship intent and --resume cross-dispatches after the fix', () => {
    const s = seedReshipRepo();
    capLines(s, 'pr-open');
    pf.break(s);

    const first = run(
      reshipScript,
      s,
      ['pr-open', 'the title', '--pr', '--', 'src/big.ts'],
      {},
      'pr body\n',
    );

    expect(first.status, first.stderr).toBe(1);
    expect(first.stderr).toMatch(pf.stderr);
    expect(recorded(s.dir, 'pr-open')).toMatchObject({
      mode: 'reship',
      title: 'the title',
      paths: ['src/big.ts'],
      body: 'pr body',
    });
    expect(s.git(['worktree', 'list', '--porcelain'])).not.toContain('devkit-reship-');

    pf.fix(s);
    const retry = run(scriptPath, s, ['--resume', 'pr-open']);
    try {
      expect(retry.status, retry.stderr).toBe(0);
      expect(retry.stderr).toContain('Resuming recorded invocation for pr-open (--pr)');
    } finally {
      dropWorktree(s.git, retry.stderr);
    }
  });
});

describe('a --resume that exits before its record write names the extra paths it lost', () => {
  const NOTICE = (branch: string) =>
    '1 path(s) briefed by this retry were NOT recorded — a bare --resume will not carry them: src/other.ts\n' +
    `  re-pass them: devkit ship --resume ${branch} -- src/other.ts\n`;

  it('ship-branch.sh: a directory refusal leaves the record narrow and says so', () => {
    const s = seedShipRepo();
    capLines(s);
    writeFileSync(join(s.dir, 'src/big.ts'), lines(20));
    writeFileSync(join(s.dir, 'src/other.ts'), lines(2));
    const branch = 'feat/pre-lost-extra';
    expect(run(scriptPath, s, [branch, 't', '--', 'src/big.ts'], {}, 'b\n').status).toBe(1);

    const retry = run(scriptPath, s, ['--resume', branch, '--', 'src/other.ts', 'src']);

    expect(retry.status, retry.stderr).toBe(1);
    expect(retry.stderr).toContain('  + src/other.ts   (briefed by this retry)');
    expect(retry.stderr).toContain(NOTICE(branch));
    expect(recorded(s.dir, branch).paths).toEqual(['src/big.ts']);
  });

  it('reship.sh: an unreadable --body-file leaves the record narrow and says so', () => {
    const s = seedReshipRepo();
    capLines(s, 'pr-open');
    writeFileSync(join(s.dir, 'src/big.ts'), lines(20));
    writeFileSync(join(s.dir, 'src/other.ts'), lines(2));
    const first = run(reshipScript, s, ['pr-open', 't', '--pr', '--', 'src/big.ts'], {}, 'b\n');
    expect(first.status, first.stderr).toBe(1);

    const retry = run(scriptPath, s, [
      '--resume',
      'pr-open',
      '--body-file',
      join(s.dir, 'absent.md'),
      '--',
      'src/other.ts',
    ]);

    expect(retry.status, retry.stderr).not.toBe(0);
    expect(retry.stderr).toContain(NOTICE('pr-open'));
    expect(recorded(s.dir, 'pr-open').paths).toEqual(['src/big.ts']);
  });
});

describe('ship-branch.sh — --from-branch source mode', () => {
  it('a size refusal records a branch-source intent that --resume replays once the fix is committed', () => {
    const s = seedShipRepoLocalRemote();
    capLines(s, 'work');
    writeFileSync(join(s.dir, 'src/big.ts'), lines(20));
    s.git(['add', 'src/big.ts'], { stdio: 'ignore' });
    s.git(['commit', '-qm', 'over cap'], { stdio: 'ignore' });
    const branch = 'feat/pre-from-branch';

    const first = run(scriptPath, s, [branch, 't', '--base', 'work', '--from-branch'], {}, 'b\n');

    expect(first.status, first.stderr).toBe(1);
    expect(first.stderr).toMatch(SIZE_RE);
    expect(recorded(s.dir, branch)).toMatchObject({
      sourceMode: 'branch',
      base: 'work',
      body: 'b',
    });
    expect(s.git(['branch', '--list', branch]).trim()).toBe('');

    writeFileSync(join(s.dir, 'src/big.ts'), lines(3));
    s.git(['commit', '-qam', 'trim'], { stdio: 'ignore' });
    const retry = run(scriptPath, s, ['--resume', branch]);
    try {
      expect(retry.status, retry.stderr).toBe(0);
      expect(retry.stderr).toContain('Resuming recorded invocation');
    } finally {
      dropWorktree(s.git, retry.stderr);
    }
  });
});

describe('ship-branch.sh — a fresh failure record never clobbers a concurrent attempt (sc-2535)', () => {
  const shipIntent = fileURLToPath(new URL('../lib/ship/ship-intent.mts', import.meta.url));

  /** A `node` on PATH that records a competing attempt the moment the size preflight starts — after
   *  this attempt took its generation snapshot, before its failure-path write. */
  function competitorEnv(s: Seeded, branch: string): NodeJS.ProcessEnv {
    const bin = join(s.dir, 'race-node-bin');
    mkdirSync(bin);
    dirs.push(bin);
    writeFileSync(
      join(bin, 'node'),
      [
        '#!/bin/bash',
        'case " $* " in *size-disable*)',
        `  printf 'competitor body' | "${process.execPath}" "${shipIntent}" write --root "$PWD" --branch '${branch}' --mode ship --title competitor -- src/big.ts >/dev/null ;;`,
        'esac',
        `exec "${process.execPath}" "$@"`,
      ].join('\n'),
    );
    chmodSync(join(bin, 'node'), 0o755);
    return { PATH: `${bin}:${s.env.PATH ?? process.env.PATH ?? ''}` };
  }

  it('keeps the record a concurrent attempt wrote after this one snapshotted', () => {
    const s = seedShipRepo();
    capLines(s);
    writeFileSync(join(s.dir, 'src/big.ts'), lines(20));
    const branch = 'feat/pre-race';

    const r = run(
      scriptPath,
      s,
      [branch, 'mine', '--', 'src/big.ts'],
      competitorEnv(s, branch),
      'b\n',
    );

    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(SIZE_RE);
    expect(r.stderr).toContain('record superseded by a concurrent attempt');
    expect(recorded(s.dir, branch)).toMatchObject({ title: 'competitor', body: 'competitor body' });
  });

  it('a sequential full re-run still replaces the previous attempt record', () => {
    const s = seedShipRepo();
    capLines(s);
    writeFileSync(join(s.dir, 'src/big.ts'), lines(20));
    const branch = 'feat/pre-rerun';

    expect(run(scriptPath, s, [branch, 'first', '--', 'src/big.ts'], {}, 'one\n').status).toBe(1);
    const second = run(scriptPath, s, [branch, 'second', '--', 'src/big.ts'], {}, 'two\n');

    expect(second.status, second.stderr).toBe(1);
    expect(second.stderr).not.toContain('superseded');
    expect(recorded(s.dir, branch)).toMatchObject({ title: 'second', body: 'two' });
  });
});

describe('ship-intent generation snapshot', () => {
  const opts = (root: string, expectGeneration?: string) => ({
    root,
    branch: 'feat/snap',
    mode: 'ship',
    title: 't',
    links: [],
    noQavisPublish: false,
    updatePrBody: false,
    draft: false,
    resumed: false,
    mergePaths: false,
    expectGeneration,
    body: Buffer.from('b'),
  });

  it('reports NO_RECORD when absent, and the stored generation once written', () => {
    const { dir } = seedShipRepo();
    expect(generationAt(join(dir, relIntentPath('feat/snap')))).toBe(NO_RECORD);
    expect(writeIntent(opts(dir), ['a.txt'])).toBe(0);
    const stored = recorded(dir, 'feat/snap').generation;
    expect(generationAt(join(dir, relIntentPath('feat/snap')))).toBe(stored);
  });

  it('--expect-generation none writes into an empty slot but never over an existing record', () => {
    const { dir } = seedShipRepo();
    expect(writeIntent(opts(dir, NO_RECORD), ['a.txt'])).toBe(0);
    const first = recorded(dir, 'feat/snap').generation;
    expect(writeIntent({ ...opts(dir, NO_RECORD), title: 'late' }, ['b.txt'])).toBe(0);
    expect(recorded(dir, 'feat/snap')).toMatchObject({
      generation: first,
      title: 't',
      paths: ['a.txt'],
    });
  });

  it('a malformed record without a generation reads as NO_RECORD', () => {
    const { dir } = seedShipRepo();
    expect(writeIntent(opts(dir), ['a.txt'])).toBe(0);
    writeFileSync(join(dir, relIntentPath('feat/snap')), '{"mode":"ship"}\n');
    expect(generationAt(join(dir, relIntentPath('feat/snap')))).toBe(NO_RECORD);
  });
});

describe('ship-branch.sh — refusals that must stay unrecorded', () => {
  it('an existing local branch refuses without writing an intent, even with an over-cap file', () => {
    const s = seedShipRepo();
    capLines(s);
    writeFileSync(join(s.dir, 'src/big.ts'), lines(20));
    s.git(['branch', 'feat/taken'], { stdio: 'ignore' });

    const r = run(scriptPath, s, ['feat/taken', 't', '--', 'src/big.ts'], {}, 'b\n');

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('branch already exists: feat/taken');
    expect(readIntent(s.dir, 'feat/taken')).not.toHaveProperty('intent');
  });

  it('nothing-to-commit refuses without writing an intent', () => {
    const s = seedShipRepo();
    capLines(s);
    writeFileSync(join(s.dir, 'src/big.ts'), lines(20));
    s.git(['add', 'src/big.ts'], { stdio: 'ignore' });
    s.git(['commit', '-qm', 'already'], { stdio: 'ignore' });

    const r = run(scriptPath, s, ['feat/empty', 't', '--', 'src/big.ts'], {}, 'b\n');

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(NOTHING_RE);
    expect(readIntent(s.dir, 'feat/empty')).not.toHaveProperty('intent');
  });
});

/** A blocking preflight placed ahead of the record would silently reintroduce sc-2535.
 *  ship-branch.sh routes through ship_abort_resumable; reship.sh runs them after its intent write. */
describe('preflight ordering guard', () => {
  const FAIL_OPEN = new Set(['ship_judge_preflight']);
  const PREFLIGHT_RE = /^\s*(?:if\s+!\s+)?([a-z_]+_preflight)\s/;
  const DIST_RE = /^\s*node "\$DIST_INTEGRITY"/; // the dist-integrity check (sc-2389)
  const calls = (src: string) =>
    src
      .split('\n')
      .map((line, i) => ({
        i,
        name: DIST_RE.test(line) ? 'DIST_INTEGRITY' : PREFLIGHT_RE.exec(line)?.[1],
      }))
      .filter((c): c is { i: number; name: string } => !!c.name && !FAIL_OPEN.has(c.name));

  it('ship-branch.sh: each aborting preflight follows the record helper and routes through it', () => {
    const src = readFileSync(scriptPath, 'utf8');
    const lns = src.split('\n');
    const helper = lns.findIndex((l) => /^ship_abort_resumable\(\)/.test(l));
    expect(helper, 'ship_abort_resumable() must exist').toBeGreaterThan(-1);
    const found = calls(src);
    expect(found.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'ship_size_preflight',
        'gate_hook_source_preflight',
        'DIST_INTEGRITY',
      ]),
    );
    for (const c of found) {
      expect(c.i, `${c.name} at line ${c.i + 1} runs before the record helper`).toBeGreaterThan(
        helper,
      );
      const block = lns.slice(c.i, c.i + 7).join('\n');
      expect(block, `${c.name} at line ${c.i + 1} must abort via ship_abort_resumable`).toContain(
        'ship_abort_resumable',
      );
    }
  });

  it('reship.sh: each aborting preflight follows the intent write', () => {
    const src = readFileSync(reshipScript, 'utf8');
    const write = src.split('\n').findIndex((l) => l.includes('"${SHIP_INTENT_ARGS[@]}"'));
    expect(write).toBeGreaterThan(-1);
    const found = calls(src);
    expect(found.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'ship_size_preflight',
        'gate_hook_source_preflight',
        'DIST_INTEGRITY',
      ]),
    );
    for (const c of found) {
      expect(c.i, `${c.name} at line ${c.i + 1} runs before the intent write`).toBeGreaterThan(
        write,
      );
    }
  });
});
