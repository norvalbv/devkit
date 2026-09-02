import { execFileSync } from 'node:child_process';
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
import {
  checkDevkitCacheGitignore,
  DEVKIT_CACHE_IGNORES,
  DEVKIT_TRACKED_UNIGNORES,
  ensureDevkitCacheGitignore,
  missingDevkitCacheIgnores,
  pruneDevkitCacheGitignore,
  repairDevkitCacheGitignore,
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
    expect(DEVKIT_CACHE_IGNORES).toContain('.devkit/anti-slop-baseline-upgrade.json');
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
      '.devkit/baselines/imports.mjs',
      '.devkit/baselines/structure/renderer.mjs',
      '.devkit/structure/exempt.mjs',
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

  it('removes a .devkit/ that existed only for its lock, and keeps one that was already there', () => {
    const d = tmp();
    writeFileSync(join(d, '.gitignore'), 'node_modules\n');
    ensureDevkitCacheGitignore(d, false);
    expect(existsSync(join(d, '.devkit'))).toBe(false); // created for the lock, gone with it
    mkdirSync(join(d, '.devkit'), { recursive: true });
    pruneDevkitCacheGitignore(d, false);
    expect(existsSync(join(d, '.devkit'))).toBe(true); // was there before: not ours to remove
  });

  it('writes under the shared .gitignore lock, so it cannot interleave with a repair', () => {
    const d = tmp();
    writeFileSync(join(d, '.gitignore'), 'node_modules\n');
    ensureDevkitCacheGitignore(d, false);
    mkdirSync(join(d, '.devkit'), { recursive: true });
    writeFileSync(join(d, '.devkit', 'gitignore.lock'), String(process.pid)); // a live holder
    expect(() => pruneDevkitCacheGitignore(d, false)).toThrow(/held by another devkit process/);
    expect(readFileSync(join(d, '.gitignore'), 'utf8')).toContain(DEVKIT_CACHE_IGNORES[0]); // untouched
  });
});

