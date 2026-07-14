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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import doctorRun from '../commands/doctor.mts';
import { applyInit } from '../commands/init.mts';
import update, { fetchLatestTag } from '../commands/update.mts';
import upgrade from '../commands/upgrade.mts';
import { applyOverlayConstraints, defaultSelection } from '../lib/components.mts';
import { isTracked } from '../lib/git-tracked.mts';
import { HEAL_ALIAS_CMD, syncOverlayHook } from '../lib/overlay.mts';
import { removeSkills } from '../lib/sync-manifest.mts';
import { rootRegistry } from './_helpers.mts';

// A full overlay selection with the opt-ins (agentHooks + fallow) ON — what the wizard produces
// when the user checks everything. applyInit consumes an already-resolved selection directly, so we
// apply the overlay constraints here too (forces tsconfig/structure/searchSteering off, husky on).
const overlayAll = () =>
  applyOverlayConstraints({ ...defaultSelection(), agentHooks: true, fallow: true });

// Stub fallow's external CLI (detect/install/baselines/hook) so overlay's fallow flow runs without
// a real `fallow` binary or a global network install. detectFallow → present, so resolveOverlayFallow
// wires the gate without installing. Plain fns (not vi.fn) so afterEach's restoreAllMocks can't clear them.
vi.mock('../lib/install/install-fallow.mts', async (importOriginal) => ({
  ...(await importOriginal()),
  detectFallow: () => ({ available: true, version: '2.89.0' }),
  installFallow: () => ({ ok: true, method: 'bun', message: 'installed fallow@2.89.0 via bun' }),
  saveFallowBaselines: () => ({ ok: true }),
  wireFallowGate: () => ({ ok: true }),
}));

// For the overlay-upgrade suite below: keep cmpSemver / needsRerun / repoUrl REAL, but stub the
// network (fetchLatestTag) and the install (default `update`, which for an overlay runs a global
// `bun add -g` — it must NOT touch the machine's global CLI from a test). applyInit + doctor stay REAL
// so the re-sync is actually exercised. No existing overlay test calls update/fetchLatestTag, so this
// module-wide mock is inert for them (doctor imports only the real cmpSemver).
vi.mock('../commands/update.mts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../commands/update.mts')>()),
  default: vi.fn(async () => 0),
  fetchLatestTag: vi.fn(),
}));

const { mkTmp, cleanup } = rootRegistry();

// These are subprocess-heavy integration tests (real `git init`/`commit` + a full applyInit overlay).
// Isolated they run in ~1-2s, but under the full suite's parallel load git/FS scheduling contention
// pushes them well past 30s. Match the global 120s testTimeout (vitest.config.mjs) — a lower cap
// here UNDERCUTS the global and re-flakes on a loaded box (observed at load ~50-70) — a genuine hang
// still dies, just slower; assertions unchanged.
vi.setConfig({ testTimeout: 120000 });

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

