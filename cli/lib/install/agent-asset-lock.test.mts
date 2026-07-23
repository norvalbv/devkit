import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAgentAssetLifecycleLock } from './agent-asset-lock.mts';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-asset-lock-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('agent asset lifecycle lock', () => {
  it('supports synchronous re-entry and releases its own lock', () => {
    const root = tempRoot();
    const result = withAgentAssetLifecycleLock(root, false, () =>
      withAgentAssetLifecycleLock(root, false, () => 'complete'),
    );

    expect(result).toBe('complete');
    expect(existsSync(join(root, '.devkit/agent-assets.lock'))).toBe(false);
  });

  it('never steals an old lock whose owner may still be running', () => {
    const root = tempRoot();
    const lock = join(root, '.devkit/agent-assets.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'owner'), 'existing-owner');
    const old = new Date('2000-01-01T00:00:00.000Z');
    utimesSync(lock, old, old);

    expect(() => withAgentAssetLifecycleLock(root, false, () => undefined)).toThrow(
      'timed out acquiring agent asset lock',
    );
    expect(readFileSync(join(lock, 'owner'), 'utf8')).toBe('existing-owner');
  });

  it('does not remove a lock after its ownership token changes', () => {
    const root = tempRoot();
    const lock = join(root, '.devkit/agent-assets.lock');

    withAgentAssetLifecycleLock(root, false, () => {
      writeFileSync(join(lock, 'owner'), 'replacement-owner');
    });

    expect(readFileSync(join(lock, 'owner'), 'utf8')).toBe('replacement-owner');
  });

  it('does not create lifecycle state during a dry run', () => {
    const root = tempRoot();

    expect(withAgentAssetLifecycleLock(root, true, () => 'preview')).toBe('preview');
    expect(existsSync(join(root, '.devkit'))).toBe(false);
  });
});
