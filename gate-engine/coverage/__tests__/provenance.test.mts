/** Coverage artifact provenance (sc-3225) end to end over real git repos: a briefed production edit
 * after the run fails closed, test drift warns, and unknown provenance never reads as fresh. */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishCoverage } from '../produce.mts';
import {
  checkProvenance,
  MANIFEST_NAME,
  readArtifact,
  readManifest,
  sha256,
  snapshotSource,
  TOUCHED,
} from '../provenance.mts';
import { CLI, testSpawnSync } from '../../../cli/__tests__/_helpers.mts';
import {
  COV,
  cleanupRepos,
  gate,
  git,
  measure,
  repo,
  stage,
  write,
} from './_provenance-fixtures.mts';

beforeEach(() => {
  vi.stubEnv('GUARD_COVERAGE_OK', '');
  vi.stubEnv('GUARD_NO_COVERAGE', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  cleanupRepos();
});

describe('producer — the manifest', () => {
  it('records HEAD, modified/untracked/deleted paths, and the published artifact hash', () => {
    const { root } = repo();
    write(root, 'src/a.mts', 'export const a = 2;\n');
    write(root, 'src/new.mts', 'export const n = 1;\n');
    unlinkSync(join(root, 'README.md'));
    measure(root);
    const m = readManifest(join(root, 'coverage'));
    expect(m?.head).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(m?.dirty['src/a.mts']).toBe(git(root, 'hash-object', 'src/a.mts'));
    expect(m?.dirty['src/new.mts']).toBe(git(root, 'hash-object', 'src/new.mts'));
    expect(m?.dirty['README.md']).toBe('deleted');
    expect(m?.artifactSha256).toBe(
      sha256(readFileSync(join(root, 'coverage/coverage-final.json'))),
    );
  });

  it('a run that CLEARS the artifact never deletes a manifest (a sibling may have just published one)', () => {
    const { root } = repo();
    measure(root);
    const sibling = readManifest(join(root, 'coverage'));
    const mtime = statSync(join(root, 'coverage/coverage-final.json')).mtimeMs;
    const runDir = join(root, 'coverage', '.runs', 'failed');
    mkdirSync(runDir, { recursive: true });
    expect(publishCoverage(runDir, root, mtime, null)).toBe('cleared');
    expect(readManifest(join(root, 'coverage'))).toEqual(sibling);
  });

  it('a stale manifest left beside a newer artifact reads as unknown, never fresh', () => {
    const { root } = repo();
    measure(root);
    measure(root, null, `${COV}\n`); // no snapshot: new bytes, old manifest stays
    write(root, 'src/a.mts', 'export const a = 3;\n');
    stage(root);
    const { code, out } = gate(root);
    expect(code).toBe(0);
    expect(out).toContain('the artifact was replaced');
  });
});

describe('gate — provenance of a passing artifact', () => {
  it('fresh: briefed edits made BEFORE the run pass and name the run', () => {
    const { root } = repo();
    write(root, 'src/a.mts', 'export const a = 2;\n');
    measure(root);
    stage(root);
    const { code, out } = gate(root);
    expect(code).toBe(0);
    expect(out).toMatch(
      /✓ Coverage gate passed \(.*\) — artifact run run-\d+, measured \d+m ago\./,
    );
    expect(out).not.toMatch(/predates|provenance unknown/);
  });

  it('a briefed PRODUCTION edit after the run fails closed and lists the file', () => {
    const { root } = repo();
    measure(root);
    write(root, 'src/a.mts', 'export const a = 3;\n');
    stage(root);
    const { code, out } = gate(root);
    expect(code).toBe(1);
    expect(out).toContain('coverage artifact predates 1 briefed file(s):');
    expect(out).toContain('src/a.mts');
    expect(out).toMatch(/ {3}read \/.*\/coverage\/coverage-final\.json/); // sc-3491: names the artifact
    expect(out).toContain('GUARD_COVERAGE_OK=1');
    expect(out).not.toContain('✓ Coverage gate passed');
  });

  it('test-only drift warns and passes', () => {
    const { root } = repo();
    measure(root);
    write(root, 'src/a.test.mts', 'test("b", () => {});\n');
    write(root, 'src/__tests__/helper.mts', 'export const h = 1;\n');
    stage(root);
    const { code, out } = gate(root);
    expect(code).toBe(0);
    expect(out).toContain('predates 2 briefed test file(s)');
    expect(out).toContain('✓ Coverage gate passed');
  });

  it('non-source drift (docs, json) is ignored', () => {
    const { root } = repo();
    measure(root);
    write(root, 'README.md', '# changed\n');
    write(root, 'baseline.json', '{}\n');
    stage(root);
    const { code, out } = gate(root);
    expect(code).toBe(0);
    expect(out).not.toMatch(/predates/);
  });

  it('a formatter rewrite after the run is drift, and the block says to format first', () => {
    const { root } = repo();
    write(root, 'src/a.mts', 'export const a=2\n');
    measure(root);
    stage(root);
    // What the hook's formatter does before the gate runs: judged like any other post-run change.
    write(root, 'src/a.mts', 'export const a = 2;\n');
    git(root, 'add', 'src/a.mts');
    const { code, out } = gate(root);
    expect(code).toBe(1);
    expect(out).toContain('Run the formatter before coverage');
  });

  it('a file staged after everything else is still in the briefed set', () => {
    const { root } = repo();
    measure(root);
    stage(root);
    write(root, 'src/late.mts', 'export const l = 1;\n');
    git(root, 'add', 'src/late.mts');
    expect(gate(root).code).toBe(1);
  });

  it('new and deleted briefed production files are drift', () => {
    const { root } = repo();
    measure(root);
    write(root, 'src/new.mts', 'export const n = 1;\n');
    unlinkSync(join(root, 'src/a.mts'));
    stage(root);
    const { code, out } = gate(root);
    expect(code).toBe(1);
    expect(out).toContain('predates 2 briefed file(s)');
  });

  it('HEAD moved after the run (a commit), briefed file unchanged since: fresh', () => {
    const { root } = repo();
    const base = git(root, 'rev-parse', 'HEAD');
    write(root, 'src/a.mts', 'export const a = 5;\n');
    git(root, 'commit', '-qam', 'edit');
    measure(root);
    // The ship worktree sits at the base with the briefed content staged on top.
    git(root, 'reset', '-q', '--soft', base);
    stage(root);
    expect(gate(root).code).toBe(0);
  });

  it('a monorepo package cwd keys paths to the repo root', () => {
    const { root, cwd } = repo('pkg');
    measure(cwd);
    write(root, 'pkg/src/a.mts', 'export const a = 9;\n');
    stage(root);
    const { code, out } = gate(cwd);
    expect(code).toBe(1);
    expect(out).toContain('src/a.mts');
  });
});

describe('gate — provenance it cannot establish passes out loud', () => {
  it('no manifest (plain vitest --coverage)', () => {
    const { root } = repo();
    measure(root);
    rmSync(join(root, 'coverage', MANIFEST_NAME));
    write(root, 'src/a.mts', 'export const a = 3;\n');
    stage(root);
    const { code, out } = gate(root);
    expect(code).toBe(0);
    expect(out).toContain('provenance unknown (no manifest');
    expect(out).not.toContain('artifact run');
  });

  it('a BYTE-IDENTICAL artifact from another write is unknown, never the old run', () => {
    const { root } = repo();
    measure(root);
    const file = join(root, 'coverage/coverage-final.json');
    const bytes = readFileSync(file);
    writeFileSync(`${file}.tmp`, bytes);
    renameSync(`${file}.tmp`, file); // same bytes, a different file — as a plain vitest run leaves
    stage(root);
    const { code, out } = gate(root);
    expect(code).toBe(0);
    expect(out).toContain('the artifact was replaced');
    expect(out).not.toContain('artifact run');
  });

  it('artifact replaced after its manifest (hash mismatch)', () => {
    const { root } = repo();
    measure(root);
    writeFileSync(join(root, 'coverage/coverage-final.json'), `${COV}\n`);
    stage(root);
    const { code, out } = gate(root);
    expect(code).toBe(0);
    expect(out).toContain('the artifact was replaced');
  });

  it('a manifest HEAD git cannot resolve is unknown, never fresh', () => {
    const { root } = repo();
    measure(root);
    const file = join(root, 'coverage', MANIFEST_NAME);
    const m = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...m, head: 'deadbeef'.repeat(5) }));
    write(root, 'src/a.mts', 'export const a = 3;\n');
    stage(root);
    const cov = readArtifact(join(root, 'coverage/coverage-final.json'));
    expect(checkProvenance(root, join(root, 'coverage'), cov, () => 'production').state).toBe(
      'unknown',
    );
  });

  it('GUARD_COVERAGE_OK still wins over a production drift', () => {
    const { root } = repo();
    measure(root);
    write(root, 'src/a.mts', 'export const a = 3;\n');
    stage(root);
    vi.stubEnv('GUARD_COVERAGE_OK', '1');
    expect(gate(root).code).toBe(0);
  });
});

