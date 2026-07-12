import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
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
  execFileSync('git', ['init', '-q'], { cwd: root });
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
    const frozen = JSON.parse(readFileSync(join(root, 'eslint/baselines/size.json'), 'utf8'));
    expect(frozen).toEqual({ files: { 'src/a.ts': { file: 1, fn: 0 } } });
    expect(run(root, 'gate').status).toBe(0);
  });

  it('writes the baseline under the CONSUMER cwd, not the package dir (W-3)', () => {
    const root = makeRoot();
    write(root, 'src/a.ts', '/* eslint-disable max-lines */\nexport {};\n');
    expect(run(root, 'freeze').status).toBe(0);
    expect(() => readFileSync(join(root, 'eslint/baselines/size.json'), 'utf8')).not.toThrow();
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
    expect(() => readFileSync(join(root, 'eslint/baselines/size.json'), 'utf8')).toThrow();
  });

  it('freeze deletes a stale empty baseline once the last disable heals', () => {
    const root = makeRoot();
    write(root, 'src/a.ts', '/* eslint-disable max-lines */\nexport {};\n');
    run(root, 'freeze'); // size.json = {1,0}
    write(root, 'src/a.ts', 'export {};\n'); // healed
    expect(run(root, 'freeze').status).toBe(0);
    expect(() => readFileSync(join(root, 'eslint/baselines/size.json'), 'utf8')).toThrow();
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
    gitAdd(root, 'src/a.ts', 'eslint/baselines/size.json'); // baseline is committed → tracked
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root });
    write(root, 'src/a.ts', 'export {};\n'); // healed
    gitAdd(root, 'src/a.ts');
    const r = run(root, 'gate');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('removed & staged');
    expect(() => readFileSync(join(root, 'eslint/baselines/size.json'), 'utf8')).toThrow();
    // the deletion rides this commit
    const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=D'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(staged).toContain('eslint/baselines/size.json');
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
      readFileSync(join(root, 'eslint/baselines/size-lines.json'), 'utf8'),
    );
    expect(baseline.files['src/legacy.ts']).toBe(80);
    expect(run(root, 'gate').status).toBe(0); // grandfathered → allowed
    write(root, 'src/fresh.ts', big(70)); // NEW over-cap → blocked
    const r = run(root, 'gate');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('exceed their line limit');
    expect(r.stderr).toContain('src/fresh.ts: 70 lines (max 50)');
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
      readFileSync(join(root, 'eslint/baselines/size-lines.json'), 'utf8'),
    );
    expect(baseline.files['src/legacy.ts']).toBe(60); // ceiling ratcheted down 80 → 60
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
      readFileSync(join(root, 'eslint/baselines/size-lines.json'), 'utf8'),
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
    expect(() => readFileSync(join(root, 'eslint/baselines/size-lines.json'), 'utf8')).toThrow();
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
      readFileSync(join(root, 'eslint/baselines/size-lines.json'), 'utf8'),
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
    expect(run(root, 'gate').status).toBe(0); // y's unstaged growth must not block x's commit
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
      readFileSync(join(root, 'eslint/baselines/size-lines.json'), 'utf8'),
    );
    expect(baseline.files['src/legacy.ts']).toBe(80); // unchanged — no mutation without a commit
  });

  it('freeze is monotone-down: never raises a recorded ceiling (anti-laundering)', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/legacy.ts', big(80)); // 80 lines on disk
    // Pre-seed a lower ceiling as if a --no-verify growth is now being re-frozen.
    write(
      root,
      'eslint/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 60 } }),
    );
    expect(run(root, 'freeze').status).toBe(0);
    const baseline = JSON.parse(
      readFileSync(join(root, 'eslint/baselines/size-lines.json'), 'utf8'),
    );
    expect(baseline.files['src/legacy.ts']).toBe(60); // stayed 60, NOT raised to 80
  });

  it('freezeLines grandfathers over-cap files into size-lines.json and NEVER touches size.json', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 });
    write(root, 'src/legacy.ts', big(80));
    // A pre-existing disable-count baseline (as if adopted long ago). enabling the line cap on an
    // adopted repo must NOT re-snapshot this — that would launder any --no-verify disable growth.
    write(root, 'eslint/baselines/size.json', JSON.stringify({ fileDisables: 5, fnDisables: 3 }));
    const sizeBefore = readFileSync(join(root, 'eslint/baselines/size.json'), 'utf8');

    expect(freezeLines(root)).toBe(1);
    const lines = JSON.parse(readFileSync(join(root, 'eslint/baselines/size-lines.json'), 'utf8'));
    expect(lines).toEqual({ maxLines: 50, files: { 'src/legacy.ts': 80 } });
    // The disable-count baseline is byte-identical — freezeLines writes ONLY the line baseline.
    expect(readFileSync(join(root, 'eslint/baselines/size.json'), 'utf8')).toBe(sizeBefore);
  });

  it('freezeLines is a no-op (returns 0, writes nothing) when the cap is off', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'] }); // no maxLines
    write(root, 'src/huge.ts', big(900));
    expect(freezeLines(root)).toBe(0);
    expect(() => readFileSync(join(root, 'eslint/baselines/size-lines.json'), 'utf8')).toThrow();
  });
});

describe('per-file disable ratchet (auto-lower, migration, net-zero)', () => {
  const run = (root, cmd) =>
    spawnSync(process.execPath, [SCRIPT, cmd], { cwd: root, encoding: 'utf8' });
  const readBaseline = (root) =>
    JSON.parse(readFileSync(join(root, 'eslint/baselines/size.json'), 'utf8'));
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

  it('a stale {0,0} legacy baseline self-deletes + stages in a commit (the qavis case)', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['src'] });
    write(root, 'src/a.ts', 'export {};\n'); // no disables anywhere
    write(root, 'eslint/baselines/size.json', JSON.stringify({ fileDisables: 0, fnDisables: 0 }));
    gitAdd(root, 'src/a.ts', 'eslint/baselines/size.json');
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
    expect(staged).toContain('eslint/baselines/size.json');
  });

  it('a legacy baseline with REAL disables blocks with a migrate hint (never silently un-grandfathers)', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src'] });
    write(root, 'src/a.ts', dis(1)); // a real, grandfathered-in-old-format disable
    write(root, 'eslint/baselines/size.json', JSON.stringify({ fileDisables: 1, fnDisables: 0 }));
    const r = run(root, 'gate');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('pre-per-file baseline');
    expect(r.stderr).toContain('guard-size freeze');
  });

  it('a legacy baseline migrates to per-file shape on `guard-size freeze`', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src'] });
    write(root, 'src/a.ts', dis(1));
    write(root, 'eslint/baselines/size.json', JSON.stringify({ fileDisables: 1, fnDisables: 0 }));
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
      'eslint/baselines/size.json',
      JSON.stringify({ files: { 'src/a.ts': { file: 1, fn: 0 } } }),
    );
    expect(run(root, 'freeze').status).toBe(0);
    expect(readBaseline(root).files['src/a.ts']).toEqual({ file: 1, fn: 0 }); // stayed 1, NOT raised to 2
  });
});
