/**
 * Synced-asset OWNERSHIP — the single source of truth for "which on-disk skill/agent/hook is
 * devkit's vs the consumer's." Two halves:
 *   - FORWARD (sync-time): `findConflicts`/`matchesBundle`/`ownedNames` tell the sync step which
 *     same-named asset the consumer authored (preserve) vs devkit's own (overwrite).
 *   - REVERSE (uninstall): remove the devkit-synced files a manifest records (from .claude + .cursor)
 *     and drop the manifest; the no-manifest fallback reuses the SAME ownership signal so it never
 *     deletes a preserved user asset. Shared by `init`/`init --remove-deselected`/`clean`. `root` is
 *     the git root (skills + agents are repo-wide), = cwd for a single-package repo.
 */
import { type Dirent, existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_TARGETS } from './components.mts';
import { packageDir, readJson, sha256 } from './fs-helpers.mts';
import { isTracked } from './git-tracked.mts';

/** A `<kind>-manifest.json`: per-file shas devkit RECORDED writing, plus the surfaces it wrote to. */
export interface SyncManifest {
  /** `"<name>/<file>" → sha256` — every synced file devkit wrote (top-level key ⇒ owned name). */
  files: Record<string, string>;
  /** Surface names devkit recorded writing to (e.g. `['claude', 'cursor']`); absent ⇒ legacy, all-surface. */
  targets?: string[];
}

// ── ownership inference (forward: sync-time conflict detection) ───────────────────────────────
// A consumer may author their OWN skill/agent/hook under a name devkit bundles. These tell the sync
// step which on-disk asset is the user's (preserve) vs devkit's own (overwrite), via two signals:
// the per-file sha manifest (names devkit RECORDED writing) + a byte-for-byte tree compare against
// the bundle (so an unmanifested-but-identical copy adopts cleanly rather than freezing as a false
// "conflict"). A name is the USER's iff NOT manifest-owned AND its on-disk content DIVERGES.

/** Top-level names devkit RECORDED as installed, from a manifest's `files` keys ("<name>/…" → <name>). */
export function ownedNames(manifest: SyncManifest | null): Set<string> {
  return new Set(Object.keys(manifest?.files ?? {}).map((rel) => rel.split('/')[0]));
}

// Recursively compare an on-disk entry to a bundle entry: both must exist, be the same kind, and —
// for a dir — hold the SAME child names whose subtrees all match; for a file — the same bytes. Any
// extra/missing child or byte diff ⇒ false.
function entryMatches(onDisk: string, src: string): boolean {
  if (!existsSync(onDisk) || !existsSync(src)) return false;
  // A symlink is never a byte-identical copy of a bundled regular file/dir (devkit ships neither as
  // a symlink). Reject it BEFORE the sha256 below, which follows the link and would otherwise hash
  // the target and mis-classify a symlinked asset as bundle-owned.
  if (lstatSync(onDisk).isSymbolicLink() || lstatSync(src).isSymbolicLink()) return false;
  const onDiskDir = lstatSync(onDisk).isDirectory();
  if (onDiskDir !== lstatSync(src).isDirectory()) return false;
  if (!onDiskDir) return sha256(onDisk) === sha256(src);
  const a = readdirSync(onDisk).sort();
  const b = readdirSync(src).sort();
  if (a.length !== b.length || a.some((name, i) => name !== b[i])) return false;
  return b.every((name) => entryMatches(join(onDisk, name), join(src, name)));
}

/**
 * Does the consumer's on-disk `<dir>/<name>` byte-match devkit's bundled `<srcDir>/<name>` exactly?
 * @param root consumer/git root
 * @param dir target surface dir (e.g. `.claude/skills`)
 * @param name asset name (skill dir / agent .md / hook script file)
 * @param srcDir devkit's bundle dir for this kind (packageDir()/skills | /agents | /agents-hooks)
 */
