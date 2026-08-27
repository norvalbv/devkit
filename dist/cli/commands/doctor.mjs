/** `devkit doctor` diagnoses init drift. Read-only unless `--fix`; it never refreshes baselines.
 * Exit: 0 all-ok, 1 drift, 2 not-initialized. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QAVIS_RECIPE, qavisOnPath } from '../../gate-engine/qavis-advisory/check.mjs';
import { FANOUT_BASELINE, LEGACY_FANOUT_BASELINE, LEGACY_LINES_BASELINE, LEGACY_SIZE_BASELINE, LINES_BASELINE, readRatchetBaseline, SIZE_BASELINE, } from '../../gate-engine/ratchets/baseline-paths.mjs';
import { RECOMMENDED_GUARD_IDS, structureCmdFor } from '../lib/components.mjs';
import { detectGitRoot } from '../lib/detect-git-root.mjs';
import { checkAgentAssets, checkRegistrations } from '../lib/doctor/asset-checks.mjs';
import { check } from '../lib/doctor/check-result.mjs';
import { checkExtends, EXTENDS_REPAIRABLE, expectedExtends, repairExtends, } from '../lib/doctor/extends-checks.mjs';
import { checkGuardConfig, SEARCH_INDEX_CHECK } from '../lib/doctor/guard-config-checks.mjs';
import { hookChecks } from '../lib/doctor/hook-checks.mjs';
import { runOverlayDoctor } from '../lib/doctor/overlay-doctor.mjs';
import { checkLockPin, checkPin } from '../lib/doctor/pin/pin-checks.mjs';
import { ALLOW_SKEW_ENV, delegateToPinned, printSkewBanner, runnerSkew, skewCheck, } from '../lib/doctor/pin/runner-identity.mjs';
import { runSelfHostDoctor } from '../lib/doctor/self-host-doctor.mjs';
import { packageDir, readJson } from '../lib/fs-helpers.mjs';
import { checkCommitMsgHook, commitMsgGuards } from '../lib/husky/commit-msg-block.mjs';
import { extractGuardBlock, QAVIS_ADVISORY_ID } from '../lib/husky/husky-block.mjs';
import { checkAdhdSkill } from '../lib/install/adhd-skill.mjs';
import { resolveExistingAgentProviders, SUPPORTED_AGENT_PROVIDERS, } from '../lib/install/agent-assets/agent-providers.mjs';
import { checkAntiSlopCapability, syncAntiSlopCapability, } from '../lib/install/anti-slop/lifecycle.mjs';
import { selectedHookAssets } from '../lib/install/hook-registration-ledger/selection.mjs';
import { checkOxcCapability, syncOxcCapability } from '../lib/install/oxc/lifecycle.mjs';
import { cmpSemver, fetchLatestTag } from './update.mjs';
// Devkit modules are .mts in source and .mjs when installed; runtime string paths need the live ext.
const SELF_EXT = import.meta.url.endsWith('.mts') ? '.mts' : '.mjs';
function checkConfig(cwd) {
    if (!existsSync(join(cwd, '.devkit', 'config.json'))) {
        return check('.devkit/config.json', 'MISSING', 'not initialized', 'run `devkit init`');
    }
    return check('.devkit/config.json', 'OK', 'present');
}
function checkStructureLint(cwd, stack) {
    const { gitRoot, pkgRel } = detectGitRoot(cwd);
    const hookPath = join(gitRoot, '.husky', 'pre-commit');
    if (!existsSync(hookPath)) {
        return check('structure-lint', 'MISSING', 'no hook', 'run `devkit init`', true);
    }
    const block = extractGuardBlock(readFileSync(hookPath, 'utf8'), pkgRel) ?? '';
    const expectedCmd = structureCmdFor(stack);
    if (!block.includes(`--structure "${expectedCmd}"`)) {
        return check('structure-lint', 'DRIFT', `no \`--structure "${expectedCmd}"\` on the guard-deterministic line`, 'run `devkit init --force` to enable it', true);
    }
    return check('structure-lint', 'OK', `runs \`${expectedCmd}\``);
}
// searchSteering: the guard + counter engine bins are present in the installed package.
function checkSearchToolBins() {
    const dir = join(packageDir(), 'gate-engine', 'search-tool');
    const missing = [`search-tool-guard${SELF_EXT}`, `search-tool-counter${SELF_EXT}`].filter((f) => !existsSync(join(dir, f)));
    if (missing.length) {
        return check('search-steering bins', 'MISSING', `engine bin(s) absent: ${missing.join(', ')}`, 'reinstall @norvalbv/devkit');
    }
    return check('search-steering bins', 'OK', 'guard + counter present');
}
function checkBaselines(cwd) {
    const present = [
        ['fanout', readRatchetBaseline(cwd, FANOUT_BASELINE, LEGACY_FANOUT_BASELINE)],
        ['size', readRatchetBaseline(cwd, SIZE_BASELINE, LEGACY_SIZE_BASELINE)],
        ['line-growth', readRatchetBaseline(cwd, LINES_BASELINE, LEGACY_LINES_BASELINE)],
    ].flatMap(([name, baseline]) => (baseline ? [name] : []));
    // A ratchet baseline holds ONLY grandfathered debt and is cut once at init. An absent one means
    // "no debt — cap enforced from guard.config.json", which is healthy, not drift. So this is purely
    // informational: never MISSING, never a --fix target.
    return check('baselines', 'OK', present.length
        ? `grandfathered debt: ${present.join(' + ')}`
        : 'no grandfathered debt (enforced from config)');
}
const SEMVER = /^\d+\.\d+\.\d+$/;
// Warn when the RUNNING devkit is older than this repo's init stamp, a hand-declared `minDevkit`
// floor, or the latest tag (info-only, never DRIFT; skippable via DEVKIT_SKIP_REMOTE_CHECKS).
// Read-only, config.json-only (not package.json) — `devkit update` is always the told-to remedy.
export function checkVersion(cwd, env = process.env) {
    const pkg = readJson(join(packageDir(), 'package.json'));
    const running = pkg?.version;
    if (!running || !SEMVER.test(running))
        return check('devkit version', 'OK', 'unknown');
    const cfg = readJson(join(cwd, '.devkit', 'config.json'));
    const min = cfg?.minDevkit;
    // The init-time devkit version is the `devkitRef` pin (`vX.Y.Z`). Use it as the drift baseline
    // when it's a clean version tag — devkitRef can also be 'main'/a branch/SHA, which has no baseline.
    const ref = cfg?.devkitRef;
    const stamped = typeof ref === 'string' && ref.startsWith('v') ? ref.slice(1) : undefined;
    if (min && SEMVER.test(min) && cmpSemver(running, min) < 0) {
        return check('devkit version', 'DRIFT', `installed ${running} < required minimum ${min}`, 'devkit update');
    }
    if (stamped && SEMVER.test(stamped) && cmpSemver(running, stamped) < 0) {
        return check('devkit version', 'DRIFT', `installed ${running} older than this repo's init (${stamped})`, 'devkit update');
    }
    const { latest } = env.DEVKIT_SKIP_REMOTE_CHECKS ? {} : fetchLatestTag(); // no `error` key on success
    const behind = latest && cmpSemver(running, latest) < 0 ? `, latest ${latest} — run \`devkit update\`` : '';
    // Echo whichever floors are declared so a satisfied min/stamp is visibly active, not silent.
    const meta = [stamped && `repo init ${stamped}`, min && `min ${min}`].filter(Boolean).join(', ');
    return check('devkit version', 'OK', `installed ${running}${meta ? ` (${meta})` : ''}${behind}`);
}
// Reproduce the recorded selection rather than the all-on `--yes` default.
function selectionFlags(sel) {
    const flags = ['--yes'];
    const toggles = [
        'biome',
        'tsconfig',
        'skills',
        'agents',
        'husky',
        'structure',
    ];
    for (const id of toggles) {
        if (sel[id] === false)
            flags.push(`--no-${id}`);
    }
    if (sel.lineGrowth === false)
        flags.push('--no-line-growth');
    for (const [id, flag] of [
        ['fallow', '--fallow'],
        ['searchSteering', '--search-steering'],
        ['agentHooks', '--agent-hooks'],
        ['searchCode', '--search-code'],
        ['adhd', '--adhd'],
        ['priorArtGate', '--prior-art-gate'],
        ['antiSlop', '--anti-slop'],
    ])
        if (sel[id])
            flags.push(flag);
    if (!sel.guards?.length)
        flags.push('--no-guards');
    else
        flags.push('--guards', sel.guards.join(','));
    for (const t of SUPPORTED_AGENT_PROVIDERS) {
        if (sel.agentTargets && !sel.agentTargets.includes(t))
            flags.push(`--no-${t}`);
    }
    return flags;
}
// --fix repairs only fixable findings, preserves tuned config content, and never refreezes.
// Missing files/hooks use init with the recorded selection and install mode.
// Reason: flat repair orchestration: independent sequential `if (this kind drifted) repair it` steps (extends-repair loop, init re-run, sync-skills, recreate-missing-baseline) with near-zero nesting; high branch COUNT, each a trivial guarded fixup. Splitting scatters the deliberate repair ordering.
// fallow-ignore-next-line complexity
function applyFix(cwd, results, sel, stack, standalone) {
    console.log('\n--fix: re-running idempotent steps for the recorded selection...');
    // Repair only the mode-correct extends pointer; init recreates missing configs below.
    const want = expectedExtends(stack, standalone);
    for (const r of results) {
        const kind = EXTENDS_REPAIRABLE[r.name];
        if (kind && r.status === 'DRIFT' && repairExtends(join(cwd, r.name), want[kind])) {
            console.log(`  ✓ repaired ${r.name} extends → ${want[kind]}`);
        }
    }
    // MISSING template files / husky drift → init for the recorded selection (idempotent).
    const OXC_CHECKS = new Set([
        'Oxc manifest',
        'Oxc runtime',
        'Oxlint base',
        'oxlint config',
        'oxfmt config',
    ]);
    const needsOxcSync = results.some((r) => OXC_CHECKS.has(r.name) && r.fixable && r.status !== 'OK');
    const needsAntiSlopSync = Boolean(sel.antiSlop) &&
        results.some((r) => r.name.startsWith('anti-slop') && r.fixable && r.status !== 'OK');
    const needsInit = results.some((r) => r.fixable &&
        r.status === 'MISSING' &&
        !OXC_CHECKS.has(r.name) &&
        r.name !== 'baselines' &&
        r.name !== 'skills' &&
        r.name !== 'agents');
    // The guard blocks (pre-commit + commit-msg) AND the structure-lint `--structure` arg are all
    // rebuilt by init from the recorded selection — so a drifted result on any of them takes the
    // same init repair path (each flags itself fixable, else --fix would no-op it).
    // `r.fixable` is part of the condition, not just the name: a hook check can now report a problem
    // init CANNOT repair (a hand-written gate call OUTSIDE the managed block — regenerating the block
    // leaves it untouched). Without this, --fix re-inits on every run and the warning never clears.
    const HOOK_CHECKS = new Set(['.husky/pre-commit', '.husky/commit-msg', 'structure-lint']);
    const hookDrift = results.some((r) => r.fixable &&
        (HOOK_CHECKS.has(r.name) || r.name === 'agent-hooks' || r.name === 'hook registrations') &&
        r.status !== 'OK');
    // A lost `indexPath` is repaired the way it was written: by init's --search-code step (which
    // selectionFlags already emits for a repo whose recorded selection has it). `r.fixable` carries
    // that precondition — the check clears it only when the selection can actually reproduce the
    // wiring, so --fix never re-inits chasing a warning it has no flag to clear.
    const indexDrift = results.some((r) => r.name === SEARCH_INDEX_CHECK && r.fixable && r.status !== 'OK');
    if (needsInit || hookDrift || indexDrift) {
        const args = ['init', '--stack', stack, ...selectionFlags(sel)];
        if (standalone)
            args.push('--standalone');
        execFileSync(process.execPath, [join(packageDir(), 'cli', `index${SELF_EXT}`), ...args], {
            cwd,
            stdio: 'inherit',
        });
    }
    if (needsAntiSlopSync)
        syncAntiSlopCapability(cwd);
    if (needsOxcSync && !needsAntiSlopSync)
        syncOxcCapability(cwd, { antiSlop: sel.antiSlop === true });
    const skills = results.find((r) => r.name === 'skills');
    if (skills?.fixable && skills.status !== 'OK') {
        execFileSync(process.execPath, [join(packageDir(), 'cli', `index${SELF_EXT}`), 'sync-skills'], {
            cwd,
            stdio: 'inherit',
        });
    }
    const agents = results.find((r) => r.name === 'agents');
    if (agents?.fixable && agents.status !== 'OK') {
        execFileSync(process.execPath, [join(packageDir(), 'cli', `index${SELF_EXT}`), 'sync-agents'], {
            cwd,
            stdio: 'inherit',
        });
    }
    // Baselines are cut at init; an explicit re-cut uses `guard-* freeze`, never doctor.
}
/**
 * qavis-advisory health — ADVISORY, printed by every doctor mode, never a CheckResult and never a
 * `--fix` target. Deliberately outside the exit code: a repo that keeps the guard selected but has
 * no qavis installed is a choice, not drift.
 *
 * What it catches is the gate's one blind spot: it fails OPEN when qavis can't be reached, so a
 * missing binary looks exactly like a healthy "nothing to QA" at commit time. Resolved against the
 * git ROOT because that's the cwd the husky fragment shells the gate from — doctor should report
 * what the hook would actually see, not what this cwd sees.
 */
