import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { relIntentPath } from '../lib/ship/ship-intent.mts';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import {
  GH_BODY_VIEW_ARM,
  installHook,
  scriptPath,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

const REPO_JSON = '{"full_name":"acme/app","default_branch":"trunk","owner":{"login":"acme"}}';

/** A fake GitHub: new PR #42 targets main, origin's default is trunk, and #41 is main's open PR. */
function fakeGitHub(log: string): string {
  const bin = mkdtempSync(join(tmpdir(), 'ship-stack-bin-'));
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
${GH_BODY_VIEW_ARM}
case "$*" in
  "pr "*) [ "$2" = edit ] && cat >/dev/null; echo https://github.com/acme/app/pull/42 ;;
  *" POST "*) cat >/dev/null; echo '{"number":7}' ;;
  *"/pulls/42") echo '{"number":42,"stack":null,"base":{"ref":"main","repo":${REPO_JSON}}}' ;;
  *"head=acme:main"*) echo '[{"number":41,"stack":null,"base":{"ref":"trunk","repo":${REPO_JSON}}}]' ;;
esac
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  return bin;
}

const argvLog = () => join(mkdtempSync(join(tmpdir(), 'gh-argv-')), 'argv.txt');

/** Every `gh api` call the ship made, in order. */
const apiCalls = (log: string) =>
  readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('api '));

function runShip(dir: string, env: NodeJS.ProcessEnv, log: string, argv: string[]) {
  return spawnSync('/bin/bash', [scriptPath, ...argv], {
    cwd: dir,
    input: 'b\n',
    encoding: 'utf8',
    env: { ...env, PATH: `${fakeGitHub(log)}:${env.PATH ?? process.env.PATH ?? ''}` },
  });
}

describe('ship-branch.sh — GitHub native stacks', () => {
  it("joins the new PR to its base PR's stack by default", () => {
    const { dir, env } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const log = argvLog();

    const r = runShip(dir, env, log, ['feat/stacked', 't', 'note.txt']);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('ship: stacked #42 on #41 (GitHub stack #7)');
    expect(apiCalls(log)).toContain('api -X POST repos/acme/app/stacks --input -');
  });

  it('--no-stack makes no stack call at all', () => {
    const { dir, env } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const log = argvLog();

    const r = runShip(dir, env, log, ['feat/unstacked', 't', '--no-stack', 'note.txt']);

    expect(r.status, r.stderr).toBe(0);
    expect(apiCalls(log)).toEqual([]);
  });

  it('a gate-blocked --no-stack ship still skips stacking when replayed by --resume', () => {
    const { dir, env } = seedShipRepoLocalRemote({ hookBody: 'exit 1' });
    writeFileSync(join(dir, '.gitignore'), '.devkit/\n');
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const log = argvLog();

    const blocked = runShip(dir, env, log, ['feat/opt-out', 't', '--no-stack', '--', 'note.txt']);
    expect(blocked.status, blocked.stderr).not.toBe(0);
    const record = JSON.parse(readFileSync(join(dir, relIntentPath('feat/opt-out')), 'utf8'));
    expect(record.noStack).toBe(true);

    installHook(dir, 'exit 0');
    const resumed = runShip(dir, env, log, ['--resume', 'feat/opt-out']);

    expect(resumed.status, resumed.stderr).toBe(0);
    expect(readFileSync(log, 'utf8')).toContain('pr create');
    expect(apiCalls(log)).toEqual([]);
  });
});
