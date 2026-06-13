import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectStack } from '../lib/detect-stack.mjs';

let roots = [];
function tmpRepo(pkg) {
  const root = mkdtempSync(join(tmpdir(), 'detect-'));
  roots.push(root);
  if (pkg !== undefined) writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
  return root;
}
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

describe('detectStack', () => {
  it('picks electron when electron (or electron-vite) is a dep', () => {
    expect(detectStack(tmpRepo({ devDependencies: { electron: '^30' } }))).toBe('electron');
    expect(detectStack(tmpRepo({ devDependencies: { 'electron-vite': '^2' } }))).toBe('electron');
  });

  it('electron wins over react (an electron app also pulls react)', () => {
    const root = tmpRepo({ dependencies: { react: '^18' }, devDependencies: { electron: '^30' } });
    expect(detectStack(root)).toBe('electron');
  });

  it('picks next when next is a dep', () => {
    expect(detectStack(tmpRepo({ dependencies: { next: '^14' } }))).toBe('next');
  });

  it('picks node-service for a headless ESM package (no frontend framework)', () => {
    expect(detectStack(tmpRepo({ type: 'module', dependencies: { express: '^4' } }))).toBe(
      'node-service',
    );
  });

  it('a frontend framework rules OUT node-service → generic', () => {
    expect(detectStack(tmpRepo({ type: 'module', dependencies: { vue: '^3' } }))).toBe('generic');
  });

  it('falls back to generic with no package.json or no signal', () => {
    expect(detectStack(tmpRepo(undefined))).toBe('generic');
    expect(detectStack(tmpRepo({ dependencies: { lodash: '^4' } }))).toBe('generic');
  });
});
