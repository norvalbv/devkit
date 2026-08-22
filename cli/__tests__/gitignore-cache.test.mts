import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEVKIT_CACHE_IGNORES,
  DEVKIT_TRACKED_UNIGNORES,
  ensureDevkitCacheGitignore,
  pruneDevkitCacheGitignore,
} from '../lib/install/gitignore-cache.mts';

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
  it('manages the review run directory without ignoring tracked devkit state', () => {
    expect(DEVKIT_CACHE_IGNORES).toContain('.devkit/review-runs/');
    expect(DEVKIT_CACHE_IGNORES).toContain('.devkit/comment-firewall-receipts.json');
    expect(DEVKIT_CACHE_IGNORES).not.toContain('.devkit/comment-firewall-rationales.json');
    expect(DEVKIT_TRACKED_UNIGNORES).not.toContain('!.devkit/comment-firewall-rationales.json');
    expect(DEVKIT_CACHE_IGNORES).not.toContain('.devkit/');
  });

  it('appends every generated-state rule when .gitignore is absent', () => {
    const d = tmp();
    ensureDevkitCacheGitignore(d, false);
    const gi = readFileSync(join(d, '.gitignore'), 'utf8');
    for (const line of DEVKIT_CACHE_IGNORES) expect(gi).toContain(line);
    for (const line of DEVKIT_TRACKED_UNIGNORES) expect(gi).toContain(line);
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
    for (const line of [...DEVKIT_CACHE_IGNORES, ...DEVKIT_TRACKED_UNIGNORES]) {
      expect(second.split('\n').filter((l) => l === line)).toHaveLength(1);
    }
  });

  it('moves tracked-state negations after a later broad ignore rule', () => {
    const d = tmp();
    const tracked = DEVKIT_TRACKED_UNIGNORES[0];
    writeFileSync(join(d, '.gitignore'), `${tracked}\n.devkit/*\n`);

    ensureDevkitCacheGitignore(d, false);

    const lines = readFileSync(join(d, '.gitignore'), 'utf8').trimEnd().split('\n');
    expect(lines.slice(-DEVKIT_TRACKED_UNIGNORES.length)).toEqual(DEVKIT_TRACKED_UNIGNORES);
    expect(lines.filter((line) => line === tracked)).toHaveLength(1);
  });

  it('makes canonical baselines trackable beneath a blanket .devkit ignore', () => {
    const d = tmp();
    execFileSync('git', ['init', '-q'], { cwd: d });
    writeFileSync(join(d, '.gitignore'), '.devkit/\n');

    ensureDevkitCacheGitignore(d, false);

    expect(() =>
      execFileSync(
        'git',
        ['check-ignore', '-q', '--no-index', '.devkit/baselines/size-lines.json'],
        { cwd: d },
      ),
    ).toThrow();
    expect(() =>
      execFileSync('git', ['check-ignore', '-q', '--no-index', '.devkit/telemetry/events.jsonl'], {
        cwd: d,
      }),
    ).not.toThrow();
    for (const tracked of [
      '.devkit/config.json',
      '.devkit/skills-manifest.json',
      '.devkit/agents-manifest.json',
      '.devkit/agent-hooks-manifest.json',
      '.devkit/biome/base.jsonc',
      '.devkit/tsconfig/base.json',
      '.devkit/anti-slop/manifest.json',
      '.devkit/oxc/manifest.json',
      '.devkit/vendored-skills/i-have-adhd/SKILL.md',
    ]) {
      expect(() =>
        execFileSync('git', ['check-ignore', '-q', '--no-index', tracked], { cwd: d }),
      ).toThrow();
    }
    for (const local of [
      '.devkit/correctness-overrides.json',
      '.devkit/comment-firewall-rationales.json',
      '.devkit/hooks/pre-commit',
    ]) {
      expect(() =>
        execFileSync('git', ['check-ignore', '-q', '--no-index', local], { cwd: d }),
      ).not.toThrow();
    }
  });

  it('removes the obsolete tracked-rationale exception during upgrade', () => {
    const d = tmp();
    writeFileSync(join(d, '.gitignore'), '!.devkit/comment-firewall-rationales.json\n');
    ensureDevkitCacheGitignore(d, false);
    expect(readFileSync(join(d, '.gitignore'), 'utf8')).not.toContain(
      '!.devkit/comment-firewall-rationales.json',
    );
  });

  it('dry-run writes nothing', () => {
    const d = tmp();
    ensureDevkitCacheGitignore(d, true);
    expect(existsSync(join(d, '.gitignore'))).toBe(false);
  });

  it('ignores local children while explicitly preserving durable tracked state', () => {
    const d = tmp();
    ensureDevkitCacheGitignore(d, false);
    const gi = readFileSync(join(d, '.gitignore'), 'utf8');
    expect(gi).not.toMatch(/^\.devkit\/?$/m);
    expect(gi).toContain('.devkit/*');
    expect(gi).toContain('!.devkit/agents-manifest.json');
    expect(gi).toContain('!.devkit/skills-manifest.json');
    expect(gi).toContain('!.devkit/agent-hook-registrations-manifest.json');
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
    for (const line of [...DEVKIT_CACHE_IGNORES, ...DEVKIT_TRACKED_UNIGNORES])
      expect(gi).not.toContain(line);
  });

  it('no-ops when .gitignore is absent', () => {
    const d = tmp();
    expect(() => pruneDevkitCacheGitignore(d, false)).not.toThrow();
    expect(existsSync(join(d, '.gitignore'))).toBe(false);
  });
});
