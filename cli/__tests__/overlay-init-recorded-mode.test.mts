// A bare `devkit init` on a recorded overlay keeps the overlay: no committed-file writes, a
// conflicting mode refused, and a borrowing linked worktree retargeted to the home.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import initRun, { applyInit } from '../commands/init.mts';
import { applyOverlayConstraints, defaultSelection } from '../lib/components.mts';
import { CLI, devkitHome, rootRegistry } from './_helpers.mts';
import { isolateOverlayTestEnv, workRepo } from './_overlay-fixture.mts';

const { mkTmp, cleanup } = rootRegistry();
isolateOverlayTestEnv(cleanup);

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const logged = () =>
  vi
    .mocked(console.log)
    .mock.calls.map((call) => call.join(' '))
    .join('\n');

async function overlayRepo() {
  const root = workRepo(mkTmp);
  const selection = applyOverlayConstraints(
    { ...defaultSelection(), skills: false, agents: false, lineGrowth: false },
    'react-app',
  );
  await applyInit(root, { stack: 'react-app', selection, overlay: true, devkitRef: 'v0.9.0' });
  vi.mocked(console.log).mockClear();
  return root;
}

describe('devkit init on a recorded overlay install', () => {
  it('plans the overlay, not a package-mode install, when --overlay is omitted', async () => {
    const root = await overlayRepo();
    const code = await initRun(['--yes', '--anti-slop', '--base-drift', '--dry-run'], root);

    expect(code).toBe(0);
    const out = logged();
    expect(out).toContain('OVERLAY (local-only)');
    expect(out).not.toMatch(/patch package\.json|write \.husky\/|devkit \.gitignore line/);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('a real re-run without --overlay leaves every committed file untouched', async () => {
    const root = await overlayRepo();
    const pkg = readFileSync(join(root, 'package.json'), 'utf8');

    expect(await initRun(['--yes', '--base-drift'], root)).toBe(0);
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(pkg);
  });

  it('refuses --standalone before any write, naming --overlay and devkit clean', async () => {
    const root = await overlayRepo();
    const config = readFileSync(join(root, '.devkit', 'config.json'), 'utf8');

    await expect(initRun(['--yes', '--standalone'], root)).rejects.toThrow(
      /overlay \(local-only\) install.*`devkit init --overlay`.*`devkit clean`/,
    );
    expect(readFileSync(join(root, '.devkit', 'config.json'), 'utf8')).toBe(config);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  // Package-mode structure baselines are tracked files, so the overlay's own refusal must fire.
  it('--baselines-only without --overlay keeps the overlay refusal', async () => {
    const root = await overlayRepo();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await initRun(['--baselines-only'], root)).toBe(1);
    expect(error.mock.calls.join('\n')).toContain('unsupported in overlay/standalone mode');
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('a bare init in a linked worktree borrowing the overlay runs from the home', async () => {
    const root = await overlayRepo();
    const hooksPath = git(root, 'config', 'core.hooksPath');
    const wt = join(mkTmp('overlay-init-wt-'), 'wt');
    git(root, 'worktree', 'add', '-q', '--detach', wt);

    const r = spawnSync(process.execPath, [CLI, 'init', '--yes', '--dry-run'], {
      cwd: wt,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: devkitHome(mkTmp('overlay-init-home-')),
        DEVKIT_NO_TELEMETRY: '1',
      },
    });

    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(r.stderr).toContain(`borrows the overlay at ${root} — running there`);
    expect(r.stdout).toContain('OVERLAY (local-only)');
    expect(git(root, 'config', 'core.hooksPath')).toBe(hooksPath);
  });
});
