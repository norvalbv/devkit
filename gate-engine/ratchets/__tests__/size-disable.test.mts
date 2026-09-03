import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { changedSetSince, stagedSet } from '../git-index.mts';
import { countDisables, countOversized, freezeLines } from '../size-disable.mts';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'size-disable.mts');

let roots = [];
const makeRoot = () => {
  // Reason: the two ratchets (folder-fanout / size-disable) are parallel-by-design independent guard bins (+ tests); each is self-contained with the same freeze/gate CLI shell
  // fallow-ignore-next-line code-duplication
  const root = mkdtempSync(join(tmpdir(), 'ratchet-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

const write = (root, rel, content) => {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
};
const writeConfig = (root, cfg) =>
  writeFileSync(join(root, 'guard.config.json'), JSON.stringify(cfg));
const gitInit = (root) => {
  // Pinned: `git switch main` below is otherwise hostage to the machine's init.defaultBranch.
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
};
const gitAdd = (root, ...paths) => execFileSync('git', ['add', ...paths], { cwd: root });

describe('countDisables', () => {
  it('returns zeros for an empty tree (boundary state)', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'src'));
    expect(countDisables(root)).toEqual({
      fileDisables: 0,
      fnDisables: 0,
      perFile: {},
      scannedFiles: 0,
    });
  });

  it('counts a combined one-line directive in both buckets', () => {
    const root = makeRoot();
    write(root, 'src/a.ts', '/* eslint-disable max-lines, max-lines-per-function */\nexport {};\n');
    const r = countDisables(root);
    expect(r.fileDisables).toBe(1);
    expect(r.fnDisables).toBe(1);
  });

  it('attributes next-line per-function disables to fn only (substring disambiguation)', () => {
    const root = makeRoot();
    write(
      root,
      'src/b.ts',
      '// eslint-disable-next-line max-lines-per-function\nexport const f = () => {};\n',
    );
    expect(countDisables(root)).toMatchObject({ fileDisables: 0, fnDisables: 1 });
  });

  it('ignores mentions inside string literals and prose comments (false-block guard)', () => {
    const root = makeRoot();
    write(
      root,
      'src/c.ts',
      [
        "export const msg = 'adding eslint-disable max-lines is banned';",
        '// note: eslint-disable max-lines must never be added',
        'export {};',
      ].join('\n'),
    );
    expect(countDisables(root)).toMatchObject({ fileDisables: 0, fnDisables: 0 });
  });

  it('counts directives with trailing justification and CRLF line endings (Windows)', () => {
    const root = makeRoot();
    write(root, 'src/d.ts', '/* eslint-disable max-lines -- legacy */\r\nexport {};\r\n');
    expect(countDisables(root)).toMatchObject({ fileDisables: 1, fnDisables: 0 });
  });

  it('excludes test files and skip-dirs from the scan', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src', 'vercel-serverless'] });
    write(root, 'src/e.test.ts', '/* eslint-disable max-lines */\nexport {};\n');
    write(root, 'src/node_modules/dep.ts', '/* eslint-disable max-lines */\nexport {};\n');
    write(root, 'vercel-serverless/_shared/m.ts', '/* eslint-disable max-lines */\nexport {};\n');
    expect(countDisables(root)).toMatchObject({ fileDisables: 0, fnDisables: 0, scannedFiles: 0 });
  });

  it('honours config.scanRoots (multi-root, no longer hardcoded)', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src', 'socket-server/src'] });
    write(root, 'src/a.ts', '/* eslint-disable max-lines */\nexport {};\n');
    write(root, 'socket-server/src/b.ts', '/* eslint-disable max-lines */\nexport {};\n');
    write(root, 'ignored/c.ts', '/* eslint-disable max-lines */\nexport {};\n'); // not scanned
    const r = countDisables(root);
    expect(r.fileDisables).toBe(2);
    expect(r.scannedFiles).toBe(2);
  });

  it('default scanRoots is ["src"] when no config is present', () => {
    const root = makeRoot();
    write(root, 'src/a.ts', '/* eslint-disable max-lines */\nexport {};\n');
    write(root, 'socket-server/src/b.ts', '/* eslint-disable max-lines */\nexport {};\n');
    const r = countDisables(root);
    expect(r.fileDisables).toBe(1); // only src/ scanned by default
    expect(r.scannedFiles).toBe(1);
  });
});