// Seed an existing (untracked) .claude/settings.local.json — the user's own — before an overlay run.
function seedLocalSettings(root, obj) {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'settings.local.json'), JSON.stringify(obj));
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
    expect(hook).toContain('guard-deterministic'); // devkit's deterministic gates run in the overlay
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
    expect(pre).toContain('guard-deterministic');
    expect(push).not.toContain('guard-deterministic');
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

    const cleanRun = (await import('../commands/clean.mts')).default;
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

    const cleanRun = (await import('../commands/clean.mts')).default;
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
    const cleanRun = (await import('../commands/clean.mts')).default;
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
      const cleanRun = (await import('../commands/clean.mts')).default;
      await cleanRun(['--yes'], root);
      expect(git('config', '--global', '--get', 'alias.ci').trim()).toBe('commit -v');
    } finally {
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    }
  });

  it('adopted repo never re-grandfathers new debt (baselining is init-only; baseline stays absent)', async () => {
    const root = workRepo();
    const opts = {
      stack: 'react-app',
      selection: defaultSelection(),
      overlay: true,
      devkitRef: 'v0.9.0',
    };
    await applyInit(root, opts);
    // A clean repo has zero disables → NO empty size.json is written (an empty baseline is not kept
    // as a sentinel any more). The durable "already adopted" marker is .devkit/config.json.
    const sizeBaseline = join(root, 'eslint', 'baselines', 'size.json');
    expect(existsSync(sizeBaseline)).toBe(false);
    expect(existsSync(join(root, '.devkit', 'config.json'))).toBe(true);

    // add NEW size debt (an inline max-lines disable) — a re-freeze WOULD grandfather it
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'huge.ts'),
      '// eslint-disable max-lines\nexport const x = 1;\n',
    );
    await applyInit(root, opts);

    // Adopted (marker present) → freeze is skipped, so the new debt is NEVER grandfathered; the
    // baseline stays absent and the size gate still catches the disable via enforce-from-config
    // (proven in gate-engine/ratchets/__tests__/size-disable.test.mts).
    expect(existsSync(sizeBaseline)).toBe(false);
  });

  it('init-only: re-apply does NOT auto-create size-lines when maxLines is enabled later (explicit freeze does)', async () => {
    const root = workRepo();
    const opts = {
      stack: 'react-app',
      selection: defaultSelection(),
      overlay: true,
      devkitRef: 'v0.9.0',
    };
    await applyInit(root, opts); // no maxLines yet
    const linesBaseline = join(root, 'eslint', 'baselines', 'size-lines.json');
    expect(existsSync(linesBaseline)).toBe(false);

    // turn on the raw-line cap AND add a legacy giant that would need grandfathering
    const cfgPath = join(root, 'guard.config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.maxLines = 50;
    cfg.scanRoots = ['src'];
    cfg.sourceExtensions = ['ts'];
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'legacy.ts'), `${Array(80).fill('const x = 1;').join('\n')}\n`);

    await applyInit(root, opts);
    // Adopted repo → baselining is init-only; the implicit re-apply does NOT snapshot the giant.
    expect(existsSync(linesBaseline)).toBe(false);

    // The EXPLICIT re-cut path (`guard-size freeze`) is how a later cap is grandfathered.
    const script = join(process.cwd(), 'gate-engine', 'ratchets', 'size-disable.mts');
    execFileSync(process.execPath, [script, 'freeze'], { cwd: root });
    expect(existsSync(linesBaseline)).toBe(true);
  });

  // ── agent-half + fallow (the components overlay grew to install) ────────────────

  it('syncs skills + agents into the surfaces and hides them (invisible), no clobber', async () => {
    const root = workRepo(); // .claude / .cursor untracked
    await applyInit(root, {
      stack: 'react-app',
      selection: defaultSelection(), // skills + agents on (agentHooks/fallow off)
      overlay: true,
      devkitRef: 'v0.21.0',
    });

    expect(existsSync(join(root, '.claude', 'skills'))).toBe(true);
    expect(existsSync(join(root, '.cursor', 'agents'))).toBe(true);
    expect(existsSync(join(root, '.devkit', 'skills-manifest.json'))).toBe(true);
    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('.claude/skills/');
    expect(exclude).toContain('.cursor/agents/');
    // INVISIBLE: every synced file is excluded → status stays clean
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    ).toBe('');
  });

  it('Claude hooks register into settings.local.json (not the shared settings.json)', async () => {
    const root = workRepo();
    await applyInit(root, {
      stack: 'react-app',
      selection: overlayAll(),
      overlay: true,
      devkitRef: 'v0.21.0',
    });

    const local = join(root, '.claude', 'settings.local.json');
    expect(existsSync(local)).toBe(true);
    const cmds = JSON.stringify(JSON.parse(readFileSync(local, 'utf8')).hooks);
    expect(cmds).toContain('.claude/hooks/'); // a devkit agent-hook command landed here
    // the shared settings.json was NOT created by devkit
    expect(existsSync(join(root, '.claude', 'settings.json'))).toBe(false);
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    ).toBe('');
  });

  it('merges into an existing settings.local.json (preserves the user’s keys + hooks)', async () => {
    const root = workRepo();
    seedLocalSettings(root, {
      model: 'opus',
      hooks: {
        UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'echo mine' }] }],
      },
    });

    await applyInit(root, {
      stack: 'react-app',
      selection: overlayAll(),
      overlay: true,
      devkitRef: 'v0.21.0',
    });

    const merged = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'));
    expect(merged.model).toBe('opus'); // user key survives
    const all = JSON.stringify(merged.hooks);
    expect(all).toContain('echo mine'); // user hook survives
    expect(all).toContain('.claude/hooks/'); // devkit hooks merged in
  });

  it('skips a git-TRACKED .cursor/hooks.json (warns, no edit, no exclude line)', async () => {
    const root = mkTmp('overlay-cursor-');
    const git = (...a) => execFileSync('git', a, { cwd: root });
    git('init', '-q');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'work' }, null, 2));
    mkdirSync(join(root, '.cursor'), { recursive: true });
    const cursorBefore = '{ "version": 1, "hooks": {} }\n';
    writeFileSync(join(root, '.cursor', 'hooks.json'), cursorBefore);
    git('add', '-A');
    git('commit', '-qm', 'init');

    await applyInit(root, {
      stack: 'generic',
      selection: overlayAll(),
      overlay: true,
      devkitRef: 'v0.21.0',
    });

    // tracked → untouched + warned + not excluded (an exclude line can't hide a tracked edit)
    expect(readFileSync(join(root, '.cursor', 'hooks.json'), 'utf8')).toBe(cursorBefore);
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')).not.toContain(
      '.cursor/hooks.json',
    );
    const logged = console.log.mock.calls.flat().join('\n');
    expect(logged).toContain('.cursor/hooks.json is git-tracked');
    // Claude side still wired into the (untracked) local-override file
    expect(existsSync(join(root, '.claude', 'settings.local.json'))).toBe(true);
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    ).toBe('');
  });

  it('skips a git-TRACKED skill dir (no clobber), syncs the rest', async () => {
    const root = mkTmp('overlay-trackedskill-');
    const git = (...a) => execFileSync('git', a, { cwd: root });
    git('init', '-q');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'work' }, null, 2));
    // the team committed a devkit-named skill dir
    mkdirSync(join(root, '.claude', 'skills', 'commit-guard'), { recursive: true });
    const teamSkill = '# team’s own commit-guard\n';
    writeFileSync(join(root, '.claude', 'skills', 'commit-guard', 'SKILL.md'), teamSkill);
    git('add', '-A');
    git('commit', '-qm', 'init');

    await applyInit(root, {
      stack: 'generic',
      selection: defaultSelection(),
      overlay: true,
      devkitRef: 'v0.21.0',
    });

    // tracked skill left byte-identical; it's omitted from the manifest; OTHER skills synced
    expect(readFileSync(join(root, '.claude', 'skills', 'commit-guard', 'SKILL.md'), 'utf8')).toBe(
      teamSkill,
    );
    const manifest = JSON.parse(
      readFileSync(join(root, '.devkit', 'skills-manifest.json'), 'utf8'),
    );
    expect(Object.keys(manifest.files).some((k) => k.startsWith('commit-guard/'))).toBe(false);
    expect(Object.keys(manifest.files).length).toBeGreaterThan(0);
    const logged = console.log.mock.calls.flat().join('\n');
    expect(logged).toContain('skipping skill "commit-guard"');
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    ).toBe('');
  });

  it('wires fallow as an inline hook gate (not `fallow hooks install`); baselines + cache hidden', async () => {
    const root = workRepo();
    await applyInit(root, {
      stack: 'react-app',
      selection: overlayAll(),
      overlay: true,
      devkitRef: 'v0.21.0',
    });

    const hook = readFileSync(join(root, '.devkit', 'hooks', 'pre-commit'), 'utf8');
    expect(hook).toContain('fallow audit'); // inline gate
    expect(hook).not.toContain('fallow hooks install'); // NOT fallow's own (shadowed) hook
    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('.fallow/');
    expect(exclude).toContain('fallow-baselines/');
    // overlay never edits the committed .gitignore for fallow
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
    // config records fallow as actually wired
    expect(
      JSON.parse(readFileSync(join(root, '.devkit', 'config.json'), 'utf8')).components.fallow,
    ).toBe(true);
  });

  it('clean reverses the agent-half + fallow (files gone, devkit-created settings gone, exclude pruned)', async () => {
    const root = workRepo();
    await applyInit(root, {
      stack: 'react-app',
      selection: overlayAll(),
      overlay: true,
      devkitRef: 'v0.21.0',
    });
    expect(existsSync(join(root, '.claude', 'skills'))).toBe(true);
    expect(existsSync(join(root, '.claude', 'settings.local.json'))).toBe(true);

    const cleanRun = (await import('../commands/clean.mts')).default;
    await cleanRun(['--yes'], root);

    expect(existsSync(join(root, '.claude', 'skills'))).toBe(false);
    expect(existsSync(join(root, '.claude', 'agents'))).toBe(false);
    expect(existsSync(join(root, '.claude', 'hooks'))).toBe(false);
    expect(existsSync(join(root, '.devkit'))).toBe(false);
    expect(existsSync(join(root, 'fallow-baselines'))).toBe(false);
    // devkit created settings.local.json + it's now empty after stripping → removed (no footprint)
    expect(existsSync(join(root, '.claude', 'settings.local.json'))).toBe(false);
    // exclude pruned of EVERY devkit line — no orphans (skills/agents/hooks/settings/fallow, both surfaces)
    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    for (const line of [
      '.claude/skills/',
      '.cursor/agents/',
      '.claude/hooks/',
      '.cursor/hooks/',
      '.cursor/hooks.json',
      'settings.local.json',
      '.fallow/',
      'fallow-baselines/',
      'devkit',
    ]) {
      expect(exclude).not.toContain(line);
    }
    // full round-trip: back to a clean committed state
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    ).toBe('');
  });

  it('clean KEEPS a settings.local.json that holds the user’s own content', async () => {
    const root = workRepo();
    seedLocalSettings(root, { model: 'opus', hooks: {} });
    await applyInit(root, {
      stack: 'react-app',
      selection: overlayAll(),
      overlay: true,
      devkitRef: 'v0.21.0',
    });
    const cleanRun = (await import('../commands/clean.mts')).default;
    await cleanRun(['--yes'], root);

    const local = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'));
    expect(local.model).toBe('opus'); // user key survives
    expect(JSON.stringify(local.hooks)).not.toContain('.claude/hooks/'); // devkit hooks stripped
  });

  it('isTracked: true for a committed file, false for an untracked one', () => {
    const root = mkTmp('istracked-');
    const git = (...a) => execFileSync('git', a, { cwd: root });
    git('init', '-q');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    writeFileSync(join(root, 'tracked.txt'), 'x');
    git('add', 'tracked.txt');
    git('commit', '-qm', 'init');
    writeFileSync(join(root, 'untracked.txt'), 'y');

    expect(isTracked(root, 'tracked.txt')).toBe(true);
    expect(isTracked(root, 'untracked.txt')).toBe(false);
  });

  it('clean recovers STRANDED overlay leftovers when .devkit (config + manifests) is gone', async () => {
    // Reproduces the orphaned state: config + manifests deleted, core.hooksPath already restored, but
    // the synced agent-half + fallow-baselines remain. clean must still find + remove them (by the
    // bundled-name fallback, since the manifests are gone) — never strand a footprint.
    const root = workRepo();
    await applyInit(root, {
      stack: 'react-app',
      selection: overlayAll(),
      overlay: true,
      devkitRef: 'v0.22.0',
    });
    expect(existsSync(join(root, '.claude', 'skills'))).toBe(true);
    rmSync(join(root, '.devkit'), { recursive: true, force: true }); // config + manifests gone
    execFileSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: root }); // hook already restored

    const cleanRun = (await import('../commands/clean.mts')).default;
    await cleanRun(['--yes'], root);

    // every synced artifact removed despite the missing manifests
    expect(existsSync(join(root, '.claude', 'skills'))).toBe(false);
    expect(existsSync(join(root, '.cursor', 'agents'))).toBe(false);
    expect(existsSync(join(root, '.claude', 'hooks'))).toBe(false);
    expect(existsSync(join(root, 'fallow-baselines'))).toBe(false);
    expect(existsSync(join(root, '.claude', 'settings.local.json'))).toBe(false);
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    ).toBe('');
  });

  it('clean NEVER deletes a git-tracked skill dir (the user’s own, not a devkit stray)', () => {
    const root = mkTmp('clean-tracked-');
    const git = (...a) => execFileSync('git', a, { cwd: root });
    git('init', '-q');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'work' }, null, 2));
    // the team commits their OWN skill that happens to share a devkit-bundled name (no manifest →
    // removeSkills uses the bundled-name fallback, which must SKIP anything git tracks)
    mkdirSync(join(root, '.claude', 'skills', 'brainstorming'), { recursive: true });
    writeFileSync(join(root, '.claude', 'skills', 'brainstorming', 'SKILL.md'), '# ours\n');
    git('add', '-A');
    git('commit', '-qm', 'init');

    removeSkills(root, false);

    expect(existsSync(join(root, '.claude', 'skills', 'brainstorming', 'SKILL.md'))).toBe(true);
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    ).toBe('');
  });

  it('applyOverlayConstraints: forces non-viable off + husky on, keeps the viable opt-in/opt-out', () => {
    const sel = applyOverlayConstraints({
      ...defaultSelection(),
      tsconfig: true,
      structure: true,
      searchSteering: true,
      searchCode: true,
      husky: false,
      skills: true,
      agents: false, // user opted OUT — must be preserved
      agentHooks: true, // opted IN — preserved
      fallow: true,
    });
    // can't-work-without-the-package components are forced off; the local hook is forced on
    expect(sel.tsconfig).toBe(false);
    expect(sel.structure).toBe(false);
    expect(sel.searchSteering).toBe(false);
    expect(sel.searchCode).toBe(false);
    expect(sel.husky).toBe(true);
    // viable choices pass through untouched (overlay offers the same opt-in choices as package)
    expect(sel.skills).toBe(true);
    expect(sel.agents).toBe(false);
    expect(sel.agentHooks).toBe(true);
    expect(sel.fallow).toBe(true);
  });
});

