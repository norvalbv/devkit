/**
 * `devkit upgrade` — one idempotent command that fully reconciles a consumer repo to the installed
 * devkit, reading everything from .devkit/config.json. It COMPOSES the existing slices (it does not
 * replace them): version/pin reconcile → emitted-config reconcile (computeMigration) → the init broad refresh
 * (skills/agents/agent-hooks + husky/guards, honouring the RECORDED agentTargets) → doctor verify.
 *
 *   devkit upgrade [--dry-run] [--force]
 *
 * --dry-run  print every action; write nothing.
 * --force    adopt consumer-authored skill/agent/hook collisions (tuned configs are NEVER overwritten).
 *
 * Never wholesale re-installs: the ONLY install is `bun install` of a genuinely newer PUBLISHED tag.
 * A re-run is then required only when the RUNNING CLI is itself behind that tag (it can't hot-swap to
 * just-installed code); when the running CLI is already >= latest it installs AND reconciles in the
 * same pass. For the common installed==latest case (symlink / local-checkout / steady state) it
 * re-pins the stale recorded refs and reconciles in a single pass. TypeScript source, shipped as
 * prebuilt .mjs.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { confirm, isCancel, multiselect } from '@clack/prompts';
import {
  enableLineGrowth,
  hasLineCap,
  LINE_CAP,
  previewGrandfather,
} from '../../gate-engine/ratchets/size-disable.mts';
import { resolveExistingAgentTargets } from '../lib/agent-targets.mts';
import {
  applyOverlayConstraints,
  GUARD_OPTIONS,
  newBundledGates,
  normalizeSelection,
  type Selection,
} from '../lib/components.mts';
import { detectGitRoot } from '../lib/detect-git-root.mts';
import { detectStack } from '../lib/detect-stack.mts';
import { packageDir, readJson } from '../lib/fs-helpers.mts';
import { selfHostSelection } from '../lib/husky/self-host.mts';
import { syncHookScripts } from '../lib/install/install-hooks.mts';
import doctor from './doctor.mts';
import { applyInit } from './init.mts';
import { computeMigration } from './migrate-config.mts';
import { syncAgents } from './sync/sync-agents.mts';
import { syncSkills } from './sync/sync-skills.mts';
import update, { cmpSemver, DEP, fetchLatestTag, needsRerun, repinPackageJson } from './update.mts';

export const meta = {
  name: 'upgrade',
  summary: 'Fully reconcile this repo to the installed devkit (one idempotent pass).',
  help: `devkit upgrade — bring a consumer repo fully up to the installed devkit in one command.

Usage:
  devkit upgrade [--dry-run] [--force]

Reads .devkit/config.json and composes the slices: reconcile the devkit pin + devkitRef, reconcile
emitted configs (eslint.config.mjs / guard.config.json), refresh skills/agents/agent-hooks + the
husky guard block for the RECORDED selection (honours agentTargets — never re-adds a deselected
surface), then run doctor.

  --dry-run  print every action; write nothing.
  --force    adopt consumer-authored skill/agent/hook collisions (tuned configs are NEVER overwritten).

If a NEWER devkit tag is published, upgrade installs it; it then asks you to re-run ONLY if the
running CLI is itself behind that tag (it can't hot-swap to just-installed code) — a running CLI
already >= latest installs and reconciles in the same pass. Otherwise it reconciles in a single pass.
This is the SINGLE upgrade entry point — run it, not the pieces (update / sync-skills / sync-agents /
init stay callable for scripts, but upgrade composes them + the emitted-config reconcile).`,
};

// Exit for "installed a newer tag; re-run to reconcile" — distinct from 0 (done) / 1 (drift) so a
// scripted `devkit upgrade && …` doesn't treat a still-stale repo as finished.
const NEEDS_RERUN = 10;

// A clean version tag, for validating a recorded overlay `devkitRef` pin (mirrors doctor.mts).
const SEMVER = /^\d+\.\d+\.\d+$/;

// The .devkit/config.json fields upgrade reads (the recorded selection + repo mode).
interface DevkitConfig {
  overlay?: boolean;
  // Overlay's version pin lives here (there's no package.json dep) — read it the install-agnostic way.
  devkitRef?: string;
  // Overlay only: whether the opt-in machine-global commit-gate shim was wired — preserved on re-sync.
  globalCommitGate?: boolean;
  stack?: string;
  standalone?: boolean;
  selfHost?: boolean;
  components?: Partial<Selection>;
}

// A package.json read only for its version.
interface PackageManifest {
  version?: string;
}

// Reason: flat top-level pipeline — sequential guarded steps (preflight → version/pin → config reconcile →
// broad refresh → force-adopt → verify), each a single delegated call with near-zero nesting; the
// real logic lives in the composed commands (applyInit / computeMigration / doctor / update).
// fallow-ignore-next-line complexity
export default async function upgrade(args: string[], cwd: string): Promise<number> {
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');

  const cfg = readJson(join(cwd, '.devkit', 'config.json')) as DevkitConfig | null;
  if (!cfg) {
    console.error('devkit upgrade: not initialized — run `devkit init` first.');
    return 2;
  }
  const stack = cfg.stack ?? detectStack(cwd);
  const standalone = Boolean(cfg.standalone);
  const { gitRoot } = detectGitRoot(cwd);

  // agentTargets: normalizeSelection ALWAYS fills the fresh defaults, so read the RAW recorded
  // value first — else a legacy claude-only repo gets .cursor re-added. When absent (legacy config),
  // infer from which surfaces currently hold devkit content; otherwise retain the legacy pair.
  const rawTargets = cfg.components?.agentTargets;
  const agentTargets = resolveExistingAgentTargets(gitRoot, rawTargets, ['skills', 'agents']);

  // Self-host (the devkit repo dogfooding itself): there is no published pin, no emitted-config
  // migration (configs are hand-owned), and the selection is FIXED (selfHostSelection — not the
  // recorded guards, so a future RECOMMENDED_GUARD_IDS addition never triggers an interactive
  // multiselect in the dogfood repo). Regenerate the source hook + re-sync assets from the current
  // generator, then verify — the whole point is that `devkit upgrade` keeps the dogfood hook in
  // lockstep with the generator, for free.
  if (cfg.selfHost) {
    console.log(
      `devkit upgrade${dryRun ? ' (dry-run — nothing written)' : ''} — self-host (source-mode dogfood), stack=${stack}\n`,
    );
    console.log('Regenerating the source hook + re-syncing assets from the current generator.');
    await applyInit(cwd, {
      stack,
      selection: { ...selfHostSelection(), agentTargets },
      selfHost: true,
      force,
      dryRun,
      regenStructureBaselines: false,
    });
    if (dryRun) {
      console.log('\nDry-run complete — nothing written.');
      return 0;
    }
    console.log('\nverify\n');
    return doctor([], cwd);
  }

  // Overlay (local-only): the version pin is .devkit/config.json's `devkitRef` — there's no package.json
  // dep because the gates run off the GLOBAL devkit CLI (node_modules' analog). Resolve the pin the same
  // install-agnostic way and, like package mode, chase a newer PUBLISHED tag (updating the global install
  // — the analog of `bun install`), then re-sync the git-ignored gate chain + configs + skills/agents
  // against it and verify. Idempotent: baselining is init-only (repoAdopted), so a re-sync never
  // re-freezes debt. Was formerly a bail pointing at `devkit init --overlay` — that re-sync is now safe.
  if (cfg.overlay) {
    const runningVersion = (readJson(join(packageDir(), 'package.json')) as PackageManifest | null)
      ?.version;
    // devkitRef is the overlay's version pin, but it can also be 'main' / a branch / a SHA (an
    // unversioned overlay install) — only a clean `v<semver>` tag is a comparable pin. Anything else
    // falls back to the running CLI version; otherwise cmpSemver would return NaN (silently defeating the
    // update check) and `v${target}` would persist a corrupt ref like `vmain`. Mirrors doctor.mts.
    const stamped =
      cfg.devkitRef?.startsWith('v') && SEMVER.test(cfg.devkitRef.slice(1))
        ? cfg.devkitRef.slice(1)
        : undefined;
    const current = stamped || runningVersion;
    if (!current) {
      console.error('devkit upgrade: could not resolve the installed devkit version.');
      return 1;
    }
    let target = current;
    console.log(
      `devkit upgrade${dryRun ? ' (dry-run — nothing written)' : ''} — overlay (local-only), stack=${stack}\n`,
    );

    console.log('1. version / pin');
    // ponytail: inline copy of the package path's version-check (the version/pin step below); extract a
    // shared resolveTarget() only if a 4th mode needs it. Kept inline so the package path is untouched.
    const { latest, error } = fetchLatestTag();
    if (error) {
      console.log(`  ! ${error} — reconciling against the installed v${current}.`);
    } else if (latest && cmpSemver(latest, current) > 0) {
      console.log(`  newer devkit published: v${latest} (installed v${current})`);
      if (dryRun) {
        console.log(
          `  [dry-run] would install v${latest}${needsRerun(latest, runningVersion) ? ', then re-run to reconcile' : ' and reconcile in this pass'}.`,
        );
        return 0;
      }
      const code = await update([], cwd);
      if (code !== 0) return code;
      // A re-run is needed only when the RUNNING global CLI is itself behind latest — it can't hot-swap
      // to the code it just installed. When already >= latest it reconciles the overlay in this pass.
      if (needsRerun(latest, runningVersion)) {
        console.log(
          '\nInstalled a newer devkit. Re-run `devkit upgrade` to reconcile the overlay under the new version.',
        );
        return NEEDS_RERUN;
      }
      target = latest;
      console.log(
        `  ✓ installed v${latest} — running CLI already current, reconciling in this pass.`,
      );
    }

    console.log(
      '\n2. re-sync (regenerate the git-ignored gate chain + configs for the recorded selection)',
    );
    // biome is a pass-through overlay opt-out that applyOverlay never persists into config.components, so
    // normalizeSelection would default it back to `true` and silently re-add biome.devkit.jsonc to a repo
    // init'd with --no-biome. Honour the recorded value; else infer from the on-disk overlay marker (the
    // same legacy-inference idiom as `structure` above) — biome.devkit.jsonc is written iff biome was on.
    const biome = cfg.components?.biome ?? existsSync(join(cwd, 'biome.devkit.jsonc'));
    const sel = applyOverlayConstraints({
      ...normalizeSelection(cfg.components),
      agentTargets,
      biome,
    });
    // `--force` must NOT reach applyOverlay's config writers: writeIfAbsent(guard.config.json) and
    // writeBiomeOverlay OVERWRITE on force, but upgrade's contract (and the package-mode branch, which
    // hardcodes force:false) is that tuned configs are NEVER overwritten. Refreshing overlay configs is
    // the deliberate `devkit init --overlay --force`, not upgrade.
    // ponytail: overlay upgrade has no assets-only force-adopt pass (package Step 5); add if needed.
    if (force) {
      console.log(
        '  • --force: tuned overlay configs are never overwritten by upgrade — run `devkit init --overlay --force` to refresh them.',
      );
    }
    await applyInit(cwd, {
      stack,
      selection: sel,
      overlay: true,
      devkitRef: `v${target}`,
      // Preserve an opted-in machine-global commit gate: applyOverlay reads plan.globalCommitGate (NOT
      // the existing config) and rewrites the flag from it — omitting it would silently un-wire the shim.
      globalCommitGate: cfg.globalCommitGate,
      force: false,
      dryRun,
    });
    if (dryRun) {
      console.log('\nDry-run complete — nothing written.');
      return 0;
    }
    console.log('\nverify\n');
    return doctor([], cwd);
  }

  // structure: normalizeSelection ALSO defaults this to `true` when the key is absent, so a LEGACY
  // config (no `structure` key) would otherwise reach applyInit as structure:true and newly ADD
  // structure-lint to a config-driven repo that never had it. Honour the RAW recorded value; if absent
  // (legacy), infer from disk (a package-mode structure repo has an emitted eslint.config.mjs) — never
  // the normalized default. An explicit recorded `false` is preserved (false ?? x === false).
  const structure = cfg.components?.structure ?? existsSync(join(cwd, 'eslint.config.mjs'));
  const sel = { ...normalizeSelection(cfg.components), agentTargets, structure };

  console.log(`devkit upgrade${dryRun ? ' (dry-run — nothing written)' : ''} — stack=${stack}\n`);

  // ── 1. version / pin ───────────────────────────────────────────────────────
  // `current` = the version the REPO actually runs (its node_modules dep), not the CLI binary that
  // happens to be invoked — re-pinning to the CLI's version could diverge package.json from node_modules.
  const runningVersion = (readJson(join(packageDir(), 'package.json')) as PackageManifest | null)
    ?.version;
  const repoDepVersion = (
    readJson(join(cwd, 'node_modules', DEP, 'package.json')) as PackageManifest | null
  )?.version;
  const current = (!standalone && repoDepVersion) || runningVersion;
  if (!current) {
    console.error('devkit upgrade: could not resolve the installed devkit version.');
    return 1;
  }
  // The version to reconcile the pin / devkitRef / emitted files to. Bumped to `latest` below only if
  // we install a newer tag AND continue in this pass (running CLI already current — see needsRerun).
  let target = current;

  console.log('1. version / pin');
  if (!standalone && repoDepVersion && runningVersion && repoDepVersion !== runningVersion) {
    console.log(
      `  ! running devkit v${runningVersion} but this repo resolves v${repoDepVersion} — templates/skills come from the running CLI. Run via the repo's local devkit for an exact match.`,
    );
  }
  if (!standalone) {
    const { latest, error } = fetchLatestTag();
    if (error) {
      console.log(`  ! ${error} — reconciling against the installed v${current}.`);
    } else if (latest && cmpSemver(latest, current) > 0) {
      console.log(`  newer devkit published: v${latest} (installed v${current})`);
      if (dryRun) {
        console.log(
          `  [dry-run] would install v${latest}${needsRerun(latest, runningVersion) ? ', then re-run to reconcile' : ' and reconcile in this pass'}.`,
        );
        return 0;
      }
      const code = await update([], cwd);
      if (code !== 0) return code;
      // A re-run is needed only when the RUNNING CLI is itself behind latest — it can't hot-swap to
      // the code it just installed. When it is already ≥ latest (e.g. the global CLI on PATH) its
      // templates ARE latest and update reconciled node_modules in place, so continue this pass and
      // reconcile the repo to v${latest}.
      if (needsRerun(latest, runningVersion)) {
        console.log(
          '\nInstalled a newer devkit. Re-run `devkit upgrade` to reconcile emitted files under the new version.',
        );
        return NEEDS_RERUN;
      }
      target = latest;
      console.log(
        `  ✓ installed v${latest} — running CLI already current, reconciling in this pass.`,
      );
    }
  }
  if (standalone) console.log('  • standalone — no devkit pin to reconcile');
  else repinStalePin(cwd, target, dryRun);

  // ── 2. configs (migrate) ───────────────────────────────────────────────────
  // Gate on the RESOLVED `structure` (raw recorded value, or inferred from an emitted eslint.config.mjs
  // for a legacy config) — NOT the normalized default — so a non-structure repo never gets an
  // eslint.config.mjs created. applyInit's own STRUCTURE_STACKS check is the backstop for the stack.
  console.log('\n2. configs (migrate)');
  if (structure) {
    const changes = computeMigration(cwd, stack);
    if (!changes.length) console.log('  • emitted configs already match');
    for (const c of changes) {
      console.log(`  ${dryRun ? '•' : '✓'} ${c.file}  [${c.kind}]  — ${c.why}`);
      if (!dryRun) c.write();
    }
  } else {
    console.log('  • no structure preset recorded — nothing to migrate');
  }

  // ── 3. gates: reconcile newly-bundled gates against the recorded selection ─
  // applyInit rebuilds the husky block from sel.guards (the RECORDED set), so a gate shipped after
  // this repo's last install is silently dropped. Reconcile against the current bundle: offer the
  // new gates interactively (TTY), else heal the recommended ones + notice the opt-in ones (never
  // auto-added). Mutating sel.guards here feeds applyInit below, which persists it to .devkit/config.json.
  console.log('\n3. gates');
  if (!sel.husky) {
    console.log('  • husky not selected — no gates to reconcile');
  } else {
    const { recommended, optIn } = newBundledGates(sel.guards);
    const opt = (id: string) => GUARD_OPTIONS.find((g) => g.id === id);
    // Trigger ONLY on a missing RECOMMENDED gate (the genuine "you're behind" case — e.g. a
    // newly-promoted gate). An opt-in gate the user simply never enabled must NOT re-nag on every
    // upgrade; it rides along in the offer/notice below whenever a recommended reconcile fires.
    // ponytail: gate on recommended-missing (no per-repo "gates known at install" state); a purely-new
    // opt-in gate with no recommended change won't surface until one does.
    if (!recommended.length) {
      console.log('  • no new recommended gates — gate selection unchanged');
    } else if (dryRun) {
      console.log(`  [dry-run] would add recommended gate(s): ${recommended.join(', ')}`);
      for (const id of optIn) console.log(`  [dry-run] opt-in gate also available: ${id}`);
    } else if (process.stdout.isTTY && process.stdin.isTTY) {
      const picked = await multiselect({
        message: 'New gates available since your last install — select any to add',
        options: [...recommended, ...optIn].map((id) => ({
          value: id,
          label: opt(id)?.label ?? id,
          hint: opt(id)?.hint,
        })),
        initialValues: recommended,
        required: false,
      });
      if (isCancel(picked)) {
        console.log('  • skipped gate selection — existing gates unchanged');
      } else if ((picked as string[]).length) {
        sel.guards = [...sel.guards, ...(picked as string[])];
        console.log(`  ✓ added gate(s): ${(picked as string[]).join(', ')}`);
      } else {
        console.log('  • no gates selected');
      }
    } else {
      // Non-TTY: heal recommended, notice opt-in (never auto-add opt-in).
      sel.guards = [...sel.guards, ...recommended];
      console.log(`  ✓ added recommended gate(s): ${recommended.join(', ')}`);
      for (const id of optIn) {
        console.log(
          `  • devkit also bundles ${id} (opt-in) — enable with 'devkit init --guards …,${id}'`,
        );
      }
    }
  }

  // ── 3b. line-growth block: back-fill the per-file maxLines cap for repos that predate it ───
  // It's a CONFIG KNOB on the already-selected `size` guard (not a guard id), so newBundledGates never
  // surfaces it. Offer it when size runs but guard.config.json has no cap. `sel.lineGrowth` defaults
  // true (a legacy repo never recorded it) → the offer fires once; declining records false (no re-nag),
  // enabling writes the cap. Enabling here ALSO grandfathers current giants (lines-only freeze), since
  // upgrade's init pass never re-freezes an adopted repo — without it their over-cap files hard-error.
  if (
    sel.husky &&
    sel.guards.includes('size') &&
    sel.lineGrowth &&
    existsSync(join(cwd, 'guard.config.json')) &&
    !hasLineCap(cwd)
  ) {
    console.log('\n3b. line-growth block');
    if (dryRun) {
      console.log(
        `  [dry-run] would enable per-file line-growth block (maxLines ${LINE_CAP}; grandfathers ${previewGrandfather(cwd)} file(s))`,
      );
    } else if (process.stdout.isTTY && process.stdin.isTTY) {
      const yes = await confirm({
        message: `Enable the per-file line-growth block? Caps source files at ${LINE_CAP} lines; current giants are grandfathered (shrink-only), new growth is blocked.`,
        initialValue: true,
      });
      if (isCancel(yes) || !yes) {
        sel.lineGrowth = false; // record the decline so upgrade never re-nags
        console.log('  • line-growth block not enabled');
      } else {
        reportLineGrowth(enableLineGrowth(cwd));
      }
    } else {
      // Non-TTY: auto-enable + freeze (heal like a recommended gate).
      reportLineGrowth(enableLineGrowth(cwd));
    }
  }

  // ── 4. broad refresh (idempotent; never clobbers consumer configs) ─────────
  // applyInit(force:false): configs via writeIfAbsent (existing preserved), package.json devDeps,
  // husky guard block refreshed only if changed, ratchet baselines frozen only if missing,
  // skills/agents/agent-hooks synced (collisions preserved), deselected surfaces pruned, and
  // .devkit/config.json rewritten with devkitRef=v<target> (minDevkit/configOverrides carried
  // forward). regenStructureBaselines:false → an existing structure baseline is kept, never
  // re-snapshotted (no debt laundering).
  console.log('\n4. broad refresh (skills / agents / agent-hooks / husky / guards)');
  await applyInit(cwd, {
    stack,
    selection: sel,
    standalone,
    devkitRef: `v${target}`,
    force: false,
    dryRun,
    regenStructureBaselines: false,
  });

  // ── 5. --force asset adoption (assets only — never configs) ─────────────────
  // --force is driven by the `override` OPT (args only carry --dry-run). Re-syncs the selected
  // surfaces adopting consumer-authored same-named collisions; tuned biome/tsconfig are untouched.
  if (force) {
    console.log('\n5. --force: adopt consumer-authored asset collisions');
    const syncArgs = dryRun ? ['--dry-run'] : [];
    const override = () => true;
    if (sel.skills) syncSkills(syncArgs, gitRoot, sel.agentTargets, { override });
    if (sel.agents) syncAgents(syncArgs, gitRoot, sel.agentTargets, { override });
    if (sel.agentHooks) syncHookScripts(gitRoot, { dryRun, targets: sel.agentTargets, override });
  }

  // ── 6. verify ──────────────────────────────────────────────────────────────
  if (dryRun) {
    console.log('\nDry-run complete — nothing written. Re-run without --dry-run to apply.');
    return 0;
  }
  console.log('\n6. verify\n');
  return doctor([], cwd);
}

// Reconcile a stale devkit pin in package.json to `#v<target>` — update's "up to date"
// short-circuit never re-pins, so an installed==latest repo can keep a stale #vX.Y.Z. Idempotent:
// writes only when the ref actually changes; NO `bun install` — node_modules already matches the
// installed version, so a dev symlink / local checkout survives.
function repinStalePin(cwd: string, target: string, dryRun: boolean): void {
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) {
    console.log('  • no package.json — skipping pin reconcile');
    return;
  }
  const raw = readFileSync(pkgPath, 'utf8');
  const repinned = repinPackageJson(raw, target);
  if (repinned === raw) {
    console.log(`  • devkit pin unchanged (already #v${target}, or not a #v tag)`);
    return;
  }
  if (dryRun) {
    console.log(`  [dry-run] re-pin devkit → #v${target}`);
    return;
  }
  writeFileSync(pkgPath, repinned);
  console.log(`  ✓ re-pinned devkit → #v${target}`);
}

// Print the outcome of a line-growth enable — honest when an unreadable guard.config.json meant the
// cap was NOT written (enableLineGrowth skips rather than crashing on a corrupt file).
function reportLineGrowth({
  enabled,
  grandfathered,
}: {
  enabled: boolean;
  grandfathered: number;
}): void {
  console.log(
    enabled
      ? `  ✓ line-growth block enabled (maxLines ${LINE_CAP}); grandfathered ${grandfathered} file(s)`
      : '  • could not enable line-growth block — guard.config.json unreadable; skipped',
  );
}
