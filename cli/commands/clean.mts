/**
 * `devkit clean` — fully UNINSTALL devkit from a repo. Reverses init for the recorded mode:
 *   - overlay  → restore core.hooksPath, remove the local hooks + package devkit files, prune
 *                the devkit lines from .git/info/exclude (the repo goes back to untouched).
 *   - package/standalone → remove devkit-created configs, the husky devkit-guards block, skills,
 *                baselines, .devkit, and the @norvalbv/devkit dep + devkit scripts.
 *
 * Safe: only touches what devkit created (biome/tsconfig are removed ONLY if they still extend
 * devkit). Confirms first unless --yes; --dry-run prints every action and writes nothing.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { confirm, isCancel } from '@clack/prompts';
import { purgePlanCritiqueBindings } from '../../gate-engine/critique/evidence-bindings.mts';
import { purgePlanCritiqueEvidence } from '../../gate-engine/critique/evidence-store.mts';
import { resolveExistingAgentTargets } from '../lib/agent-targets.mts';
import { AGENT_TARGETS, agentSurfaceDir } from '../lib/components.mts';
import { detectGitRoot } from '../lib/detect-git-root.mts';
import { packageDir, readJson } from '../lib/fs-helpers.mts';
import { isTracked } from '../lib/git-tracked.mts';
import { removeCommitMsgBlock } from '../lib/husky/commit-msg-block.mts';
import { removeGuardBlock } from '../lib/husky/husky-block.mts';
import { pruneDevkitCacheGitignore } from '../lib/install/gitignore-cache.mts';
import { removeHookRegistrations, removeHookScripts } from '../lib/install/install-hooks.mts';
import { removeSearchCode } from '../lib/install/install-search-code.mts';
import { removeHealAlias } from '../lib/overlay.mts';
import { removeGlobalHook } from '../lib/overlay-global-hook.mts';
import { removeAgents, removeSkills } from '../lib/sync-manifest.mts';

/** The devkit-wired component flags recorded in .devkit/config.json.components. */
interface DevkitComponents {
  skills?: boolean;
  agents?: boolean;
  agentHooks?: boolean;
  searchSteering?: boolean;
  fallow?: boolean;
  searchCode?: boolean;
  agentTargets?: string[];
}
/** The subset of .devkit/config.json that `clean` reads to reverse an install. */
interface DevkitConfig {
  overlay?: boolean;
  standalone?: boolean;
  pkgRel?: string;
  origHooksPath?: string;
  components?: DevkitComponents;
}
/** The devkit-managed sections of a consumer package.json that `clean` prunes. */
interface PackageJsonShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

