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
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { hasAnyCommand, repoKey, rootRegistry, seedSessionLedger } from './_helpers.mts';

const AGENTS_HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agents-hooks');
const LIB = join(AGENTS_HOOKS, 'session-edits-lib.sh');
const FORMAT_HOOK = join(AGENTS_HOOKS, 'format-after-edit.sh');
const LINT_HOOK = join(AGENTS_HOOKS, 'lint-check.sh');
const DECISION_HOOK = join(AGENTS_HOOKS, 'decision-stop-check.sh');

const HAS_BUN = hasAnyCommand('bun');

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

const runHookRaw = (hook, root, input, tmp, extraEnv = {}) =>
  spawnSync('bash', [hook], {
    input,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: root,
      TMPDIR: tmp,
      GUARD_NO_LOG: '',
      FRINK_NO_LOG: '',
      ...extraEnv,
    },
    encoding: 'utf8',
  });
const runHook = (hook, root, payload, tmp, extraEnv = {}) =>
  runHookRaw(hook, root, JSON.stringify(payload), tmp, extraEnv);

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

  // Claude sends tool_input.file_path; Cursor afterFileEdit sends a top-level file_path.
  const PROVIDER_PAYLOADS = [
    [
      'Claude compact',
      (abs) => JSON.stringify({ session_id: 's1', tool_input: { file_path: abs } }),
    ],
    [
      'Claude pretty-printed',
      (abs) => JSON.stringify({ session_id: 's1', tool_input: { file_path: abs } }, null, 2),
    ],
    [
      'Cursor afterFileEdit',
      (abs) =>
        JSON.stringify({
          session_id: 's1',
          file_path: abs,
          edits: [{ old_string: 'a', new_string: 'b' }],
        }),
    ],
    [
      'decoy-first',
      (abs, root) =>
        JSON.stringify({
          session_id: 's1',
          tool_response: { file_path: join(root, 'src/decoy.ts') },
          tool_input: { file_path: abs },
        }),
    ],
  ];
  const CASES = PROVIDER_PAYLOADS.flatMap(([label, payloadFor]) =>
    ['src/mine.ts', 'src/a "b".ts'].map((rel) => [label, rel, payloadFor]),
  );
  it.each(CASES)('records the edited file from a %s payload (%s)', (_label, rel, payloadFor) => {
    const root = mkTmp('sesw-');
    write(root, rel);
    write(root, 'src/decoy.ts');
    const tmp = seedSessionLedger(root, 's1', null);
    const r = runHookRaw(FORMAT_HOOK, root, payloadFor(join(root, rel), root), tmp);
    expect(r.status).toBe(0);
    const ledger = join(tmp, 'devkit-session-edits', `${repoKey(root)}-s1`);
    expect(readFileSync(ledger, 'utf8')).toBe(`${rel}\n`);
  });

  it('fails open on a payload that is not JSON', () => {
    const root = mkTmp('sesw-');
    const tmp = seedSessionLedger(root, 's1', null);
    const r = runHookRaw(FORMAT_HOOK, root, '{"session_id":"s1","file_path":', tmp);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
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
    write(root, 'biome.json', '{}\n');
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

  it('skips biome when the binary is present but the repo carries no biome config', () => {
    // biome is a common TRANSITIVE dependency. Configless, it checks against its own defaults
    // (tabs, double quotes), so a repo that formats with prettier/oxfmt/dprint would fail this
    // gate on every edited file while its real format gate passes — and the suggested `biome
    // check --write` fix would rewrite the file into a style that repo then rejects.
    const root = mkTmp('sesnb-');
    write(root, 'src/mine.ts');
    write(root, 'package.json', JSON.stringify({ name: 'fx', version: '0.0.0' }));
    writeExec(
      root,
      'node_modules/.bin/biome',
      '#!/bin/sh\necho "BIOME_ARGS: $@" > biome-args.txt\nexit 1\n',
    );
    const tmp = seedSessionLedger(root, 's1', ['src/mine.ts']);
    const r = runHook(LINT_HOOK, root, { session_id: 's1' }, tmp);
    expect(r.status).toBe(0);
    expect(existsSync(join(root, 'biome-args.txt'))).toBe(false);
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

// sc-1051: a pre-`--files` bin prints tab-less labels the ledger filter silently drops; the hook must
// report that once per session per bin instead of going dark.
describe('decision-stop-check.sh — a stale guard-decisions bin is reported, not silent', () => {
  const STALE_BIN = '#!/bin/sh\nprintf "retry-policy\\ncaching\\n"\n';

  /** A consumer with NO local devkit; the stale bin lives on PATH (global install shape). */
  const globalFixture = (binDirName = 'gbin') => {
    const root = mkTmp('sess-stale-');
    write(root, 'src/mine.ts');
    const binDir = join(root, '.fake', binDirName);
    writeExec(root, join('.fake', binDirName, 'guard-decisions'), STALE_BIN);
    const tmp = seedSessionLedger(root, 's1', ['src/mine.ts']);
    const env = { PATH: `${binDir}:${process.env.PATH}` };
    const stop = (sid = 's1') => {
      seedSessionLedger(root, sid, ['src/mine.ts']);
      return runHook(DECISION_HOOK, root, { session_id: sid }, tmp, env);
    };
    return { root, binDir, tmp, env, stop };
  };

  it('a stale GLOBAL bin blocks the stop once, naming the bin and the global remedy — never bunx', () => {
    const { root, binDir, stop } = globalFixture();
    write(
      root,
      '.devkit/config.json',
      '{\n  "stack": "node-service",\n  "devkitRef": "v0.63.4"\n}\n',
    );
    const r = stop();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(join(binDir, 'guard-decisions'));
    expect(r.stderr).toContain('--files');
    expect(r.stderr).toMatch(/global devkit/);
    expect(r.stderr).toContain('v0.63.4');
    expect(r.stderr).not.toMatch(/bunx/);
    // It is NOT the ordinary smell nudge — that would tell the agent to record a decision.
    expect(r.stderr).not.toContain('New architectural decision smelled');
  });

  it('stays silent on later stops of the SAME session, and warns a NEW session once', () => {
    const { stop } = globalFixture();
    expect(stop('s1').status).toBe(2);
    const again = stop('s1');
    expect(again.status).toBe(0);
    expect(again.stderr).toBe('');
    expect(stop('s2').status).toBe(2);
  });

  it('re-arms within a session when the bin changes (an upgrade that is still stale)', () => {
    const { root, stop } = globalFixture();
    expect(stop().status).toBe(2);
    writeExec(root, '.fake/gbin/guard-decisions', `${STALE_BIN}# reinstalled, different size\n`);
    expect(stop().status).toBe(2);
  });

  it('re-arms on a same-size, same-minute rewrite of the bin (content, not just ls metadata)', () => {
    const { root, stop } = globalFixture();
    writeExec(root, '.fake/gbin/guard-decisions', `${STALE_BIN}#a\n`);
    expect(stop().status).toBe(2);
    writeExec(root, '.fake/gbin/guard-decisions', `${STALE_BIN}#b\n`);
    expect(stop().status).toBe(2);
  });

  it('fingerprints the bin that ran the scan, not one swapped in during it', () => {
    const { root, stop } = globalFixture();
    const bin = join(root, '.fake/gbin/guard-decisions');
    // Upgrade lands mid-scan: the old bin replaces itself with a DIFFERENT (still stale) bin.
    writeExec(
      root,
      '.fake/gbin/guard-decisions',
      `#!/bin/sh\nprintf '#!/bin/sh\\nprintf "retry-policy\\\\n"\\n# v2\\n' > "${bin}.new" && chmod +x "${bin}.new" && mv "${bin}.new" "${bin}"\nprintf "retry-policy\\n"\n`,
    );
    expect(stop().status).toBe(2);
    // The swapped-in bin never got its own notice, so it must not be snoozed.
    expect(stop().status).toBe(2);
  });

  it('a stale LOCAL bin names the dependency bump, not a global upgrade', () => {
    const root = mkTmp('sess-stale-');
    write(root, 'src/mine.ts');
    write(root, '.devkit/config.json', '{"devkitRef":"v0.70.1"}');
    writeExec(root, 'node_modules/.bin/guard-decisions', STALE_BIN);
    const r = runHook(
      DECISION_HOOK,
      root,
      { session_id: 's1' },
      seedSessionLedger(root, 's1', ['src/mine.ts']),
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('node_modules/.bin/guard-decisions');
    expect(r.stderr).toMatch(/dependency/);
    expect(r.stderr).toContain('v0.70.1');
    expect(r.stderr).not.toMatch(/global devkit/);
  });

  it('omits the pin cleanly when .devkit/config.json carries no devkitRef', () => {
    const r = globalFixture().stop();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Fix: upgrade the global devkit on PATH.');
    expect(r.stderr).not.toContain('devkitRef');
  });

  it('a session with no recorded edits stays silent even on a stale bin (ledger gate runs first)', () => {
    const { root, tmp, env } = globalFixture();
    const r = runHook(DECISION_HOOK, root, { session_id: 's9' }, tmp, env);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('handles a global bin whose directory path contains a space', () => {
    const { binDir, stop } = globalFixture('Application Support');
    const r = stop();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(join(binDir, 'guard-decisions'));
    expect(stop().status).toBe(0);
  });

  it('a notice that never reached a reader (EPIPE) is not snoozed — the next stop warns', async () => {
    const { root, tmp, env, stop } = globalFixture();
    const code = await new Promise((resolve) => {
      const c = spawn('bash', [DECISION_HOOK], {
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: root,
          TMPDIR: tmp,
          GUARD_NO_LOG: '',
          FRINK_NO_LOG: '',
          ...env,
        },
      });
      c.stderr.destroy(); // the harness stopped reading stderr
      c.on('close', (status) => resolve(status));
      c.stdin.end(JSON.stringify({ session_id: 's1' }));
    });
    expect(code).not.toBe(2);
    const r = stop();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--files');
  });

  it('fails OPEN when the snooze marker cannot be written — never a block on every stop', () => {
    const { tmp, stop } = globalFixture();
    // A FILE where the snooze directory should be: the marker write fails after the notice.
    writeFileSync(join(tmp, 'devkit-decision-snooze'), 'not a dir');
    expect(stop().status).toBe(0);
    expect(stop().status).toBe(0);
  });

  it('a CURRENT bin is never mistaken for stale when every pair falls outside the ledger', () => {
    const root = mkTmp('sess-stale-');
    write(root, 'src/mine.ts');
    writeExec(
      root,
      'node_modules/.bin/guard-decisions',
      '#!/bin/sh\nprintf "caching\\tsrc/other.ts\\n"\n',
    );
    const r = runHook(
      DECISION_HOOK,
      root,
      { session_id: 's1' },
      seedSessionLedger(root, 's1', ['src/mine.ts']),
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });
});
