import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkOxcCapability, removeOxcCapability, syncOxcCapability } from './lifecycle.mts';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devkit-oxc-lifecycle-'));
  roots.push(root);
  return root;
}

async function runWhileOxcLockIsHeld(root: string, action: () => void): Promise<void> {
  const ready = join(root, '.devkit', 'lock-ready');
  const lock = join(root, '.devkit', 'oxc.lock');
  const script = `
    import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const lock = process.env.DEVKIT_TEST_LOCK;
    const ready = process.env.DEVKIT_TEST_READY;
    mkdirSync(lock);
    writeFileSync(join(lock, 'holder'), String(process.pid) + ':test');
    writeFileSync(ready, 'ready');
    await new Promise((resolve) => setTimeout(resolve, 300));
    rmSync(lock, { recursive: true, force: true });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    env: { ...process.env, DEVKIT_TEST_LOCK: lock, DEVKIT_TEST_READY: ready },
    stdio: 'inherit',
  });
  await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 2_000 });
  const started = Date.now();
  action();
  expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  if (child.exitCode !== null) {
    expect(child.exitCode).toBe(0);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`child exited ${code}`)),
    );
  });
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Oxc capability lifecycle', () => {
  it('creates pinned managed state and editable root starters idempotently', () => {
    const root = tempRoot();

    syncOxcCapability(root);
    const rootLint = join(root, '.oxlintrc.json');
    const before = readFileSync(rootLint, 'utf8');
    writeFileSync(rootLint, before.replace('"rules": {}', '"rules": { "no-debugger": "off" }'));
    syncOxcCapability(root);

    expect(readFileSync(rootLint, 'utf8')).toContain('"no-debugger": "off"');
    expect(readFileSync(join(root, '.devkit/oxc/oxlint.base.json'), 'utf8')).toBe(
      readFileSync(join(import.meta.dirname, '../../../../oxc/oxlint.base.json'), 'utf8'),
    );
    expect(JSON.parse(readFileSync(join(root, '.devkit/oxc/manifest.json'), 'utf8'))).toMatchObject(
      {
        schemaVersion: 1,
        pins: { oxlint: '1.78.0', oxfmt: '0.63.0' },
        configs: {
          oxlint: { path: '.oxlintrc.json' },
          oxfmt: { path: '.oxfmtrc.json' },
        },
      },
    );
    expect(checkOxcCapability(root).every((result) => result.status === 'OK')).toBe(true);
  });

  it('serializes lifecycle ownership updates with the Oxc manifest lock', async () => {
    const root = tempRoot();
    syncOxcCapability(root);

    await runWhileOxcLockIsHeld(root, () => syncOxcCapability(root));
    rmSync(join(root, '.devkit', 'lock-ready'));
    await runWhileOxcLockIsHeld(root, () => removeOxcCapability(root));

    expect(existsSync(join(root, '.devkit/oxc.lock'))).toBe(false);
    expect(existsSync(join(root, '.devkit/oxc'))).toBe(false);
  });

  it('adopts existing supported config names without changing or later deleting them', () => {
    const root = tempRoot();
    const lint = 'export default { rules: { eqeqeq: "error" } };\n';
    const fmt = '{ /* local */ "printWidth": 92 }\n';
    writeFileSync(join(root, 'oxlint.config.ts'), lint);
    writeFileSync(join(root, '.oxfmtrc.jsonc'), fmt);

    syncOxcCapability(root);
    removeOxcCapability(root);

    expect(readFileSync(join(root, 'oxlint.config.ts'), 'utf8')).toBe(lint);
    expect(readFileSync(join(root, '.oxfmtrc.jsonc'), 'utf8')).toBe(fmt);
    expect(existsSync(join(root, '.devkit/oxc'))).toBe(false);
  });

  it('removes unchanged starters but preserves a customized starter', () => {
    const root = tempRoot();
    syncOxcCapability(root);
    writeFileSync(join(root, '.oxlintrc.json'), '{ "rules": { "no-debugger": "off" } }\n');

    removeOxcCapability(root);

    expect(existsSync(join(root, '.oxlintrc.json'))).toBe(true);
    expect(existsSync(join(root, '.oxfmtrc.json'))).toBe(false);
    expect(existsSync(join(root, '.devkit/oxc'))).toBe(false);
  });

  it('fails safely when more than one config for a tool exists', () => {
    const root = tempRoot();
    writeFileSync(join(root, '.oxlintrc.json'), '{}\n');
    writeFileSync(join(root, 'oxlint.config.ts'), 'export default {};\n');

    expect(() => syncOxcCapability(root)).toThrow(
      'multiple Oxc configs in one directory: .oxlintrc.json, oxlint.config.ts',
    );
    expect(existsSync(join(root, '.devkit/oxc/manifest.json'))).toBe(false);
  });

  it('preflights both tools before creating either starter', () => {
    const root = tempRoot();
    writeFileSync(join(root, '.oxfmtrc.json'), '{}\n');
    writeFileSync(join(root, 'oxfmt.config.ts'), 'export default {};\n');

    expect(() => syncOxcCapability(root)).toThrow(
      'multiple Oxc configs in one directory: .oxfmtrc.json, oxfmt.config.ts',
    );
    expect(existsSync(join(root, '.oxlintrc.json'))).toBe(false);
    expect(existsSync(join(root, '.devkit/oxc/manifest.json'))).toBe(false);
  });

  it('does not orphan root starters when managed state cannot be created', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.devkit/oxc/manifest.json'), { recursive: true });

    expect(() => syncOxcCapability(root)).toThrow();

    expect(existsSync(join(root, '.oxlintrc.json'))).toBe(false);
    expect(existsSync(join(root, '.oxfmtrc.json'))).toBe(false);
    expect(existsSync(join(root, '.devkit/oxc.lock'))).toBe(false);
  });

  it('treats an incomplete manifest as missing and cleans managed state conservatively', () => {
    const root = tempRoot();
    syncOxcCapability(root);
    writeFileSync(join(root, '.devkit/oxc/manifest.json'), '{ "schemaVersion": 1 }\n');

    expect(checkOxcCapability(root)[0]).toMatchObject({
      name: 'Oxc manifest',
      status: 'MISSING',
    });
    removeOxcCapability(root);

    expect(existsSync(join(root, '.oxlintrc.json'))).toBe(true);
    expect(existsSync(join(root, '.oxfmtrc.json'))).toBe(true);
    expect(existsSync(join(root, '.devkit/oxc'))).toBe(false);
  });
});