/** A parsed agent-surface settings file (.claude/settings.local.json / .cursor/hooks.json). */
interface SettingsShape {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

function rm(path: string, label: string, dryRun: boolean): void {
  if (!existsSync(path)) return;
  console.log(`  ${dryRun ? '[dry-run] remove' : '✓ removed'} ${label}`);
  if (!dryRun) rmSync(path, { recursive: true, force: true });
}

// A biome/tsconfig is devkit-created only if it still extends devkit (the package subpath, the
// vendored .devkit/ base, or an overlay sibling) — never remove a config the user owns.
function extendsDevkit(path: string): boolean {
  if (!existsSync(path)) return false;
  const raw = readFileSync(path, 'utf8');
  return (
    raw.includes('@norvalbv/devkit') ||
    raw.includes('.devkit/biome') ||
    raw.includes('.devkit/tsconfig') ||
    raw.includes('biome.devkit') ||
    raw.includes('eslint.config.devkit')
  );
}

// Drop devkit's lines (+ its header) from .git/info/exclude, leaving the user's own ignores. The
// agent-half + fallow lines (added when overlay grew past the lint/guard set) are prefix-tolerant
// (`(.*\/)?`) so a monorepo `pkgRel/`-scoped entry is pruned too — a miss orphans the line.
const DEVKIT_EXCLUDE_LINE =
  /^(# devkit overlay|\.devkit\/|.*\/\.devkit\/|.*guard\.config\.json|.*biome\.devkit\.jsonc|.*eslint\.config\.devkit\.mjs|.*eslint\/baselines\/|(.*\/)?\.claude\/(skills|agents|hooks)\/|(.*\/)?\.cursor\/(skills|agents|hooks)\/|(.*\/)?\.codex\/(agents|hooks)\/|(.*\/)?\.agents\/skills\/|(.*\/)?\.(cursor|codex)\/hooks\.json|(.*\/)?\.claude\/settings\.local\.json|(.*\/)?\.fallow\/|(.*\/)?fallow-baselines\/)/;
const BLANK_RUN_RE = /\n{3,}/g;
const LEADING_BLANKS_RE = /^\n+/;
function pruneGitExclude(gitRoot: string, dryRun: boolean): void {
  const file = join(gitRoot, '.git', 'info', 'exclude');
  if (!existsSync(file)) return;
  const lines = readFileSync(file, 'utf8').split('\n');
  const kept = lines.filter((l) => !DEVKIT_EXCLUDE_LINE.test(l));
  if (kept.length === lines.length) return;
  if (dryRun) {
    console.log('  [dry-run] prune devkit lines from .git/info/exclude');
    return;
  }
  writeFileSync(file, kept.join('\n').replace(BLANK_RUN_RE, '\n\n').replace(LEADING_BLANKS_RE, ''));
  console.log('  ✓ pruned devkit lines from .git/info/exclude');
}

// Overlay leftovers when the config (and maybe the manifests) are gone — an orphaned or partial
// clean. The tell-tale is a devkit-BUNDLED skill dir present-and-UNTRACKED under a surface (package
// mode commits its skills, so a tracked one isn't a stray), or a surviving .devkit / fallow-baselines.
function hasOverlayStrays(gitRoot: string): boolean {
  if (existsSync(join(gitRoot, '.devkit')) || existsSync(join(gitRoot, 'fallow-baselines'))) {
    return true;
  }
  const skillsSrc = join(packageDir(), 'skills');
  const names = existsSync(skillsSrc)
    ? readdirSync(skillsSrc, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : [];
  for (const surface of AGENT_TARGETS) {
    for (const name of names) {
      const rel = `${agentSurfaceDir(surface, 'skills')}/${name}`;
      if (existsSync(join(gitRoot, rel)) && !isTracked(gitRoot, rel)) return true;
    }
  }
  return false;
}

// Best-effort overlay teardown for a repo with NO config (orphaned / partial clean). Every step is
// tracked-safe + no-ops when its artifact is absent, so it's safe to run unconditionally once strays
// are detected. The synced files are removed by bundled-name fallback (the manifests may be gone);
// the per-package overlay configs (in cwd) are removed only if git doesn't track them (never the
// user's own guard.config.json / eslint dir).
function cleanOverlayStrays(cwd: string, gitRoot: string, dryRun: boolean): void {
  removeSkills(gitRoot, dryRun, AGENT_TARGETS);
  removeAgents(gitRoot, dryRun, AGENT_TARGETS);
  removeHookScripts(gitRoot, { dryRun, targets: AGENT_TARGETS });
  removeHookRegistrations(gitRoot, { dryRun, overlay: true, targets: AGENT_TARGETS });
  removeEmptyOverlaySettings(gitRoot, dryRun);
  const pfx = cwd === gitRoot ? '' : `${relative(gitRoot, cwd)}/`;
  const rmUntracked = (rel: string, label: string) => {
    if (!isTracked(gitRoot, `${pfx}${rel}`)) rm(join(cwd, rel), label, dryRun);
  };
  rmUntracked('guard.config.json', 'guard.config.json');
  rmUntracked('biome.devkit.jsonc', 'biome.devkit.jsonc');
  rmUntracked('eslint.config.devkit.mjs', 'eslint.config.devkit.mjs');
  rmUntracked('eslint/baselines', 'eslint/baselines/');
  rm(join(cwd, 'fallow-baselines'), 'fallow-baselines/', dryRun);
  rm(join(gitRoot, '.devkit'), '.devkit/', dryRun);
  pruneGitExclude(gitRoot, dryRun);
}

function restoreHooksPath(gitRoot: string, orig: string, dryRun: boolean): void {
  // A poisoned origHooksPath (devkit's own dir — from a pre-0.8.1 re-overlay) can't be restored
  // to itself (clean just deleted it). Fall back to husky's dir if present, else unset.
  let target = orig;
  if (target === '.devkit/hooks') {
    target = existsSync(join(gitRoot, '.husky', '_')) ? '.husky/_' : '';
  }
  if (dryRun) {
    console.log(`  [dry-run] restore core.hooksPath → ${target || '(unset)'}`);
    return;
  }
  try {
    if (target) execFileSync('git', ['config', 'core.hooksPath', target], { cwd: gitRoot });
    else execFileSync('git', ['config', '--unset', 'core.hooksPath'], { cwd: gitRoot });
    console.log(`  ✓ restored core.hooksPath → ${target || '(unset)'}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '';
    console.log(`  ! could not restore core.hooksPath: ${msg.split('\n')[0]}`);
  }
}

// Reason: flat overlay teardown: sequential guarded removals (hooksPath restore → alias → agent-half → configs → fallow → exclude prune) each gated by an existence/component check; high branch COUNT, near-zero nesting — splitting scatters the reverse-of-install sequence
// fallow-ignore-next-line complexity
function cleanOverlay(cwd: string, cfg: DevkitConfig, dryRun: boolean): void {
  const { gitRoot } = detectGitRoot(cwd);
  console.log('cleaning OVERLAY — restoring the repo to untouched:');
  restoreHooksPath(gitRoot, cfg.origHooksPath ?? '', dryRun);
  removeHealAlias(gitRoot, dryRun);
  // agent-half (skills/agents/agent-hook scripts + their registrations) — repo-wide at the git root.
  // The synced files + manifests are git-ignored; removing them keeps the round-trip footprint-free.
  const comp = cfg.components ?? {};
  const targets = resolveExistingAgentTargets(gitRoot, comp.agentTargets);
  if (comp.skills) removeSkills(gitRoot, dryRun, targets);
  if (comp.agents) removeAgents(gitRoot, dryRun, targets);
  if (comp.agentHooks) removeHookScripts(gitRoot, { dryRun, targets });
  // Strip devkit hooks from the LOCAL-override settings.local.json (where overlay registered them) +
  // .cursor/hooks.json; never delete the files (they may hold the user's own local settings/hooks).
  if (comp.agentHooks || comp.searchSteering) {
    removeHookRegistrations(gitRoot, { dryRun, overlay: true, targets });
    removeEmptyOverlaySettings(gitRoot, dryRun);
  }
  rm(join(gitRoot, '.devkit'), '.devkit/ (git-root hooks)', dryRun);
  rm(join(cwd, '.devkit'), `${cwd === gitRoot ? '' : 'package '}.devkit/`, dryRun);
  rm(join(cwd, 'guard.config.json'), 'guard.config.json', dryRun);
  rm(join(cwd, 'biome.devkit.jsonc'), 'biome.devkit.jsonc', dryRun);
  rm(join(cwd, 'eslint.config.devkit.mjs'), 'eslint.config.devkit.mjs', dryRun);
  rm(join(cwd, 'eslint', 'baselines'), 'eslint/baselines/', dryRun);
  // fallow: devkit saved the grandfather baselines in overlay (fallow-baselines/). The .fallow/ cache
  // is fallow's own — left in place, like package-mode clean leaves fallow's files.
  if (comp.fallow) rm(join(cwd, 'fallow-baselines'), 'fallow-baselines/', dryRun);
  pruneGitExclude(gitRoot, dryRun);
}

// Remove the @norvalbv/devkit dep + devkit-only scripts from package.json (leave public deps the
// user may have had — biome/husky/eslint — untouched).
// Reason: selective package.json key pruning: one guarded delete per devkit-owned dependency/script key, near-zero nesting; high branch COUNT (loops × per-key existence guards), each trivial
// fallow-ignore-next-line complexity
function depesc(cwd: string, dryRun: boolean): void {
  const pkgPath = join(cwd, 'package.json');
  const pkg = readJson(pkgPath) as PackageJsonShape | null;
  if (!pkg) return;
  let changed = false;
  for (const k of ['dependencies', 'devDependencies'] as const) {
    const deps = pkg[k];
    if (deps?.['@norvalbv/devkit']) {
      delete deps['@norvalbv/devkit'];
      changed = true;
    }
  }
  const scripts = pkg.scripts;
  for (const s of ['guard:freeze', 'lint:structure']) {
    if (scripts?.[s]) {
      delete scripts[s];
      changed = true;
    }
  }
  if (!changed) return;
  console.log(
    `  ${dryRun ? '[dry-run] remove' : '✓ removed'} @norvalbv/devkit dep + devkit scripts`,
  );
  if (!dryRun) writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

// A settings object holds nothing of the user's iff its only keys are `allowed` (the devkit scaffold
// keys) AND its hooks block is empty — i.e. devkit created it and all that remained were the now-
// stripped hooks. Claude (.claude/settings.local.json) allows only `hooks`; Cursor (.cursor/hooks.json)
// also has a scaffold `version`.
const onlyEmptyHooks = (obj: SettingsShape, allowed: string[]): boolean =>
  Object.keys(obj).every((k) => allowed.includes(k)) && Object.keys(obj.hooks ?? {}).length === 0;

// After stripping devkit's hooks from the overlay settings files, delete one IFF it's now empty —
// these files are untracked + were git-excluded, so pruning the exclude line would otherwise leave
// them VISIBLE as untracked leftovers. A file carrying the user's own keys is KEPT.
function removeEmptyOverlaySettings(gitRoot: string, dryRun: boolean): void {
  const claudeP = join(gitRoot, '.claude', 'settings.local.json');
  const claude = readJson(claudeP) as SettingsShape | null;
  if (claude && onlyEmptyHooks(claude, ['hooks']))
    rm(claudeP, '.claude/settings.local.json (devkit-created, now empty)', dryRun);
  const cursorP = join(gitRoot, '.cursor', 'hooks.json');
  const cursor = readJson(cursorP) as SettingsShape | null;
  if (cursor && onlyEmptyHooks(cursor, ['version', 'hooks']))
    rm(cursorP, '.cursor/hooks.json (devkit-created, now empty)', dryRun);
  const codexP = join(gitRoot, '.codex', 'hooks.json');
  const codex = readJson(codexP) as SettingsShape | null;
  if (codex && onlyEmptyHooks(codex, ['hooks']))
    rm(codexP, '.codex/hooks.json (devkit-created, now empty)', dryRun);
}

// Remove a single line devkit added to .gitignore (e.g. fallow's `.fallow/` cache dir). Leaves the
// rest of the file untouched; no-ops if the line isn't present.
function pruneGitignoreLine(root: string, line: string, dryRun: boolean): void {
  const giPath = join(root, '.gitignore');
  if (!existsSync(giPath)) return;
  const raw = readFileSync(giPath, 'utf8');
  const lines = raw.split('\n');
  const kept = lines.filter((l) => l.trim() !== line);
  if (kept.length === lines.length) return;
  console.log(`  ${dryRun ? '[dry-run] remove' : '✓ removed'} ${line} from .gitignore`);
  if (!dryRun) writeFileSync(giPath, kept.join('\n'));
}

// Reason: flat uninstall orchestration: sequential remove/prune steps each gated by an `if (exists/extends/component)` guard, near-zero nesting; high branch COUNT (one per devkit-created artifact: husky block, skills, agents, hooks, configs, fallow/search-code components), each trivial
// fallow-ignore-next-line complexity
function cleanPackage(cwd: string, cfg: DevkitConfig, dryRun: boolean): void {
  const { gitRoot } = detectGitRoot(cwd);
  console.log(`cleaning ${cfg.standalone ? 'STANDALONE' : 'PACKAGE'} devkit install:`);
  // husky devkit-guards block (package-scoped marker for a monorepo).
  const hookPath = join(gitRoot, '.husky', 'pre-commit');
  if (existsSync(hookPath)) {
    const { content, removed } = removeGuardBlock(readFileSync(hookPath, 'utf8'), cfg.pkgRel ?? '');
    if (removed) {
      console.log(
        `  ${dryRun ? '[dry-run] remove' : '✓ removed'} devkit-guards block from .husky/pre-commit`,
      );
      if (!dryRun) writeFileSync(hookPath, content);
    }
  }
  // The managed commit-msg block (review/sentry judges) — silent no-op when never installed.
  removeCommitMsgBlock(gitRoot, cfg.pkgRel ?? '', dryRun);
  // skills + agents: remove the devkit-SYNCED files (per each manifest) from selected providers,
  // then drop the manifest. (Previously only the manifest was deleted, so the synced files leaked.)
  const targets = resolveExistingAgentTargets(gitRoot, cfg.components?.agentTargets);
  removeSkills(gitRoot, dryRun, targets);
  removeAgents(gitRoot, dryRun, targets);
  // agent-hook scripts + the hook registrations they wrote.
  removeHookScripts(gitRoot, { dryRun, targets });
  removeHookRegistrations(gitRoot, { dryRun, targets });
  // devkit-created configs/data in the package.
  for (const f of ['biome.jsonc', 'tsconfig.json']) {
    if (extendsDevkit(join(cwd, f))) rm(join(cwd, f), f, dryRun);
  }
  rm(join(cwd, 'guard.config.json'), 'guard.config.json', dryRun);
  rm(join(cwd, 'eslint.config.mjs'), 'eslint.config.mjs', dryRun);
  rm(join(cwd, 'eslint'), 'eslint/ (domains + baselines)', dryRun);
  rm(join(cwd, '.co-occurrence-allowlist.json'), '.co-occurrence-allowlist.json', dryRun);
  // fallow component: devkit added the `.fallow/` gitignore line (install-fallow). fallow's OWN
  // hook + .fallowrc are fallow's to remove (`fallow hooks uninstall`) — not devkit-created.
  if (cfg.components?.fallow) pruneGitignoreLine(gitRoot, '.fallow/', dryRun);
  // search-code: remove the devkit-written opt-in config + the `.search-code/` gitignore line.
  // The index dir itself is the engine's data — left in place.
  if (cfg.components?.searchCode) {
    removeSearchCode(cwd, dryRun);
    pruneGitignoreLine(gitRoot, '.search-code/', dryRun);
  }
  // Regenerated gate caches: init adds these .gitignore lines on every package/standalone install
  // (the gate engine writes them regardless of components), so reverse them unconditionally.
  pruneDevkitCacheGitignore(cwd, dryRun);
  rm(join(cwd, '.devkit'), '.devkit/', dryRun);
  depesc(cwd, dryRun);
  console.log(
    "  (left your own biome/husky/eslint deps + fallow's own files in place — `fallow hooks uninstall` to remove those)",
  );
}

export const meta = {
  name: 'clean',
  summary: 'Uninstall devkit — reverse init for the recorded mode.',
  help: `devkit clean — uninstall devkit (reverse init for the recorded mode).

Usage:
  devkit clean [--yes] [--dry-run]
  devkit clean --evidence [--older-than-days N] [--yes] [--dry-run]

Overlay restores core.hooksPath + prunes .git/info/exclude; package/standalone removes configs,
the hook block, deps, and synced skills/agents. \`--evidence\` purges local plan-critique evidence
instead of uninstalling devkit. Safe — only removes what devkit created.`,
};

// Reason: flat clean dispatch: parse flags, then a linear cascade of guards (no config → orphaned-overlay recovery vs no-op; TTY confirm; overlay vs package branch); high branch COUNT from sequential early-returns, each trivial, extracting them scatters one entry-point's control flow
// fallow-ignore-next-line complexity
export default async function run(args: string[], cwd: string): Promise<number> {
  const dryRun = args.includes('--dry-run');
  const yes = args.includes('--yes') || args.includes('-y');
  const evidenceOnly = args.includes('--evidence');
  if (evidenceOnly) {
    const ageIndex = args.indexOf('--older-than-days');
    const ageDays = ageIndex === -1 ? null : Number.parseInt(args[ageIndex + 1] ?? '', 10);
    if (ageIndex !== -1 && (ageDays === null || !Number.isFinite(ageDays) || ageDays <= 0)) {
      console.error('devkit clean --evidence: --older-than-days must be a positive integer');
      return 1;
    }
    if (!yes && !dryRun && process.stdout.isTTY) {
      const go = await confirm({
        message: ageDays
          ? `Purge plan-critique evidence older than ${ageDays} day(s)?`
          : 'Purge ALL local plan-critique evidence?',
        initialValue: false,
      });
      if (isCancel(go) || !go) {
        console.log('Aborted — no evidence removed.');
        return 0;
      }
    }
    const purgeOptions = {
      olderThanMs: ageDays ? ageDays * 24 * 60 * 60 * 1000 : undefined,
      dryRun,
    };
    const evidence = purgePlanCritiqueEvidence(purgeOptions);
    const bindings = purgePlanCritiqueBindings(cwd, purgeOptions);
    const result = {
      files: evidence.files + bindings.files,
      bytes: evidence.bytes + bindings.bytes,
    };
    console.log(
      `devkit clean --evidence${dryRun ? ' (dry-run)' : ''}: ${result.files} file(s), ${result.bytes} byte(s) ${dryRun ? 'would be removed' : 'removed'}`,
    );
    return 0;
  }
  // --global: remove the machine-global opt-in pre-commit shim (~/.config/husky/init.sh). It's shared
  // by every overlaid repo, so it is NEVER removed by a per-repo clean — only this explicit flag.
  const removeGlobal = args.includes('--global');
  const cfg = readJson(join(cwd, '.devkit', 'config.json')) as DevkitConfig | null;
  if (removeGlobal) {
    console.log(
      `devkit clean --global${dryRun ? ' (dry-run)' : ''}: machine-global pre-commit shim`,
    );
    removeGlobalHook({ dryRun });
    if (!cfg) {
      console.log(`\n${dryRun ? 'Dry-run complete.' : 'Done.'}`);
      return 0;
    }
    console.log('');
  }
  if (!cfg) {
    // Orphaned overlay: the config is gone but core.hooksPath still points at our (deleted) dir.
    const { gitRoot } = detectGitRoot(cwd);
    let hp = '';
    try {
      hp = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
        cwd: gitRoot,
        encoding: 'utf8',
      }).trim();
    } catch {
      // unset
    }
    // Orphaned/partial overlay: the config is gone, but core.hooksPath may still point at our
    // (deleted) dir AND/OR synced agent-half files + fallow-baselines may be stranded. Recover the
    // full overlay footprint, not just the hook — the agent-half is removed by bundled-name fallback
    // since the manifests may be gone too (the old recovery removed `.devkit/` without them).
    if (hp === '.devkit/hooks' || hasOverlayStrays(gitRoot)) {
      console.log(
        hp === '.devkit/hooks'
          ? 'devkit clean: orphaned overlay (core.hooksPath → .devkit/hooks, no config) — recovering:\n'
          : 'devkit clean: overlay leftovers found (no config) — cleaning them up:\n',
      );
      if (hp === '.devkit/hooks') restoreHooksPath(gitRoot, '.devkit/hooks', dryRun); // → .husky/_ or unset
      removeHealAlias(gitRoot, dryRun);
      cleanOverlayStrays(cwd, gitRoot, dryRun);
      console.log(`\n${dryRun ? 'Dry-run complete.' : 'Recovered.'}`);
      return 0;
    }
    console.log('devkit clean: nothing to clean — no .devkit/config.json in this repo.');
    return 0;
  }
  const mode = cfg.overlay ? 'overlay' : cfg.standalone ? 'standalone' : 'package';
  if (!yes && !dryRun && process.stdout.isTTY) {
    const go = await confirm({
      message: `Remove ALL devkit (${mode}) from this repo?`,
      initialValue: true,
    });
    if (isCancel(go) || !go) {
      console.log('Aborted — nothing removed.');
      return 0;
    }
  }
  console.log('');
  if (cfg.overlay) cleanOverlay(cwd, cfg, dryRun);
  else cleanPackage(cwd, cfg, dryRun);
  console.log(`\n${dryRun ? 'Dry-run complete (nothing removed).' : 'devkit clean complete.'}`);
  return 0;
}
