/**
 * Local-only overlay installs keep Devkit files invisible via `.git/info/exclude`, redirect the
 * clone's `core.hooksPath` through Devkit while preserving existing hooks, and extend committed
 * lint configs without touching package.json. Husky may reclaim the hook path after install;
 * `git ci`, re-running overlay init, or the optional global commit gate restores it.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { syncAgents } from '../commands/sync/sync-agents.mts';
import { syncSkills } from '../commands/sync/sync-skills.mts';
import { AGENT_TARGETS, normalizeSelection, type Selection } from './components.mts';
import { detectGitRoot } from './detect-git-root.mts';
import { packageDir, readJson, writeIfAbsent } from './fs-helpers.mts';
import { trackedPathPredicate } from './git-tracked.mts';
import { buildOverlayHook, buildPassthroughHook } from './husky/husky-block.mts';
import { selectedHookAssets } from './install/hook-registration-ledger/selection.mts';
import { detectFallow, installFallow, saveFallowBaselines } from './install/install-fallow.mts';
import {
  installHookRegistrations,
  removeHookRegistrations,
  removeHookScripts,
  syncHookScripts,
} from './install/install-hooks.mts';
import { overlayAssetExcludes } from './install/overlay-asset-excludes.mts';
import { addToGitExclude } from './install/overlay-excludes.mts';
import { firstLine } from './standalone.mts';
import { removeAgents, removeSkills } from './sync-manifest.mts';

const LOCAL_HOOKS = '.devkit/hooks';
// every `bun install`; this LOCAL (uncommitted) alias re-points it back to our hooks dir right
// before a commit, so `git ci …` keeps devkit's gates wired without touching anything committed.
// Fail-open `;` (never `&&`): a re-point hiccup must NEVER block your commit — it just runs the
// repo's own hooks that once, matching every devkit gate's fail-open stance.
const HEAL_ALIAS_NAME = 'ci';
const HEAL_ALIAS_CMD = `!git config --local core.hooksPath ${LOCAL_HOOKS}; git commit`;
// "Ours" by a STABLE marker (the re-point), not the exact literal — so a future HEAL_ALIAS_CMD
// tweak still recognises (and lets `clean` remove) an alias an older devkit installed.
const isHealAlias = (v: string) => v.startsWith('!') && v.includes(`core.hooksPath ${LOCAL_HOOKS}`);
// husky sets core.hooksPath to `.husky/_`; the real committed script is the parent's hook.
const HUSKY_UNDERSCORE_RE = /\/_$/;
// Standard git hook names — used to pick the repo's real hooks out of a hooks dir (ignoring
// husky internals / .sample files / stray entries).
const GIT_HOOKS = new Set([
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'post-rewrite',
  'post-update',
  'pre-auto-gc',
]);

// The raw core.hooksPath (the repo's CURRENT hooks setting), '' if unset. Captured BEFORE we
// override it so `devkit clean` can restore exactly what was there.
function readHooksPath(gitRoot: string) {
  try {
    return execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd: gitRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

// Install the per-clone `git ci` self-heal alias (LOCAL config — never global). The collision check
// reads the RESOLVED value (--get, all scopes) so a user's common GLOBAL `ci` (= `commit -v`) is
// seen and NEVER clobbered; we only set ours when `ci` is unset or already ours.
function installHealAlias(gitRoot: string, dryRun: boolean) {
  let current = '';
  try {
    current = execFileSync('git', ['config', '--get', `alias.${HEAL_ALIAS_NAME}`], {
      cwd: gitRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    current = ''; // unset
  }
  if (current && !isHealAlias(current)) {
    console.log(
      `  • git alias '${HEAL_ALIAS_NAME}' already set — skipping self-heal. Re-point at commit time with: git config core.hooksPath ${LOCAL_HOOKS}`,
    );
    return;
  }
  if (dryRun) {
    console.log(
      `  [dry-run] git config --local alias.${HEAL_ALIAS_NAME} (self-heal core.hooksPath)`,
    );
    return;
  }
  try {
    execFileSync('git', ['config', '--local', `alias.${HEAL_ALIAS_NAME}`, HEAL_ALIAS_CMD], {
      cwd: gitRoot,
    });
    console.log(
      `  ✓ git ${HEAL_ALIAS_NAME} self-heal alias (re-points core.hooksPath before commit)`,
    );
  } catch (e) {
    console.log(`  ! could not set alias.${HEAL_ALIAS_NAME}: ${firstLine(e)}`);
  }
}

// Remove the self-heal alias on `clean` — ONLY when it's ours (by marker) and ONLY at --local scope
// (read --local too, so we never even inspect, let alone touch, the user's GLOBAL `ci`).
export function removeHealAlias(gitRoot: string, dryRun: boolean) {
  let current = '';
  try {
    current = execFileSync('git', ['config', '--local', '--get', `alias.${HEAL_ALIAS_NAME}`], {
      cwd: gitRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return; // no local alias
  }
  if (!isHealAlias(current)) return; // foreign / the user's own — leave it
  if (dryRun) {
    console.log(`  [dry-run] unset local alias.${HEAL_ALIAS_NAME}`);
    return;
  }
  try {
    execFileSync('git', ['config', '--local', '--unset', `alias.${HEAL_ALIAS_NAME}`], {
      cwd: gitRoot,
    });
    console.log(`  ✓ removed git ${HEAL_ALIAS_NAME} self-heal alias`);
  } catch (e) {
    console.log(`  ! could not unset alias.${HEAL_ALIAS_NAME}: ${firstLine(e)}`);
  }
}

export { HEAL_ALIAS_CMD, HEAL_ALIAS_NAME, isHealAlias };

// The TRUE original core.hooksPath to record (so `devkit clean` restores it). CRITICAL: if a
// prior overlay is already in place (current === .devkit/hooks), recording that would make clean
// restore a value devkit itself deleted — so recover the real original from the prior overlay's
// config, else detect husky (.husky/_), else '' (unset). This makes re-running overlay idempotent.
export function captureOrigHooksPath(gitRoot: string, cwd: string): string {
  const current = readHooksPath(gitRoot);
  if (current && current !== LOCAL_HOOKS) return current;
  const prev = readJson(join(cwd, '.devkit', 'config.json'));
  if (
    prev &&
    typeof prev === 'object' &&
    'origHooksPath' in prev &&
    typeof prev.origHooksPath === 'string'
  ) {
    return prev.origHooksPath;
  }
  return existsSync(join(gitRoot, '.husky', '_')) ? '.husky/_' : '';
}

// Where the repo's hook SCRIPTS live (git-root-relative). husky's .husky/_ → the scripts are the
// parent's .husky/<hook>; a custom hooksPath holds them directly; unset → .git/hooks.
export function overlayHookScriptDir(origHooksPath: string) {
  if (origHooksPath && origHooksPath !== LOCAL_HOOKS) {
    return origHooksPath.replace(HUSKY_UNDERSCORE_RE, '');
  }
  return '.git/hooks';
}

// The repo's existing hooks (names) in `scriptDir` — what we must keep running when we take over
// core.hooksPath.
function detectExistingHooks(gitRoot: string, scriptDir: string) {
  const abs = join(gitRoot, scriptDir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).filter((f) => GIT_HOOKS.has(f));
}

// Detect the repo's flat eslint config to extend (overlay only supports flat ESM/JS configs).
function repoEslintConfig(cwd: string) {
  for (const f of ['eslint.config.mjs', 'eslint.config.js']) {
    if (existsSync(join(cwd, f))) return f;
  }
  return null;
}

function writeEslintOverlay(cwd: string, force: boolean, dryRun: boolean) {
  const repo = repoEslintConfig(cwd);
  if (!repo) {
    console.log('  • no flat eslint.config.{mjs,js} found — skipping eslint overlay');
    return false;
  }
  const dest = join(cwd, 'eslint.config.devkit.mjs');
  const content = `// devkit OVERLAY eslint config (LOCAL, git-ignored) — extends the repo's own config and
// adds devkit's built-in size caps (no plugin). The overlay hook runs THIS over staged files.
import repoConfig from './${repo}';

const base = Array.isArray(repoConfig) ? repoConfig : [repoConfig];

export default [
  ...base,
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    ignores: ['**/*.{test,spec}.{ts,tsx,js,jsx}'],
    rules: {
      'max-lines': ['error', { max: 500, skipBlankLines: false, skipComments: false }],
      'max-lines-per-function': [
        'error',
        { max: 300, skipBlankLines: false, skipComments: false, IIFEs: true },
      ],
    },
  },
];
`;
  if (dryRun) {
    console.log(`  [dry-run] write eslint.config.devkit.mjs (extends ./${repo} + size caps)`);
    return true;
  }
  if (existsSync(dest) && !force) {
    console.log('  • eslint.config.devkit.mjs exists (use --force to refresh)');
    return true;
  }
  writeFileSync(dest, content);
  console.log(`  ✓ wrote eslint.config.devkit.mjs (extends ./${repo} + size caps)`);
  return true;
}

function writeBiomeOverlay(cwd: string, stack: string, force: boolean, dryRun: boolean) {
  if (!existsSync(join(cwd, 'biome.jsonc')) && !existsSync(join(cwd, 'biome.json'))) {
    console.log('  • no repo biome config — skipping biome overlay');
    return false;
  }
  const repoBiome = existsSync(join(cwd, 'biome.jsonc')) ? './biome.jsonc' : './biome.json';
  const variant = ['electron', 'react-app', 'next'].includes(stack) ? 'react' : 'base';
  if (dryRun) {
    console.log('  [dry-run] vendor biome base + write biome.devkit.jsonc (extends repo biome)');
    return true;
  }
  // Vendor devkit's biome bases so the overlay can extend them by relative path (no package).
  const destDir = join(cwd, '.devkit', 'biome');
  mkdirSync(destDir, { recursive: true });
  for (const f of readdirSync(join(packageDir(), 'biome'))) {
    copyFileSync(join(packageDir(), 'biome', f), join(destDir, f));
  }
  const content = `${JSON.stringify(
    { extends: [repoBiome, `./.devkit/biome/${variant}.jsonc`] },
    null,
    2,
  )}\n`;
  const dest = join(cwd, 'biome.devkit.jsonc');
  if (existsSync(dest) && !force) {
    console.log('  • biome.devkit.jsonc exists (use --force to refresh)');
    return true;
  }
  writeFileSync(dest, content);
  console.log(`  ✓ wrote biome.devkit.jsonc (extends ${repoBiome} + devkit ${variant})`);
  return true;
}

// Take over core.hooksPath (at the GIT ROOT — repo-wide) and write our hooks dir. CRITICAL: git
// then runs ONLY our dir, so we wrap EVERY hook the repo already had (pre-push, commit-msg, …) as
// a pass-through, or they'd silently stop. pre-commit additionally runs devkit's gates (cd'd into
// the package for a monorepo) before chaining to the repo's pre-commit.
function installOverlayHook(
  gitRoot: string,
  pkgRel: string,
  sel: Selection,
  origHooksPath: string,
  dryRun: boolean,
  fallow = false,
) {
  const scriptDir = overlayHookScriptDir(origHooksPath);
  const existing = detectExistingHooks(gitRoot, scriptDir);
  const preCommitChain = existing.includes('pre-commit') ? `${scriptDir}/pre-commit` : '';
  const passthrough = existing.filter((h) => h !== 'pre-commit');
  if (dryRun) {
    console.log(
      `  [dry-run] git config core.hooksPath ${LOCAL_HOOKS}; pre-commit (gates${preCommitChain ? ` → ${preCommitChain}` : ''}${fallow ? ' + fallow' : ''})${passthrough.length ? `; pass-through: ${passthrough.join(', ')}` : ''}`,
    );
    return;
  }
  const dir = join(gitRoot, LOCAL_HOOKS);
  mkdirSync(dir, { recursive: true });
  // pre-commit: devkit gates (+ optional fallow gate) + chain to the repo's pre-commit (if any).
  const pre = join(dir, 'pre-commit');
  writeFileSync(pre, buildOverlayHook(sel, preCommitChain, pkgRel, { fallow }));
  chmodSync(pre, 0o755);
  // every OTHER existing hook → pass-through wrapper so it keeps running unchanged.
  for (const h of passthrough) {
    const p = join(dir, h);
    writeFileSync(p, buildPassthroughHook(`${scriptDir}/${h}`));
    chmodSync(p, 0o755);
  }
  try {
    execFileSync('git', ['config', 'core.hooksPath', LOCAL_HOOKS], {
      cwd: gitRoot,
    });
    const extra = passthrough.length ? ` (+ pass-through: ${passthrough.join(', ')})` : '';
    console.log(
      `  ✓ core.hooksPath → ${LOCAL_HOOKS} (local) — pre-commit + your hooks preserved${extra}`,
    );
  } catch (e) {
    console.log(`  ! could not set core.hooksPath: ${firstLine(e)}`);
  }
}

/**
 * Recompute the overlay pre-commit hook from the RECORDED config and report — or, unless `dryRun`,
 * repair — drift against a freshly-built hook. `devkit update` re-pins the CLI but does NOT regenerate
 * the git-ignored `.devkit/hooks/pre-commit`, so an updated repo can keep running an OLD hook shape
 * (e.g. one predating a new ship gate) until re-init. This lets `devkit doctor --fix` refresh it
 * without a manual `devkit init --overlay`. Pass-through wrappers are refreshed alongside (idempotent).
 * `core.hooksPath` is left untouched — the `git ci` alias owns it and doctor reports it separately.
 * Returns { missing, drift } observed BEFORE any write (missing counts as drift).
 */
export function syncOverlayHook(
  gitRoot: string,
  cwd: string,
  cfg: {
    components?: Partial<Selection>;
    pkgRel?: string;
    origHooksPath?: string;
  },
  { dryRun }: { dryRun: boolean },
): { missing: boolean; drift: boolean } {
  const sel = normalizeSelection(cfg.components ?? {});
  const pkgRel = cfg.pkgRel ?? '';
  const fallow = Boolean(cfg.components?.fallow);
  // Use the RECORDED origHooksPath — post-install core.hooksPath is `.devkit/hooks`, so reading it
  // live would chain the overlay to ITSELF. Fall back to the same recovery init uses.
  const origHooksPath = cfg.origHooksPath ?? captureOrigHooksPath(gitRoot, cwd);
  const scriptDir = overlayHookScriptDir(origHooksPath);
  const existing = detectExistingHooks(gitRoot, scriptDir);
  const preCommitChain = existing.includes('pre-commit') ? `${scriptDir}/pre-commit` : '';
  const expected = buildOverlayHook(sel, preCommitChain, pkgRel, { fallow });

  const pre = join(gitRoot, LOCAL_HOOKS, 'pre-commit');
  const current = existsSync(pre) ? readFileSync(pre, 'utf8') : null;
  const missing = current === null;
  const drift = current !== expected; // a missing hook (null) is drift too

  if (!dryRun && drift) {
    const dir = join(gitRoot, LOCAL_HOOKS);
    mkdirSync(dir, { recursive: true });
    writeFileSync(pre, expected);
    chmodSync(pre, 0o755);
    // refresh the pass-through wrappers for the repo's OTHER hooks (idempotent).
    for (const h of existing.filter((n) => n !== 'pre-commit')) {
      const p = join(dir, h);
      writeFileSync(p, buildPassthroughHook(`${scriptDir}/${h}`));
      chmodSync(p, 0o755);
    }
  }
  return { missing, drift };
}

// Resolve fallow for an overlay install: detect → (warn + global install if missing) → save
// baselines so `fallow audit` only blocks on NEW issues (a legacy repo's existing debt is
// grandfathered — else the gate fail-CLOSES on the very first commit). Returns whether the fallow
// gate should be wired into the hook. Fail-open: if fallow can't be installed, ABORT the component
// (no gate, no baselines) rather than wire a gate that can't run — never block the user.
function resolveOverlayFallow(cwd: string, dryRun: boolean) {
  if (dryRun) {
    console.log('  [dry-run] fallow: detect → install-if-missing → save baselines → gate in hook');
    return true;
  }
  const det = detectFallow({ cwd });
  if (det.available) {
    console.log(`  ✓ fallow present (${det.version})`);
  } else {
    console.log('  ! fallow not found — attempting a global install (bun → npm → cargo)...');
    const r = installFallow({ cwd });
    if (!r.ok) {
      console.log(
        '  ! fallow not installed — skipping the fallow gate (install it above, re-run).',
      );
      return false;
    }
    console.log(`  ✓ ${r.message}`);
  }
  const saved = saveFallowBaselines({ cwd });
  console.log(
    `  ${saved.ok ? '✓ saved' : '! some'} fallow baselines → fallow-baselines/ (grandfather debt)`,
  );
  return true;
}

// Sync the agent-half (skills + agents + agentHooks) into the git root's selected surfaces, skipping
// any path git already TRACKS (C2 — exclude can't hide a tracked file), and return the git-root-
// relative paths to hide via .git/info/exclude (derived from each sync's returned manifest, so a
// skipped-because-tracked file is never excluded for). searchSteering stays unwired because its
// node_modules/@norvalbv/devkit command cannot resolve in a package-less overlay (C1).
// Reason: flat overlay agent-surface orchestration: ordered `if (sel.x) sync + derive excludes` steps (skills → agents → hook scripts → registrations) mirroring installAgentSurfaces; high branch COUNT, each trivial, no nesting
// fallow-ignore-next-line complexity
function installOverlayAgentSurfaces(
  gitRoot: string,
  sel: Selection,
  dryRun: boolean,
  force = false,
  legacyOwnedComponentIds: string[] = [],
) {
  const targets = sel.agentTargets ?? AGENT_TARGETS;
  const skipTracked = trackedPathPredicate(gitRoot);
  // --force can replace an untracked collision; tracked files always remain untouched.
  const override = force ? () => true : undefined;
  const args = dryRun ? ['--dry-run'] : [];
  const excl = [];
  if (sel.skills) {
    console.log('  skills');
    const m = syncSkills(args, gitRoot, targets, {
      skipTracked,
      override,
      guards: sel.guards ?? [],
    });
    excl.push(...overlayAssetExcludes(m, 'skills', targets));
    // The manifest is always written, even if every asset is preserved.
    excl.push('.devkit/skills-manifest.json');
  } else if (existsSync(join(gitRoot, '.devkit', 'skills-manifest.json'))) {
    removeSkills(gitRoot, dryRun);
  }
  if (sel.agents) {
    console.log('  agents');
    const m = syncAgents(args, gitRoot, targets, { skipTracked, override });
    excl.push(...overlayAssetExcludes(m, 'agents', targets));
    excl.push('.devkit/agents-manifest.json');
  } else if (existsSync(join(gitRoot, '.devkit', 'agents-manifest.json'))) {
    removeAgents(gitRoot, dryRun);
  }
  const hooks = selectedHookAssets(sel, { searchSteering: false });
  const desiredHooks = hooks.scripts;
  if (desiredHooks.length) {
    console.log('  agent-hook scripts');
    const m = syncHookScripts(gitRoot, {
      dryRun,
      targets,
      desired: desiredHooks,
      skipTracked,
      override,
    });
    excl.push(...overlayAssetExcludes(m, 'hooks', targets));
    excl.push('.devkit/agent-hooks-manifest.json');
    console.log('  agent hook registrations');
    const { wrote } = installHookRegistrations(gitRoot, hooks.components, {
      dryRun,
      targets,
      overlay: true,
      legacyOwnedComponentIds,
    });
    excl.push(...wrote);
  } else {
    if (existsSync(join(gitRoot, '.devkit', 'agent-hooks-manifest.json')))
      removeHookScripts(gitRoot, { dryRun });
    removeHookRegistrations(gitRoot, { dryRun, targets, overlay: true });
  }
  const prunedTargets = AGENT_TARGETS.filter((target) => !targets.includes(target));
  if (prunedTargets.length) {
    if (sel.skills) removeSkills(gitRoot, dryRun, prunedTargets, false);
    if (sel.agents) removeAgents(gitRoot, dryRun, prunedTargets, false);
    if (desiredHooks.length)
      removeHookScripts(gitRoot, { dryRun, targets: prunedTargets, dropManifest: false });
    removeHookRegistrations(gitRoot, { dryRun, targets: prunedTargets, overlay: true });
  }
  return excl;
}

/** Install the overlay and return the cleanup metadata recorded in its config. */
// Reason: flat overlay install orchestration: ordered guarded steps (config → lint → fallow → hook → alias → surfaces → exclude) each a single delegated call; high branch COUNT, near-zero nesting — splitting scatters the install sequence
// fallow-ignore-next-line complexity
export function installOverlay(
  cwd: string,
  sel: Selection,
  stack: string,
  force: boolean,
  dryRun: boolean,
) {
  // Configs live in cwd; hooks and git-exclude live at the git root (also in a monorepo).
  const { gitRoot, pkgRel } = detectGitRoot(cwd);
  // The real original hooksPath (never our own .devkit/hooks) — recorded for restore on clean.
  const origHooksPath = captureOrigHooksPath(gitRoot, cwd);
  const prior = readJson(join(cwd, '.devkit', 'config.json')) as {
    components?: Partial<Pick<Selection, 'searchSteering' | 'agentHooks' | 'guards'>>;
  } | null;
  const legacyOwnedComponentIds = [
    prior?.components?.searchSteering && 'searchSteering',
    prior?.components?.agentHooks && 'agentHooks',
    prior?.components?.guards?.includes('decisions') && 'decisions',
  ].filter((id): id is string => Boolean(id));
  const pfx = pkgRel ? `${pkgRel}/` : '';
  const excludes = new Set([
    `${LOCAL_HOOKS}/`, // .devkit/hooks at the git root
    `${pfx}.devkit/`, // the package's .devkit (config + vendored biome)
    `${pfx}guard.config.json`,
    `${pfx}eslint/baselines/`,
  ]);
  if (pkgRel) console.log(`  monorepo: package "${pkgRel}" — hook + git-ignore at the git root`);

  // guard.config.json (data) — generic template.
  console.log('  guard.config.json');
  if (sel.guards?.length) {
    const src = join(packageDir(), 'templates', 'generic', 'guard.config.json');
    if (dryRun) {
      console.log('  [dry-run] write guard.config.json');
    } else {
      writeIfAbsent(join(cwd, 'guard.config.json'), readFileSync(src, 'utf8'), {
        force,
      });
      console.log('  ✓ guard.config.json');
    }
  }

  // ours-extends-theirs lint overlays, in the package.
  console.log('  lint overlays (extend the repo config)');
  if (sel.biome && writeBiomeOverlay(cwd, stack, force, dryRun)) {
    excludes.add(`${pfx}biome.devkit.jsonc`);
  }
  if (writeEslintOverlay(cwd, force, dryRun)) excludes.add(`${pfx}eslint.config.devkit.mjs`);

  // Resolve fallow before rendering the hook; an unavailable binary aborts only that component.
  let fallowWired = false;
  if (sel.fallow) {
    console.log('  fallow (code-health gate)');
    fallowWired = resolveOverlayFallow(cwd, dryRun);
    if (fallowWired) {
      excludes.add(`${pfx}.fallow/`);
      excludes.add(`${pfx}fallow-baselines/`);
    }
  }

  // local hook (core.hooksPath override) at the git root + chain + pass-through of all hooks.
  console.log('  local hook');
  installOverlayHook(gitRoot, pkgRel, sel, origHooksPath, dryRun, fallowWired);

  // Per-clone alias restores this repo-wide hook path after husky reclaims it.
  installHealAlias(gitRoot, dryRun);

  for (const rel of installOverlayAgentSurfaces(
    gitRoot,
    sel,
    dryRun,
    force,
    legacyOwnedComponentIds,
  ))
    excludes.add(rel);

  // make it all invisible to git (the git root's .git/info/exclude).
  console.log('  git-ignore (local)');
  addToGitExclude(gitRoot, [...excludes], dryRun);

  // Cleanup restores the original hook path and only removes components recorded as wired.
  return { origHooksPath, fallowWired };
}
