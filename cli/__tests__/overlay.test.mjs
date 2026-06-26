/**
 * Overlay (local-only): use devkit on a repo you can't modify. Must be INVISIBLE to git
 * (.git/info/exclude → clean `git status`), NON-INVASIVE (package.json + the team's husky hook
 * untouched), and layer ours-extends-theirs configs + a local hook that chains to the team's.
 */
// Reason: test scenario setup is intentionally explicit + self-contained per install mode (package/standalone/overlay/monorepo); shared bits already live in __tests__/_helpers.mjs
// fallow-ignore-next-line code-duplication
import { execFileSync } from 'node:child_process';
// Reason: test scenario setup is intentionally explicit + self-contained per install mode (package/standalone/overlay/monorepo); shared bits already live in __tests__/_helpers.mjs
// fallow-ignore-next-line code-duplication
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyInit } from '../commands/init.mjs';
import { defaultSelection } from '../lib/components.mjs';
import { HEAL_ALIAS_CMD } from '../lib/overlay.mjs';
import { rootRegistry } from './_helpers.mjs';

const { mkTmp, cleanup } = rootRegistry();

// These are subprocess-heavy integration tests (real `git init`/`commit` + a full applyInit overlay).
// Isolated they run in ~1-2s, but under the full suite's parallel load git/FS scheduling contention
// pushes them past the 5s default → flaky timeouts. Give them ample headroom (assertions unchanged).
vi.setConfig({ testTimeout: 20000 });

