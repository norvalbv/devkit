import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FANOUT_BASELINE,
  IMPORT_WALL_BASELINE,
  LEGACY_LINES_BASELINE,
  LINES_BASELINE,
  migrateRatchetBaselines,
  readRatchetBaseline,
  SIZE_BASELINE,
  STRUCTURE_BASELINE_DIR,
  STRUCTURE_EXEMPT,
  writeRatchetBaseline,
} from '../baseline-paths.mts';

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

  it('writes canonical state unless a legacy baseline actually exists', () => {
    const root = makeRoot();
    expect(readRatchetBaseline(root, LINES_BASELINE, LEGACY_LINES_BASELINE)).toBeNull();
    write(root, LEGACY_LINES_BASELINE, '{"files":{}}\n');
    expect(readRatchetBaseline(root, LINES_BASELINE, LEGACY_LINES_BASELINE)?.relativePath).toBe(
      LEGACY_LINES_BASELINE,
    );
    write(root, LINES_BASELINE, '{"files":{}}\n');
    expect(readRatchetBaseline(root, LINES_BASELINE, LEGACY_LINES_BASELINE)?.relativePath).toBe(
      LINES_BASELINE,
    );
  });

  it('keeps an existing legacy alias current instead of retiring it on a gate write', () => {
    const root = makeRoot();
    write(root, LEGACY_LINES_BASELINE, '{"files":{"src/legacy.ts":80}}\n');

    writeRatchetBaseline(
      root,
      LINES_BASELINE,
      LEGACY_LINES_BASELINE,
      '{"files":{"src/legacy.ts":70}}\n',
    );

    // Present is not enough: stale bytes here would enforce an OUTDATED ceiling, which is worse
    // than either keeping the alias current or deleting it outright.
    expect(readFileSync(join(root, LEGACY_LINES_BASELINE), 'utf8')).toBe(
      '{"files":{"src/legacy.ts":70}}\n',
    );
    expect(readFileSync(join(root, LINES_BASELINE), 'utf8')).toBe(
      '{"files":{"src/legacy.ts":70}}\n',
    );
  });

  it('re-points a dangling alias instead of reading it as retired', () => {
    const root = makeRoot();
    write(root, LINES_BASELINE, '{"files":{"src/legacy.ts":80}}\n');
    mkdirSync(join(root, LEGACY_LINES_BASELINE, '..'), { recursive: true });
    // existsSync follows the link and reports false here, which would misread a name that still
    // exists as one migration retired — leaving a legacy-only reader with a broken path.
    symlinkSync(join(root, 'never-existed.json'), join(root, LEGACY_LINES_BASELINE));

    writeRatchetBaseline(
      root,
      LINES_BASELINE,
      LEGACY_LINES_BASELINE,
      '{"files":{"src/legacy.ts":70}}\n',
    );

    expect(readFileSync(join(root, LEGACY_LINES_BASELINE), 'utf8')).toBe(
      '{"files":{"src/legacy.ts":70}}\n',
    );
  });

  it('never creates a legacy alias in a repo that has already migrated', () => {
    const root = makeRoot();
    write(root, LINES_BASELINE, '{"files":{"src/legacy.ts":80}}\n');

    writeRatchetBaseline(
      root,
      LINES_BASELINE,
      LEGACY_LINES_BASELINE,
      '{"files":{"src/legacy.ts":70}}\n',
    );

    expect(existsSync(join(root, LEGACY_LINES_BASELINE))).toBe(false);
  });

  it('leaves a refreshed alias migratable as a duplicate rather than a conflict', () => {
    const root = makeRoot();
    write(root, LEGACY_LINES_BASELINE, '{"files":{"src/legacy.ts":80}}\n');
    writeRatchetBaseline(
      root,
      LINES_BASELINE,
      LEGACY_LINES_BASELINE,
      '{"files":{"src/legacy.ts":70}}\n',
    );

    // Keeping both names byte-identical satisfies hasStableBaselineConflict by CONTENT, which is
    // what the delete used to buy by absence — so the explicit migration still completes cleanly.
    expect(migrateRatchetBaselines(root)).toEqual([
      { from: LEGACY_LINES_BASELINE, kind: 'removed-duplicate', to: LINES_BASELINE },
    ]);
    expect(existsSync(join(root, LEGACY_LINES_BASELINE))).toBe(false);
    expect(readFileSync(join(root, LINES_BASELINE), 'utf8')).toBe(
      '{"files":{"src/legacy.ts":70}}\n',
    );
  });

  it('leaves a legacy-only reader reading the tightened ceiling after a gate write', () => {
    const root = makeRoot();
    write(root, LEGACY_LINES_BASELINE, '{"files":{"src/legacy.ts":80}}\n');
    writeRatchetBaseline(
      root,
      LINES_BASELINE,
      LEGACY_LINES_BASELINE,
      '{"files":{"src/legacy.ts":70}}\n',
    );

    // Read the legacy path directly: a pre-migration devkit has no canonical-first fallback.
    expect(readFileSync(join(root, LEGACY_LINES_BASELINE), 'utf8')).toBe(
      '{"files":{"src/legacy.ts":70}}\n',
    );
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

  it('stops a package gate write before deleting legacy debt when canonical is ignored', () => {
    const root = makeRoot();
    execFileSync('git', ['init', '-q'], { cwd: root });
    write(root, '.gitignore', '.devkit/\n');
    write(root, LEGACY_LINES_BASELINE, '{"files":{"src/legacy.ts":80}}\n');

    expect(() =>
      writeRatchetBaseline(
        root,
        LINES_BASELINE,
        LEGACY_LINES_BASELINE,
        '{"files":{"src/legacy.ts":70}}\n',
      ),
    ).toThrow(`${LINES_BASELINE} is ignored by Git`);
    expect(existsSync(join(root, LEGACY_LINES_BASELINE))).toBe(true);
    expect(existsSync(join(root, LINES_BASELINE))).toBe(false);
  });

  it('keeps ignored canonical writes available to deliberately untracked overlay mode', () => {
    const root = makeRoot();
    execFileSync('git', ['init', '-q'], { cwd: root });
    write(root, '.gitignore', '.devkit/\n');
    write(root, '.devkit/config.json', '{"overlay":true}\n');
    write(root, LEGACY_LINES_BASELINE, '{"files":{"src/legacy.ts":80}}\n');

    writeRatchetBaseline(
      root,
      LINES_BASELINE,
      LEGACY_LINES_BASELINE,
      '{"files":{"src/legacy.ts":70}}\n',
    );

    expect(readFileSync(join(root, LINES_BASELINE), 'utf8')).toContain('70');
    // A gate write never retires the legacy alias — it refreshes it, so a reader still resolving
    // that name sees the SAME tightened ceiling rather than nothing (sc-1934) or stale debt.
    expect(readFileSync(join(root, LEGACY_LINES_BASELINE), 'utf8')).toContain('70');
  });

  it('never writes through the alias when it IS canonical', () => {
    const root = makeRoot();
    // Branch 1 leaves both names on ONE inode, so a second write through the alias truncates
    // canonical, and an equality check between two names of one file cannot detect it.
    write(root, LEGACY_LINES_BASELINE, '{"files":{"src/legacy.ts":80}}\n');
    writeRatchetBaseline(
      root,
      LINES_BASELINE,
      LEGACY_LINES_BASELINE,
      '{"files":{"src/legacy.ts":70}}\n',
    );
    expect(statSync(join(root, LEGACY_LINES_BASELINE)).ino).toBe(
      statSync(join(root, LINES_BASELINE)).ino,
    );

    const long = `{"files":{"src/legacy.ts":65,"src/pad.ts":${'9'.repeat(40)}}}\n`;
    writeRatchetBaseline(root, LINES_BASELINE, LEGACY_LINES_BASELINE, long);
    writeRatchetBaseline(
      root,
      LINES_BASELINE,
      LEGACY_LINES_BASELINE,
      '{"files":{"src/legacy.ts":60}}\n',
    );

    // Byte-exact, not merely parseable: a truncate-then-write through the shared inode would leave
    // the longer payload's tail behind and still look like JSON to a lenient assertion.
    expect(readFileSync(join(root, LINES_BASELINE), 'utf8')).toBe(
      '{"files":{"src/legacy.ts":60}}\n',
    );
    expect(() => JSON.parse(readFileSync(join(root, LINES_BASELINE), 'utf8'))).not.toThrow();
  });

  it("persists the writer's payload when a peer changes legacy state before fallback", () => {
    const root = makeRoot();
    const tightened = '{"files":{"src/legacy.ts":70}}\n';
    write(root, LEGACY_LINES_BASELINE, '{"files":{"src/legacy.ts":80}}\n');
    writeRatchetBaseline(root, LINES_BASELINE, LEGACY_LINES_BASELINE, tightened, {
      link: replaceLegacyThenDeny('{"files":{"src/legacy.ts":60}}\n'),
    });
    expect(readFileSync(join(root, LINES_BASELINE), 'utf8')).toBe(tightened);
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

    writeRatchetBaseline(
      root,
      LINES_BASELINE,
      LEGACY_LINES_BASELINE,
      '{"files":{"src/legacy.ts":70}}\n',
      { stage: true },
    );

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

  it('tracks a later canonical write without ever recreating a retired name', () => {
    const root = makeRoot();
    write(root, LEGACY_LINES_BASELINE, '{"files":{"src/legacy.ts":80}}\n');
    const tighten = (n: number) =>
      writeRatchetBaseline(
        root,
        LINES_BASELINE,
        LEGACY_LINES_BASELINE,
        `{"files":{"src/legacy.ts":${n}}}\n`,
      );

    tighten(70);
    tighten(60);
    expect(readFileSync(join(root, LEGACY_LINES_BASELINE), 'utf8')).toBe(
      readFileSync(join(root, LINES_BASELINE), 'utf8'),
    );

    // Once migration retires the name, no later write may bring it back — O_CREAT is absent, so the
    // kernel refuses rather than this code racing a check against migration's removal.
    rmSync(join(root, LEGACY_LINES_BASELINE));
    tighten(50);
    expect(existsSync(join(root, LEGACY_LINES_BASELINE))).toBe(false);
    expect(readFileSync(join(root, LINES_BASELINE), 'utf8')).toContain('50');
  });

  it('keeps a split pair current, so the fix survives a clone or checkout', () => {
    const root = makeRoot();
    // Git cannot materialise two tracked paths as one inode and the write stages both names, so
    // this split pair is what every clone or checkout hands the next write.
    write(root, LINES_BASELINE, '{"files":{"src/legacy.ts":80}}\n');
    write(root, LEGACY_LINES_BASELINE, '{"files":{"src/legacy.ts":80}}\n');
    expect(statSync(join(root, LINES_BASELINE)).ino).not.toBe(
      statSync(join(root, LEGACY_LINES_BASELINE)).ino,
    );

    const tighten = (n: number) =>
      writeRatchetBaseline(
        root,
        LINES_BASELINE,
        LEGACY_LINES_BASELINE,
        `{"files":{"src/legacy.ts":${n}}}\n`,
      );
    tighten(70);
    tighten(60);

    // Both names track every write, which is what a legacy-only reader needs.
    expect(readFileSync(join(root, LEGACY_LINES_BASELINE), 'utf8')).toBe(
      '{"files":{"src/legacy.ts":60}}\n',
    );
    expect(readFileSync(join(root, LINES_BASELINE), 'utf8')).toBe(
      '{"files":{"src/legacy.ts":60}}\n',
    );
  });

  it('keeps a projected pair intact when the caller holds one inode', () => {
    const wt = makeRoot();
    const caller = makeRoot();
    // A healthy caller: the two names are ONE file, so both symlinks resolve to the same inode and
    // the canonical write publishes both at once.
    write(caller, LINES_BASELINE, '{"files":{"src/legacy.ts":80}}\n');
    mkdirSync(join(caller, LEGACY_LINES_BASELINE, '..'), { recursive: true });
    linkSync(join(caller, LINES_BASELINE), join(caller, LEGACY_LINES_BASELINE));
    for (const rel of [LINES_BASELINE, LEGACY_LINES_BASELINE]) {
      mkdirSync(join(wt, rel, '..'), { recursive: true });
      symlinkSync(join(caller, rel), join(wt, rel));
    }

    writeRatchetBaseline(
      wt,
      LINES_BASELINE,
      LEGACY_LINES_BASELINE,
      '{"files":{"src/legacy.ts":70}}\n',
    );

    // Neither projected name is disturbed, and both report the tightened ceiling in the caller.
    expect(existsSync(join(caller, LEGACY_LINES_BASELINE))).toBe(true);
    expect(readFileSync(join(caller, LEGACY_LINES_BASELINE), 'utf8')).toBe(
      readFileSync(join(caller, LINES_BASELINE), 'utf8'),
    );
    expect(readFileSync(join(caller, LINES_BASELINE), 'utf8')).toContain('70');
  });

  it('leaves both names holding one ceiling after concurrent gate writes', async () => {
    const root = makeRoot();
    write(root, LEGACY_LINES_BASELINE, '{"files":{"src/legacy.ts":900}}\n');
    write(
      root,
      'concurrent-write.mjs',
      `import { writeRatchetBaseline, LINES_BASELINE, LEGACY_LINES_BASELINE } from ${JSON.stringify(new URL('../baseline-paths.mts', import.meta.url).href)};\nwriteRatchetBaseline(process.argv[2], LINES_BASELINE, LEGACY_LINES_BASELINE, process.argv[3]);\n`,
    );
    const run = (contents: string) =>
      new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [join(root, 'concurrent-write.mjs'), root, contents]);
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.on('close', (code) => resolve({ code, stderr }));
      });

    // Distinct ceilings per writer: with equal ones an interleave would hide behind the equality.
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => run(`{"files":{"src/legacy.ts":${800 + i}}}\n`)),
    );

    expect(results).toEqual(Array.from({ length: 8 }, () => ({ code: 0, stderr: '' })));
    // Not `legacy === canonical`: they are one inode here, so that compares a file to itself. Assert
    // the published ceiling is one of the writers' payloads and parses — a torn write fails both.
    const published = readFileSync(join(root, LEGACY_LINES_BASELINE), 'utf8');
    expect(() => JSON.parse(published)).not.toThrow();
    expect(JSON.parse(published).files['src/legacy.ts']).toBeGreaterThanOrEqual(800);
  });

  it('converges when a gate write races migration', async () => {
    const root = makeRoot();
    const prior = '{"files":{"src/legacy.ts":80}}\n';
    const tightened = '{"files":{"src/legacy.ts":70}}\n';
    write(root, LEGACY_LINES_BASELINE, prior);
    write(
      root,
      'race.mjs',
      `import { migrateRatchetBaselines, writeRatchetBaseline, LINES_BASELINE, LEGACY_LINES_BASELINE } from ${JSON.stringify(new URL('../baseline-paths.mts', import.meta.url).href)};\nif (process.argv[3] === 'write') writeRatchetBaseline(process.argv[2], LINES_BASELINE, LEGACY_LINES_BASELINE, ${JSON.stringify(tightened)}); else migrateRatchetBaselines(process.argv[2]);\n`,
    );
    const run = (mode: 'migrate' | 'write') =>
      new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [join(root, 'race.mjs'), root, mode], { cwd: root });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.on('close', (code) => resolve({ code, stderr }));
      });

    const results = await Promise.all([
      ...Array.from({ length: 4 }, () => run('migrate')),
      ...Array.from({ length: 4 }, () => run('write')),
    ]);

    expect(results).toEqual(Array.from({ length: 8 }, () => ({ code: 0, stderr: '' })));
    expect(readFileSync(join(root, LINES_BASELINE), 'utf8')).toBe(tightened);
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
