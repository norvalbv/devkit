import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FANOUT_BASELINE,
  IMPORT_WALL_BASELINE,
  LINES_BASELINE,
  migrateRatchetBaselines,
  readRatchetBaseline,
  removeRatchetBaseline,
  SIZE_BASELINE,
  STRUCTURE_BASELINE_DIR,
  STRUCTURE_EXEMPT,
  writeRatchetBaseline,
} from '../baseline-paths.mts';

// Retired legacy pathname, still recognised by init/upgrade migration (sc-2256).
const LEGACY_LINES_BASELINE = 'eslint/baselines/size-lines.json';

let roots: string[] = [];

function denyHardLink(code: 'EXDEV' | 'EPERM'): () => never {
  return () => {
    throw Object.assign(new Error('forced link failure'), { code });
  };
}

function completeMigrationBeforeCreate(contents: string): (path: string) => never {
  return (path) => {
    writeFileSync(path, contents);
    throw Object.assign(new Error('peer already created baseline'), { code: 'EEXIST' });
  };
}

function completeModuleMigrationBeforeCreate(
  legacyFile: string,
  contents: string,
): (path: string) => never {
  return (path) => {
    writeFileSync(path, contents);
    rmSync(legacyFile);
    throw Object.assign(new Error('peer already moved module baseline'), { code: 'EEXIST' });
  };
}

function completePartialMigrationAfterDelay(contents: string): (path: string) => never {
  return (path) => {
    writeFileSync(path, '{"files":');
    spawn(
      process.execPath,
      [
        '-e',
        `setTimeout(() => require('node:fs').writeFileSync(process.argv[1], ${JSON.stringify(contents)}), 10)`,
        path,
      ],
      { stdio: 'ignore' },
    );
    throw Object.assign(new Error('peer is still creating baseline'), { code: 'EEXIST' });
  };
}

function replaceLegacyThenDeny(contents: string): (source: string) => never {
  return (source) => {
    writeFileSync(source, contents);
    throw Object.assign(new Error('forced link failure'), { code: 'EXDEV' });
  };
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ratchet-baselines-'));
  roots.push(root);
  return root;
}