// A work repo that already has a committed husky hook + flat eslint + biome (the team's).
function workRepo() {
  const root = mkTmp('overlay-');
  const git = (...a) => execFileSync('git', a, { cwd: root });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'work', devDependencies: { react: '^18' } }, null, 2),
  );
  mkdirSync(join(root, '.husky'), { recursive: true });
  writeFileSync(join(root, '.husky', 'pre-commit'), '#!/bin/sh\necho team-hook\n');
  writeFileSync(join(root, 'eslint.config.mjs'), 'export default [{ rules: {} }];\n');
  writeFileSync(join(root, 'biome.jsonc'), '{ "linter": { "enabled": true } }\n');
  git('config', 'core.hooksPath', '.husky/_'); // simulate husky owning the hook
  git('add', '-A');
  // Reason: test scenario setup is intentionally explicit + self-contained per install mode (package/standalone/overlay/monorepo); shared bits already live in __tests__/_helpers.mjs
  // fallow-ignore-next-line code-duplication
  git('commit', '-qm', 'init');
  return root;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('overlay (local-only) install', () => {
  it('invisible + non-invasive: extends the repo, chains to the team hook, git status clean', async () => {
    const root = workRepo();
    const pkgBefore = readFileSync(join(root, 'package.json'), 'utf8');
    const huskyBefore = readFileSync(join(root, '.husky', 'pre-commit'), 'utf8');

    await applyInit(root, {
      stack: 'react-app',
      selection: defaultSelection(),
      overlay: true,
      devkitRef: 'v0.7.0',
    });

    // NON-INVASIVE: package.json + the team's hook are byte-identical
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(pkgBefore);
    expect(readFileSync(join(root, '.husky', 'pre-commit'), 'utf8')).toBe(huskyBefore);

    // INVISIBLE: git status clean (every devkit file is in .git/info/exclude)
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    ).toBe('');
    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('.devkit/');
    expect(exclude).toContain('guard.config.json');
    expect(exclude).toContain('eslint.config.devkit.mjs');

    // LOCAL HOOK: core.hooksPath points at the git-ignored dir; hook chains to the team's + is valid sh
    expect(
      execFileSync('git', ['config', '--get', 'core.hooksPath'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
    ).toBe('.devkit/hooks');
    const hook = readFileSync(join(root, '.devkit', 'hooks', 'pre-commit'), 'utf8');
    expect(hook).toContain('__dk_gate');
    expect(hook).toContain('.husky/pre-commit'); // chains to the team's committed hook
    expect(() =>
      execFileSync('sh', ['-n', join(root, '.devkit', 'hooks', 'pre-commit')], { stdio: 'pipe' }),
    ).not.toThrow();

    // OURS-EXTENDS-THEIRS: local configs extend the repo's committed ones
    expect(readFileSync(join(root, 'eslint.config.devkit.mjs'), 'utf8')).toContain(
      "import repoConfig from './eslint.config.mjs'",
    );
    expect(JSON.parse(readFileSync(join(root, 'biome.devkit.jsonc'), 'utf8')).extends).toEqual([
      './biome.jsonc',
      './.devkit/biome/react.jsonc',
    ]);

    // config records overlay
    expect(JSON.parse(readFileSync(join(root, '.devkit', 'config.json'), 'utf8')).overlay).toBe(
      true,
    );
  });

  it('monorepo subdir: hook + .git/info/exclude live at the git ROOT, not the package', async () => {
    // git root with the app in a subdir (the case that ENOENT'd: .git is above cwd).
    const root = mkTmp('overlay-mono-');
    const git = (...a) => execFileSync('git', a, { cwd: root });
    git('init', '-q');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root' }, null, 2));
    mkdirSync(join(root, '.husky'), { recursive: true });
    writeFileSync(join(root, '.husky', 'pre-commit'), '#!/bin/sh\necho team\n');
    const pkg = join(root, 'services', 'webapp');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'webapp' }, null, 2));
    writeFileSync(join(pkg, 'eslint.config.mjs'), 'export default [{ rules: {} }];\n');
    writeFileSync(join(pkg, 'biome.jsonc'), '{}\n');
    git('config', 'core.hooksPath', '.husky/_');
    git('add', '-A');
    git('commit', '-qm', 'init');

    await applyInit(pkg, {
      stack: 'react-app',
      selection: defaultSelection(),
      overlay: true,
      devkitRef: 'v0.7.1',
    });

    // hook + git-exclude at the ROOT, NOT the package
    expect(existsSync(join(root, '.devkit', 'hooks', 'pre-commit'))).toBe(true);
    expect(existsSync(join(pkg, '.devkit', 'hooks'))).toBe(false);
    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('.devkit/hooks/');
    expect(exclude).toContain('services/webapp/guard.config.json');

    // configs in the package; hook cd's into it; core.hooksPath at the root
    expect(existsSync(join(pkg, 'guard.config.json'))).toBe(true);
    expect(readFileSync(join(root, '.devkit', 'hooks', 'pre-commit'), 'utf8')).toContain(
      'cd "services/webapp"',
    );
    expect(
      execFileSync('git', ['config', '--get', 'core.hooksPath'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
    ).toBe('.devkit/hooks');
    expect(() =>
      execFileSync('sh', ['-n', join(root, '.devkit', 'hooks', 'pre-commit')], { stdio: 'pipe' }),
    ).not.toThrow();
    // still invisible
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    ).toBe('');
  });

  it('preserves ALL the repo hooks (pass-through wrappers), not just pre-commit', async () => {
    const root = mkTmp('overlay-hooks-');
    const git = (...a) => execFileSync('git', a, { cwd: root });
    git('init', '-q');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'work' }, null, 2));
    mkdirSync(join(root, '.husky'), { recursive: true });
    for (const h of ['pre-commit', 'pre-push', 'commit-msg']) {
      writeFileSync(join(root, '.husky', h), `#!/bin/sh\necho ${h}\n`);
    }
    git('config', 'core.hooksPath', '.husky/_');
    git('add', '-A');
    git('commit', '-qm', 'init');

    await applyInit(root, {
      stack: 'generic',
      selection: defaultSelection(),
      overlay: true,
      devkitRef: 'v0.8.0',
    });

    // a wrapper exists for EVERY repo hook (else core.hooksPath takeover would silently drop it)
    for (const h of ['pre-commit', 'pre-push', 'commit-msg']) {
      expect(existsSync(join(root, '.devkit', 'hooks', h))).toBe(true);
    }
    // pre-commit runs devkit gates; the others are pure pass-throughs to the repo's own
    const pre = readFileSync(join(root, '.devkit', 'hooks', 'pre-commit'), 'utf8');
    const push = readFileSync(join(root, '.devkit', 'hooks', 'pre-push'), 'utf8');
    expect(pre).toContain('__dk_gate');
    expect(push).not.toContain('__dk_gate');
    expect(push).toContain('.husky/pre-push');
  });

  it('devkit clean reverses overlay (restores core.hooksPath, removes files, prunes exclude)', async () => {
    const root = workRepo(); // committed husky pre-commit + eslint + biome; core.hooksPath .husky/_
    await applyInit(root, {
      stack: 'react-app',
      selection: defaultSelection(),
      overlay: true,
      devkitRef: 'v0.8.0',
    });
    // overlay applied
    expect(
      execFileSync('git', ['config', '--get', 'core.hooksPath'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
      // Reason: test scenario setup is intentionally explicit + self-contained per install mode (package/standalone/overlay/monorepo); shared bits already live in __tests__/_helpers.mjs
      // fallow-ignore-next-line code-duplication
    ).toBe('.devkit/hooks');

    const cleanRun = (await import('../commands/clean.mjs')).default;
    await cleanRun(['--yes'], root);

    // core.hooksPath restored to the original; devkit files gone; the team's untouched
    expect(
      execFileSync('git', ['config', '--get', 'core.hooksPath'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
    ).toBe('.husky/_');
    expect(existsSync(join(root, '.devkit'))).toBe(false);
    expect(existsSync(join(root, 'guard.config.json'))).toBe(false);
    expect(existsSync(join(root, 'biome.devkit.jsonc'))).toBe(false);
    expect(existsSync(join(root, 'eslint.config.devkit.mjs'))).toBe(false);
    expect(existsSync(join(root, 'biome.jsonc'))).toBe(true); // the team's, untouched
    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).not.toContain('.devkit/');
    // back to a clean committed state
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    ).toBe('');
  });

  it('re-running overlay keeps the TRUE original core.hooksPath (clean restores it, not .devkit/hooks)', async () => {
    const root = workRepo(); // core.hooksPath .husky/_
    const opts = {
      stack: 'react-app',
      selection: defaultSelection(),
      overlay: true,
      devkitRef: 'v0.8.1',
    };
    await applyInit(root, opts);
    await applyInit(root, opts); // re-run — current hooksPath is now .devkit/hooks

    // the recorded original must still be the TRUE one, not devkit's own (deleted-on-clean) dir
    expect(
      JSON.parse(readFileSync(join(root, '.devkit', 'config.json'), 'utf8')).origHooksPath,
    ).toBe('.husky/_');

    const cleanRun = (await import('../commands/clean.mjs')).default;
    await cleanRun(['--yes'], root);
    // Reason: test scenario setup is intentionally explicit + self-contained per install mode (package/standalone/overlay/monorepo); shared bits already live in __tests__/_helpers.mjs
    // fallow-ignore-next-line code-duplication
    expect(
      execFileSync('git', ['config', '--get', 'core.hooksPath'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
    ).toBe('.husky/_');
  });

  it('installs a per-clone `git ci` self-heal alias that re-points core.hooksPath', async () => {
    const root = workRepo();
    const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
    await applyInit(root, {
      stack: 'react-app',
      selection: defaultSelection(),
      overlay: true,
      devkitRef: 'v0.9.0',
    });

    expect(git('config', '--local', '--get', 'alias.ci').trim()).toBe(HEAL_ALIAS_CMD);

    // simulate husky re-claiming the hook on `bun install`, then heal via `git ci`
    git('config', 'core.hooksPath', '.husky/_');
    git('ci', '--allow-empty', '-m', 'heal');
    expect(git('config', '--get', 'core.hooksPath').trim()).toBe('.devkit/hooks');
  });

  it('clean removes the self-heal alias', async () => {
    const root = workRepo();
    await applyInit(root, {
      stack: 'react-app',
      selection: defaultSelection(),
      overlay: true,
      devkitRef: 'v0.9.0',
    });
    const cleanRun = (await import('../commands/clean.mjs')).default;
    await cleanRun(['--yes'], root);
    expect(() =>
      execFileSync('git', ['config', '--local', '--get', 'alias.ci'], { cwd: root, stdio: 'pipe' }),
    ).toThrow(); // unset → git exits 1
  });

  it("never clobbers a user's GLOBAL `ci` alias (skip-on-collision)", async () => {
    const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = join(mkTmp('ghome-'), '.gitconfig');
    try {
      const root = workRepo();
      const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
      git('config', '--global', 'alias.ci', 'commit -v');

      await applyInit(root, {
        stack: 'react-app',
        selection: defaultSelection(),
        overlay: true,
        devkitRef: 'v0.9.0',
      });

      // no LOCAL alias was installed (would shadow the global) …
      expect(() =>
        execFileSync('git', ['config', '--local', '--get', 'alias.ci'], {
          cwd: root,
          stdio: 'pipe',
        }),
      ).toThrow();
      // … and the user's global `ci` is intact, before AND after clean
      expect(git('config', '--global', '--get', 'alias.ci').trim()).toBe('commit -v');
      const cleanRun = (await import('../commands/clean.mjs')).default;
      await cleanRun(['--yes'], root);
      expect(git('config', '--global', '--get', 'alias.ci').trim()).toBe('commit -v');
    } finally {
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    }
  });

  it('freeze-if-absent: re-running overlay keeps the baseline (does NOT re-grandfather new debt)', async () => {
    const root = workRepo();
    const opts = {
      stack: 'react-app',
      selection: defaultSelection(),
      overlay: true,
      devkitRef: 'v0.9.0',
    };
    await applyInit(root, opts);
    const sizeBefore = readFileSync(join(root, 'eslint', 'baselines', 'size.json'), 'utf8');
    expect(JSON.parse(sizeBefore).fileDisables).toBe(0);

    // add NEW size debt (an inline max-lines disable) — a re-freeze WOULD grandfather it
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'huge.ts'),
      '// eslint-disable max-lines\nexport const x = 1;\n',
    );
    await applyInit(root, opts);

    // baseline unchanged → the ratchet still catches the new disable on the next commit
    expect(readFileSync(join(root, 'eslint', 'baselines', 'size.json'), 'utf8')).toBe(sizeBefore);
  });

  it('freeze-if-absent still creates a MISSING size-lines baseline when maxLines is later turned on', async () => {
    const root = workRepo();
    const opts = {
      stack: 'react-app',
      selection: defaultSelection(),
      overlay: true,
      devkitRef: 'v0.9.0',
    };
    await applyInit(root, opts); // no maxLines yet → only size.json
    const linesBaseline = join(root, 'eslint', 'baselines', 'size-lines.json');
    expect(existsSync(linesBaseline)).toBe(false);

    // turn on the raw-line cap, then re-apply — size.json exists but size-lines.json is still missing
    const cfgPath = join(root, 'guard.config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.maxLines = 50;
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
    await applyInit(root, opts);

    expect(existsSync(linesBaseline)).toBe(true); // first-freeze of the lines baseline was NOT skipped
  });
});
