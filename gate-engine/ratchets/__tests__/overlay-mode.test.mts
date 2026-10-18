import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { overlayInstall } from '../../overlay-mode.mts';

let roots: string[] = [];

function repo(config?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'overlay-mode-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  if (config !== undefined) {
    mkdirSync(join(root, '.devkit'));
    writeFileSync(join(root, '.devkit/config.json'), config);
  }
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe('overlayInstall', () => {
  it.each([
    ['an overlay config', '{"overlay":true}\n', true],
    ['a package config', '{}\n', false],
    ['no config anywhere', undefined, false],
  ])('answers from %s', (_label, config, expected) => {
    vi.stubEnv('DEVKIT_OVERLAY', '');
    expect(overlayInstall(repo(config))).toBe(expected);
  });

  it('throws naming the file when config.json does not parse, rather than answering package mode', () => {
    vi.stubEnv('DEVKIT_OVERLAY', '');
    const root = repo('{"overlay":tru');
    expect(() => overlayInstall(root)).toThrow(
      `${join(root, '.devkit/config.json')} could not be read`,
    );
  });

  it('treats a regular file named .devkit as no config rather than an unreadable one', () => {
    vi.stubEnv('DEVKIT_OVERLAY', '');
    const root = repo();
    writeFileSync(join(root, '.devkit'), 'not a directory\n');
    expect(overlayInstall(root)).toBe(false);
  });

  it('DEVKIT_OVERLAY=1 answers overlay without reading the config', () => {
    vi.stubEnv('DEVKIT_OVERLAY', '1');
    expect(overlayInstall(repo('{"overlay":tru'))).toBe(true);
  });
});
