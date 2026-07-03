import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEVKIT_CACHE_IGNORES,
  ensureDevkitCacheGitignore,
  pruneDevkitCacheGitignore,
} from '../lib/install/gitignore-cache.mjs';

const dirs = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'devkit-gi-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('ensureDevkitCacheGitignore', () => {
  it('appends every cache pattern when .gitignore is absent', () => {
    const d = tmp();
    ensureDevkitCacheGitignore(d, false);
    const gi = readFileSync(join(d, '.gitignore'), 'utf8');
    for (const line of DEVKIT_CACHE_IGNORES) expect(gi).toContain(line);
  });

  it('is idempotent, preserves existing lines, never duplicates', () => {
    const d = tmp();
    writeFileSync(join(d, '.gitignore'), 'node_modules\n');
    ensureDevkitCacheGitignore(d, false);
    const first = readFileSync(join(d, '.gitignore'), 'utf8');
    ensureDevkitCacheGitignore(d, false);
    const second = readFileSync(join(d, '.gitignore'), 'utf8');
    expect(second).toBe(first);
    expect(second).toContain('node_modules');
    for (const line of DEVKIT_CACHE_IGNORES) {
      expect(second.split('\n').filter((l) => l === line)).toHaveLength(1);
    }
  });

  it('dry-run writes nothing', () => {
    const d = tmp();
    ensureDevkitCacheGitignore(d, true);
    expect(existsSync(join(d, '.gitignore'))).toBe(false);
  });

  it('never blanket-ignores .devkit/ (tracked manifests + vendored configs stay tracked)', () => {
    const d = tmp();
    ensureDevkitCacheGitignore(d, false);
    const gi = readFileSync(join(d, '.gitignore'), 'utf8');
    expect(gi).not.toMatch(/^\.devkit\/?$/m);
    expect(gi).not.toContain('.devkit/agents-manifest.json');
    expect(gi).not.toContain('.devkit/skills-manifest.json');
  });
});

describe('pruneDevkitCacheGitignore', () => {
  it('removes every cache line and keeps the rest', () => {
    const d = tmp();
    writeFileSync(join(d, '.gitignore'), 'node_modules\n');
    ensureDevkitCacheGitignore(d, false);
    pruneDevkitCacheGitignore(d, false);
    const gi = readFileSync(join(d, '.gitignore'), 'utf8');
    expect(gi).toContain('node_modules');
    for (const line of DEVKIT_CACHE_IGNORES) expect(gi).not.toContain(line);
  });

  it('no-ops when .gitignore is absent', () => {
    const d = tmp();
    expect(() => pruneDevkitCacheGitignore(d, false)).not.toThrow();
    expect(existsSync(join(d, '.gitignore'))).toBe(false);
  });
});
