import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const here = (name: string) => fileURLToPath(new URL(`./${name}`, import.meta.url));
const helper = here('resume-extras-notice.sh');

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A root holding one real directory, `dir`, the way a refused directory argument looks on disk. */
function rootWithDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'resume-notice-'));
  roots.push(root);
  mkdirSync(join(root, 'dir'));
  return root;
}

/** Source the helper under errexit + nounset like the ship scripts, arm it, then run `tail`. */
function run(extras: string[], tail: string, branch = 'feat/x') {
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      `set -euo pipefail; . "$HELPER"; BR=$1; ROOT=$2; shift 2; PATHS=("$@"); RESUME_EXTRA_PATHS=("$@"); ship_resume_brief 2>/dev/null; ${tail}`,
      'bash',
      branch,
      rootWithDir(),
      ...extras,
    ],
    { encoding: 'utf8', env: { ...process.env, HELPER: helper } },
  );
}

describe('ship_resume_extras_notice', () => {
  it('prints a re-pass command that survives a paste: paths and branch are shell-quoted', () => {
    const r = run(['a b.ts', '$x.ts'], 'exit 1', 'feat/it s');

    expect(r.status).toBe(1);
    expect(r.stderr).toBe(
      'ship: 2 path(s) briefed by this retry were NOT recorded — a bare --resume will not carry them: a\\ b.ts \\$x.ts\n' +
        '  re-pass them: devkit ship --resume feat/it\\ s -- a\\ b.ts \\$x.ts\n',
    );
  });

  it('says nothing when every extra was a refused directory, instead of an empty command', () => {
    const r = run(['dir'], 'exit 1');

    expect(r.status).toBe(1);
    expect(r.stderr).toBe('');
  });

  it('reads the exit status when it is the first statement of a later cleanup handler', () => {
    const handler = 'cleanup() { ship_resume_extras_notice; true; }; trap cleanup EXIT;';

    expect(run(['a.ts'], `${handler} exit 3`).stderr).toContain('NOT recorded');
    expect(run(['a.ts'], `${handler} exit 0`).stderr).toBe('');
  });

  it('stays quiet once a record write was attempted, however the run then ends', () => {
    expect(run(['a.ts'], 'RESUME_EXTRAS_UNRECORDED=0; exit 1').stderr).toBe('');
  });

  it.each([
    ['ship-branch.sh', 'cleanup'],
    ['reship.sh', 'rewrite_ref_cleanup'],
  ])('%s: %s() calls the notice before anything can change $?', (script, fn) => {
    const source = readFileSync(here(script), 'utf8');
    const body = source.slice(source.indexOf(`\n${fn}() {\n`)).split('\n')[2];

    expect(body.trim()).toMatch(/^ship_resume_extras_notice( #.*)?$/);
  });

  it('reship.sh: its cleanup() trap is only installed after the notice is disarmed', () => {
    // cleanup() runs other commands before rewrite_ref_cleanup, so it must never be the live EXIT
    // trap while the notice is armed.
    const source = readFileSync(here('reship.sh'), 'utf8');

    expect(source.indexOf('\nRESUME_EXTRAS_UNRECORDED=0\n')).toBeGreaterThan(0);
    expect(source.indexOf('\ntrap cleanup EXIT\n')).toBeGreaterThan(
      source.indexOf('\nRESUME_EXTRAS_UNRECORDED=0\n'),
    );
  });
});
