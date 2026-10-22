// The agent hooks' Oxfmt steps: devkit's pinned bin (package, then global), else the repo's own
// (overlay). Each test REPLACES PATH, so the runtimes that exist are exactly the ones it lists.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { rootRegistry, seedSessionLedger } from './_helpers.mts';

const AGENTS_HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agents-hooks');
const FORMAT_HOOK = join(AGENTS_HOOKS, 'format-after-edit.sh');
const LINT_HOOK = join(AGENTS_HOOKS, 'lint-check.sh');

const SYSTEM_PATH = '/usr/bin:/bin';
const systemHas = (bin) => SYSTEM_PATH.split(':').some((d) => existsSync(join(d, bin)));
const realNode = (() => {
  const r = spawnSync('bash', ['-c', 'command -v node'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
})();
const NO_SYSTEM_BUN = realNode !== null && !systemHas('bun');

const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

const write = (root, rel, body, mode = 0o644) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
  chmodSync(join(root, rel), mode);
};

/** A formatter stub that records which bin ran and with what, prints like oxfmt, and exits `code`. */
const stub = (name, code) =>
  `#!/bin/sh\necho "${name} $*" > fmt-args.txt\necho "Checking formatting..."\nexit ${code}\n`;

/** PATH with node (unless `node: false`), optional global bins, and the system dirs — never bun. */
const pathWith = (root, { node = true, globals = {} } = {}) => {
  const dir = join(root, '.shims');
  mkdirSync(dir, { recursive: true });
  if (node) symlinkSync(realNode, join(dir, 'node'));
  for (const [name, body] of Object.entries(globals)) write(dir, name, body, 0o755);
  return `${dir}:${SYSTEM_PATH}`;
};

/** A repo with an Oxfmt config, one edited file, and `bins` installed in its node_modules/.bin. */
const oxfmtRepo = (bins, files = {}) => {
  const root = mkTmp('oxfmt-hook-');
  write(root, 'package.json', JSON.stringify({ name: 'fx', version: '0.0.0' }));
  write(root, '.oxfmtrc.json', '{}\n');
  write(root, 'src/mine.mts', 'export const x = 1;\n');
  for (const [rel, body] of Object.entries(files)) write(root, rel, body);
  for (const [name, body] of Object.entries(bins))
    write(root, `node_modules/.bin/${name}`, body, 0o755);
  return root;
};

const runHook = (hook, root, payload, path) =>
  spawnSync('bash', [hook], {
    input: JSON.stringify({ session_id: 's1', ...payload }),
    env: {
      ...process.env,
      PATH: path,
      CLAUDE_PROJECT_DIR: root,
      TMPDIR: seedSessionLedger(root, 's1', hook === LINT_HOOK ? ['src/mine.mts'] : null),
    },
    encoding: 'utf8',
  });
const ran = (root) =>
  existsSync(join(root, 'fmt-args.txt')) ? readFileSync(join(root, 'fmt-args.txt'), 'utf8') : '';
const edit = (root, path) =>
  runHook(FORMAT_HOOK, root, { file_path: join(root, 'src/mine.mts') }, path);

describe.skipIf(!NO_SYSTEM_BUN)('format-after-edit — Oxfmt on the edited file', () => {
  it("runs devkit's pinned bin on an edited .mts, and keeps the hook's stdout to `{}`", () => {
    const root = oxfmtRepo({ 'devkit-oxfmt': stub('devkit-oxfmt', 0), oxfmt: stub('oxfmt', 0) });
    const r = edit(root, pathWith(root));
    expect(ran(root)).toMatch(/^devkit-oxfmt --no-error-on-unmatched-pattern --write .*mine\.mts/);
    expect(r.stdout.trim()).toBe('{}');
  });

  it("an overlay repo with no devkit bin runs the repo's own oxfmt", () => {
    const root = oxfmtRepo({ oxfmt: stub('oxfmt', 0) });
    edit(root, pathWith(root));
    expect(ran(root)).toMatch(/^oxfmt --no-error-on-unmatched-pattern --write/);
  });

  it("a standalone repo with nothing installed runs the global devkit's bin", () => {
    const root = oxfmtRepo({});
    edit(root, pathWith(root, { globals: { 'devkit-oxfmt': stub('global-devkit-oxfmt', 0) } }));
    expect(ran(root)).toMatch(/^global-devkit-oxfmt --no-error-on-unmatched-pattern --write/);
  });

  it('a repo with no Oxfmt config is never formatted', () => {
    const root = oxfmtRepo({ 'devkit-oxfmt': stub('devkit-oxfmt', 0) });
    rmSync(join(root, '.oxfmtrc.json'));
    edit(root, pathWith(root));
    expect(ran(root)).toBe('');
  });
});

describe.skipIf(!NO_SYSTEM_BUN)('lint-check — Oxfmt check of the session files', () => {
  const stop = (bins, files = {}) => {
    const root = oxfmtRepo(bins, files);
    return { root, r: runHook(LINT_HOOK, root, {}, pathWith(mkTmp('shims-'))) };
  };

  it('blocks on unformatted files (exit 1), naming the bin that ran in the fix hint', () => {
    const { root, r } = stop({ 'devkit-oxfmt': stub('devkit-oxfmt', 1) });
    expect(r.status).toBe(2);
    expect(ran(root)).toMatch(/^devkit-oxfmt --no-error-on-unmatched-pattern --check .*mine\.mts/);
    expect(r.stderr).toContain(
      "Run './node_modules/.bin/devkit-oxfmt --write <file>' to auto-fix.",
    );
  });

  it('stands down on a parse error or unmatched path (exit 2) and on a bin that cannot start (127)', () => {
    for (const code of [2, 127]) {
      const { r } = stop({ 'devkit-oxfmt': stub('devkit-oxfmt', code) });
      expect(r.status, `exit ${code}`).toBe(0);
    }
  });

  it('a lockfile naming an uninstalled package manager still runs the format check', () => {
    const { root, r } = stop({ 'devkit-oxfmt': stub('devkit-oxfmt', 1) }, { 'pnpm-lock.yaml': '' });
    expect(r.status).toBe(2);
    expect(ran(root)).toContain('src/mine.mts');
  });

  it('a clean format pass still reaches the npm-script steps through the resolved manager', () => {
    const pkg = { name: 'fx', version: '0.0.0', scripts: { 'lint:structure': 'x' } };
    const root = oxfmtRepo(
      { 'devkit-oxfmt': stub('devkit-oxfmt', 0) },
      { 'package.json': JSON.stringify(pkg), 'package-lock.json': '{}' },
    );
    const npm = '#!/bin/sh\necho "src/mine.mts: STRUCTURE PM=npm $*"\nexit 1\n';
    const r = runHook(LINT_HOOK, root, {}, pathWith(root, { globals: { npm } }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('src/mine.mts: STRUCTURE PM=npm run lint:structure');
  });
});

describe.skipIf(!NO_SYSTEM_BUN || systemHas('node'))('lint-check without node', () => {
  it("stands down when a real bin's node shebang has no node", () => {
    const root = oxfmtRepo({ 'devkit-oxfmt': '#!/usr/bin/env node\nprocess.exit(1);\n' });
    const r = runHook(LINT_HOOK, root, {}, pathWith(root, { node: false }));
    expect(r.status).toBe(0);
  });
});

describe('devkit-oxfmt — the pinned Oxfmt, in-process', () => {
  const BIN = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'commands',
    'oxc',
    'oxfmt-bin.mts',
  );
  // Reached by spawning it, so vitest's import graph needs to see it too.
  void (() => import('../commands/oxc/oxfmt-bin.mts'));

  it('passes argv and exit status through: --check fails on unformatted code, --write fixes it', () => {
    const root = mkTmp('oxfmt-bin-');
    write(root, '.oxfmtrc.json', '{ "singleQuote": true }\n');
    write(root, 'a.ts', 'export const x = {a:1,b:"two"}\n');
    const run = (...args) =>
      spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8' });

    expect(run('--check', 'a.ts').status).toBe(1);
    expect(run('--no-error-on-unmatched-pattern', '--write', 'a.ts').status).toBe(0);
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe("export const x = { a: 1, b: 'two' };\n");
  });
});