function write(root: string, relativePath: string, contents: string): void {
  const file = join(root, relativePath);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, contents);
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe('ratchet baseline paths', () => {
  it('keeps engine-neutral ratchets under .devkit', () => {
    expect([FANOUT_BASELINE, LINES_BASELINE, SIZE_BASELINE]).toEqual([
      '.devkit/baselines/fanout.json',
      '.devkit/baselines/size-lines.json',
      '.devkit/baselines/size.json',
    ]);
  });

  it('reads only the canonical baseline (the legacy generation is retired)', () => {
    const root = makeRoot();
    expect(readRatchetBaseline(root, LINES_BASELINE)).toBeNull();
    write(root, 'eslint/baselines/size-lines.json', '{"files":{}}\n');
    expect(readRatchetBaseline(root, LINES_BASELINE)).toBeNull();
    write(root, LINES_BASELINE, '{"files":{}}\n');
    expect(readRatchetBaseline(root, LINES_BASELINE)?.relativePath).toBe(LINES_BASELINE);
  });

  it('a canonical write or clear discards a stale retired copy so migration cannot resurrect it', () => {
    const root = makeRoot();
    write(root, '.devkit/config.json', '{"overlay":true}\n');
    write(root, LEGACY_LINES_BASELINE, '{"files":{"src/legacy.ts":80}}\n');

    writeRatchetBaseline(root, LINES_BASELINE, '{"files":{"src/legacy.ts":70}}\n');
    expect(existsSync(join(root, LEGACY_LINES_BASELINE))).toBe(false);
    expect(migrateRatchetBaselines(root, { dryRun: true })).toEqual([]);

    write(root, LEGACY_LINES_BASELINE, '{"files":{"src/legacy.ts":80}}\n');
    removeRatchetBaseline(root, LINES_BASELINE);
    expect(existsSync(join(root, LEGACY_LINES_BASELINE))).toBe(false);
    expect(migrateRatchetBaselines(root, { dryRun: true })).toEqual([]);
  });

  it('spares a TRACKED retired copy on an overlay install, leaving it for the next full install', () => {
    const root = makeRoot();
    execFileSync('git', ['init', '-q'], { cwd: root });
    write(root, '.devkit/config.json', '{"overlay":true}\n');
    write(root, LEGACY_LINES_BASELINE, '{"files":{"src/legacy.ts":80}}\n');
    execFileSync('git', ['add', '--', LEGACY_LINES_BASELINE], { cwd: root });

    // Overlay hides its files through .git/info/exclude, which cannot hide a deletion: removing a
    // tracked path would dirty the very tree an overlay install promises not to touch.
    removeRatchetBaseline(root, LINES_BASELINE);
    expect(readFileSync(join(root, LEGACY_LINES_BASELINE), 'utf8')).toBe(
      '{"files":{"src/legacy.ts":80}}\n',
    );
    expect(existsSync(join(root, LINES_BASELINE))).toBe(false);
    // The committed ceiling outlives the overlay's local clear, so a later full install adopts it.
    expect(migrateRatchetBaselines(root, { dryRun: true })).toEqual([
      { from: LEGACY_LINES_BASELINE, kind: 'moved', to: LINES_BASELINE },
    ]);

    // A local overlay write cannot silently overwrite it either: divergent ceilings stop migration.
    writeRatchetBaseline(root, LINES_BASELINE, '{"files":{"src/legacy.ts":70}}\n');
    expect(existsSync(join(root, LEGACY_LINES_BASELINE))).toBe(true);
    expect(() => migrateRatchetBaselines(root)).toThrow(/different contents/);
  });

  it('an overlay write spares a tracked retired copy still hard-linked by an interrupted migration', () => {
    const root = makeRoot();
    execFileSync('git', ['init', '-q'], { cwd: root });
    write(root, '.devkit/config.json', '{"overlay":true}\n');
    write(root, LEGACY_LINES_BASELINE, '{"files":{"src/legacy.ts":80}}\n');
    execFileSync('git', ['add', '--', LEGACY_LINES_BASELINE], { cwd: root });
    // migrateRatchetBaselines links canonical to legacy before unlinking legacy; an interrupt
    // between the two leaves both names on one inode, which a truncating write would rewrite.
    mkdirSync(join(root, '.devkit/baselines'), { recursive: true });
    linkSync(join(root, LEGACY_LINES_BASELINE), join(root, LINES_BASELINE));

    writeRatchetBaseline(root, LINES_BASELINE, '{"files":{"src/legacy.ts":70}}\n');

    expect(readFileSync(join(root, LEGACY_LINES_BASELINE), 'utf8')).toBe(
      '{"files":{"src/legacy.ts":80}}\n',
    );
    expect(readFileSync(join(root, LINES_BASELINE), 'utf8')).toBe(
      '{"files":{"src/legacy.ts":70}}\n',
    );
  });

  it('writes through a per-file baseline symlink the ship worktree projects', () => {
    const root = makeRoot();
    const primary = makeRoot();
    const real = join(primary, 'size-lines.json');
    writeFileSync(real, '{"files":{"src/a.ts":9}}\n');
    mkdirSync(join(root, '.devkit/baselines'), { recursive: true });
    // link-gate-configs.sh projects each baseline as its OWN symlink, and the write has to reach
    // the primary checkout's file (git-index.mts) rather than replace the link.
    symlinkSync(real, join(root, LINES_BASELINE));

    writeRatchetBaseline(root, LINES_BASELINE, '{"files":{"src/a.ts":7}}\n');

    expect(lstatSync(join(root, LINES_BASELINE)).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toBe('{"files":{"src/a.ts":7}}\n');
  });

  it('moves legacy ratchets byte-for-byte and is idempotent', () => {
    const root = makeRoot();
    const bytes = '{"files":{"src/legacy.ts":731}}\n';
    write(root, 'eslint/baselines/size-lines.json', bytes);

    expect(migrateRatchetBaselines(root)).toEqual([
      {
        from: 'eslint/baselines/size-lines.json',
        kind: 'moved',
        to: LINES_BASELINE,
      },
    ]);
    expect(readFileSync(join(root, LINES_BASELINE), 'utf8')).toBe(bytes);
    expect(existsSync(join(root, 'eslint/baselines/size-lines.json'))).toBe(false);
    expect(migrateRatchetBaselines(root)).toEqual([]);
  });

  it('moves ESLint-hosted structure debt and permanent exemptions under Devkit ownership', () => {
    const root = makeRoot();
    const tree = 'export const rendererStructureBaseline = ["legacy.ts"]\n';
    const imports = 'export const rendererImportWallBaseline = []\n';
    const exempt = 'export const structureExempt = { renderer: ["vendored.ts"] }\n';
    write(root, 'eslint/baselines/renderer.mjs', tree);
    write(root, 'eslint/baselines/imports.mjs', imports);
    write(root, 'eslint/baselines/exempt.mjs', exempt);

    expect(migrateRatchetBaselines(root)).toEqual([
      { from: 'eslint/baselines/imports.mjs', kind: 'moved', to: IMPORT_WALL_BASELINE },
      { from: 'eslint/baselines/exempt.mjs', kind: 'moved', to: STRUCTURE_EXEMPT },
      {
        from: 'eslint/baselines/renderer.mjs',
        kind: 'moved',
        to: `${STRUCTURE_BASELINE_DIR}/renderer.mjs`,
      },
    ]);
    expect(readFileSync(join(root, IMPORT_WALL_BASELINE), 'utf8')).toBe(imports);
    expect(readFileSync(join(root, STRUCTURE_EXEMPT), 'utf8')).toBe(exempt);
    expect(readFileSync(join(root, STRUCTURE_BASELINE_DIR, 'renderer.mjs'), 'utf8')).toBe(tree);
  });

  it('removes a token-equivalent MJS duplicate with different comments and formatting', () => {
    const root = makeRoot();
    write(
      root,
      'eslint/baselines/renderer.mjs',
      '// old generated header\nexport const rendererStructureBaseline=["legacy.ts"];\n',
    );
    write(
      root,
      `${STRUCTURE_BASELINE_DIR}/renderer.mjs`,
      '// new generated header\nexport const rendererStructureBaseline = [\n  "legacy.ts"\n];\n',
    );

    expect(migrateRatchetBaselines(root)).toEqual([
      {
        from: 'eslint/baselines/renderer.mjs',
        kind: 'removed-duplicate',
        to: `${STRUCTURE_BASELINE_DIR}/renderer.mjs`,
      },
    ]);
    expect(existsSync(join(root, 'eslint/baselines/renderer.mjs'))).toBe(false);
  });

  it('stages both sides of a tracked baseline move', () => {
    const root = makeRoot();
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    write(root, LEGACY_LINES_BASELINE, '{"files":{"src/legacy.ts":731}}\n');
    execFileSync('git', ['add', LEGACY_LINES_BASELINE], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'legacy baseline'], { cwd: root });

    migrateRatchetBaselines(root);

    const staged = execFileSync('git', ['diff', '--cached', '--name-status'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(staged).toContain(LEGACY_LINES_BASELINE);
    expect(staged).toContain(LINES_BASELINE);
  });

  it('stops before deleting tracked debt when the canonical baseline is ignored', () => {
    const root = makeRoot();
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    write(root, '.gitignore', '.devkit/\n');
    write(root, LEGACY_LINES_BASELINE, '{"files":{"src/legacy.ts":731}}\n');
    execFileSync('git', ['add', '.gitignore', LEGACY_LINES_BASELINE], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'legacy baseline'], { cwd: root });

    expect(() => migrateRatchetBaselines(root)).toThrow(`${LINES_BASELINE} is ignored by Git`);
    expect(existsSync(join(root, LEGACY_LINES_BASELINE))).toBe(true);
    expect(existsSync(join(root, LINES_BASELINE))).toBe(false);
    expect(
      execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }),
    ).toBe('');
  });

  it('stops a package gate write when the canonical baseline is ignored', () => {
    const root = makeRoot();
    execFileSync('git', ['init', '-q'], { cwd: root });
    write(root, '.gitignore', '.devkit/\n');

    expect(() =>
      writeRatchetBaseline(root, LINES_BASELINE, '{"files":{"src/legacy.ts":70}}\n'),
    ).toThrow(`${LINES_BASELINE} is ignored by Git`);
    expect(existsSync(join(root, LINES_BASELINE))).toBe(false);
  });

  it('keeps ignored canonical writes available to deliberately untracked overlay mode', () => {
    const root = makeRoot();
    execFileSync('git', ['init', '-q'], { cwd: root });
    write(root, '.gitignore', '.devkit/\n');
    write(root, '.devkit/config.json', '{"overlay":true}\n');

    writeRatchetBaseline(root, LINES_BASELINE, '{"files":{"src/legacy.ts":70}}\n');

    expect(readFileSync(join(root, LINES_BASELINE), 'utf8')).toContain('70');
  });

  it('copies legacy debt during migration when hard links are not permitted', () => {
    const root = makeRoot();
    const bytes = '{"files":{"src/legacy.ts":80}}\n';
    const concurrentBytes = '{"files":{"src/legacy.ts":70}}\n';
    write(root, LEGACY_LINES_BASELINE, bytes);
    expect(migrateRatchetBaselines(root, { link: replaceLegacyThenDeny(concurrentBytes) })).toEqual(
      [{ from: LEGACY_LINES_BASELINE, kind: 'moved', to: LINES_BASELINE }],
    );
    expect(readFileSync(join(root, LINES_BASELINE), 'utf8')).toBe(concurrentBytes);
    expect(existsSync(join(root, LEGACY_LINES_BASELINE))).toBe(false);
  });

  it('accepts a matching migration completed by a peer before exclusive creation', () => {
    const root = makeRoot();
    const bytes = '{"files":{"src/legacy.ts":80}}\n';
    write(root, LEGACY_LINES_BASELINE, bytes);
    expect(
      migrateRatchetBaselines(root, {
        link: denyHardLink('EXDEV'),
        create: completeMigrationBeforeCreate(bytes),
      }),
    ).toHaveLength(1);
    expect(readFileSync(join(root, LINES_BASELINE), 'utf8')).toBe(bytes);
  });

  it('accepts a matching MJS migration after a peer removes the legacy name', () => {
    const root = makeRoot();
    const bytes = 'export const rendererImportWallBaseline = ["legacy.ts"]\n';
    write(root, 'eslint/baselines/imports.mjs', bytes);

    expect(
      migrateRatchetBaselines(root, {
        link: denyHardLink('EXDEV'),
        create: completeModuleMigrationBeforeCreate(
          join(root, 'eslint/baselines/imports.mjs'),
          bytes,
        ),
      }),
    ).toHaveLength(1);
    expect(readFileSync(join(root, IMPORT_WALL_BASELINE), 'utf8')).toBe(bytes);
  });

  it('waits for a peer to finish writing an exclusively created baseline', () => {
    const root = makeRoot();
    const bytes = '{"files":{"src/legacy.ts":80}}\n';
    write(root, LEGACY_LINES_BASELINE, bytes);
    expect(
      migrateRatchetBaselines(root, {
        link: denyHardLink('EPERM'),
        create: completePartialMigrationAfterDelay(bytes),
      }),
    ).toHaveLength(1);
    expect(readFileSync(join(root, LINES_BASELINE), 'utf8')).toBe(bytes);
  });

  it('allows the ship worktree canonical baseline symlink', () => {
    const root = makeRoot();
    const linked = makeRoot();
    execFileSync('git', ['init', '-q'], { cwd: root });
    write(root, '.gitignore', '.devkit/\n');
    mkdirSync(join(root, '.devkit'), { recursive: true });
    symlinkSync(linked, join(root, '.devkit/baselines'));

    writeRatchetBaseline(root, LINES_BASELINE, '{"files":{"src/legacy.ts":70}}\n', {
      stage: true,
    });

    expect(readFileSync(join(linked, 'size-lines.json'), 'utf8')).toContain('70');
  });

  it('finishes index staging after an interrupted filesystem move', () => {
    const root = makeRoot();
    const bytes = '{"files":{"src/legacy.ts":731}}\n';
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    write(root, LEGACY_LINES_BASELINE, bytes);
    execFileSync('git', ['add', LEGACY_LINES_BASELINE], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'legacy baseline'], { cwd: root });
    write(root, LINES_BASELINE, bytes);
    rmSync(join(root, LEGACY_LINES_BASELINE));

    expect(migrateRatchetBaselines(root)).toEqual([
      { from: LEGACY_LINES_BASELINE, kind: 'moved', to: LINES_BASELINE },
    ]);
    const staged = execFileSync('git', ['diff', '--cached', '--name-status'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(staged).toContain(LEGACY_LINES_BASELINE);
    expect(staged).toContain(LINES_BASELINE);
  });

  it('is idempotent across concurrent migration processes', async () => {
    const root = makeRoot();
    const bytes = '{"files":{"src/legacy.ts":731}}\n';
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    write(root, LEGACY_LINES_BASELINE, bytes);
    execFileSync('git', ['add', LEGACY_LINES_BASELINE], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'legacy baseline'], { cwd: root });
    write(
      root,
      'migrate.mjs',
      `import { migrateRatchetBaselines } from ${JSON.stringify(new URL('../baseline-paths.mts', import.meta.url).href)};\nmigrateRatchetBaselines(process.argv[2]);\n`,
    );
    const run = () =>
      new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [join(root, 'migrate.mjs'), root], { cwd: root });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.on('close', (code) => resolve({ code, stderr }));
      });

    const results = await Promise.all(Array.from({ length: 8 }, run));

    expect(results).toEqual(Array.from({ length: 8 }, () => ({ code: 0, stderr: '' })));
    expect(readFileSync(join(root, LINES_BASELINE), 'utf8')).toBe(bytes);
    expect(existsSync(join(root, LEGACY_LINES_BASELINE))).toBe(false);
  });

  it('removes an equal legacy duplicate without rewriting the canonical copy', () => {
    const root = makeRoot();
    const bytes = '{"cap":12,"dirs":{}}\n';
    write(root, FANOUT_BASELINE, bytes);
    write(root, 'eslint/baselines/fanout.json', bytes);

    expect(migrateRatchetBaselines(root)).toEqual([
      {
        from: 'eslint/baselines/fanout.json',
        kind: 'removed-duplicate',
        to: FANOUT_BASELINE,
      },
    ]);
    expect(readFileSync(join(root, FANOUT_BASELINE), 'utf8')).toBe(bytes);
    expect(existsSync(join(root, 'eslint/baselines/fanout.json'))).toBe(false);
  });

  it('treats differently formatted JSON with the same debt as an equal duplicate', () => {
    const root = makeRoot();
    const canonical = '{\n  "files": {\n    "src/a.ts": 500\n  }\n}\n';
    write(root, LINES_BASELINE, canonical);
    write(root, LEGACY_LINES_BASELINE, '{"files":{"src/a.ts":500}}');

    expect(migrateRatchetBaselines(root)).toEqual([
      { from: LEGACY_LINES_BASELINE, kind: 'removed-duplicate', to: LINES_BASELINE },
    ]);
    expect(readFileSync(join(root, LINES_BASELINE), 'utf8')).toBe(canonical);
    expect(existsSync(join(root, LEGACY_LINES_BASELINE))).toBe(false);
  });

  it('fails before changing anything when legacy and canonical debt conflict', () => {
    const root = makeRoot();
    write(root, LINES_BASELINE, '{"files":{"src/a.ts":500}}\n');
    write(root, 'eslint/baselines/size-lines.json', '{"files":{"src/a.ts":700}}\n');
    write(root, 'eslint/baselines/size.json', '{"files":{}}\n');

    expect(() => migrateRatchetBaselines(root)).toThrow(
      'both eslint/baselines/size-lines.json and .devkit/baselines/size-lines.json exist with different contents',
    );
    expect(existsSync(join(root, 'eslint/baselines/size.json'))).toBe(true);
    expect(existsSync(join(root, SIZE_BASELINE))).toBe(false);
  });

  it('reports dry-run moves without changing the repository', () => {
    const root = makeRoot();
    write(root, 'eslint/baselines/size.json', '{"files":{}}\n');

    expect(migrateRatchetBaselines(root, { dryRun: true })).toEqual([
      { from: 'eslint/baselines/size.json', kind: 'moved', to: SIZE_BASELINE },
    ]);
    expect(existsSync(join(root, 'eslint/baselines/size.json'))).toBe(true);
    expect(existsSync(join(root, SIZE_BASELINE))).toBe(false);
  });
});
