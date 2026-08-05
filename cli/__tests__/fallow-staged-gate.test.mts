/**
 * Runtime tests for agents-hooks/fallow-staged-gate.sh — devkit's thin staged-scope wrapper.
 *
 * devkit decides SCOPE (the staged diff), fallow decides findings. What must hold:
 *   - fallow is invoked with --diff-stdin, never a bare audit (a bare audit resolves its base as
 *     the merge-base against the remote default, which sweeps in other agents' unstaged work —
 *     the sc-1192 failure and the whole reason this wrapper exists);
 *   - the gate blocks on verdict=fail AND on introduced duplication, which fallow reports as
 *     verdict=warn (measured) — gating on verdict alone silently stops blocking clone groups;
 *   - it degrades OPEN on every tooling condition (no fallow, old fallow, unreadable output,
 *     nothing staged) and CLOSED only on a real verdict;
 *   - it is inert for every non-commit shell command, especially commands that recover a failing
 *     staged set (`git reset`, `git restore --staged`);
 *   - a block prints fallow's own explanation, never a bare exit code (sc-1192's lesson).
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { rootRegistry } from './_helpers.mts';

const GATE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'agents-hooks',
  'fallow-staged-gate.sh',
);

const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

/** A stub `fallow` that records its argv and replies with the given audit JSON. */
function stubFallow(dir: string, auditJson: string, { version = '3.6.0' } = {}) {
  const binDir = join(dir, 'stub-bin');
  mkdirSync(binDir, { recursive: true });
  const stub = join(binDir, 'fallow');
  writeFileSync(
    stub,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fallow ${version}"; exit 0; fi
echo "$@" >> "${join(dir, 'argv.log')}"
cat > /dev/null
cat <<'JSON'
${auditJson}
JSON
exit 0
`,
  );
  chmodSync(stub, 0o755);
  if (!existsSync(join(binDir, 'node'))) symlinkSync(process.execPath, join(binDir, 'node'));
  return binDir;
}

/** A repo with a .fallowrc and one staged file, so the gate has something to scope. */
function repoWithStaged(dir: string) {
  const git = (args: string) => spawnSync('git', args.split(' '), { cwd: dir, encoding: 'utf8' });
  writeFileSync(join(dir, '.fallowrc.jsonc'), '{}\n');
  git('init -q -b main');
  git('config user.email t@t.t');
  git('config user.name t');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  git('add a.ts');
  git('-c commit.gpgsign=false commit -qm base');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
  git('add a.ts');
}

interface RunOptions {
  command?: string;
  input?: string;
  cursor?: boolean;
  env?: Record<string, string>;
}

function run(
  dir: string,
  binDir: string,
  { command = 'git commit -m "test"', input, cursor = false, env = {} }: RunOptions = {},
) {
  const PATH = [binDir, '/usr/bin', '/bin'].join(':');
  const r = spawnSync('bash', [GATE], {
    cwd: dir,
    encoding: 'utf8',
    input: input ?? JSON.stringify(cursor ? { command } : { tool_input: { command } }),
    env: { ...process.env, PATH, CLAUDE_PROJECT_DIR: dir, ...env },
  });
  return { status: r.status, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
}

const PASS = '{"verdict":"pass","attribution":{"duplication_introduced":0}}';

describe('fallow-staged-gate.sh', () => {
  it.each([
    'git reset',
    'git restore --staged a.ts',
    'git stash',
    'echo alive',
    'bun test',
    'devkit ship codex/example "example" -- a.ts',
    'git --version commit',
    'git -v commit',
    'git --help commit',
    'git -h commit',
    'git -C . --version commit',
    'git --exec-path commit',
    'git --html-path commit',
    'git --man-path commit',
    'git --info-path commit',
    'git --list-cmds=main commit',
    'echo git commit',
    'echo "git commit -m quoted-prose"',
    'echo "; git commit -m quoted-prose"',
    // sc-1417: a valueless global flag used to swallow the subcommand, promoting a later literal
    // `commit` argument into subcommand position and blocking read-only queries and recovery.
    'git --no-pager log --stat commit',
    'git --no-pager status commit',
    'git --no-pager reset commit',
    'git -C /tmp --no-pager log --all commit',
  ])('does not audit a staged failure before non-commit command: %s', (command) => {
    const dir = mkTmp('staged-gate-');
    repoWithStaged(dir);
    const binDir = stubFallow(dir, '{"verdict":"fail","attribution":{"duplication_introduced":0}}');
    expect(run(dir, binDir, { command }).status).toBe(0);
    expect(existsSync(join(dir, 'argv.log'))).toBe(false);
  });

  it.each([
    'git -C . commit -m "test"',
    'git -c commit.gpgsign=false commit -m "test"',
    'command git --git-dir=.git commit -m "test"',
    'git --exec-path=/usr/lib/git-core commit -m "test"',
    'git --no-pager commit -m "test"',
  ])('audits commits after supported Git global options: %s', (command) => {
    const dir = mkTmp('staged-gate-');
    repoWithStaged(dir);
    const binDir = stubFallow(dir, '{"verdict":"fail","attribution":{"duplication_introduced":0}}');
    expect(run(dir, binDir, { command }).status).toBe(2);
  });

  // Documented fail-open gap, asserted so a future change to it has to be deliberate: the anchor
  // requires git to BEGIN the segment, so an env-assignment prefix or a wrapper binary bypasses the
  // agent surface entirely. Those commits still meet fallow's own git hook, so the gate under-fires
  // rather than stranding an agent — the side every classification error must land on (sc-1417).
  it.each([
    'FOO=1 git commit -m "test"',
    'env FOO=1 git commit -m "test"',
    'sudo git commit -m "test"',
    'bash -c "git commit -m test"',
  ])('under-fires rather than blocking on a wrapped commit: %s', (command) => {
    const dir = mkTmp('staged-gate-');
    repoWithStaged(dir);
    const binDir = stubFallow(dir, '{"verdict":"fail","attribution":{"duplication_introduced":0}}');
    expect(run(dir, binDir, { command }).status).toBe(0);
    expect(existsSync(join(dir, 'argv.log'))).toBe(false);
  });

  it('recognises Cursor beforeShellExecution command payloads', () => {
    const dir = mkTmp('staged-gate-');
    repoWithStaged(dir);
    const binDir = stubFallow(dir, '{"verdict":"fail","attribution":{"duplication_introduced":0}}');
    expect(
      run(dir, binDir, { command: 'cd . && git -C . commit -m "test"', cursor: true }).status,
    ).toBe(2);
  });

  it('fails OPEN when hook input is missing or malformed', () => {
    const dir = mkTmp('staged-gate-');
    repoWithStaged(dir);
    const binDir = stubFallow(dir, '{"verdict":"fail","attribution":{"duplication_introduced":0}}');
    expect(run(dir, binDir, { input: '' }).status).toBe(0);
    expect(run(dir, binDir, { input: 'not-json' }).status).toBe(0);
    expect(existsSync(join(dir, 'argv.log'))).toBe(false);
  });

  it('hands fallow the STAGED diff via --diff-stdin, never a bare audit', () => {
    const dir = mkTmp('staged-gate-');
    repoWithStaged(dir);
    const binDir = stubFallow(dir, PASS);
    expect(run(dir, binDir).status).toBe(0);
    const argv = spawnSync('cat', [join(dir, 'argv.log')], { encoding: 'utf8' }).stdout;
    expect(argv).toContain('--diff-stdin');
    // A bare audit would resolve its own base — the exact over-blocking this wrapper removes.
    expect(argv).not.toMatch(/--base|--changed-since/);
  });

  it('blocks on verdict=fail and shows fallow reasoning, not just a code', () => {
    const dir = mkTmp('staged-gate-');
    repoWithStaged(dir);
    const binDir = stubFallow(dir, '{"verdict":"fail","attribution":{"duplication_introduced":0}}');
    const r = run(dir, binDir);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/verdict=fail/);
  });

  it('blocks introduced duplication, which fallow reports as verdict=warn', () => {
    // Measured on fallow 3.6.0: a duplication-only staged set returns warn, and --gate all does
    // NOT change that. Gating on verdict alone would let every introduced clone group through.
    const dir = mkTmp('staged-gate-');
    repoWithStaged(dir);
    const binDir = stubFallow(dir, '{"verdict":"warn","attribution":{"duplication_introduced":1}}');
    const r = run(dir, binDir);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/duplication=1/);
  });

  it('allows a warn verdict with no introduced duplication', () => {
    const dir = mkTmp('staged-gate-');
    repoWithStaged(dir);
    const binDir = stubFallow(dir, '{"verdict":"warn","attribution":{"duplication_introduced":0}}');
    expect(run(dir, binDir).status).toBe(0);
  });

  it('skips when nothing is staged (git push, deletion-only) without spawning fallow', () => {
    const dir = mkTmp('staged-gate-');
    writeFileSync(join(dir, '.fallowrc.jsonc'), '{}\n');
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    const binDir = stubFallow(dir, PASS);
    const r = run(dir, binDir);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/no staged added lines/);
    expect(existsSync(join(dir, 'argv.log'))).toBe(false);
  });

  /**
   * sc-1366. `2>/dev/null || true` used to collapse "the diff is empty" and "the diff could not be
   * read" into one skip message, so a staged object git can no longer read was reported as
   * "nothing to audit" — a clean-looking result for a repo in a broken state.
   */
  it('an unreadable staged object is reported as a fault, not as "nothing to audit"', () => {
    const dir = mkTmp('staged-gate-');
    const binDir = stubFallow(dir, PASS);
    repoWithStaged(dir);
    // Reproduce the sc-1420 failure. BOTH steps are load-bearing, verified: with the loose blob
    // deleted but the working-tree file still holding identical content, `git diff --cached`
    // re-reads the content from the worktree and exits 0. It only fails once neither the object
    // database nor the worktree can supply the staged content.
    const oid = spawnSync('git', ['rev-parse', ':a.ts'], {
      cwd: dir,
      encoding: 'utf8',
    }).stdout.trim();
    rmSync(join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2)), { force: true });
    rmSync(join(dir, 'a.ts'), { force: true });

    const r = run(dir, binDir);
    // ALLOW: exit 2 is this hook's BLOCK signal, and a failing staged set must never block the
    // `git reset` / `git restore --staged` commands that make it recoverable.
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/could not READ the staged diff/);
    expect(r.stderr).not.toMatch(/no staged added lines/);
    // stderr on an exit-0 PreToolUse hook is surfaced nowhere, so the report must ride stdout.
    const payload = JSON.parse(r.stdout.trim());
    expect(payload.systemMessage).toMatch(/NOT a finding against your code/);
    // Never a permissionDecision: this hook must not start auto-approving commits it used to
    // leave to the normal permission flow.
    expect(payload.hookSpecificOutput).toBeUndefined();
    expect(existsSync(join(dir, 'argv.log'))).toBe(false);
  });

  it('a readable-but-empty staged diff still takes the plain skip path', () => {
    const dir = mkTmp('staged-gate-');
    writeFileSync(join(dir, '.fallowrc.jsonc'), '{}\n');
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    const r = run(dir, stubFallow(dir, PASS));
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/no staged added lines/);
    expect(r.stdout.trim()).toBe(''); // no JSON — nothing to report
  });

  it('fails OPEN before fallow when the staged diff exceeds its 10 MiB stdin cap', () => {
    const dir = mkTmp('staged-gate-');
    repoWithStaged(dir);
    writeFileSync(join(dir, 'a.ts'), `export const payload = '${'x'.repeat(10 * 1024 * 1024)}';\n`);
    spawnSync('git', ['add', 'a.ts'], { cwd: dir });
    const binDir = stubFallow(
      dir,
      '{"verdict":"fail","attribution":{"duplication_introduced":0}}',
      { version: '3.10.0' },
    );

    const r = run(dir, binDir);

    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/staged diff is .* bytes \(cap 10485760\).*skipping/i);
    expect(existsSync(join(dir, 'argv.log'))).toBe(false);
  });

  it('fails OPEN on a fallow older than the floor (an unknown flag is indistinguishable from a real error)', () => {
    const dir = mkTmp('staged-gate-');
    repoWithStaged(dir);
    const binDir = stubFallow(dir, PASS, { version: '3.0.0' });
    const r = run(dir, binDir);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/below 3\.6\.0/);
  });

  it('fails OPEN when fallow output cannot be read', () => {
    const dir = mkTmp('staged-gate-');
    repoWithStaged(dir);
    const binDir = stubFallow(dir, 'not json at all');
    const r = run(dir, binDir);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/could not read/);
  });

  it('is inert without a .fallowrc', () => {
    const dir = mkTmp('staged-gate-');
    repoWithStaged(dir);
    spawnSync('rm', [join(dir, '.fallowrc.jsonc')]);
    const binDir = stubFallow(dir, '{"verdict":"fail","attribution":{"duplication_introduced":9}}');
    expect(run(dir, binDir).status).toBe(0);
  });
});
