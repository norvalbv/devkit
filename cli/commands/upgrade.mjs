/**
 * `devkit upgrade` — one idempotent command that fully reconciles a consumer repo to the installed
 * devkit, reading everything from .devkit/config.json. It COMPOSES the existing slices (it does not
 * replace them): version/pin reconcile → migrate (emitted configs) → the init broad refresh
 * (skills/agents/agent-hooks + husky/guards, honouring the RECORDED agentTargets) → doctor verify.
 *
 *   devkit upgrade [--dry-run] [--force]
 *
 * --dry-run  print every action; write nothing.
 * --force    adopt consumer-authored skill/agent/hook collisions (tuned configs are NEVER overwritten).
 *
 * Never wholesale re-installs: the ONLY install is `bun install` of a genuinely newer PUBLISHED tag
 * (then re-run under the new code — the running process can't hot-swap to just-installed code). For
 * the common installed==latest case (symlink / local-checkout / steady state) it re-pins the stale
 * recorded refs and reconciles in a single pass. Plain .mjs, no build.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_TARGETS, normalizeSelection } from '../lib/components.mjs';
import { detectGitRoot } from '../lib/detect-git-root.mjs';
import { detectStack } from '../lib/detect-stack.mjs';
import { packageDir, readJson } from '../lib/fs-helpers.mjs';
import { syncHookScripts } from '../lib/install/install-hooks.mjs';
import doctor from './doctor.mjs';
import { applyInit } from './init.mjs';
import { computeMigration } from './migrate.mjs';
import { syncAgents } from './sync-agents.mjs';
import { syncSkills } from './sync-skills.mjs';
import update, { cmpSemver, DEP, fetchLatestTag, repinPackageJson } from './update.mjs';

export const meta = {
  name: 'upgrade',
  summary: 'Fully reconcile this repo to the installed devkit (one idempotent pass).',
  help: `devkit upgrade — bring a consumer repo fully up to the installed devkit in one command.

Usage:
  devkit upgrade [--dry-run] [--force]

Reads .devkit/config.json and composes the slices: reconcile the devkit pin + devkitRef, run
migrate (emitted configs), refresh skills/agents/agent-hooks + the husky guard block for the
RECORDED selection (honours agentTargets — never re-adds a deselected surface), then run doctor.

  --dry-run  print every action; write nothing.
  --force    adopt consumer-authored skill/agent/hook collisions (tuned configs are NEVER overwritten).

If a NEWER devkit tag is published, upgrade installs it and asks you to re-run (the running process
can't hot-swap to just-installed code). Otherwise it reconciles in a single pass. Composes
update / migrate / sync-skills / sync-agents / init — it does not replace them.`,
};

// Exit for "installed a newer tag; re-run to reconcile" — distinct from 0 (done) / 1 (drift) so a
// scripted `devkit upgrade && …` doesn't treat a still-stale repo as finished.
const NEEDS_RERUN = 10;

// Reason: flat top-level pipeline — sequential guarded steps (preflight → version/pin → migrate →
// broad refresh → force-adopt → verify), each a single delegated call with near-zero nesting; the
// real logic lives in the composed commands (applyInit / computeMigration / doctor / update).
// fallow-ignore-next-line complexity
export default async function upgrade(args, cwd) {
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');

  const cfg = readJson(join(cwd, '.devkit', 'config.json'));
  if (!cfg) {
    console.error('devkit upgrade: not initialized — run `devkit init` first.');
    return 2;
  }
  if (cfg.overlay) {
    console.error(
      'devkit upgrade: this is an overlay (local-only) repo — re-run `devkit init --overlay` to re-sync.',
    );
    return 1;
  }

  const stack = cfg.stack ?? detectStack(cwd);
  const standalone = Boolean(cfg.standalone);
  const { gitRoot } = detectGitRoot(cwd);

  // agentTargets: normalizeSelection ALWAYS fills this (both surfaces), so read the RAW recorded
  // value first — else a legacy claude-only repo gets .cursor re-added. When absent (legacy config),
  // infer from which surfaces currently hold devkit content; fall back to both.
  const rawTargets = cfg.components?.agentTargets;
  const inferred = AGENT_TARGETS.filter(
    (t) =>
      existsSync(join(gitRoot, `.${t}`, 'skills')) || existsSync(join(gitRoot, `.${t}`, 'agents')),
  );
  const agentTargets = rawTargets ?? (inferred.length ? inferred : AGENT_TARGETS);
  const sel = { ...normalizeSelection(cfg.components), agentTargets };

  console.log(`devkit upgrade${dryRun ? ' (dry-run — nothing written)' : ''} — stack=${stack}\n`);

  // ── 1. version / pin ───────────────────────────────────────────────────────
  // `current` = the version the REPO actually runs (its node_modules dep), not the CLI binary that
  // happens to be invoked — re-pinning to the CLI's version could diverge package.json from node_modules.
  const runningVersion = readJson(join(packageDir(), 'package.json'))?.version;
  const repoDepVersion = readJson(join(cwd, 'node_modules', DEP, 'package.json'))?.version;
  const current = (!standalone && repoDepVersion) || runningVersion;
  if (!current) {
    console.error('devkit upgrade: could not resolve the installed devkit version.');
    return 1;
  }

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
        console.log(`  [dry-run] would install v${latest}, then re-run to reconcile.`);
        return 0;
      }
      const code = await update([], cwd);
      if (code !== 0) return code;
      console.log(
        '\nInstalled a newer devkit. Re-run `devkit upgrade` to reconcile emitted files under the new version.',
      );
      return NEEDS_RERUN;
    }
  }
  const target = current;
  if (standalone) console.log('  • standalone — no devkit pin to reconcile');
  else repinStalePin(cwd, target, dryRun);

  // ── 2. configs (migrate) ───────────────────────────────────────────────────
  // Gate on the RAW recorded `structure` (normalizeSelection defaults it true for legacy configs),
  // so a non-structure repo never gets an eslint.config.mjs created. A recorded structure:true
  // implies a structure stack (init records it only when isStructure held).
  console.log('\n2. configs (migrate)');
  if (cfg.components?.structure === true) {
    const changes = computeMigration(cwd, stack);
    if (!changes.length) console.log('  • emitted configs already match');
    for (const c of changes) {
      console.log(`  ${dryRun ? '•' : '✓'} ${c.file}  [${c.kind}]  — ${c.why}`);
      if (!dryRun) c.write();
    }
  } else {
    console.log('  • no structure preset recorded — nothing to migrate');
  }

  // ── 3+4. broad refresh (idempotent; never clobbers consumer configs) ───────
  // applyInit(force:false): configs via writeIfAbsent (existing preserved), package.json devDeps,
  // husky guard block refreshed only if changed, ratchet baselines frozen only if missing,
  // skills/agents/agent-hooks synced (collisions preserved), deselected surfaces pruned, and
  // .devkit/config.json rewritten with devkitRef=v<target> (minDevkit/configOverrides carried
  // forward). regenStructureBaselines:false → an existing structure baseline is kept, never
  // re-snapshotted (no debt laundering).
  console.log('\n3. broad refresh (skills / agents / agent-hooks / husky / guards)');
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
    console.log('\n4. --force: adopt consumer-authored asset collisions');
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
  console.log('\n5. verify\n');
  return doctor([], cwd);
}

// Reconcile a stale devkit pin in package.json to `#v<target>` — update's "up to date"
// short-circuit never re-pins, so an installed==latest repo can keep a stale #vX.Y.Z. Idempotent:
// writes only when the ref actually changes; NO `bun install` — node_modules already matches the
// installed version, so a dev symlink / local checkout survives.
function repinStalePin(cwd, target, dryRun) {
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