// `devkit update` re-pins the CLI but never regenerates the git-ignored .devkit/hooks/pre-commit, so an
// updated overlay repo can keep an OLD hook shape (a version-skew gap). syncOverlayHook + `doctor --fix`
// let the hook be refreshed without a manual `devkit init --overlay`.
describe('overlay hook regeneration (syncOverlayHook + doctor --fix)', () => {
  const initOverlay = (root) =>
    applyInit(root, {
      stack: 'react-app',
      selection: defaultSelection(),
      overlay: true,
      devkitRef: 'v0.7.0',
    });
  // Simulate a post-update skew: overwrite the fresh hook with an OLD shape (no ship sentinel).
  const staleHook = (root) =>
    writeFileSync(
      join(root, '.devkit', 'hooks', 'pre-commit'),
      '#!/bin/sh\n# old devkit overlay hook\nexit 0\n',
    );
  const readHook = (root) => readFileSync(join(root, '.devkit', 'hooks', 'pre-commit'), 'utf8');
  const readCfg = (root) => JSON.parse(readFileSync(join(root, '.devkit', 'config.json'), 'utf8'));

  it('syncOverlayHook detects a stale hook, regenerates it, then reports clean (idempotent)', async () => {
    const root = workRepo();
    await initOverlay(root);
    staleHook(root);
    const cfg = readCfg(root);

    // dry-run: drift detected, nothing written
    expect(syncOverlayHook(root, root, cfg, { dryRun: true })).toEqual({
      missing: false,
      drift: true,
    });
    expect(readHook(root)).not.toContain('devkit-gates: chain start');

    // heal: reports the pre-write drift AND rewrites the hook to the current shape
    expect(syncOverlayHook(root, root, cfg, { dryRun: false }).drift).toBe(true);
    expect(readHook(root)).toContain('devkit-gates: chain start'); // the current ship sentinel is back
    expect(readHook(root)).toContain('.husky/pre-commit'); // still chains to the team's hook

    // idempotent: a freshly-healed hook shows no drift
    expect(syncOverlayHook(root, root, cfg, { dryRun: true }).drift).toBe(false);
  });

  it('doctor flags a stale overlay hook (exit 1); doctor --fix regenerates it (exit 0)', async () => {
    const root = workRepo();
    await initOverlay(root);
    staleHook(root);

    // read-only doctor: STALE → drift → exit 1, hook untouched
    expect(await doctorRun([], root)).toBe(1);
    expect(readHook(root)).not.toContain('devkit-gates: chain start');

    // doctor --fix: regenerates → exit 0, sentinel restored
    expect(await doctorRun(['--fix'], root)).toBe(0);
    expect(readHook(root)).toContain('devkit-gates: chain start');
  });
});