describe('CLI freeze/gate contract (what a pre-commit hook relies on)', () => {
  const run = (root, cmd) =>
    spawnSync(process.execPath, [SCRIPT, cmd], { cwd: root, encoding: 'utf8' });

  it('freeze writes the generated counts; gate passes when nothing changed', () => {
    const root = makeRoot();
    write(root, 'src/a.ts', '/* eslint-disable max-lines */\nexport {};\n');
    expect(run(root, 'freeze').status).toBe(0);
    const frozen = JSON.parse(readFileSync(join(root, '.devkit/baselines/size.json'), 'utf8'));
    expect(frozen).toEqual({ files: { 'src/a.ts': { file: 1, fn: 0 } } });
    expect(run(root, 'gate').status).toBe(0);
  });

  it('freeze ignores a stale pull-request base because only gate consumes PR scope', () => {
    const root = makeRoot();
    write(root, 'src/a.ts', '/* eslint-disable max-lines */\nexport {};\n');
    const r = spawnSync(process.execPath, [SCRIPT, 'freeze'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GUARD_RATCHET_BASE: 'missing-base' },
    });
    expect(r.status, r.stderr).toBe(0);
    const frozen = JSON.parse(readFileSync(join(root, '.devkit/baselines/size.json'), 'utf8'));
    expect(frozen).toEqual({ files: { 'src/a.ts': { file: 1, fn: 0 } } });
  });

  it('writes the baseline under the CONSUMER cwd, not the package dir (W-3)', () => {
    const root = makeRoot();
    write(root, 'src/a.ts', '/* eslint-disable max-lines */\nexport {};\n');
    expect(run(root, 'freeze').status).toBe(0);
    expect(() => readFileSync(join(root, '.devkit/baselines/size.json'), 'utf8')).not.toThrow();
  });

  it('gate exits 1 when a NEW file-level disable appears', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src'] }); // governed repo → enforce even with no debt baseline
    write(root, 'src/a.ts', 'export {};\n');
    run(root, 'freeze'); // 0 disables → no baseline written
    write(root, 'src/b.ts', '/* eslint-disable max-lines */\nexport {};\n');
    const r = run(root, 'gate');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('may only SHRINK');
  });

  it('gate exits 1 when only the per-function count grows', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src'] });
    write(root, 'src/a.ts', 'export {};\n');
    run(root, 'freeze');
    write(root, 'src/b.ts', '// eslint-disable-next-line max-lines-per-function\nexport {};\n');
    expect(run(root, 'gate').status).toBe(1);
  });

  it('freeze writes NO baseline when there are zero disables (no empty file left on disk)', () => {
    const root = makeRoot();
    write(root, 'src/a.ts', 'export {};\n');
    expect(run(root, 'freeze').status).toBe(0);
    expect(() => readFileSync(join(root, '.devkit/baselines/size.json'), 'utf8')).toThrow();
  });

  it('freeze deletes a stale empty baseline once the last disable heals', () => {
    const root = makeRoot();
    write(root, 'src/a.ts', '/* eslint-disable max-lines */\nexport {};\n');
    run(root, 'freeze'); // size.json = {1,0}
    write(root, 'src/a.ts', 'export {};\n'); // healed
    expect(run(root, 'freeze').status).toBe(0);
    expect(() => readFileSync(join(root, '.devkit/baselines/size.json'), 'utf8')).toThrow();
  });

  it('gate ENFORCES from config (not fail-open) when governed but no baseline exists', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src'] }); // governed, never frozen
    write(root, 'src/a.ts', '/* eslint-disable max-lines */\nexport {};\n');
    const r = run(root, 'gate');
    expect(r.status).toBe(1); // a disable with no grandfathering is blocked
    expect(r.stderr).toContain('may only SHRINK');
  });

  it('gate heal-deletes + stages size.json when the last disable heals in a real commit', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'] });
    write(root, 'src/a.ts', '/* eslint-disable max-lines */\nexport {};\n');
    run(root, 'freeze'); // size.json = {1,0}
    gitAdd(root, 'src/a.ts', '.devkit/baselines/size.json'); // baseline is committed → tracked
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root });
    write(root, 'src/a.ts', 'export {};\n'); // healed
    gitAdd(root, 'src/a.ts');
    const r = run(root, 'gate');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('removed & staged');
    expect(() => readFileSync(join(root, '.devkit/baselines/size.json'), 'utf8')).toThrow();
    // the deletion rides this commit
    const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=D'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(staged).toContain('.devkit/baselines/size.json');
  });

  it('gate exits 0 (with a re-freeze reminder) when counts shrink', () => {
    const root = makeRoot();
    write(root, 'src/a.ts', '/* eslint-disable max-lines */\nexport {};\n');
    run(root, 'freeze');
    write(root, 'src/a.ts', 'export {};\n');
    const r = run(root, 'gate');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('shrank');
  });

  it('gate fails OPEN (exit 2) in an UNGOVERNED repo (no guard.config.json) with no baseline', () => {
    const root = makeRoot(); // no guard.config.json → not governed → never wedge
    write(root, 'src/a.ts', '/* eslint-disable max-lines */\nexport {};\n');
    expect(run(root, 'gate').status).toBe(2);
  });

  it('unknown command exits 2', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'src'));
    expect(run(root, 'bogus').status).toBe(2);
  });

  it('gate honours config.scanRoots end-to-end (multi-root growth caught)', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src', 'socket-server/src'] });
    write(root, 'src/a.ts', 'export {};\n');
    run(root, 'freeze');
    write(root, 'socket-server/src/b.ts', '/* eslint-disable max-lines */\nexport {};\n');
    expect(run(root, 'gate').status).toBe(1);
  });
});

