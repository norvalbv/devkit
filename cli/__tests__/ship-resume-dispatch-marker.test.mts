import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { testExecFileSync as execFileSync, testSpawnSync as spawnSync } from './_helpers.mts';
import {
  installHook,
  publishEnvFor,
  reshipScript,
  scriptPath,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

const intentCli = fileURLToPath(new URL('../lib/ship/ship-intent.mts', import.meta.url));
const MARKER = 'DEVKIT_SHIP_RESUME_DISPATCHED';

function seedResumableRepo() {
  const seeded = seedShipRepoLocalRemote({ hookBody: 'exit 1' });
  writeFileSync(join(seeded.dir, '.gitignore'), '.devkit/\n');
  writeFileSync(join(seeded.dir, 'note.txt'), 'hello\n');
  return seeded;
}

function run(script: string, dir: string, env: NodeJS.ProcessEnv, argv: string[], input = '') {
  return spawnSync('/bin/bash', [script, ...argv], { cwd: dir, input, encoding: 'utf8', env });
}

/** A passing pre-commit hook that records what the cross-dispatched script's gates inherit. */
function observeMarker(dir: string): () => string {
  const seen = join(dir, 'marker-seen');
  installHook(dir, `echo "\${${MARKER}-unset}" > '${seen}'\nexit 0`);
  return () => {
    expect(existsSync(seen), 'the receiver never reached its commit hook').toBe(true);
    return readFileSync(seen, 'utf8').trim();
  };
}

describe('ship --resume cross-dispatch consumes its one-hop marker', () => {
  it('reship.sh handing a recorded new ship to ship-branch.sh leaves no marker for the gates', () => {
    const { dir, env, git } = seedResumableRepo();
    const blocked = run(scriptPath, dir, { ...env, SHIP_DRY_RUN: '1' }, [
      'feat/to-ship',
      'x',
      '--',
      'note.txt',
    ]);
    expect(blocked.status).not.toBe(0);
    const seen = observeMarker(dir);
    // reship.sh's own loop guard must still read the marker it unset on arrival.
    const looped = run(reshipScript, dir, { ...env, [MARKER]: '1' }, ['--resume', 'feat/to-ship']);
    expect(looped.status).not.toBe(0);
    expect(looped.stderr).toContain('dispatched in a loop');

    const r = run(reshipScript, dir, { ...env, SHIP_DRY_RUN: '1' }, ['--resume', 'feat/to-ship']);
    expect(r.status, r.stderr).toBe(0);
    expect(seen()).toBe('unset');
    git(['worktree', 'prune']);
  });

  it('a plain ship started under an inherited marker still keeps it from the gates', () => {
    const { dir, env, git } = seedResumableRepo();
    const seen = observeMarker(dir);
    const r = run(
      scriptPath,
      dir,
      { ...env, SHIP_DRY_RUN: '1', [MARKER]: '1' },
      ['feat/plain', 'x', '--', 'note.txt'],
      'b\n',
    );
    expect(r.status, r.stderr).toBe(0);
    expect(seen()).toBe('unset');
    git(['worktree', 'prune']);
  });

  it('ship-branch.sh handing a recorded re-push to reship.sh leaves no marker for the gates', () => {
    const { dir, env, git } = seedResumableRepo();
    installHook(dir, 'exit 0');
    const { publishEnv } = publishEnvFor(dir, env);
    const first = run(
      scriptPath,
      dir,
      publishEnv,
      ['feat/to-reship', 'x', '--', 'note.txt'],
      'b\n',
    );
    expect(first.status, first.stderr).toBe(0);
    writeFileSync(join(dir, 'note.txt'), 'hello again\n');
    execFileSync(
      'node',
      [
        intentCli,
        'write',
        '--root',
        dir,
        '--branch',
        'feat/to-reship',
        '--mode',
        'reship',
        '--title',
        'x',
        '--',
        'note.txt',
      ],
      { input: 'b\n', env },
    );
    const seen = observeMarker(dir);

    const r = run(scriptPath, dir, publishEnv, ['--resume', 'feat/to-reship']);
    expect(r.status, r.stderr).toBe(0);
    expect(seen()).toBe('unset');
    git(['worktree', 'prune']);
  });
});