export function matchesBundle(root: string, dir: string, name: string, srcDir: string): boolean {
  return entryMatches(join(root, dir, name), join(srcDir, name));
}

/**
 * The names that are the USER's own (preserve unless overridden): present under some target surface,
 * DIVERGENT from the bundle, and NOT manifest-owned ON THAT SURFACE. An absent or byte-identical copy
 * is not a conflict. Ownership is surface-aware: a manifest proves devkit wrote a name only to the
 * surfaces it recorded (`manifest.targets`), so a same-named divergent asset on a NEWLY-enabled
 * surface is still treated as the consumer's (a legacy manifest without `targets` is read as owning
 * every surface — the pre-existing behaviour, no regression; the guard activates after the next sync).
 * @param root consumer/git root
 * @param srcDir devkit's bundle dir for this kind
 * @param names the bundle's top-level names (what devkit would write)
 * @param targets surface names (e.g. ['claude', 'cursor'])
 * @param subdir the kind's surface subdir ('skills' | 'agents' | 'hooks')
 * @param manifest the prior <kind>-manifest.json (or null)
 * @returns conflict names
 */
export function findConflicts(
  root: string,
  srcDir: string,
  names: string[],
  targets: string[],
  subdir: string,
  manifest: SyncManifest | null,
): string[] {
  const owned = ownedNames(manifest);
  const ownedTargets = manifest?.targets ? new Set(manifest.targets) : null;
  return names.filter((name) =>
    targets.some((t) => {
      const dir = `.${t}/${subdir}`;
      if (!existsSync(join(root, dir, name)) || matchesBundle(root, dir, name, srcDir))
        return false;
      // diverges from the bundle → the consumer's, UNLESS devkit owns this name ON THIS surface
      return !(owned.has(name) && (!ownedTargets || ownedTargets.has(t)));
    }),
  );
}

// ── manifest-driven teardown (reverse: uninstall) ────────────────────────────────────────────

// The names devkit BUNDLES (top-level skill dirs / agent .md files / hook scripts) — the fallback
// name source when a manifest is gone (an orphaned or partial clean), so strays can still be
// enumerated + removed. Shared with install-hooks' removeHookScripts (one place, no dup).
export function bundledNames(sub: string, isMatch: (e: Dirent) => boolean): string[] {
  const dir = join(packageDir(), sub);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(isMatch)
    .map((e) => e.name);
}

// Shared teardown tail (skills/agents AND agent-hook scripts): drop each now-empty surface dir so a
// full uninstall leaves no footprint — but ONLY when empty (a consumer may keep their own files
// there) — then drop the manifest if asked + it existed. No-op under dryRun.
export function pruneEmptyDirsAndManifest(
  root: string,
  dirs: string[],
  manifestPath: string,
  manifest: SyncManifest | null,
  dropManifest: boolean,
  dryRun: boolean,
): void {
  if (dryRun) return;
  for (const dir of dirs) {
    const p = join(root, dir);
    if (existsSync(p) && readdirSync(p).length === 0) rmSync(p, { recursive: true, force: true });
  }
  if (dropManifest && manifest) rmSync(manifestPath, { force: true });
}

