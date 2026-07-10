/**
 * Session-scoped in-flight hook errors (session-edits-lib.sh + its writer/readers).
 *
 * In a shared checkout, parallel Claude sessions previously blocked each other: the Stop hooks
 * (lint-check / knip-check / decision-stop-check) reported REPO-WIDE errors, so a session that
 * merely replied to the user got blocked at stop by another session's in-flight breakage. These
 * tests pin the new contract: format-after-edit.sh records every edit in a per-session ledger
 * ($TMPDIR/devkit-session-edits/<REPO_KEY>-<session_id>); the Stop hooks report only errors in
 * ledger files and FAIL-OPEN (exit 0) for a session with no edits or a partially-synced consumer
 * missing the lib. The commit/ship gate chain stays repo-wide and is untouched.
 *
 * Lives under cli/ because vitest's include glob is ['gate-engine/**\/*.test.mjs','cli/**\/*.test.mjs'].
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { repoKey, rootRegistry, seedSessionLedger } from './_helpers.mts';

const AGENTS_HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agents-hooks');
const LIB = join(AGENTS_HOOKS, 'session-edits-lib.sh');
const FORMAT_HOOK = join(AGENTS_HOOKS, 'format-after-edit.sh');
const LINT_HOOK = join(AGENTS_HOOKS, 'lint-check.sh');
const DECISION_HOOK = join(AGENTS_HOOKS, 'decision-stop-check.sh');

const HAS_BUN = spawnSync('bash', ['-c', 'command -v bun'], { encoding: 'utf8' }).status === 0;

const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

const write = (root, rel, body = 'export {};\n') => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};
const writeExec = (root, rel, body) => {
  write(root, rel, body);
  chmodSync(join(root, rel), 0o755);
};

const runHook = (hook, root, payload, tmp) =>
  spawnSync('bash', [hook], {
    input: JSON.stringify(payload),
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: root,
      TMPDIR: tmp,
      GUARD_NO_LOG: '',
      FRINK_NO_LOG: '',
    },
    encoding: 'utf8',
  });

describe('format-after-edit.sh — session-edits ledger writer', () => {
  it('records the repo-relative path keyed by the payload session_id', () => {
    const root = mkTmp('sesw-');
    write(root, 'src/mine.ts');
    const tmp = seedSessionLedger(root, 's1', null); // isolated TMPDIR, no ledger yet
    const r = runHook(
      FORMAT_HOOK,
      root,
      { session_id: 's1', file_path: join(root, 'src/mine.ts') },
      tmp,
    );
    expect(r.status).toBe(0);
    const ledger = join(tmp, 'devkit-session-edits', `${repoKey(root)}-s1`);
    expect(readFileSync(ledger, 'utf8')).toBe('src/mine.ts\n');
  });

  it('never records a file outside CLAUDE_PROJECT_DIR (sibling-checkout guard)', () => {
    const root = mkTmp('sesw-');
    const other = mkTmp('sesw-other-');
    write(other, 'src/theirs.ts');
    const tmp = seedSessionLedger(root, 's1', null);
    const r = runHook(
      FORMAT_HOOK,
      root,
      { session_id: 's1', file_path: join(other, 'src/theirs.ts') },
      tmp,
    );
    expect(r.status).toBe(0);
    expect(existsSync(join(tmp, 'devkit-session-edits', `${repoKey(root)}-s1`))).toBe(false);
  });
});

// Two eslint-stylish blocks (absolute-path headers, indented error rows) — the shape a real
// `lint:structure` failure has. The filter must keep the WHOLE block of a session file (header
// AND rows) and drop the other block entirely.
const structureStub = (root) =>
  [
    `echo "${join(root, 'src/mine.ts')}"`,
    'echo "  3:1  error  max-lines  MINE_ROW"',
    `echo "${join(root, 'src/other.ts')}"`,
    'echo "  9:1  error  max-lines  OTHER_ROW"',
    'exit 1',
  ].join('\n');

const lintFixture = () => {
  const root = mkTmp('sesl-');
  write(root, 'src/mine.ts');
  write(root, 'src/other.ts');
  write(root, 'structure-stub.sh', structureStub(root));
  write(
    root,
    'package.json',
    JSON.stringify({
      name: 'fx',
      version: '0.0.0',
      scripts: { 'lint:structure': 'bash structure-stub.sh' },
    }),
  );
  return root;
};

describe.skipIf(!HAS_BUN)('lint-check.sh — session scoping', () => {
  it('fail-open: a session with no recorded edits is never blocked, even with repo-wide breakage', () => {
    const root = lintFixture();
    const r = runHook(
      LINT_HOOK,
      root,
      { session_id: 's2' },
      seedSessionLedger(root, 's1', ['src/mine.ts']),
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it("reports only the session file's stylish block (header + indented rows), not the other block", () => {
    const root = lintFixture();
    const r = runHook(
      LINT_HOOK,
      root,
      { session_id: 's1' },
      seedSessionLedger(root, 's1', ['src/mine.ts']),
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('src/mine.ts');
    expect(r.stderr).toContain('MINE_ROW');
    expect(r.stderr).not.toContain('OTHER_ROW');
    expect(r.stderr).not.toContain('src/other.ts');
  });

  it('passes when every violation belongs to files another session edited', () => {
    const root = lintFixture();
    write(root, 'src/untouched.ts');
    const r = runHook(
      LINT_HOOK,
      root,
      { session_id: 's1' },
      seedSessionLedger(root, 's1', ['src/untouched.ts']),
    );
    expect(r.status).toBe(0);
  });

  it('blank ledger lines never wildcard the filter back to repo-wide', () => {
    const root = lintFixture();
    write(root, 'src/untouched.ts');
    const tmp = seedSessionLedger(root, 's1', ['', 'src/untouched.ts', '']);
    const r = runHook(LINT_HOOK, root, { session_id: 's1' }, tmp);
    expect(r.status).toBe(0);
  });

  it("runs biome on the session's edited (biome-supported) files only", () => {
    const root = mkTmp('sesb-');
    write(root, 'src/mine.ts');
    write(root, 'src/other.ts');
    write(root, 'notes.md', '# notes\n');
    write(root, 'package.json', JSON.stringify({ name: 'fx', version: '0.0.0' }));
    writeExec(
      root,
      'node_modules/.bin/biome',
      '#!/bin/sh\necho "BIOME_ARGS: $@" > biome-args.txt\nexit 0\n',
    );
    const tmp = seedSessionLedger(root, 's1', ['src/mine.ts', 'notes.md']);
    const r = runHook(LINT_HOOK, root, { session_id: 's1' }, tmp);
    expect(r.status).toBe(0);
    const args = readFileSync(join(root, 'biome-args.txt'), 'utf8');
    expect(args).toContain('src/mine.ts');
    expect(args).not.toContain('src/other.ts');
    expect(args).not.toContain('notes.md'); // not a biome-supported extension
  });

  it('fail-open when session-edits-lib.sh is missing (sync-hooks --only partial install)', () => {
    const root = lintFixture();
    const hookDir = mkTmp('seslib-');
    writeFileSync(join(hookDir, 'lint-check.sh'), readFileSync(LINT_HOOK, 'utf8'));
    const r = runHook(
      join(hookDir, 'lint-check.sh'),
      root,
      { session_id: 's1' },
      seedSessionLedger(root, 's1', ['src/mine.ts']),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('{}');
  });

  it('REPO_KEY parity: a ledger written by format-after-edit.sh is found by lint-check.sh', () => {
    const root = lintFixture();
    const tmp = seedSessionLedger(root, 's1', null);
    runHook(FORMAT_HOOK, root, { session_id: 's1', file_path: join(root, 'src/mine.ts') }, tmp);
    const r = runHook(LINT_HOOK, root, { session_id: 's1' }, tmp);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('MINE_ROW');
  });
});

describe('filter_output_to_session_files — matching edge cases', () => {
  const filter = (root, ledgerLines, output) => {
    write(root, 'ledger.txt', `${ledgerLines.join('\n')}\n`);
    write(root, 'output.txt', `${output.join('\n')}\n`);
    return spawnSync(
      'bash',
      ['-c', `source "${LIB}" && filter_output_to_session_files ledger.txt < output.txt`],
      { cwd: root, encoding: 'utf8' },
    ).stdout;
  };

  it('anchors on path boundaries: a.mts never matches a.mts.bak', () => {
    const root = mkTmp('sesf-');
    const out = filter(root, ['a.mts'], ['a.mts.bak: BAK_ERR', 'a.mts: REAL_ERR']);
    expect(out).toContain('REAL_ERR');
    expect(out).not.toContain('BAK_ERR');
  });

  it('matches a trailing path in a knip-style row', () => {
    const root = mkTmp('sesf-');
    const out = filter(
      root,
      ['src/mine.ts'],
      ['deadFn  src/mine.ts:3:1', 'deadFn  src/other.ts:9:1'],
    );
    expect(out).toContain('src/mine.ts:3:1');
    expect(out).not.toContain('src/other.ts');
  });

  it('normalizes absolute and ./-prefixed paths against the relative ledger', () => {
    const root = mkTmp('sesf-');
    const out = filter(
      root,
      ['src/mine.ts'],
      [`${root}/src/mine.ts(2,1): error TS2304`, './src/mine.ts: DOT_ERR', './src/other.ts: OTHER'],
    );
    expect(out).toContain('TS2304');
    expect(out).toContain('DOT_ERR');
    expect(out).not.toContain('OTHER');
  });
});

describe('decision-stop-check.sh — nudge scoped to session edits', () => {
  const decisionFixture = () => {
    const root = mkTmp('sesd-');
    write(root, 'src/mine.ts');
    write(root, 'src/other.ts');
    writeExec(
      root,
      'node_modules/.bin/guard-decisions',
      '#!/bin/sh\nprintf "caching\\tsrc/other.ts\\n"\nprintf "retry-policy\\tsrc/mine.ts\\n"\n',
    );
    return root;
  };

  it('nudges only about smells in files this session edited', () => {
    const root = decisionFixture();
    const r = runHook(
      DECISION_HOOK,
      root,
      { session_id: 's1' },
      seedSessionLedger(root, 's1', ['src/mine.ts']),
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('retry-policy');
    expect(r.stderr).not.toContain('caching');
  });

  it('stays silent for a session with no recorded edits', () => {
    const root = decisionFixture();
    const r = runHook(
      DECISION_HOOK,
      root,
      { session_id: 's2' },
      seedSessionLedger(root, 's1', ['src/mine.ts']),
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });
});
