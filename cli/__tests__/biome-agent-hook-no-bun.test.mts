// The agent hooks' biome steps run the local bin, so a repo without bun still gets them. Each test
// REPLACES PATH, so the runtimes that exist are exactly the ones it lists.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
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

/** PATH with node (unless `node: false`) and the system dirs, never bun. */
const pathWithout = (root, { node = true } = {}) => {
  const dir = join(root, '.shims');
  mkdirSync(dir, { recursive: true });
  if (node) symlinkSync(realNode, join(dir, 'node'));
  return `${dir}:${SYSTEM_PATH}`;
};

/** A biome repo whose stub bin logs its argv, prints to stdout like biome does, and exits `code`. */
const biomeRepo = (code, files = {}) => {
  const root = mkTmp('biome-nobun-');
  write(root, 'package.json', JSON.stringify({ name: 'fx', version: '0.0.0' }));
  write(root, 'biome.json', '{}\n');
  write(root, 'src/mine.ts', 'export const x = 1;\n');
  for (const [rel, body] of Object.entries(files)) write(root, rel, body);
  write(
    root,
    'node_modules/.bin/biome',
    `#!/bin/sh\necho "$@" > biome-args.txt\necho "Checked 1 file."\nexit ${code}\n`,
    0o755,
  );
  return root;
};

const runHook = (hook, root, payload, path) =>
  spawnSync('bash', [hook], {
    input: JSON.stringify({ session_id: 's1', ...payload }),
    env: {
      ...process.env,
      PATH: path,
      CLAUDE_PROJECT_DIR: root,
      TMPDIR: seedSessionLedger(root, 's1', hook === LINT_HOOK ? ['src/mine.ts'] : null),
    },
    encoding: 'utf8',
  });

describe.skipIf(!NO_SYSTEM_BUN)('biome agent-hook steps without bun', () => {
  it('format-after-edit runs the local biome on the edit and keeps its stdout to `{}`', () => {
    const root = biomeRepo(0);
    const r = runHook(
      FORMAT_HOOK,
      root,
      { file_path: join(root, 'src/mine.ts') },
      pathWithout(root),
    );
    expect(readFileSync(join(root, 'biome-args.txt'), 'utf8')).toContain('check --write');
    expect(r.stdout.trim()).toBe('{}');
  });

  it("lint-check blocks on biome's findings with a hint naming the command that ran", () => {
    const r = runHook(LINT_HOOK, biomeRepo(1), {}, pathWithout(mkTmp('shims-')));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Run './node_modules/.bin/biome check --write <file>' to auto-fix.");
    expect(r.stderr).not.toContain('bun run');
  });

  it('lint-check stands down when the biome bin cannot start (exit 127)', () => {
    const r = runHook(LINT_HOOK, biomeRepo(127), {}, pathWithout(mkTmp('shims-')));
    expect(r.status).toBe(0);
  });

  it('a lockfile naming an uninstalled package manager still runs the biome step', () => {
    const root = biomeRepo(1, { 'pnpm-lock.yaml': '' });
    const r = runHook(LINT_HOOK, root, {}, pathWithout(mkTmp('shims-')));
    expect(r.status).toBe(2);
    expect(readFileSync(join(root, 'biome-args.txt'), 'utf8')).toContain('src/mine.ts');
  });

  it('a clean biome pass still reaches the npm-script steps through the resolved manager', () => {
    const pkg = { name: 'fx', version: '0.0.0', scripts: { 'lint:structure': 'x' } };
    const root = biomeRepo(0, { 'package.json': JSON.stringify(pkg), 'package-lock.json': '{}' });
    const shims = pathWithout(root);
    write(
      root,
      '.shims/npm',
      '#!/bin/sh\necho "src/mine.ts: STRUCTURE PM=npm $*"\nexit 1\n',
      0o755,
    );
    const r = runHook(LINT_HOOK, root, {}, shims);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('src/mine.ts: STRUCTURE PM=npm run lint:structure');
  });
});

describe.skipIf(!NO_SYSTEM_BUN || systemHas('node'))('biome agent-hook steps without node', () => {
  it("lint-check stands down when the real launcher's node shebang has no node", () => {
    const root = biomeRepo(0);
    write(root, 'node_modules/.bin/biome', '#!/usr/bin/env node\nprocess.exit(1);\n', 0o755);
    const r = runHook(LINT_HOOK, root, {}, pathWithout(root, { node: false }));
    expect(r.status).toBe(0);
  });
});