describe('raw-line cap (the maxLines gate — size owned by the ratchet, not eslint)', () => {
  const run = (root, cmd) =>
    spawnSync(process.execPath, [SCRIPT, cmd], { cwd: root, encoding: 'utf8' });
  const big = (n) => Array(n).fill('const x = 1;').join('\n'); // n lines

  it('countOversized flags source files over the cap; tests + small files exempt', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/big.ts', big(80));
    write(root, 'src/small.ts', big(10));
    write(root, 'src/big.test.ts', big(80)); // test → exempt
    expect(countOversized(root)).toEqual([{ file: 'src/big.ts', lines: 80 }]);
  });

  it('does not count a trailing line separator as a phantom source line', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/exact-lf.ts', `${big(50)}\n`);
    write(root, 'src/exact-crlf.ts', `${big(50).replaceAll('\n', '\r\n')}\r\n`);
    write(root, 'src/exact-unterminated.ts', big(50));

    expect(countOversized(root)).toEqual([]);
  });

  it('countOversized applies the separate loose cap when test ratcheting is enabled', () => {
    const root = makeRoot();
    writeConfig(root, {
      scanRoots: ['src'],
      sourceExtensions: ['ts'],
      maxLines: 50,
      maxTestLines: 100,
    });
    write(root, 'src/big.ts', big(80));
    write(root, 'src/big.test.ts', big(120));
    write(root, 'src/small.test.ts', big(90));
    expect(countOversized(root)).toEqual([
      { file: 'src/big.test.ts', lines: 120 },
      { file: 'src/big.ts', lines: 80 },
    ]);
  });

  it('off by default (maxLines 0) → never flags, however large', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'] });
    write(root, 'src/huge.ts', big(900));
    expect(countOversized(root)).toEqual([]);
  });

  it('freeze grandfathers current over-cap files; gate passes; a NEW over-cap file fails', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/legacy.ts', big(80));
    expect(run(root, 'freeze').status).toBe(0);
    const baseline = JSON.parse(
      readFileSync(join(root, '.devkit/baselines/size-lines.json'), 'utf8'),
    );
    expect(baseline.files['src/legacy.ts']).toBe(80);
    expect(run(root, 'gate').status).toBe(0); // grandfathered → allowed
    write(root, 'src/fresh.ts', big(70)); // NEW over-cap → blocked
    const r = run(root, 'gate');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('exceed their line limit');
    expect(r.stderr).toContain('src/fresh.ts: 70 lines (max 50)');
  });

  it('freeze records logical line counts under the current baseline version', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/legacy.ts', `${big(80)}\n`);

    expect(run(root, 'freeze').status).toBe(0);

    const baseline = JSON.parse(
      readFileSync(join(root, '.devkit/baselines/size-lines.json'), 'utf8'),
    );
    expect(baseline.lineCountVersion).toBe(2);
    expect(baseline.files['src/legacy.ts']).toBe(80);
  });

  it('the staged snapshot admits a newline-terminated file at the exact cap', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/base.ts', big(1));
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    write(root, 'src/exact.ts', `${big(50)}\n`);
    gitAdd(root, 'src/exact.ts');

    const result = run(root, 'gate');

    expect(result.status, result.stderr).toBe(0);
  });

  it('does not give a legacy split-count baseline one line of growth headroom', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/legacy.ts', `${big(80)}\n`);
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 81 } }),
    );
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'legacy split-count baseline'], { cwd: root });
    write(root, 'src/legacy.ts', `${big(81)}\n`);
    gitAdd(root, 'src/legacy.ts');

    const result = run(root, 'gate');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/legacy.ts: 81 lines (max 80)');
  });

  it.each([
    ['without a final newline', big(81)],
    ['after changing to CR separators', Array(81).fill('const x = 1;').join('\r')],
  ])('anchors legacy baseline conversion before candidate growth %s', (_label, candidate) => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/legacy.ts', `${big(80)}\n`);
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 81 } }),
    );
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'legacy split-count baseline'], { cwd: root });
    write(root, 'src/legacy.ts', candidate);
    gitAdd(root, 'src/legacy.ts');

    const result = run(root, 'gate');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/legacy.ts: 81 lines (max 80)');
  });

  it('does not invent legacy growth when only a final newline is added', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/legacy.ts', big(80));
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 80 } }),
    );
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'legacy split-count baseline'], { cwd: root });
    write(root, 'src/legacy.ts', `${big(80)}\n`);
    gitAdd(root, 'src/legacy.ts');

    const result = run(root, 'gate');

    expect(result.status, result.stderr).toBe(0);
  });

  it('drops stale legacy grandfathering when its producer file is absent', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/legacy.ts', `${big(80)}\n`);
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 81 } }),
    );
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'legacy split-count baseline'], { cwd: root });
    rmSync(join(root, 'src/legacy.ts'));
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'delete legacy source'], { cwd: root });
    write(root, 'src/legacy.ts', big(81));
    gitAdd(root, 'src/legacy.ts');

    const result = run(root, 'gate');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/legacy.ts: 81 lines (max 50)');
  });

  it('a grandfathered file that GROWS past its recorded ceiling fails (the ratchet)', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/legacy.ts', big(80));
    run(root, 'freeze'); // ceiling recorded at 80
    write(root, 'src/legacy.ts', big(100)); // grew past 80
    const r = run(root, 'gate');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('src/legacy.ts: 100 lines (max 80)');
  });

  it('grandfathers an oversized test and blocks growth past its recorded ceiling', () => {
    const root = makeRoot();
    writeConfig(root, {
      scanRoots: ['src'],
      sourceExtensions: ['ts'],
      maxLines: 50,
      maxTestLines: 100,
    });
    write(root, 'src/executor.test.ts', big(120));
    expect(run(root, 'freeze').status).toBe(0);
    const baseline = JSON.parse(
      readFileSync(join(root, '.devkit/baselines/size-lines.json'), 'utf8'),
    );
    expect(baseline.files['src/executor.test.ts']).toBe(120);
    write(root, 'src/executor.test.ts', big(130));
    const r = run(root, 'gate');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('src/executor.test.ts: 130 lines (max 120)');
  });

  it('a STAGED file that shrinks (still over cap) → gate auto-lowers its ceiling', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/legacy.ts', big(80));
    run(root, 'freeze'); // ceiling recorded at 80
    write(root, 'src/legacy.ts', big(60)); // shrank but still over the cap
    gitAdd(root, 'src/legacy.ts'); // it is part of this commit
    expect(run(root, 'gate').status).toBe(0);
    const baseline = JSON.parse(
      readFileSync(join(root, '.devkit/baselines/size-lines.json'), 'utf8'),
    );
    expect(baseline.files['src/legacy.ts']).toBe(60); // ceiling ratcheted down 80 → 60
  });

  it('a staged oversized test that shrinks auto-lowers its ceiling', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, {
      scanRoots: ['src'],
      sourceExtensions: ['ts'],
      maxLines: 50,
      maxTestLines: 100,
    });
    write(root, 'src/executor.test.ts', big(120));
    run(root, 'freeze');
    write(root, 'src/executor.test.ts', big(110));
    gitAdd(root, 'src/executor.test.ts');
    expect(run(root, 'gate').status).toBe(0);
    const baseline = JSON.parse(
      readFileSync(join(root, '.devkit/baselines/size-lines.json'), 'utf8'),
    );
    expect(baseline.files['src/executor.test.ts']).toBe(110);
  });

  it('a STAGED file dropped under the cap → gate auto-removes it from the baseline (file kept while others remain)', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/legacy.ts', big(80));
    write(root, 'src/other.ts', big(90)); // a second giant keeps the baseline non-empty
    run(root, 'freeze');
    write(root, 'src/legacy.ts', big(10)); // healed under the cap
    gitAdd(root, 'src/legacy.ts');
    expect(run(root, 'gate').status).toBe(0);
    const baseline = JSON.parse(
      readFileSync(join(root, '.devkit/baselines/size-lines.json'), 'utf8'),
    );
    expect(baseline.files).not.toHaveProperty('src/legacy.ts');
    expect(baseline.files['src/other.ts']).toBe(90); // untouched
  });

  it('the LAST grandfathered file healing → gate deletes + stages size-lines.json (no empty file left)', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/legacy.ts', big(80));
    run(root, 'freeze'); // size-lines.json = { legacy: 80 }
    write(root, 'src/legacy.ts', big(10)); // last giant healed under the cap
    gitAdd(root, 'src/legacy.ts');
    const r = run(root, 'gate');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('removed & staged');
    expect(() => readFileSync(join(root, '.devkit/baselines/size-lines.json'), 'utf8')).toThrow();
  });

  it('lowers the ceiling for the STAGED file only; a parallel unstaged shrink stays untouched', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/x.ts', big(80));
    write(root, 'src/y.ts', big(90));
    run(root, 'freeze'); // x:80, y:90
    write(root, 'src/x.ts', big(60)); // both shrink in the working tree...
    write(root, 'src/y.ts', big(70));
    gitAdd(root, 'src/x.ts'); // ...but only x is in THIS commit
    expect(run(root, 'gate').status).toBe(0);
    const baseline = JSON.parse(
      readFileSync(join(root, '.devkit/baselines/size-lines.json'), 'utf8'),
    );
    expect(baseline.files['src/x.ts']).toBe(60); // lowered
    expect(baseline.files['src/y.ts']).toBe(90); // untouched — another agent's uncommitted work
  });

  it('an unstaged over-ceiling file does not block a commit that stages only a clean file', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/x.ts', big(80));
    write(root, 'src/y.ts', big(90));
    run(root, 'freeze'); // x:80, y:90
    write(root, 'src/y.ts', big(200)); // a parallel agent grows y past its ceiling, UNSTAGED
    write(root, 'src/x.ts', big(70)); // this agent's file is fine
    gitAdd(root, 'src/x.ts');
    const r = run(root, 'gate');
    expect(r.status).toBe(0); // y's unstaged growth must not block x's commit
    expect(r.stderr).not.toContain('MERGE_HEAD'); // the expected non-merge fallback stays quiet
  });

  it('a merge ignores inherited upstream size debt but still gates merge-authored growth', () => {
    const root = makeRoot();
    gitInit(root);
    execFileSync('git', ['branch', '-M', 'main'], { cwd: root });
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/base.ts', big(10));
    gitAdd(root, 'guard.config.json', 'src/base.ts');
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });

    execFileSync('git', ['switch', '-qc', 'feature'], { cwd: root });
    write(root, 'src/feature.ts', big(10));
    gitAdd(root, 'src/feature.ts');
    execFileSync('git', ['commit', '-qm', 'feature'], { cwd: root });

    execFileSync('git', ['switch', '-q', 'main'], { cwd: root });
    write(root, 'src/upstream.ts', `/* eslint-disable max-lines */\n${big(79)}`);
    gitAdd(root, 'src/upstream.ts');
    execFileSync('git', ['commit', '-qm', 'upstream'], { cwd: root });

    execFileSync('git', ['switch', '-q', 'feature'], { cwd: root });
    execFileSync('git', ['merge', '--no-commit', '--no-ff', 'main'], { cwd: root });

    expect(stagedSet(root)).toEqual(new Set());
    const r = run(root, 'gate');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('src/upstream.ts');

    write(root, 'src/resolution.ts', big(70));
    gitAdd(root, 'src/resolution.ts');
    expect(stagedSet(root)).toEqual(new Set(['src/resolution.ts']));
    const resolved = run(root, 'gate');
    expect(resolved.status).toBe(1);
    expect(resolved.stderr).toContain('src/resolution.ts: 70 lines (max 50)');
    expect(resolved.stderr).not.toContain('src/upstream.ts');
  });

  it('preserves leading whitespace when scoping a PR from a nested directory', () => {
    const root = makeRoot();
    gitInit(root);
    write(root, ' leading/base.ts', 'export {};\n');
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    write(root, ' leading/changed.ts', 'export const changed = true;\n');
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'change nested file'], { cwd: root });

    expect(changedSetSince(join(root, ' leading'), base)).toEqual(new Set(['changed.ts']));
  });

  it('with nothing staged (CI / audit) the whole tree is enforced and the baseline is not mutated', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/legacy.ts', big(80));
    run(root, 'freeze'); // 80
    write(root, 'src/legacy.ts', big(120)); // grew, but nothing is staged
    const r = run(root, 'gate');
    expect(r.status).toBe(1); // whole-tree enforcement still catches a committed-state violation
    const baseline = JSON.parse(
      readFileSync(join(root, '.devkit/baselines/size-lines.json'), 'utf8'),
    );
    expect(baseline.files['src/legacy.ts']).toBe(80); // unchanged — no mutation without a commit
  });

  it('pull-request CI ignores inherited line drift outside the diff', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/inherited.ts', big(80));
    write(root, 'src/clean.ts', big(10));
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/inherited.ts': 60 } }),
    );
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'base with inherited drift'], { cwd: root });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    write(root, 'src/clean.ts', big(11));
    gitAdd(root, 'src/clean.ts');
    execFileSync('git', ['commit', '-qm', 'unrelated PR change'], { cwd: root });

    expect(run(root, 'gate').status).toBe(1); // push/manual audit still sees the inherited drift
    const pr = spawnSync(process.execPath, [SCRIPT, 'gate'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GUARD_RATCHET_BASE: base },
    });
    expect(pr.status, pr.stderr).toBe(0);
    expect(pr.stderr).not.toContain('src/inherited.ts');
  });

  it('pull-request CI still blocks a changed file that exceeds its ceiling', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/changed.ts', big(80));
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/changed.ts': 80 } }),
    );
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    write(root, 'src/changed.ts', big(90));
    gitAdd(root, 'src/changed.ts');
    execFileSync('git', ['commit', '-qm', 'grow changed file'], { cwd: root });

    const pr = spawnSync(process.execPath, [SCRIPT, 'gate'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GUARD_RATCHET_BASE: base },
    });
    expect(pr.status).toBe(1);
    expect(pr.stderr).toContain('src/changed.ts: 90 lines (max 80)');
  });

  it('blocks a baseline-only ceiling lowering in local, pull-request, and audit modes', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/legacy.ts', big(90));
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 100 } }),
    );
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 80 } }),
    );
    gitAdd(root, '.devkit/baselines/size-lines.json');
    const local = run(root, 'gate');
    expect(local.status, local.stderr).toBe(1);
    expect(local.stderr).toContain('src/legacy.ts: ceiling lowered 100 → 80');

    execFileSync('git', ['commit', '-qm', 'lower ceiling only'], { cwd: root });
    const pr = spawnSync(process.execPath, [SCRIPT, 'gate'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GUARD_RATCHET_BASE: base },
    });
    expect(pr.status, pr.stderr).toBe(1);
    expect(pr.stderr).toContain('src/legacy.ts: ceiling lowered 100 → 80');
    expect(run(root, 'gate').status).toBe(1);
  });

  it('compares a pull-request ceiling lowering with the merge base, not the moving base tip', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/legacy.ts', big(90));
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 100 } }),
    );
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'merge base'], { cwd: root });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 80 } }),
    );
    gitAdd(root, '.devkit/baselines/size-lines.json');
    execFileSync('git', ['commit', '-qm', 'pull request lowers ceiling'], { cwd: root });
    const prHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();

    execFileSync('git', ['switch', '-qc', 'base-tip', base], { cwd: root });
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 60 } }),
    );
    gitAdd(root, '.devkit/baselines/size-lines.json');
    execFileSync('git', ['commit', '-qm', 'base branch independently lowers ceiling'], {
      cwd: root,
    });
    const baseTip = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['checkout', '-q', '--detach', prHead], { cwd: root });

    const pr = spawnSync(process.execPath, [SCRIPT, 'gate'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GUARD_RATCHET_BASE: baseTip },
    });
    expect(pr.status, pr.stderr).toBe(1);
    expect(pr.stderr).toContain('src/legacy.ts: ceiling lowered 100 → 80');
  });

  it('reports unavailable or malformed authority snapshots as infrastructure failures', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/legacy.ts', big(70));
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 100 } }),
    );
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });

    write(root, '.devkit/baselines/size-lines.json', '{');
    gitAdd(root, '.devkit/baselines/size-lines.json');
    const malformedFreeze = run(root, 'freeze');
    expect(malformedFreeze.status, malformedFreeze.stderr).toBe(2);
    expect(malformedFreeze.stderr).toContain('guard-size freeze unavailable');
    expect(malformedFreeze.stderr).not.toContain('at freezeLinesBaseline');
    const malformed = run(root, 'gate');
    expect(malformed.status, malformed.stderr).toBe(2);
    expect(malformed.stderr).toContain('guard-size: invalid line baseline JSON');
    expect(malformed.stderr).not.toContain('at lineCeilingChanges');

    const conflictRoot = makeRoot();
    gitInit(conflictRoot);
    writeConfig(conflictRoot, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(conflictRoot, 'src/legacy.ts', big(70));
    write(conflictRoot, 'src/conflict.ts', 'base\n');
    write(
      conflictRoot,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 100 } }),
    );
    gitAdd(conflictRoot, '-A');
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: conflictRoot });
    const conflictBase = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: conflictRoot,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['switch', '-qc', 'other'], { cwd: conflictRoot });
    write(conflictRoot, 'src/conflict.ts', 'other\n');
    gitAdd(conflictRoot, 'src/conflict.ts');
    execFileSync('git', ['commit', '-qm', 'other source'], { cwd: conflictRoot });
    execFileSync('git', ['checkout', '-q', '--detach', conflictBase], { cwd: conflictRoot });
    write(conflictRoot, 'src/conflict.ts', 'current\n');
    gitAdd(conflictRoot, 'src/conflict.ts');
    execFileSync('git', ['commit', '-qm', 'current source'], { cwd: conflictRoot });
    expect(spawnSync('git', ['merge', 'other'], { cwd: conflictRoot }).status).toBe(1);
    const conflicted = run(conflictRoot, 'gate');
    expect(conflicted.status, conflicted.stderr).toBe(2);
    expect(conflicted.stderr).toContain('guard-size: Git index snapshot is unavailable');
    expect(conflicted.stderr).not.toContain('at lineCeilingChanges');
  });

  it('allows a valid staged baseline to recover an invalid committed baseline', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/legacy.ts', big(70));
    write(root, '.devkit/baselines/size-lines.json', '{');
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'invalid committed baseline'], { cwd: root });

    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 100 } }),
    );
    gitAdd(root, '.devkit/baselines/size-lines.json');
    const repaired = run(root, 'gate');
    expect(repaired.status, repaired.stderr).toBe(0);
    expect(repaired.stderr).not.toContain('invalid line baseline JSON in HEAD');
  });

  it('blocks removing the only ceiling for an untouched oversized file', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/legacy.ts', big(90));
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 100 } }),
    );
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    rmSync(join(root, '.devkit/baselines/size-lines.json'));
    gitAdd(root, '-A');
    const local = run(root, 'gate');
    expect(local.status, local.stderr).toBe(1);
    expect(local.stderr).toContain('src/legacy.ts: ceiling lowered 100 → 50');
    execFileSync('git', ['commit', '-qm', 'remove ceiling'], { cwd: root });

    const pr = spawnSync(process.execPath, [SCRIPT, 'gate'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GUARD_RATCHET_BASE: base },
    });
    expect(pr.status, pr.stderr).toBe(1);
  });

  it.each([
    { label: 'raise', lines: 90, previous: 100, current: 110 },
    { label: 'safe lowering', lines: 70, previous: 100, current: 80 },
  ])(
    'allows a baseline-only $label that leaves the governed file legal',
    ({ lines, previous, current }) => {
      const root = makeRoot();
      gitInit(root);
      writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
      write(root, 'src/legacy.ts', big(lines));
      write(
        root,
        '.devkit/baselines/size-lines.json',
        JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': previous } }),
      );
      gitAdd(root, '-A');
      execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
      const base = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).trim();
      write(
        root,
        '.devkit/baselines/size-lines.json',
        JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': current } }),
      );
      gitAdd(root, '.devkit/baselines/size-lines.json');
      expect(run(root, 'gate').status).toBe(0);
      execFileSync('git', ['commit', '-qm', 'adjust safe ceiling'], { cwd: root });

      const pr = spawnSync(process.execPath, [SCRIPT, 'gate'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, GUARD_RATCHET_BASE: base },
      });
      expect(pr.status, pr.stderr).toBe(0);
    },
  );

  it('validates a recorded test ceiling even when the category cap is disabled', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, {
      scanRoots: ['src'],
      sourceExtensions: ['ts'],
      maxLines: 50,
      maxTestLines: 0,
    });
    write(root, 'src/legacy.test.ts', big(90));
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, maxTestLines: 0, files: { 'src/legacy.test.ts': 100 } }),
    );
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, maxTestLines: 0, files: { 'src/legacy.test.ts': 80 } }),
    );
    gitAdd(root, '.devkit/baselines/size-lines.json');

    const result = run(root, 'gate');
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('src/legacy.test.ts: ceiling lowered 100 → 80');
  });

  it('ignores a non-baselined staged file when its category cap is disabled', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, {
      scanRoots: ['src'],
      sourceExtensions: ['ts'],
      maxLines: 50,
      maxTestLines: 0,
    });
    write(root, 'src/app.ts', big(10));
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    write(root, 'src/app.test.ts', big(20));
    gitAdd(root, 'src/app.test.ts');

    const result = run(root, 'gate');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('src/app.test.ts');
  });

  it('reads an untouched governed file from the index when its staged ceiling is lowered', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/legacy.ts', big(90));
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 100 } }),
    );
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });

    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 80 } }),
    );
    gitAdd(root, '.devkit/baselines/size-lines.json');
    write(root, 'src/legacy.ts', big(70)); // unstaged worktree shrink must not hide index debt
    const result = run(root, 'gate');
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('src/legacy.ts: 90 lines (max 80)');
  });

  it('does not let an unstaged worktree growth falsely block a safe staged lowering', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/legacy.ts', big(70));
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 100 } }),
    );
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });

    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 80 } }),
    );
    gitAdd(root, '.devkit/baselines/size-lines.json');
    write(root, 'src/legacy.ts', big(90));
    const result = run(root, 'gate');
    expect(result.status, result.stderr).toBe(0);
  });

  it('auto-tightens from the index snapshot and remains valid when the gate retries', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/legacy.ts', big(90));
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 100 } }),
    );
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });

    write(root, 'src/legacy.ts', big(90).replace('x', 'y'));
    gitAdd(root, 'src/legacy.ts');
    write(root, 'src/legacy.ts', big(70));
    const first = run(root, 'gate');
    expect(first.status, first.stderr).toBe(0);
    const tightened = JSON.parse(
      readFileSync(join(root, '.devkit/baselines/size-lines.json'), 'utf8'),
    );
    expect(tightened.files['src/legacy.ts']).toBe(90);
    const retry = run(root, 'gate');
    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stderr).not.toContain('ceiling lowered');
  });

  it('cannot mask staged source growth with an unstaged worktree baseline edit', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/legacy.ts', big(90));
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 100 } }),
    );
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });

    write(root, 'src/legacy.ts', big(150));
    gitAdd(root, 'src/legacy.ts');
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 500 } }),
    );
    const result = run(root, 'gate');
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('src/legacy.ts: 150 lines (max 100)');
  });

  it('ignores an inherited merge ceiling but blocks a lower merge-authored resolution', () => {
    const inherited = makeRoot();
    gitInit(inherited);
    writeConfig(inherited, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(inherited, 'src/legacy.ts', big(90));
    write(inherited, 'src/feature.ts', big(10));
    write(
      inherited,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 100 } }),
    );
    gitAdd(inherited, '-A');
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: inherited });
    execFileSync('git', ['switch', '-qc', 'feature'], { cwd: inherited });
    write(inherited, 'src/feature.ts', big(11));
    gitAdd(inherited, 'src/feature.ts');
    execFileSync('git', ['commit', '-qm', 'feature'], { cwd: inherited });
    execFileSync('git', ['switch', '-q', 'main'], { cwd: inherited });
    write(
      inherited,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 80 } }),
    );
    gitAdd(inherited, '.devkit/baselines/size-lines.json');
    execFileSync('git', ['commit', '-qm', 'upstream lowering'], { cwd: inherited });
    execFileSync('git', ['switch', '-q', 'feature'], { cwd: inherited });
    execFileSync('git', ['merge', '--no-commit', '--no-ff', 'main'], { cwd: inherited });
    expect(run(inherited, 'gate').status).toBe(0);

    const resolved = makeRoot();
    gitInit(resolved);
    writeConfig(resolved, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(resolved, 'src/legacy.ts', big(70));
    write(
      resolved,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 100 } }),
    );
    gitAdd(resolved, '-A');
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: resolved });
    execFileSync('git', ['switch', '-qc', 'feature'], { cwd: resolved });
    write(
      resolved,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 90 } }),
    );
    gitAdd(resolved, '.devkit/baselines/size-lines.json');
    execFileSync('git', ['commit', '-qm', 'feature ceiling'], { cwd: resolved });
    execFileSync('git', ['switch', '-q', 'main'], { cwd: resolved });
    write(
      resolved,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 80 } }),
    );
    gitAdd(resolved, '.devkit/baselines/size-lines.json');
    execFileSync('git', ['commit', '-qm', 'main ceiling'], { cwd: resolved });
    execFileSync('git', ['switch', '-q', 'feature'], { cwd: resolved });
    spawnSync('git', ['merge', '--no-commit', '--no-ff', 'main'], { cwd: resolved });
    write(
      resolved,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 60 } }),
    );
    gitAdd(resolved, '.devkit/baselines/size-lines.json');
    const result = run(resolved, 'gate');
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('src/legacy.ts: ceiling lowered 80 → 60');
  });

  it('uses the strictest matching parent when a legacy merge changes line-ending shape', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/legacy.ts', big(70));
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 100 } }),
    );
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });

    execFileSync('git', ['switch', '-qc', 'feature'], { cwd: root });
    write(root, 'src/legacy.ts', big(81));
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 81 } }),
    );
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'unterminated parent'], { cwd: root });

    execFileSync('git', ['switch', '-q', 'main'], { cwd: root });
    write(root, 'src/legacy.ts', `${big(80)}\n`);
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 81 } }),
    );
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'newline parent'], { cwd: root });

    execFileSync('git', ['switch', '-q', 'feature'], { cwd: root });
    spawnSync('git', ['merge', '--no-commit', '--no-ff', 'main'], { cwd: root });
    write(root, 'src/legacy.ts', Array(81).fill('const x = 1;').join('\r'));
    gitAdd(root, 'src/legacy.ts');

    const result = run(root, 'gate');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/legacy.ts: 81 lines (max 80)');

    expect(freezeLines(root)).toBe(1);
    const frozen = JSON.parse(
      readFileSync(join(root, '.devkit/baselines/size-lines.json'), 'utf8'),
    );
    expect(frozen).toMatchObject({
      lineCountVersion: 2,
      files: { 'src/legacy.ts': 80 },
    });
    gitAdd(root, '.devkit/baselines/size-lines.json');
    const afterFreeze = run(root, 'gate');
    expect(afterFreeze.status).toBe(1);
    expect(afterFreeze.stderr).toContain('src/legacy.ts: 81 lines (max 80)');
  });

  it('pull-request CI fails unavailable when its supplied base cannot be resolved', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/clean.ts', big(10));
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    const pr = spawnSync(process.execPath, [SCRIPT, 'gate'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GUARD_RATCHET_BASE: 'missing-base' },
    });
    expect(pr.status).toBe(2);
    expect(pr.stderr).toContain('pull-request base is unavailable');
  });

  it('automatic freezeLines stays monotone-down and never raises a recorded ceiling', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/legacy.ts', big(80)); // 80 lines on disk
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 60 } }),
    );
    expect(freezeLines(root)).toBe(1);
    const baseline = JSON.parse(
      readFileSync(join(root, '.devkit/baselines/size-lines.json'), 'utf8'),
    );
    expect(baseline.files['src/legacy.ts']).toBe(60); // stayed 60, NOT raised to 80
  });

  it('treats a line baseline without files as empty during gate and freeze', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/legacy.ts', big(80));
    write(root, '.devkit/baselines/size-lines.json', '{"maxLines":50}\n');

    const gate = run(root, 'gate');
    expect(gate.status).toBe(1);
    expect(gate.stderr).toContain('exceed their line limit');
    expect(gate.stderr).not.toContain('TypeError');
    expect(freezeLines(root)).toBe(1);
    expect(
      JSON.parse(readFileSync(join(root, '.devkit/baselines/size-lines.json'), 'utf8')).files,
    ).toEqual({ 'src/legacy.ts': 80 });
  });

  it('explicit guard-size freeze refreshes legitimate drift and names every raised ceiling', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/legacy.ts', big(80));
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 60 } }),
    );

    const result = run(root, 'freeze');

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('1 file(s) grew since the last freeze');
    expect(result.stdout).toContain('src/legacy.ts: 60 → 80');
    const baseline = JSON.parse(
      readFileSync(join(root, '.devkit/baselines/size-lines.json'), 'utf8'),
    );
    expect(baseline.files['src/legacy.ts']).toBe(80);
  });

  it('freezeLines grandfathers over-cap files into size-lines.json and NEVER touches size.json', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/legacy.ts', big(80));
    // A pre-existing disable-count baseline (as if adopted long ago). enabling the line cap on an
    // adopted repo must NOT re-snapshot this — that would launder any --no-verify disable growth.
    write(root, '.devkit/baselines/size.json', JSON.stringify({ fileDisables: 5, fnDisables: 3 }));
    const sizeBefore = readFileSync(join(root, '.devkit/baselines/size.json'), 'utf8');

    expect(freezeLines(root)).toBe(1);
    const lines = JSON.parse(readFileSync(join(root, '.devkit/baselines/size-lines.json'), 'utf8'));
    expect(lines).toEqual({
      lineCountVersion: 2,
      maxLines: 50,
      maxTestLines: 0,
      files: { 'src/legacy.ts': 80 },
    });
    // The disable-count baseline is byte-identical — freezeLines writes ONLY the line baseline.
    expect(readFileSync(join(root, '.devkit/baselines/size.json'), 'utf8')).toBe(sizeBefore);
  });

  it('freezeLines is a no-op (returns 0, writes nothing) when the cap is off', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'] }); // no maxLines
    write(root, 'src/huge.ts', big(900));
    expect(freezeLines(root)).toBe(0);
    expect(() => readFileSync(join(root, '.devkit/baselines/size-lines.json'), 'utf8')).toThrow();
  });
});

