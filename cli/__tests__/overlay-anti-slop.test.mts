/**
 * Overlay anti-slop install refusals: overlay never writes into a repo that already tracks an
 * anti-slop path or owns its own Oxlint config, and never touches the exclude file itself.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { applyInit } from '../commands/init.mts';
import { applyOverlayConstraints, defaultSelection } from '../lib/components.mts';
import { wireOverlayAntiSlop } from '../lib/install/anti-slop/overlay/install.mts';
import { rootRegistry } from './_helpers.mts';
import {
  isolateOverlayTestEnv,
  readCfgComponents,
  workRepo as fixtureWorkRepo,
} from './_overlay-fixture.mts';

const { mkTmp, cleanup } = rootRegistry();
const workRepo = () => fixtureWorkRepo(mkTmp);
isolateOverlayTestEnv(cleanup);

describe('overlay anti-slop — refusals that keep the tree clean', () => {
  const porcelain = (root: string) =>
    execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });

  it('refuses when git already tracks an anti-slop path, and writes nothing', async () => {
    const root = workRepo();
    const git = (...a: string[]) => execFileSync('git', a, { cwd: root });
    writeFileSync(join(root, '.anti-slop-baseline.json'), '{"schemaVersion":1,"entries":[]}\n');
    git('add', '-f', '.anti-slop-baseline.json');
    git('commit', '-qm', 'tracked baseline');

    await applyInit(root, {
      stack: 'generic',
      selection: applyOverlayConstraints({ ...defaultSelection(), antiSlop: true }, 'react-app'),
      overlay: true,
      devkitRef: 'v0.0.0-test',
    });

    expect(readCfgComponents(root).antiSlop).toBe(false);
    expect(existsSync(join(root, 'oxlint.devkit.json'))).toBe(false);
    expect(existsSync(join(root, '.devkit', 'anti-slop', 'manifest.json'))).toBe(false);
    expect(porcelain(root)).toBe('');
  });

  it('refuses when the repo owns its own Oxlint config, rather than silently overriding it', async () => {
    const root = workRepo();
    const git = (...a: string[]) => execFileSync('git', a, { cwd: root });
    writeFileSync(join(root, '.oxlintrc.json'), '{ "rules": { "eqeqeq": "error" } }\n');
    git('add', '-A');
    git('commit', '-qm', 'consumer oxlint config');

    await applyInit(root, {
      stack: 'generic',
      selection: applyOverlayConstraints({ ...defaultSelection(), antiSlop: true }, 'react-app'),
      overlay: true,
      devkitRef: 'v0.0.0-test',
    });

    expect(readCfgComponents(root).antiSlop).toBe(false);
    expect(existsSync(join(root, 'oxlint.devkit.json'))).toBe(false);
    // The consumer's own config survives byte for byte.
    expect(readFileSync(join(root, '.oxlintrc.json'), 'utf8')).toContain('"eqeqeq": "error"');
    expect(porcelain(root)).toBe('');
  });

  // The damage is a WINDOW — the caller's later reconcile restores what a partial one pruned — so an
  // end-state assertion cannot see it. Asserted at the seam: this writes no exclude line at all.
  it('wireOverlayAntiSlop never reconciles the exclude file itself', () => {
    const root = workRepo();
    const git = (...a: string[]) => execFileSync('git', a, { cwd: root });
    writeFileSync(join(root, '.anti-slop-baseline.json'), '{"schemaVersion":1,"entries":[]}\n');
    git('add', '-f', '.anti-slop-baseline.json');
    git('commit', '-qm', 'tracked baseline');

    const excludePath = join(root, '.git', 'info', 'exclude');
    mkdirSync(join(root, '.git', 'info'), { recursive: true });
    const seeded = [
      '# devkit overlay (local-only) — not committed',
      '.claude/skills/',
      '.claude/agents/',
      '.devkit/skills-manifest.json',
      '',
    ].join('\n');
    writeFileSync(excludePath, seeded);

    const wiring = wireOverlayAntiSlop(root, root, '', { antiSlop: true }, false);

    expect(wiring.wired).toBe(false);
    // Byte-for-byte: the agent half is the caller's to reconcile, and nothing here may touch it.
    expect(readFileSync(excludePath, 'utf8')).toBe(seeded);
  });

  it('an Oxc install failure is printed and the overlay install goes on', () => {
    const root = workRepo();
    writeFileSync(join(root, '.devkit'), 'not a directory\n');
    const log = vi.mocked(console.log);
    log.mockClear();
    expect(wireOverlayAntiSlop(root, root, '', { antiSlop: false }, false).wired).toBe(false);
    expect(log.mock.calls.flat().join('\n')).toContain('! Oxc could not be installed');
  });

  // The writer skips assertNoConfigCollisions under overlay because it neither reads nor writes a
  // consumer root config; the PREFLIGHT has to agree or a second oxfmt config aborts the install.
  it('installs despite two consumer Oxfmt configs — overlay owns neither', async () => {
    const root = workRepo();
    const git = (...a: string[]) => execFileSync('git', a, { cwd: root });
    writeFileSync(join(root, '.oxfmtrc.json'), '{ "indentWidth": 2 }\n');
    writeFileSync(join(root, 'oxfmt.config.mts'), 'export default { indentWidth: 2 };\n');
    git('add', '-A');
    git('commit', '-qm', 'two oxfmt configs');

    await applyInit(root, {
      stack: 'generic',
      selection: applyOverlayConstraints({ ...defaultSelection(), antiSlop: true }, 'react-app'),
      overlay: true,
      devkitRef: 'v0.0.0-test',
    });

    expect(readCfgComponents(root).antiSlop).toBe(true);
    expect(existsSync(join(root, 'oxlint.devkit.json'))).toBe(true);
    expect(porcelain(root)).toBe('');
  });
});