export function printQavisAdvisoryHealth(cwd, guards) {
    if (!guards.includes(QAVIS_ADVISORY_ID))
        return;
    const { gitRoot } = detectGitRoot(cwd);
    if (!existsSync(join(gitRoot, QAVIS_RECIPE))) {
        console.log(`  · ${QAVIS_ADVISORY_ID}: no ${QAVIS_RECIPE} — gate inert (nothing to QA)`);
    }
    else if (!qavisOnPath()) {
        console.log(`  · ${QAVIS_ADVISORY_ID}: ${QAVIS_RECIPE} present but qavis is NOT on PATH — the QA advisory is skipped on every commit (install qavis, or drop the guard)`);
    }
    else {
        console.log(`  ✓ ${QAVIS_ADVISORY_ID}: qavis on PATH (${QAVIS_RECIPE} present)`);
    }
}
// The default component selection (pre-`components`-block configs, and the all-on fallback).
const DEFAULT_DOCTOR_SEL = {
    biome: true,
    tsconfig: true,
    skills: true,
    husky: true,
    structure: false,
    guards: [...RECOMMENDED_GUARD_IDS],
};
// Self-host (the devkit repo dogfooding itself) doctor: the ONE health signal is whether the
// committed source hook still matches what the CURRENT generator produces — a mismatch means the
// generator changed without a regen, or the hook was hand-edited. `--fix` regenerates it. Skills/
// agents are advisory (a re-sync heals them). Pin/extends/structure/version checks don't apply —
// the configs are hand-owned local files, not `@norvalbv/devkit/*` extends, and there is no dep.
/** Build package/standalone checks from the recorded selection. */
// Reason: flat dispatch: one `if (selected) push(check())` per component; the branch COUNT is high but each is trivial and nesting is zero. Splitting obscures the check list.
// fallow-ignore-next-line complexity
async function collectResults(cwd, cfg, configResult) {
    // Selection-aware: only check the components actually installed (fresh init always records it).
    const recorded = cfg.components ?? DEFAULT_DOCTOR_SEL;
    const { gitRoot } = detectGitRoot(cwd);
    const surfaces = resolveExistingAgentProviders(gitRoot, recorded.agentTargets);
    const sel = { ...recorded, agentTargets: surfaces };
    // Standalone (no-package): biome/tsconfig extend VENDORED relative paths, and there is no devkit
    // pin to check (the whole point — no package dep).
    const standalone = Boolean(cfg.standalone);
    const stack = cfg.stack ?? 'generic';
    const expected = expectedExtends(stack, standalone);
    // Emitted configs the consumer has intentionally hand-owned — doctor treats their extends as OK.
    const overrides = new Set(cfg.configOverrides ?? []);
    const results = [configResult];
    if (sel.husky)
        results.push(...hookChecks(cwd, sel.guards ?? []));
    if (sel.husky && commitMsgGuards(sel.guards ?? []).length)
        results.push(checkCommitMsgHook(cwd, sel.guards ?? []));
    // biome and tsconfig differ only by filename and expected pointer.
    for (const [on, file, want] of [
        [sel.biome, 'biome.jsonc', expected.biome],
        [sel.tsconfig, 'tsconfig.json', expected.tsconfig],
    ])
        if (on)
            results.push(checkExtends(cwd, file, want, 'extends', overrides.has(file)));
    if (sel.guards?.length || sel.structure)
        results.push(...(await checkGuardConfig(cwd, sel.guards?.includes('dup') === true, sel.searchCode === true)));
    if (sel.structure && sel.husky)
        results.push(checkStructureLint(cwd, stack));
    const hooks = selectedHookAssets(sel);
    if (sel.skills && surfaces.length)
        results.push(checkAgentAssets(cwd, 'skills', surfaces, sel));
    if (sel.agents && surfaces.length)
        results.push(checkAgentAssets(cwd, 'agents', surfaces));
    if (hooks.scripts.length && surfaces.length)
        results.push(checkAgentAssets(cwd, 'hooks', surfaces, { expected: hooks.scripts }));
    if (sel.adhd)
        results.push(checkAdhdSkill(cwd));
    if (sel.searchSteering)
        results.push(checkSearchToolBins());
    results.push(...checkOxcCapability(cwd));
    if (sel.antiSlop)
        results.push(...checkAntiSlopCapability(cwd));
    if (surfaces.length)
        results.push(checkRegistrations(cwd, hooks.components, surfaces));
    if (sel.guards?.includes('fanout') || sel.guards?.includes('size'))
        results.push(checkBaselines(cwd));
    // Two halves of the same signal: checkPin reads what package.json asks for, checkLockPin reads
    // what bun.lock recorded for it. The latter is null whenever there is nothing to verify, which is
    // what keeps doctor off the network for non-bun consumers.
    if (!standalone) {
        results.push(checkPin(cwd));
        const lock = checkLockPin(cwd);
        if (lock)
            results.push(lock);
    }
    results.push(checkVersion(cwd));
    return { results, sel };
}
// Reason: flat CLI orchestration: sequential not-initialized short-circuit, overlay short-circuit, collectResults, print loop, then fix-if-drift; near-zero nesting, each branch a single guarded step. High branch COUNT, each trivial; splitting fragments the command's top-level flow.
// fallow-ignore-next-line complexity
export const meta = {
    name: 'doctor',
    summary: 'Diagnose drift for the installed component set (read-only).',
    help: `devkit doctor — diagnose drift for the installed component set (read-only).

Usage:
  devkit doctor [--fix]

  --fix    Re-run init for the recorded selection (recreates MISSING pieces; never re-freezes a
           baseline). In an overlay repo, regenerates a stale/missing local gate hook (e.g. after
           \`devkit update\` shipped a new hook shape). Exit 0 all-ok, 1 drift, 2 not-initialized.

Also warns if the RUNNING devkit is older than this repo's init stamp or a hand-declared
"minDevkit":"x.y.z" floor in .devkit/config.json.

Runner skew: if the devkit you invoked is OLDER than the one this repo pins, doctor says so in every
mode and refuses to rewrite managed state (.devkit/oxc) in the older shape. With --fix it re-execs
the repo's own node_modules/.bin/devkit and returns that binary's exit code; when no pinned binary
resolves it writes nothing and prints the install command instead. DEVKIT_ALLOW_SKEWED_FIX=1 forces
the write anyway — it announces itself and is recorded in the managed manifest.`,
};
export default async function run(args, cwd) {
    const fix = args.includes('--fix');
    // Not-initialized short-circuit (exit 2).
    const configResult = checkConfig(cwd);
    if (configResult.status === 'MISSING') {
        console.log('devkit doctor\n');
        console.log(`  ✗ ${configResult.name}: ${configResult.detail} — ${configResult.remediation}`);
        console.log('  (was this an overlay repo? `devkit clean` removes any leftover local git config — core.hooksPath / the git ci alias.)');
        return 2;
    }
    const cfg = (readJson(join(cwd, '.devkit', 'config.json')) ?? {});
    // Ahead of every mode branch: an older devkit rewrites managed state in ITS shape, so the skew
    // has to be named — and handed off — in overlay and self-host too, not only package mode. The
    // remedy is a hand-off rather than a refusal because a command devkit prescribes must be one
    // devkit can perform (docs/decisions/overlay-self-heal.md, Target 2026-08-05).
    const skew = runnerSkew(cwd, cfg);
    const packageMode = !cfg.overlay && !cfg.selfHost;
    // The opt-out only means anything if it reaches the WRITER, so a forced run must fall through to
    // the normal repair rather than hand off — the pinned binary is not the one being forced.
    if (skew.kind === 'older' && !process.env[ALLOW_SKEW_ENV]) {
        // Package mode reports skew as a check row below, so the banner would say it twice; overlay and
        // self-host have no row, and --fix leads with it because it precedes the hand-off.
        if (fix || !packageMode)
            printSkewBanner(skew);
        if (fix) {
            // The pinned binary prints its own full diagnosis, so ours would only duplicate it.
            const delegated = delegateToPinned(skew, ['doctor', ...args], cwd);
            if (delegated !== null)
                return delegated;
            console.log(`\n  ✗ No pinned devkit to hand off to — nothing written. Run: ${skew.remediation}`);
            return 1;
        }
    }
    // `|| 1` on skew: drift is drift in every mode, so a skewed overlay/self-host doctor must not
    // report 0 where package mode reports 1 for the identical condition.
    const skewed = skew.kind === 'older';
    if (cfg.overlay)
        return (await runOverlayDoctor(cwd, cfg, fix, printQavisAdvisoryHealth)) || +skewed;
    if (cfg.selfHost)
        return (await runSelfHostDoctor(cwd, cfg, fix)) || +skewed;
    const { results, sel } = await collectResults(cwd, cfg, configResult);
    const skewRow = skewCheck(skew);
    if (skewRow)
        results.unshift(skewRow);
    console.log('devkit doctor\n');
    const glyph = { OK: '✓', DRIFT: '⚠', MISSING: '✗' };
    for (const r of results) {
        let line = `  ${glyph[r.status]} ${r.name}: ${r.status} — ${r.detail}`;
        if (r.status !== 'OK' && r.remediation)
            line += `\n      → ${r.remediation}`;
        console.log(line);
    }
    printQavisAdvisoryHealth(cwd, sel.guards ?? []);
    const drifted = results.some((r) => r.status !== 'OK' && !r.advisory); // see CheckResult.advisory
    if (fix && drifted) {
        applyFix(cwd, results, sel, cfg.stack ?? 'generic', Boolean(cfg.standalone));
        console.log('\n--fix applied. Re-run `devkit doctor` to confirm.');
    }
    if (!drifted) {
        console.log('\nAll checks OK.');
        return 0;
    }
    return 1;
}
export { collectResults, selectionFlags };
