import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectStack } from '../lib/detect-stack.mts';

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

  it('picks react-app when react is present (not next/electron)', () => {
    expect(detectStack(tmpRepo({ dependencies: { react: '^18', vite: '^5' } }))).toBe('react-app');
  });

  it('picks component-lib for a published lib with react as a PEER dep', () => {
    const root = tmpRepo({
      exports: { '.': './dist/index.js' },
      peerDependencies: { react: '>=18' },
      devDependencies: { react: '^19', typescript: '^5' },
    });
    expect(detectStack(root)).toBe('component-lib');
  });

  it('component-lib needs BOTH react-peer AND a package surface (else react-app)', () => {
    // react peer but no exports/main/module → an app being authored, not a published lib.
    expect(
      detectStack(
        tmpRepo({ peerDependencies: { react: '>=18' }, devDependencies: { react: '^19' } }),
      ),
    ).toBe('react-app');
    // exports but react is a normal dep (not peer) → a react app that happens to publish → react-app.
    expect(
      detectStack(tmpRepo({ exports: { '.': './i.js' }, dependencies: { react: '^18' } })),
    ).toBe('react-app');
  });

  it('next wins over react (next pulls react)', () => {
    expect(detectStack(tmpRepo({ dependencies: { react: '^18', next: '^14' } }))).toBe('next');
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
