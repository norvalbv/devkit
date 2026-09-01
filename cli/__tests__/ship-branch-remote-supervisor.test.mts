import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import { scriptPath } from './_ship-branch-fixture.mts';

// The published package carries only the compiled `.mjs` next to the ship scripts; the `.mts`
// exists in a source checkout alone. ship-branch.sh runs from both trees.
const FN_RE = /^bounded_remote_git\(\) \{[\s\S]*?^\}/m;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A ship dir holding only the supervisor extension a given tree ships, plus a stub that echoes argv. */
function shipTree(ext: 'mts' | 'mjs') {
  const dir = mkdtempSync(join(tmpdir(), 'ship-supervisor-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'review/process'), { recursive: true });
  writeFileSync(
    join(dir, `review/process/gate-supervisor.${ext}`),
    "console.log('SUPERVISOR ' + process.argv.slice(2).join(' '));\n",
  );
  return dir;
}

function runBoundedRemoteGit(scriptDir: string) {
  const fn = FN_RE.exec(readFileSync(scriptPath, 'utf8'))?.[0];
  if (!fn) throw new Error('bounded_remote_git not found in ship-branch.sh');
  return spawnSync(
    '/bin/bash',
    ['-c', `set -eu; SCRIPT_DIR=${JSON.stringify(scriptDir)}; ${fn}; bounded_remote_git ls-remote`],
    { encoding: 'utf8' },
  );
}

describe('ship-branch.sh — bounded_remote_git resolves the packaged supervisor', () => {
  for (const ext of ['mts', 'mjs'] as const) {
    it(`runs the .${ext} supervisor when that is the one on disk`, () => {
      const r = runBoundedRemoteGit(shipTree(ext));
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe('SUPERVISOR 60 -- git ls-remote\n');
    });
  }
});
