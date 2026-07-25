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
 *   - a block prints fallow's own explanation, never a bare exit code (sc-1192's lesson).
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

function run(dir: string, binDir: string, env: Record<string, string> = {}) {
  const PATH = [binDir, '/usr/bin', '/bin'].join(':');
  const r = spawnSync('bash', [GATE], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH, CLAUDE_PROJECT_DIR: dir, ...env },
  });
  return { status: r.status, stderr: r.stderr ?? '' };
}

const PASS = '{"verdict":"pass","attribution":{"duplication_introduced":0}}';

describe('fallow-staged-gate.sh', () => {
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
