import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { testExecFileSync as execFileSync, testSpawnSync as spawnSync } from './_helpers.mts';

// Why this suite rewrites the script before running it.
//
// bash 4.4+ — every Linux CI runner — leaves a bare `local x` UNSET, so reading it under `set -u`
// aborts the shell. bash 3.2, all macOS ships and therefore what every local pre-push gate here
// actually runs, treats the same declaration as an empty string. The two disagree on exactly one
// thing, and that one thing is load-bearing: sc-1341 shipped a `lost` that was assigned only inside
// an `if` and read unconditionally. The full suite passed locally and every CI job died with
// "lost: unbound variable" — main and every open PR were red until it was found.
//
// So a test that merely runs the script proves nothing on a Mac: the defect is not expressible
// there. To make it expressible we strip the bare (uninitialized) names from each `local`
// declaration, which is precisely what bash 4.4+ does to them. Names carrying an initializer are
// kept, so the rewrite isolates the single semantic difference and nothing else.

const LIB = fileURLToPath(new URL('../lib/ship/assert-staged-set.sh', import.meta.url));
const LOCAL_RE = /^(\s*)local\s+(.*)$/;
const UNBOUND_RE = /unbound variable/;
const COMMIT_SCOPE_DECL_RE = /^[ \t]*local wt=\$1 base=\$2 state=\$3.*$/m;
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

// Mirrors a real ship: stage briefed work, snapshot the index, commit, then assert the commit still
// carries it. `missing` comes out empty here — the clean path, the one every honest ship takes and
// the one that was aborting.
const DRIVER = `#!/bin/bash
set -euo pipefail
lib=$1; repo=$2; state=$3
. "$lib"
cd "$repo"
base=$(git rev-parse HEAD)
printf 'changed\\n' > note.txt
git add note.txt
ship_record_staged_state "$repo" "$state"
git commit -qm ship
ship_assert_commit_scope "$repo" "$base" "$state"
`;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function workDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/**
 * Rewrite every `local` declaration the way bash 4.4+ effectively treats it: names with an
 * initializer stay, bare names disappear (there they are UNSET, not empty). A declaration left with
 * nothing becomes `:` so the line stays syntactically valid.
 */
function emulateBash44(src: string) {
  let rewritten = 0;
  const text = src
    .split('\n')
    .map((line) => {
      const m = LOCAL_RE.exec(line);
      if (!m) return line;
      const names = m[2].split(/\s+/).filter(Boolean);
      const kept = names.filter((t) => t.includes('='));
      if (kept.length === names.length) return line;
      rewritten += 1;
      return kept.length ? `${m[1]}local ${kept.join(' ')}` : `${m[1]}:`;
    })
    .join('\n');
  return { text, rewritten };
}

function seedRepo() {
  const dir = workDir('shipstrict-repo-');
  const env = { ...process.env, ...GIT_ENV };
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: 'ignore' });
  for (const a of [
    ['init', '-q', '-b', 'work'],
    ['config', 'user.email', 'a@b.c'],
    ['config', 'user.name', 'a'],
    ['config', 'commit.gpgsign', 'false'],
  ])
    git(a);
  writeFileSync(join(dir, 'note.txt'), 'base\n');
  git(['add', 'note.txt']);
  git(['commit', '-q', '-m', 'base']);
  return { dir, env };
}

describe('assert-staged-set.sh under bash 4.4+ `local` semantics', () => {
  it('rewrites the declaration under test — the suite cannot silently go vacuous', () => {
    // If the declaration is ever reformatted past the rewriter, every behavioural assertion below
    // would still pass while testing nothing. Fail loudly here instead.
    const src = readFileSync(LIB, 'utf8');
    const before = COMMIT_SCOPE_DECL_RE.exec(src);
    expect(before, 'ship_assert_commit_scope declaration not found — update this suite').not.toBe(
      null,
    );

    const { text, rewritten } = emulateBash44(src);
    expect(rewritten).toBeGreaterThan(0);
    expect(COMMIT_SCOPE_DECL_RE.exec(text)?.[0]).not.toBe(before?.[0]);
  });

  it('has teeth: a conditionally-assigned bare local does abort under the rewrite', () => {
    // The sc-1341 shape in miniature. This is the positive control: it proves the mechanism can
    // still detect the defect, so a green run of the real-script test below means something.
    const fixture = [
      'demo() {',
      '  local missing lost',
      '  missing=$1',
      '  if [ -n "$missing" ]; then lost=x; fi',
      '  if [ -n "$lost" ]; then return 1; fi',
      '  return 0',
      '}',
    ].join('\n');
    const { text, rewritten } = emulateBash44(fixture);
    expect(rewritten).toBe(1);

    const script = join(workDir('shipstrict-ctl-'), 'fixture.sh');
    writeFileSync(script, `set -euo pipefail\n${text}\ndemo ""\n`);
    const r = spawnSync('/bin/bash', [script], { encoding: 'utf8' });

    expect(r.stderr).toMatch(UNBOUND_RE);
    expect(r.status).not.toBe(0);
  });

  it('an honest ship passes ship_assert_commit_scope instead of aborting unbound', () => {
    const { dir, env } = seedRepo();
    const work = workDir('shipstrict-lib-');
    const lib = join(work, 'assert-staged-set.sh');
    const driver = join(work, 'drive.sh');
    writeFileSync(lib, emulateBash44(readFileSync(LIB, 'utf8')).text);
    writeFileSync(driver, DRIVER);

    const r = spawnSync('/bin/bash', [driver, lib, dir, join(work, 'state')], {
      encoding: 'utf8',
      env,
    });

    expect(r.stderr).not.toMatch(UNBOUND_RE);
    expect(r.status, r.stderr).toBe(0);
  });
});