describe('telemetry', () => {
  it('emits one coverage_provenance event carrying the state', () => {
    const { root } = repo();
    const sink = join(root, 'events.jsonl');
    vi.stubEnv('DEVKIT_GATE_EVENTS', sink);
    measure(root);
    write(root, 'src/a.mts', 'export const a = 3;\n');
    stage(root);
    gate(root);
    const events = readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'coverage_provenance');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ state: 'drift', production_count: 1, test_count: 0 });
  });
});

/** An istanbul report measuring `files` (absolute paths, as a real run in `root` would key them). */
const covFor = (root: string, ...files: string[]) =>
  JSON.stringify(
    Object.fromEntries(
      files.map((f) => [
        join(root, f),
        { statementMap: { '0': { start: { line: 1 } } }, s: { '0': 1 }, f: {}, b: {} },
      ]),
    ),
  );

describe('edge cases — which briefed paths a package gate owns', () => {
  it('a monorepo package gate ignores drift in a sibling package it never measured', () => {
    const { root, cwd } = repo('pkg');
    write(root, 'other/src/b.mts', 'export const b = 1;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'sibling');
    measure(cwd);
    write(root, 'other/src/b.mts', 'export const b = 2;\n');
    stage(root);
    const { code, out } = gate(cwd);
    expect(code).toBe(0);
    expect(out).not.toMatch(/predates/);
  });

  it('…but a sibling file the package artifact DID measure (workspace import) still blocks', () => {
    const { root, cwd } = repo('pkg');
    write(root, 'shared/src/util.mts', 'export const u = 1;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'shared');
    measure(cwd, snapshotSource(cwd), covFor(root, 'pkg/src/a.mts', 'shared/src/util.mts'));
    write(root, 'shared/src/util.mts', 'export const u = 2;\n');
    stage(root);
    const { code, out } = gate(cwd);
    expect(code).toBe(1);
    expect(out).toContain('shared/src/util.mts');
  });

  it('a root file sharing a measured file\'s tail (src/a.mts vs pkg/src/a.mts) is not "measured"', () => {
    const { root, cwd } = repo('pkg');
    write(root, 'src/a.mts', 'export const rootA = 1;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'root copy');
    measure(cwd, snapshotSource(cwd), covFor(root, 'pkg/src/a.mts'));
    write(root, 'src/a.mts', 'export const rootA = 2;\n');
    stage(root);
    expect(gate(cwd).code).toBe(0);
  });

  it('a measured source outside sourceExtensions still blocks (default config, .js sources)', () => {
    const { root } = repo();
    // No sourceExtensions: the default is ts/tsx, which a .js consumer never configured away from.
    writeFileSync(join(root, 'guard.config.json'), JSON.stringify({ coverage: {} }));
    write(root, 'lib/index.js', 'module.exports = 1;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'js');
    measure(root, snapshotSource(root), covFor(root, 'lib/index.js'));
    write(root, 'lib/index.js', 'module.exports = 2;\n');
    stage(root);
    const { code, out } = gate(root);
    expect(code).toBe(1);
    expect(out).toContain('lib/index.js');
  });
});

describe('edge cases — real-world staging shapes', () => {
  it('a partially staged file: the committed hunk is not what coverage measured → drift', () => {
    const { root } = repo();
    measure(root); // measured HEAD content
    write(root, 'src/a.mts', 'export const a = 2;\n');
    git(root, 'add', 'src/a.mts');
    write(root, 'src/a.mts', 'export const a = 1;\n'); // working tree back to what was measured
    expect(gate(root).code).toBe(1);
  });

  it('edits left UNSTAGED after the run do not matter: the committed blob was measured', () => {
    const { root } = repo();
    write(root, 'src/a.mts', 'export const a = 2;\n');
    measure(root);
    git(root, 'add', 'src/a.mts');
    write(root, 'src/a.mts', 'export const a = 99;\n');
    expect(gate(root).code).toBe(0);
  });

  it('paths with pathspec magic, spaces and non-ASCII bytes are compared literally', () => {
    const { root } = repo();
    const odd = ['src/[id].mts', 'src/my file.mts', 'src/café.mts', 'src/*.mts'];
    for (const f of odd) write(root, f, 'export const x = 1;\n');
    measure(root);
    stage(root);
    expect(gate(root).code).toBe(0); // measured as-is → fresh
    for (const f of odd) write(root, f, 'export const x = 2;\n');
    stage(root);
    const { code, out } = gate(root);
    expect(code).toBe(1);
    expect(out).toContain(`predates ${odd.length} briefed file(s)`);
  });

  it('eol normalisation (CRLF working copy, eol=lf attributes) is not drift', () => {
    const { root } = repo();
    write(root, '.gitattributes', '* text eol=lf\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'attrs');
    write(root, 'src/a.mts', 'export const a = 2;\r\n');
    measure(root);
    stage(root);
    expect(gate(root).code).toBe(0);
  });
});

describe('edge cases — concurrent producers', () => {
  it("a run whose failure KEEPS a sibling's artifact leaves that sibling's manifest intact", () => {
    const { root } = repo();
    measure(root); // the sibling that succeeded
    const sibling = readManifest(join(root, 'coverage'));
    const runDir = join(root, 'coverage', '.runs', 'ours-failed');
    mkdirSync(runDir, { recursive: true });
    // before === null: the artifact appeared during our run, so it is the sibling's.
    expect(publishCoverage(runDir, root, null, null)).toBe('kept');
    expect(readManifest(join(root, 'coverage'))).toEqual(sibling);
  });
});

describe('edge cases — wiring through the real coverage-run CLI', () => {
  it('a source file edited WHILE vitest runs counts as unmeasured', () => {
    const { root } = repo();
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    write(root, '.gitignore', 'coverage/\nnode_modules/\n');
    // A vitest stand-in that edits a source file mid-run, then emits a report.
    const stub = join(root, 'node_modules', '.bin', 'vitest');
    writeFileSync(
      stub,
      [
        '#!/bin/sh',
        '[ "$1" = "--version" ] && { echo "vitest/4.1.10"; exit 0; }',
        'for a in "$@"; do case $a in --coverage.reportsDirectory=*) d=${a#*=};; esac; done',
        `echo 'export const a = 7;' > src/a.mts`,
        `mkdir -p "$d"; printf '%s' '${COV}' > "$d/coverage-final.json"`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const run = testSpawnSync(process.execPath, [CLI, 'coverage-run'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(readManifest(join(root, 'coverage'))?.dirty['src/a.mts']).toBe(TOUCHED);
    stage(root);
    const { code, out } = gate(root);
    expect(code).toBe(1);
    expect(out).toContain('src/a.mts');
  });

  it('a file edited and RESTORED while vitest runs is still unmeasured (start hashes match)', () => {
    const { root } = repo();
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    write(root, '.gitignore', 'coverage/\nnode_modules/\n');
    write(root, 'src/a.mts', 'export const a = 5;\n'); // briefed content, dirty at the start
    // A vitest stand-in that rewrites the file mid-run and puts the start bytes back.
    const stub = join(root, 'node_modules', '.bin', 'vitest');
    writeFileSync(
      stub,
      [
        '#!/bin/sh',
        '[ "$1" = "--version" ] && { echo "vitest/4.1.10"; exit 0; }',
        'for a in "$@"; do case $a in --coverage.reportsDirectory=*) d=${a#*=};; esac; done',
        `echo 'export const a = 7;' > src/a.mts`,
        `echo 'export const a = 5;' > src/a.mts`,
        `mkdir -p "$d"; printf '%s' '${COV}' > "$d/coverage-final.json"`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const run = testSpawnSync(process.execPath, [CLI, 'coverage-run'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(readManifest(join(root, 'coverage'))?.dirty['src/a.mts']).toBe(TOUCHED);
    stage(root); // committed bytes == the start hash, yet not what coverage necessarily read
    const { code, out } = gate(root);
    expect(code).toBe(1);
    expect(out).toContain('src/a.mts');
  });

  it('a file deleted before the run, recreated and measured mid-run, then removed again is unmeasured', () => {
    const { root } = repo();
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    write(root, '.gitignore', 'coverage/\nnode_modules/\n');
    unlinkSync(join(root, 'src/a.mts')); // deleted at the start: the snapshot records 'deleted'
    // A vitest stand-in that recreates the file, measures it, and removes it again.
    const stub = join(root, 'node_modules', '.bin', 'vitest');
    writeFileSync(
      stub,
      [
        '#!/bin/sh',
        '[ "$1" = "--version" ] && { echo "vitest/4.1.10"; exit 0; }',
        'for a in "$@"; do case $a in --coverage.reportsDirectory=*) d=${a#*=};; esac; done',
        `echo 'export const a = 7;' > src/a.mts`,
        `mkdir -p "$d"; printf '{"%s/src/a.mts":%s}' "$PWD" '${JSON.stringify(Object.values(JSON.parse(COV))[0])}' > "$d/coverage-final.json"`,
        'rm src/a.mts',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const run = testSpawnSync(process.execPath, [CLI, 'coverage-run'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(readManifest(join(root, 'coverage'))?.dirty['src/a.mts']).toBe(TOUCHED);
    stage(root); // commits the deletion the snapshot recorded — yet the report measured the file
    const { code, out } = gate(root);
    expect(code).toBe(1);
    expect(out).toContain('src/a.mts');
  });
});
