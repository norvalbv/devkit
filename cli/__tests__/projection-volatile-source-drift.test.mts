import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  materializeProjectionRuntime,
  verifyProjectionRuntime,
} from '../lib/ship/review/projection/runtime.mts';
import { rootRegistry } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();

afterEach(cleanup);

const INDEX = '.search-code/index.db';
const CANDIDATES = [
  INDEX,
  '.fallow',
  '.decisions',
  '.devkit/baselines/size.json',
  'fallow-baselines',
  'guard.config.json',
];

function write(root: string, path: string, content: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
}

function capturedTarget(linkIndexTo?: string) {
  const parent = mkTmp('volatile projection-');
  const root = join(parent, 'target repo');
  const worktree = join(parent, 'review worktree');
  mkdirSync(root);
  mkdirSync(worktree);
  execFileSync('git', ['init', '-q', root]);
  if (linkIndexTo) {
    mkdirSync(join(root, '.search-code'));
    symlinkSync(linkIndexTo, join(root, INDEX));
  } else {
    write(root, INDEX, 'sqlite-main');
  }
  write(root, `${INDEX}-shm`, 'wal-index');
  write(root, '.fallow/cache.json', '{}\n');
  write(root, '.decisions/index.json', '{}\n');
  write(root, '.devkit/baselines/size.json', '{"frozen":1}\n');
  write(root, 'fallow-baselines/x.json', '{"frozen":1}\n');
  write(root, 'guard.config.json', '{}\n');
  const manifest = join(parent, 'projection-runtime.json');
  materializeProjectionRuntime(root, worktree, manifest, CANDIDATES, INDEX);
  const verify = () => verifyProjectionRuntime(root, worktree, manifest);
  return { parent, root, worktree, manifest, verify };
}

describe('review projection: volatile cache sources may churn after capture', () => {
  it('keeps the verdict when the live SQLite index and pure caches change bytes', () => {
    const { root, verify } = capturedTarget();
    appendFileSync(join(root, `${INDEX}-shm`), 'reader-touched');
    write(root, `${INDEX}-wal`, 'new-frames');
    write(root, '.fallow/cache.json', '{"rebuilt":true}\n');
    write(root, '.decisions/index.json', '{"rebuilt":true}\n');
    expect(verify).not.toThrow();
  });

  it('keeps the verdict when a linked index target is rewritten', () => {
    const parent = mkTmp('volatile external-');
    const external = join(parent, 'index.db');
    writeFileSync(external, 'sqlite-main');
    const { verify } = capturedTarget(external);
    writeFileSync(external, 'sqlite-reindexed');
    expect(verify).not.toThrow();
  });

  it.each(['.devkit/baselines/size.json', 'fallow-baselines/x.json', 'guard.config.json'])(
    'still discards the verdict when verdict-defining input %s changes',
    (path) => {
      const { root, verify } = capturedTarget();
      write(root, path, '{"loosened":true}\n');
      expect(verify).toThrow(/target gate projection changed while review was running/);
    },
  );

  it('still rejects a nested symlink planted in a private cache copy', () => {
    const { parent, worktree, verify } = capturedTarget();
    const outside = join(parent, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(worktree, '.fallow', 'unsafe'));
    expect(verify).toThrow(/nested symlink/);
  });

  it('authenticates the volatility flag through the manifest self-hash', () => {
    const { manifest, verify } = capturedTarget();
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    const entry = parsed.entries.find(
      (item: { path: string }) => item.path === 'guard.config.json',
    );
    expect(entry.sourceVolatile).toBe(false);
    entry.sourceVolatile = true;
    writeFileSync(manifest, JSON.stringify(parsed));
    expect(verify).toThrow(/self-hash is invalid/);
  });
});