// `devkit upgrade` in an overlay repo used to BAIL (exit 1, "re-run devkit init --overlay to re-sync").
// It now re-syncs in place: the pin is .devkit/config.json's `devkitRef` (install-agnostic — overlay
// has no package.json dep), so upgrade resolves it, optionally bumps the global CLI to a newer tag, then
// regenerates the git-ignored gate chain + configs and verifies — the same shape as the self-host branch.
describe('overlay upgrade (re-syncs, not the old bail)', () => {
  const cfgPathOf = (root) => join(root, '.devkit', 'config.json');
  const readCfg = (root) => JSON.parse(readFileSync(cfgPathOf(root), 'utf8'));
  // The version the running CLI reports (upgrade reads its OWN package.json via packageDir()).
  const V = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version;
  const mkOverlay = (root, extra = {}) =>
    applyInit(root, {
      stack: 'react-app',
      selection: defaultSelection(),
      overlay: true,
      devkitRef: 'v0.7.0',
      ...extra,
    });

  beforeEach(() => {
    // Re-establish the mock impls each test (the suite's afterEach runs vi.restoreAllMocks()).
    vi.mocked(update).mockReset().mockResolvedValue(0);
    vi.mocked(fetchLatestTag).mockReset().mockReturnValue({ latest: '0.0.0' }); // steady state: nothing newer
  });

  it('re-syncs instead of bailing: regenerates a stale hook, exit 0, no install', async () => {
    const root = workRepo();
    await mkOverlay(root);
    // simulate a post-update skew: an OLD hook shape that upgrade must refresh
    writeFileSync(join(root, '.devkit', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');

    const code = await upgrade([], root);

    expect(code).toBe(0); // NOT the old exit-1 bail
    expect(vi.mocked(update)).not.toHaveBeenCalled(); // nothing newer published → no global install
    const hook = readFileSync(join(root, '.devkit', 'hooks', 'pre-commit'), 'utf8');
    expect(hook).toContain('guard-deterministic'); // regenerated to the real overlay gate chain
    expect(hook).toContain('.husky/pre-commit'); // still chains to the team's committed hook
  });

  it('bumps the config.json devkitRef pin when a newer tag is published (running CLI current)', async () => {
    const root = workRepo();
    await mkOverlay(root); // pinned at v0.7.0
    vi.mocked(fetchLatestTag).mockReturnValue({ latest: V }); // published == running CLI → needsRerun false

    const code = await upgrade([], root);

    expect(code).toBe(0);
    expect(vi.mocked(update)).toHaveBeenCalledTimes(1); // installed the newer tag (stubbed global add)
    expect(readCfg(root).devkitRef).toBe(`v${V}`); // pin bumped in the SAME pass
  });

  it('running CLI behind latest → installs and returns NEEDS_RERUN (10), pin NOT yet bumped', async () => {
    const root = workRepo();
    await mkOverlay(root);
    vi.mocked(fetchLatestTag).mockReturnValue({ latest: '99.0.0' }); // newer than the running CLI

    const code = await upgrade([], root);

    expect(code).toBe(10);
    expect(vi.mocked(update)).toHaveBeenCalledTimes(1);
    expect(readCfg(root).devkitRef).toBe('v0.7.0'); // returned before reconciling
  });

  it('preserves an opted-in globalCommitGate on re-sync (never silently un-wires the shim)', async () => {
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = mkTmp('overlay-xdg-'); // sandbox the machine-global init.sh write
    try {
      const root = workRepo();
      await mkOverlay(root, { globalCommitGate: true });
      expect(readCfg(root).globalCommitGate).toBe(true);

      await upgrade([], root);

      expect(readCfg(root).globalCommitGate).toBe(true); // still wired after the re-sync
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
    }
  });

  it('idempotent: re-sync never re-freezes debt (adopted → baseline stays absent), exit 0', async () => {
    const root = workRepo();
    await mkOverlay(root);
    const sizeBaseline = join(root, 'eslint', 'baselines', 'size.json');
    expect(existsSync(sizeBaseline)).toBe(false);

    // add NEW size debt that a re-freeze WOULD grandfather
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'huge.ts'),
      '// eslint-disable max-lines\nexport const x = 1;\n',
    );

    expect(await upgrade([], root)).toBe(0);
    expect(existsSync(sizeBaseline)).toBe(false); // adopted repo → freeze skipped, debt not laundered
  });

  it('--dry-run writes nothing (a stale hook stays stale), exit 0', async () => {
    const root = workRepo();
    await mkOverlay(root);
    const stale = '#!/bin/sh\nexit 0\n';
    writeFileSync(join(root, '.devkit', 'hooks', 'pre-commit'), stale);

    const code = await upgrade(['--dry-run'], root);

    expect(code).toBe(0);
    expect(readFileSync(join(root, '.devkit', 'hooks', 'pre-commit'), 'utf8')).toBe(stale); // untouched
  });

  it('does NOT re-add biome to a --no-biome overlay (opt-out survives; applyOverlay never records biome)', async () => {
    const root = workRepo();
    // simulate `devkit init --overlay --no-biome`: biome off, so no biome.devkit.jsonc is written and
    // applyOverlay's config write never records `biome` (its components literal omits the key).
    await applyInit(root, {
      stack: 'react-app',
      selection: applyOverlayConstraints({ ...defaultSelection(), biome: false }),
      overlay: true,
      devkitRef: 'v0.7.0',
    });
    expect(existsSync(join(root, 'biome.devkit.jsonc'))).toBe(false); // opted out at init
    expect(readCfg(root).components.biome).toBeUndefined(); // never persisted → the gap the fix closes

    await upgrade([], root);

    // upgrade infers biome from the absent on-disk marker (not normalizeSelection's true default), so
    // the opt-out is honoured — biome.devkit.jsonc is NOT silently re-added.
    expect(existsSync(join(root, 'biome.devkit.jsonc'))).toBe(false);
  });

  it('upgrade --force does NOT overwrite a tuned guard.config.json (configs are never overwritten)', async () => {
    const root = workRepo();
    await mkOverlay(root);
    const gc = join(root, 'guard.config.json');
    const tuned = { ...JSON.parse(readFileSync(gc, 'utf8')), __tuned: 'keep-me' };
    writeFileSync(gc, `${JSON.stringify(tuned, null, 2)}\n`);

    await upgrade(['--force'], root);

    // --force forwards force:false into applyOverlay's config writers, so the hand-tuned file survives.
    expect(JSON.parse(readFileSync(gc, 'utf8')).__tuned).toBe('keep-me');
  });

  it("non-semver devkitRef ('main'/branch/SHA): resolves to the running version, never persists 'vmain'", async () => {
    const root = workRepo();
    await mkOverlay(root);
    // an overlay installed off a branch, not a tag — devkitRef is not a comparable semver
    const cfg = readCfg(root);
    cfg.devkitRef = 'main';
    writeFileSync(cfgPathOf(root), JSON.stringify(cfg));

    expect(await upgrade([], root)).toBe(0);

    const after = readCfg(root).devkitRef;
    expect(after).not.toBe('vmain'); // NOT the corrupt ref the naive slice would persist
    expect(after.startsWith('v')).toBe(true);
    // the tail is a real semver (resolved from the running CLI), not the branch name
    expect(
      after
        .slice(1)
        .split('.')
        .every((p: string) => Number.isInteger(Number(p))),
    ).toBe(true);
  });
});
