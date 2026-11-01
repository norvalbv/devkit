// Overlay never edits a git-tracked agent hook file, Claude's settings.local.json included: install
// and clean skip it, and doctor reports it with the remedy instead of drift --fix cannot repair.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import cleanRun from '../commands/clean.mts';
import doctorRun from '../commands/doctor.mts';
import { applyInit } from '../commands/init.mts';
import { applyOverlayConstraints, defaultSelection } from '../lib/components.mts';
import { rootRegistry } from './_helpers.mts';
import { isolateOverlayTestEnv, workRepo } from './_overlay-fixture.mts';

const { mkTmp, cleanup } = rootRegistry();
isolateOverlayTestEnv(cleanup);

const LOCAL = '.claude/settings.local.json';
const SHARED = '.claude/settings.json';
const RETIRED_COMMAND =
  'FALLOW_GATE_COMMIT_ONLY=1 bash "$CLAUDE_PROJECT_DIR/.claude/hooks/fallow-gate.sh"';
const RETIRED_HOOKS = {
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: RETIRED_COMMAND }] }],
  },
};

const git = (root: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const logged = () => vi.mocked(console.log).mock.calls.flat().join('\n');
const read = (root: string, rel: string) => readFileSync(join(root, rel), 'utf8');

/** A work repo whose settings.local.json is committed compact, so any rewrite shows as a diff. */
function repoTrackingLocalSettings({ commitRetiredShared = false } = {}) {
  const root = workRepo(mkTmp);
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, LOCAL), JSON.stringify({ hooks: {} }));
  git(root, 'add', '-f', LOCAL);
  if (commitRetiredShared) {
    writeFileSync(join(root, SHARED), JSON.stringify(RETIRED_HOOKS));
    git(root, 'add', SHARED);
  }
  git(root, 'commit', '-qm', 'track agent settings');
  return root;
}

const overlayInit = (root: string) =>
  applyInit(root, {
    stack: 'react-app',
    selection: applyOverlayConstraints({ ...defaultSelection(), agentHooks: true }, 'react-app'),
    overlay: true,
    devkitRef: 'v0.21.0',
  });

describe('overlay with a git-tracked settings.local.json', () => {
  it('never edits it across init, doctor --fix and clean; doctor advises with both rows', async () => {
    const root = repoTrackingLocalSettings({ commitRetiredShared: true });
    const before = read(root, LOCAL);
    await overlayInit(root);

    expect(read(root, LOCAL)).toBe(before);
    expect(read(root, '.git/info/exclude')).not.toContain(LOCAL);
    expect(logged()).toContain(`${LOCAL} is git-tracked`);

    vi.mocked(console.log).mockClear();
    expect(await doctorRun([], root)).toBe(0);
    expect(logged()).toMatch(
      /hook registrations: committed, so overlay never edits it .*claude:tracked:\.claude\/settings\.local\.json.*git rm --cached.*fallow-gate\.sh hooks devkit will not remove: claude:retired-registration:\.claude\/settings\.json/,
    );
    expect(await doctorRun(['--fix'], root)).toBe(0);
    expect(read(root, LOCAL)).toBe(before);

    await cleanRun(['--yes'], root);
    expect(read(root, LOCAL)).toBe(before);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('keeps the tracked-file notice and its remedy on a row that also reports missing registrations', async () => {
    const root = repoTrackingLocalSettings();
    await overlayInit(root);
    rmSync(join(root, '.cursor', 'hooks.json'));

    vi.mocked(console.log).mockClear();
    expect(await doctorRun([], root)).toBe(1);
    expect(logged()).toMatch(
      /hook registrations: \d+ provider registration issue\(s\): cursor:.*also: committed, so overlay never edits it .*claude:tracked:\.claude\/settings\.local\.json.*git rm --cached/,
    );
  });

  it('still strips a retired hook from an untracked settings.json', async () => {
    const root = repoTrackingLocalSettings();
    writeFileSync(join(root, SHARED), JSON.stringify(RETIRED_HOOKS));
    await overlayInit(root);

    expect(read(root, SHARED)).not.toContain('fallow-gate.sh');
    expect(await doctorRun([], root)).toBe(0);
  });

  it("the advisory's remedy registers the hooks and hides the now-untracked file", async () => {
    const root = repoTrackingLocalSettings();
    await overlayInit(root);
    git(root, 'rm', '-q', '--cached', LOCAL);

    expect(await doctorRun(['--fix'], root)).toBe(0);
    expect(read(root, LOCAL)).toContain('.claude/hooks/');
    expect(read(root, '.git/info/exclude')).toContain(LOCAL);
  });
});