// sc-2333: a consumer whose .gitignore predates a managed rule (qavis lacked `.devkit/ship-intent-*`)
// only learned of it from ship's inline warning, after the invocation had already gone unrecorded.
describe('checkDevkitCacheGitignore', () => {
  const gitRepo = () => {
    const d = tmp();
    execFileSync('git', ['init', '-q', d]);
    return d;
  };

  it('reports DRIFT naming each rule Git does not honour, and is fixable', () => {
    const d = gitRepo();
    writeFileSync(join(d, '.gitignore'), 'node_modules\n.devkit/prefix-cache.json\n');
    const missing = missingDevkitCacheIgnores(d);
    expect(missing).toContain('.devkit/ship-intent-*');
    expect(missing).not.toContain('.devkit/prefix-cache.json');
    const result = checkDevkitCacheGitignore(d);
    expect(result.status).toBe('DRIFT');
    expect(result.fixable).toBe(true);
    expect(result.detail).toContain('.devkit/ship-intent-*');
    expect(result.remediation).toContain('devkit doctor --fix');
  });

  it('asks Git, not the text: a whitespace-mangled or later-negated rule is still missing', () => {
    const d = gitRepo();
    writeFileSync(
      join(d, '.gitignore'),
      ' .devkit/ship-intent-*\n.devkit/telemetry/\n!.devkit/telemetry/\n',
    );
    const missing = missingDevkitCacheIgnores(d);
    expect(missing).toContain('.devkit/ship-intent-*');
    expect(missing).toContain('.devkit/telemetry/');
  });

  it('--fix converges on a defeated rule: re-asserted at the tail, where last-match wins', () => {
    const d = gitRepo();
    writeFileSync(
      join(d, '.gitignore'),
      ' .devkit/ship-intent-*\n.devkit/telemetry/\n!.devkit/telemetry/\n',
    );
    const before = checkDevkitCacheGitignore(d);
    expect(before.status).toBe('DRIFT');
    repairDevkitCacheGitignore(d, [before]);
    expect(missingDevkitCacheIgnores(d)).toEqual([]);
    expect(checkDevkitCacheGitignore(d).status).toBe('OK');
    // Idempotent: a second repair on an OK row writes nothing.
    const text = readFileSync(join(d, '.gitignore'), 'utf8');
    repairDevkitCacheGitignore(d, [checkDevkitCacheGitignore(d)]);
    expect(readFileSync(join(d, '.gitignore'), 'utf8')).toBe(text);
  });

  it('waits behind a live devkit writer holding the .gitignore lock, and releases its own', () => {
    const d = gitRepo();
    mkdirSync(join(d, '.devkit'), { recursive: true });
    writeFileSync(join(d, '.devkit', 'gitignore.lock'), String(process.pid)); // a live holder
    expect(() => ensureDevkitCacheGitignore(d, false)).toThrow(/held by another devkit process/);
    expect(existsSync(join(d, '.gitignore'))).toBe(false); // nothing written under contention
    rmSync(join(d, '.devkit', 'gitignore.lock'));
    ensureDevkitCacheGitignore(d, false);
    expect(existsSync(join(d, '.devkit', 'gitignore.lock'))).toBe(false); // released
    expect(checkDevkitCacheGitignore(d).status).toBe('OK');
  });

  it('names a dead holder instead of reclaiming its lock (no lock-free reclaim is race-free), and waits on a live one', () => {
    const d = gitRepo();
    mkdirSync(join(d, '.devkit'), { recursive: true });
    const lock = join(d, '.devkit', 'gitignore.lock');
    writeFileSync(lock, '999999999'); // no such pid
    expect(() => ensureDevkitCacheGitignore(d, false)).toThrow(
      /held by pid 999999999, which no longer exists — remove the file/,
    );
    expect(existsSync(lock)).toBe(true); // never removed on the operator's behalf
    expect(existsSync(join(d, '.gitignore'))).toBe(false);
    writeFileSync(lock, String(process.pid)); // a live holder, however old the file
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, old, old);
    expect(() => ensureDevkitCacheGitignore(d, false)).toThrow(/held by another devkit process/);
    writeFileSync(lock, 'not a pid'); // unreadable owner: treated as held
    expect(() => ensureDevkitCacheGitignore(d, false)).toThrow(/held by another devkit process/);
    rmSync(lock);
    ensureDevkitCacheGitignore(d, false);
    expect(existsSync(lock)).toBe(false); // released after the write
    expect(checkDevkitCacheGitignore(d).status).toBe('OK');
  });

  it('is OK once ensure has run, so check and repair converge', () => {
    const d = gitRepo();
    expect(checkDevkitCacheGitignore(d).status).toBe('DRIFT');
    ensureDevkitCacheGitignore(d, false);
    expect(missingDevkitCacheIgnores(d)).toEqual([]);
    expect(checkDevkitCacheGitignore(d).status).toBe('OK');
  });

  it('falls back to exact, untrimmed lines when Git cannot answer (not a repository), and --fix converges there too', () => {
    const d = tmp();
    expect(checkDevkitCacheGitignore(d).status).toBe('DRIFT');
    ensureDevkitCacheGitignore(d, false);
    expect(checkDevkitCacheGitignore(d).status).toBe('OK');
    writeFileSync(join(d, '.gitignore'), ' .devkit/ship-intent-*\n');
    const mangled = checkDevkitCacheGitignore(d);
    expect(mangled.detail).toContain('.devkit/ship-intent-*');
    repairDevkitCacheGitignore(d, [mangled]);
    expect(checkDevkitCacheGitignore(d).status).toBe('OK');
  });

  it('reads check-ignore with -z, so a colon in an excludes-file path cannot hide a negation', () => {
    const d = gitRepo();
    const excludes = join(d, 'team:ignore');
    writeFileSync(excludes, '!.devkit/telemetry/\n');
    writeFileSync(join(d, '.gitignore'), '.devkit/telemetry/\n');
    execFileSync('git', ['-C', d, 'config', 'core.excludesFile', excludes]);
    // .gitignore's positive rule wins over the excludes file, so telemetry IS ignored here;
    // the point is that the -z parse must not throw or misread the colon-bearing source.
    expect(missingDevkitCacheIgnores(d)).not.toContain('.devkit/telemetry/');
    writeFileSync(join(d, '.gitignore'), '');
    execFileSync('git', ['-C', d, 'config', 'core.excludesFile', excludes]);
    expect(missingDevkitCacheIgnores(d)).toContain('.devkit/telemetry/');
  });
});
