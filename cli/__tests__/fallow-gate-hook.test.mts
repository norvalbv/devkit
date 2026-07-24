/**
 * Runtime tests for the fallow-gate.sh PreToolUse hook (sc-1192). The distribution suites treat
 * agents-hooks scripts as opaque blobs, so this is the only coverage of what the gate DOES.
 *
 * The gate exists because `fallow hooks install` generates a stock gate that blocks on any
 * introduced finding anywhere in the worktree; devkit re-scopes that to the staged diff via
 * gate-engine/fallow/staged-filter. What must hold:
 *   - inert without a .fallowrc or without fallow (a synced hook must never be noisy);
 *   - routes on `git commit`, and on `git push` only when FALLOW_GATE_COMMIT_ONLY is unset;
 *   - verdict=fail + filter says "no overlap" → PASS (the whole point of staged scoping);
 *   - verdict=fail + filter says "overlap" → BLOCK, printing the blockers;
 *   - filter unavailable → BLOCK on the unscoped verdict, but NAME the reason (sc-1192: an
 *     anonymous rc=2 blocked a ship with nothing to act on).
 * Lives under cli/__tests__ because vitest's include glob only covers gate-engine/ and cli/.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { rootRegistry } from './_helpers.mts';

const GATE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'agents-hooks',
  'fallow-gate.sh',
);

const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

/** A stub `fallow` on PATH: reports a version above the floor and prints the given audit JSON. */
function stubFallow(dir: string, auditJson: string, { auditExit = 1 } = {}) {
  const binDir = join(dir, 'stub-bin');
  mkdirSync(binDir, { recursive: true });
  const stub = join(binDir, 'fallow');
  writeFileSync(
    stub,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fallow 3.6.0"; exit 0; fi
cat <<'JSON'
${auditJson}
JSON
exit ${auditExit}
`,
  );
  chmodSync(stub, 0o755);
  return binDir;
}

/** A stub staged-filter at the real path the gate probes, exiting with the given code. */
function stubFilter(dir: string, { exit = 0, stdout = '', stderr = '' }) {
  const filterDir = join(
    dir,
    'node_modules',
    '@norvalbv',
    'devkit',
    'dist',
    'gate-engine',
    'fallow',
  );
  mkdirSync(filterDir, { recursive: true });
  writeFileSync(
    join(filterDir, 'staged-filter.mjs'),
    `${stdout ? `process.stdout.write(${JSON.stringify(stdout)});` : ''}
${stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : ''}
process.exit(${exit});
`,
  );
}

function fixture({ fallowrc = true } = {}) {
  const dir = mkTmp('fallow-gate-');
  if (fallowrc) writeFileSync(join(dir, '.fallowrc.jsonc'), '{}\n');
  return dir;
}

function run(dir: string, command: string, { binDir = '', env = {} } = {}) {
  // A MINIMAL PATH: the stub dir (into which node is symlinked) plus the system bins. Inheriting
  // the real PATH let a developer's live fallow answer instead of the stub; adding node's own
  // directory then exposed `npx`, whose --no-install probe found that same fallow by another
  // route. Symlinking node in keeps the only discoverable fallow the one the test put there.
  if (binDir && !existsSync(join(binDir, 'node')))
    symlinkSync(process.execPath, join(binDir, 'node'));
  const PATH = [binDir, '/usr/bin', '/bin'].filter(Boolean).join(':');
  const r = spawnSync('bash', [GATE], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, PATH, CLAUDE_PROJECT_DIR: dir, ...env },
  });
  return { status: r.status, stderr: r.stderr ?? '' };
}

const FAIL_AUDIT = '{"verdict":"fail","complexity":{"findings":[]}}';

describe('fallow-gate.sh', () => {
  it('is inert without a .fallowrc (an unadopted consumer must not be gated)', () => {
    const dir = fixture({ fallowrc: false });
    const binDir = stubFallow(dir, FAIL_AUDIT);
    const r = run(dir, 'git commit -m x', { binDir });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('skips with a visible notice when fallow is absent', () => {
    const r = run(fixture(), 'git commit -m x', { binDir: mkTmp('empty-bin-') });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/fallow binary not found/);
  });

  it('ignores commands that are not a git commit', () => {
    const dir = fixture();
    const binDir = stubFallow(dir, FAIL_AUDIT);
    // `git committed` and `gitcommit` are near-misses the word boundaries must reject. A command
    // that merely CONTAINS `git commit` (`foo && git commit`) is deliberately audited — erring
    // toward auditing is the safe direction for a gate.
    for (const cmd of ['ls -la', 'gitcommit', 'git committed', 'git status']) {
      expect(run(dir, cmd, { binDir }).status).toBe(0);
      expect(run(dir, cmd, { binDir }).stderr).toBe('');
    }
  });

  it('audits git push only when FALLOW_GATE_INCLUDE_PUSH is set', () => {
    // Commit-only is the DEFAULT so the registered command can stay a bare `bash <path>` — an
    // env-var prefix on the registration breaks the derived Cursor command.
    const dir = fixture();
    const binDir = stubFallow(dir, FAIL_AUDIT);
    stubFilter(dir, { exit: 0 });
    expect(run(dir, 'git push', { binDir }).stderr).toBe('');
    const withPush = run(dir, 'git push', { binDir, env: { FALLOW_GATE_INCLUDE_PUSH: '1' } });
    expect(withPush.stderr).toMatch(/staged-scoped/);
  });

  it('PASSES a fail verdict when no introduced finding overlaps the staged diff', () => {
    const dir = fixture();
    const binDir = stubFallow(dir, FAIL_AUDIT);
    stubFilter(dir, { exit: 0 });
    const r = run(dir, 'git commit -m x', { binDir });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/no introduced finding overlaps the staged diff/);
  });

  it('BLOCKS and prints the blockers when a finding overlaps the staged diff', () => {
    const dir = fixture();
    const binDir = stubFallow(dir, FAIL_AUDIT);
    stubFilter(dir, { exit: 1, stdout: '[{"kind":"complexity","path":"src/a.ts"}]' });
    const r = run(dir, 'git commit -m x', { binDir });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/overlap the staged diff/);
    expect(r.stderr).toContain('src/a.ts');
  });

  it('blocks on the unscoped verdict but NAMES the reason when the filter cannot attribute', () => {
    const dir = fixture();
    const binDir = stubFallow(dir, FAIL_AUDIT);
    stubFilter(dir, {
      exit: 2,
      stderr: 'fallow-staged-filter: could not read the staged diff — errno=EAGAIN\n',
    });
    const r = run(dir, 'git commit -m x', { binDir });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/staged-diff filter unavailable \(rc=2\)/);
    expect(r.stderr).toMatch(/errno=EAGAIN/); // the reason, not just the rc
  });

  it('blocks with a named reason when devkit s filter is missing entirely', () => {
    const dir = fixture();
    const binDir = stubFallow(dir, FAIL_AUDIT);
    const r = run(dir, 'git commit -m x', { binDir });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/staged-diff filter not found/);
  });

  it('never echoes the audit payload (it would blow the agent context window)', () => {
    const dir = fixture();
    const marker = 'PAYLOAD_MARKER_DO_NOT_PRINT';
    const binDir = stubFallow(dir, `{"verdict":"fail","note":"${marker}"}`);
    stubFilter(dir, { exit: 2 });
    const r = run(dir, 'git commit -m x', { binDir });
    expect(r.status).toBe(2);
    expect(r.stderr).not.toContain(marker);
  });

  it('fails open when the audit errors without a verdict', () => {
    const dir = fixture();
    const binDir = stubFallow(dir, 'not json at all', { auditExit: 3 });
    const r = run(dir, 'git commit -m x', { binDir });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/exited 3/);
  });

  it('blocks a fallow older than the version floor', () => {
    const dir = fixture();
    const binDir = stubFallow(dir, FAIL_AUDIT);
    writeFileSync(
      join(binDir, 'fallow'),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fallow 2.1.0"; exit 0; fi\nexit 1\n',
    );
    chmodSync(join(binDir, 'fallow'), 0o755);
    const r = run(dir, 'git commit -m x', { binDir });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/below required 2\.46\.0/);
  });
});
