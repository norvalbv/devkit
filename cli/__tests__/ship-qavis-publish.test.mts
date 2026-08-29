/** The post-push Qavis evidence hand-off, end to end through the real ship. Sibling of
 *  ship-branch.test.mts, which has no maxTestLines headroom. */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import {
  ghStub,
  localBranchExists,
  manifestOf,
  remoteBranchExists,
  scriptPath,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

/** A qavis with today's real command set. `--help` answers wherever it appears (commander does), so
 *  an exit-status probe would read `publish` as present — the trap the degradation exists to avoid. */
function stubQavisWithout(dir, commands) {
  writeFileSync(
    join(dir, 'qavis'),
    `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--help" ] && { printf "Commands:\\n${commands
      .map((c) => `  ${c} [options]  x\\n`)
      .join('')}"; exit 0; }; done\n` +
      `case "$1" in\n  ${commands.join('|')}) exit 0 ;;\n  *) echo "error: unknown command '$1'" >&2; exit 1 ;;\nesac\n`,
  );
  chmodSync(join(dir, 'qavis'), 0o755);
}

describe('ship — post-push Qavis evidence hand-off', () => {
  // sc-2028: the hand-off shelled `qavis publish`, a subcommand qavis has never exposed, so every
  // ship carrying a pass receipt ended on `unknown command 'publish'` plus a retry line naming that
  // same impossible command — read by autonomous agents as a terminal post-ship failure. It sits
  // AFTER `gh pr create` and BEFORE the manifest write, so this pins both halves: the hand-off
  // degrades to a runnable remedy, and reconcile still records the pushed branch.
  it('degrades to a runnable remedy on a qavis without publish, without losing the manifest', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    mkdirSync(join(dir, '.qavis'), { recursive: true });
    writeFileSync(join(dir, '.qavis/receipt.json'), '{"sha":"deadbeef"}\n'); // a pass to publish
    const stubBin = ghStub('echo "https://github.com/acme/app/pull/42"');
    stubQavisWithout(stubBin, ['qa', 'waive', 'route']);

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/qavis-publish', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, PATH: `${stubBin}:${process.env.PATH}` },
    });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/pull\/42/);
    expect(r.stderr).not.toMatch(/unknown command/); // never invoked, so never rejected
    expect(r.stderr).toMatch(/qavis qa --pr 42 .* --annotate description/); // a remedy that runs
    expect(r.stderr).not.toMatch(/qavis publish --pr/);
    // The whole reason the probe may not throw: errexit here would strand the pushed branch.
    expect(manifestOf(dir).branches['feat/qavis-publish'].prNumber).toBe(42);
    expect(remoteBranchExists(bare, 'feat/qavis-publish')).toBe(true);
    expect(localBranchExists(git, 'feat/qavis-publish')).toBe(false);
  });
});