// Remove the devkit-synced entries a manifest records (skills/agents `<name>/` dirs OR flat agent-
// hook script files) from each surface dir, then prune empty dirs + the manifest. When the manifest
// is gone (orphaned/partial clean), falls back to `fallbackNames` (the package's bundled set) and
// then NEVER deletes a git-tracked path (the user's own). Shared by skills/agents + hook-scripts.
// Reason: flat manifest-teardown orchestration: sequential guarded steps (remove synced dirs, prune empty surface dirs, drop manifest) each gated by dryRun/dropManifest over the dirs list; high branch COUNT, each branch trivial, and the filesystem teardown is exercised end-to-end via init/clean not unit-tested (CRAP)
// fallow-ignore-next-line complexity
export function removeManifested(
  root: string,
  manifestRel: string,
  dirs: string[],
  kind: string,
  dryRun: boolean,
  dropManifest: boolean,
  fallbackNames: string[] = [],
  srcDir: string | null = null,
): void {
  const manifestPath = join(root, '.devkit', manifestRel);
  const manifest = readJson(manifestPath) as SyncManifest | null;
  // Names from the manifest (exactly what devkit wrote) or, when it's gone, the package's bundled
  // set — so an orphaned/partial clean can still find + remove strays.
  const names = manifest
    ? new Set(
        Object.keys(manifest.files)
          .map((rel) => rel.split('/')[0])
          .filter(Boolean),
      )
    : new Set(fallbackNames);
  if (!names.size) {
    console.log(`  • no ${manifestRel} — no ${kind} to remove`);
    return;
  }
  // Manifest keys are "<name>/<file>"; devkit owns the whole "<name>/" dir under each target, so
  // remove the dir — removing only the listed files left empty "<name>/" dirs behind (the other
  // half of the clean leak). recursive+force: an already-partial/absent dir is fine.
  // The fallback path (no manifest) guards a user's OWN same-named asset two ways, since there
  // `names` is the package's WHOLE bundled set (could match the consumer's own dir): never delete a
  // git-TRACKED one, and never delete an UNtracked one whose content DIVERGES from the bundle (= the
  // user's, e.g. a preserved non-devkit collision) — only devkit's own untouched strays (content
  // matches the bundle) are removed. With a manifest, `names` is exactly what devkit WROTE, and a
  // package-mode uninstall MUST remove its committed (tracked) files, so removal is unconditional.
  const guardTracked = !manifest;
  let n = 0;
  for (const name of names) {
    for (const dir of dirs) {
      const rel = `${dir}/${name}`;
      const p = join(root, dir, name);
      if (!existsSync(p)) continue;
      if (guardTracked) {
        if (isTracked(root, rel)) continue;
        if (srcDir && !matchesBundle(root, dir, name, srcDir)) {
          console.log(
            `  ! keeping ${kind} "${name}" — untracked + diverges from the bundle (not devkit's)`,
          );
          continue;
        }
      }
      n++;
      if (!dryRun) rmSync(p, { recursive: true, force: true });
    }
  }
  pruneEmptyDirsAndManifest(root, dirs, manifestPath, manifest, dropManifest, dryRun);
  if (n || manifest) {
    console.log(
      `  ${dryRun ? '[dry-run] remove' : '✓ removed'} ${n} synced ${kind} dir(s)${dropManifest && manifest ? ' + manifest' : ''}`,
    );
  }
}

/**
 * @param root git root
 * @param dryRun
 * @param targets surfaces to remove from (default both)
 * @param dropManifest also delete the manifest (default true — a full uninstall)
 */
export function removeSkills(
  root: string,
  dryRun: boolean,
  targets?: string[],
  dropManifest = true,
): void {
  const manifest = readJson(join(root, '.devkit', 'skills-manifest.json')) as SyncManifest | null;
  const managedTargets = targets ?? manifest?.targets ?? AGENT_TARGETS;
  const dirs = managedTargets.map((t) => `.${t}/skills`);
  const fallback = bundledNames('skills', (e) => e.isDirectory());
  removeManifested(
    root,
    'skills-manifest.json',
    dirs,
    'skill',
    dryRun,
    dropManifest,
    fallback,
    join(packageDir(), 'skills'),
  );
}

export function removeAgents(
  root: string,
  dryRun: boolean,
  targets: string[] = AGENT_TARGETS,
  dropManifest = true,
): void {
  const dirs = targets.map((t) => `.${t}/agents`);
  const fallback = bundledNames('agents', (e) => e.isFile() && e.name.endsWith('.md'));
  removeManifested(
    root,
    'agents-manifest.json',
    dirs,
    'agent',
    dryRun,
    dropManifest,
    fallback,
    join(packageDir(), 'agents'),
  );
}