describe('per-file disable ratchet (auto-lower, migration, net-zero)', () => {
  const run = (root, cmd) =>
    spawnSync(process.execPath, [SCRIPT, cmd], { cwd: root, encoding: 'utf8' });
  const readBaseline = (root) =>
    JSON.parse(readFileSync(join(root, '.devkit/baselines/size.json'), 'utf8'));
  // n file-level `eslint-disable max-lines` directives in one file.
  const dis = (n) => `${Array(n).fill('/* eslint-disable max-lines */').join('\n')}\nexport {};\n`;

  it('a STAGED file whose disables partially shrink → gate auto-lowers its entry (no manual freeze)', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'] });
    write(root, 'src/a.ts', dis(2)); // 2 file-level disables
    run(root, 'freeze');
    expect(readBaseline(root).files['src/a.ts']).toEqual({ file: 2, fn: 0 });
    write(root, 'src/a.ts', dis(1)); // removed one disable
    gitAdd(root, 'src/a.ts');
    expect(run(root, 'gate').status).toBe(0);
    expect(readBaseline(root).files['src/a.ts']).toEqual({ file: 1, fn: 0 }); // ratcheted 2 → 1
  });

  it("a STAGED file's disables all heal → its entry is removed (baseline kept while others remain)", () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'] });
    write(root, 'src/a.ts', dis(1));
    write(root, 'src/b.ts', dis(1)); // a second grandfathered file keeps the baseline non-empty
    run(root, 'freeze');
    write(root, 'src/a.ts', 'export {};\n'); // healed
    gitAdd(root, 'src/a.ts');
    expect(run(root, 'gate').status).toBe(0);
    const baseline = readBaseline(root);
    expect(baseline.files).not.toHaveProperty('src/a.ts');
    expect(baseline.files['src/b.ts']).toEqual({ file: 1, fn: 0 }); // untouched
  });

  it('lowers the STAGED file only; a parallel unstaged shrink is not laundered in', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'] });
    write(root, 'src/x.ts', dis(2));
    write(root, 'src/y.ts', dis(2));
    run(root, 'freeze'); // x:2, y:2
    write(root, 'src/x.ts', dis(1)); // both shrink in the tree...
    write(root, 'src/y.ts', dis(1));
    gitAdd(root, 'src/x.ts'); // ...but only x is in THIS commit
    expect(run(root, 'gate').status).toBe(0);
    const baseline = readBaseline(root);
    expect(baseline.files['src/x.ts']).toEqual({ file: 1, fn: 0 }); // lowered
    expect(baseline.files['src/y.ts']).toEqual({ file: 2, fn: 0 }); // untouched — another agent's WIP
  });

  it('a net-zero disable SWAP (remove in A, add in B) now BLOCKS — per-file, not a global count', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'] });
    write(root, 'src/a.ts', dis(1));
    write(root, 'src/b.ts', 'export {};\n');
    run(root, 'freeze'); // { a: {1,0} } — global total 1
    write(root, 'src/a.ts', 'export {};\n'); // -1
    write(root, 'src/b.ts', dis(1)); // +1 → global total unchanged at 1
    gitAdd(root, 'src/a.ts', 'src/b.ts');
    const r = run(root, 'gate');
    expect(r.status).toBe(1); // a global-count ratchet would have passed; per-file catches B
    expect(r.stderr).toContain('may only SHRINK');
    expect(r.stderr).toContain('src/b.ts');
  });

  it('pull-request CI ignores inherited disable debt outside the diff', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'] });
    write(root, 'src/inherited.ts', dis(1));
    write(root, 'src/clean.ts', 'export {};\n');
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'base with inherited debt'], { cwd: root });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    write(root, 'src/clean.ts', 'export const clean = true;\n');
    gitAdd(root, 'src/clean.ts');
    execFileSync('git', ['commit', '-qm', 'unrelated PR change'], { cwd: root });

    expect(run(root, 'gate').status).toBe(1); // whole-tree audit retains the migration block
    const pr = spawnSync(process.execPath, [SCRIPT, 'gate'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GUARD_RATCHET_BASE: base },
    });
    expect(pr.status, pr.stderr).toBe(0);
    expect(pr.stderr).not.toContain('src/inherited.ts');
  });

  it('a stale {0,0} legacy baseline self-deletes + stages in a commit (the qavis case)', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'] });
    write(root, 'src/a.ts', 'export {};\n'); // no disables anywhere
    write(root, '.devkit/baselines/size.json', JSON.stringify({ fileDisables: 0, fnDisables: 0 }));
    gitAdd(root, 'src/a.ts', '.devkit/baselines/size.json');
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root });
    write(root, 'src/a.ts', 'export const x = 1;\n'); // an ordinary staged change
    gitAdd(root, 'src/a.ts');
    const r = run(root, 'gate');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('removed & staged');
    expect(() => readBaseline(root)).toThrow(); // gone
    const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=D'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(staged).toContain('.devkit/baselines/size.json');
  });

  it('a legacy baseline with REAL disables blocks with a migrate hint (never silently un-grandfathers)', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src'] });
    write(root, 'src/a.ts', dis(1)); // a real, grandfathered-in-old-format disable
    write(root, '.devkit/baselines/size.json', JSON.stringify({ fileDisables: 1, fnDisables: 0 }));
    const r = run(root, 'gate');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('pre-per-file baseline');
    expect(r.stderr).toContain('guard-size freeze');
  });

  it('a legacy baseline is NOT deleted by an unrelated commit — an UNSTAGED real disable still blocks', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'] });
    write(root, 'src/a.ts', dis(1)); // a real disable — stays UNSTAGED
    write(root, 'src/b.ts', 'export {};\n');
    write(root, '.devkit/baselines/size.json', JSON.stringify({ fileDisables: 1, fnDisables: 0 }));
    gitAdd(root, 'src/a.ts', 'src/b.ts', '.devkit/baselines/size.json');
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root });
    write(root, 'src/b.ts', 'export const x = 1;\n'); // ordinary change to an UNRELATED file
    gitAdd(root, 'src/b.ts'); // only b is staged; a.ts (with the disable) is not
    const r = run(root, 'gate');
    expect(r.status).toBe(1); // must block on the whole-tree disable, never staged-scope past it
    expect(r.stderr).toContain('pre-per-file baseline');
    expect(() => readBaseline(root)).not.toThrow(); // size.json is NOT deleted
  });

  it('pull-request CI still blocks a legacy baseline until its disables are migrated', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'] });
    write(root, 'src/inherited.ts', dis(1));
    write(root, 'src/clean.ts', 'export {};\n');
    write(root, '.devkit/baselines/size.json', JSON.stringify({ fileDisables: 1, fnDisables: 0 }));
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'legacy baseline'], { cwd: root });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    write(root, 'src/clean.ts', 'export const clean = true;\n');
    gitAdd(root, 'src/clean.ts');
    execFileSync('git', ['commit', '-qm', 'unrelated PR change'], { cwd: root });

    const r = spawnSync(process.execPath, [SCRIPT, 'gate'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GUARD_RATCHET_BASE: base },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('pre-per-file baseline');
    expect(r.stderr).toContain('guard-size freeze');
  });

  it('a legacy baseline migrates to per-file shape on `guard-size freeze`', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src'] });
    write(root, 'src/a.ts', dis(1));
    write(root, '.devkit/baselines/size.json', JSON.stringify({ fileDisables: 1, fnDisables: 0 }));
    expect(run(root, 'freeze').status).toBe(0);
    expect(readBaseline(root)).toEqual({ files: { 'src/a.ts': { file: 1, fn: 0 } } });
    expect(run(root, 'gate').status).toBe(0); // now recognised, passes
  });

  it('freeze is monotone-down per file: never raises a recorded count (anti-laundering)', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src'] });
    write(root, 'src/a.ts', dis(2)); // 2 disables on disk
    // Pre-seed a lower ceiling as if a --no-verify growth is being re-frozen.
    write(
      root,
      '.devkit/baselines/size.json',
      JSON.stringify({ files: { 'src/a.ts': { file: 1, fn: 0 } } }),
    );
    expect(run(root, 'freeze').status).toBe(0);
    expect(readBaseline(root).files['src/a.ts']).toEqual({ file: 1, fn: 0 }); // stayed 1, NOT raised to 2
  });
});
