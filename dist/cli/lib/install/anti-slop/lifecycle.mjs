/** Install, verify, and remove Devkit's pinned self-contained anti-slop plugin. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { withLock, writeFileAtomic } from '../../atomic-write.mjs';
import { check } from '../../doctor/check-result.mjs';
import { packageDir } from '../../fs-helpers.mjs';
import { assertOxcCapabilityReady, oxcBaseCapabilityIssue, syncOxcCapability, } from '../oxc/lifecycle.mjs';
import { resolveOxcRuntime } from '../oxc/runtime.mjs';
import { ANTI_SLOP_BASELINE_MODE, ANTI_SLOP_CONFIG_REL, ANTI_SLOP_EXECUTION_MODE_ENV, ANTI_SLOP_LOCK_REL, ANTI_SLOP_MANAGED_REL, ANTI_SLOP_MANIFEST_REL, ANTI_SLOP_PLUGIN_API_VERSION, ANTI_SLOP_RULE_IDS, ANTI_SLOP_UPSTREAM, renderAntiSlopConfig, } from './constants.mjs';
import { installExecutionModeWrapper } from './execution-mode.mjs';
const PROBE_REL = `${ANTI_SLOP_MANAGED_REL}/probe.ts`;
const PROBE_RULE = 'anti-slop/no-object-parameters';
const PROBE_RULE_CODE = 'anti-slop(no-object-parameters)';
const BASE_PROBE_CODE = 'eslint(no-undef)';
const BASE_PROBE_GLOBAL = '__DEVKIT_OXC_BASE_1_78_0_MANAGED_PROBE__';
const PROBE_SOURCE = `function devkitManagedProbe(value: object) { void ${BASE_PROBE_GLOBAL}; return value; }\n`;
const PROBE_CONFIG_SOURCE = `${JSON.stringify({ extends: ['../oxc/oxlint.base.json'], rules: { [PROBE_RULE]: 'off' } }, null, 2)}\n`;
const PROBE_MAX_OUTPUT = 2 * 1024 * 1024;
const PLUGIN_MODULE = /\.(?:m?js|ts)$/u;
const digest = (content) => createHash('sha256').update(content).digest('hex');
function treeDigest(root) {
    const hash = createHash('sha256');
    const files = readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name))
        .sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
    for (const file of files) {
        hash.update(relative(root, file).split('\\').join('/'));
        hash.update('\0');
        hash.update(readFileSync(file));
        hash.update('\0');
    }
    return hash.digest('hex');
}
function pluginSource() {
    const root = join(packageDir(), 'anti-slop', 'src');
    if (existsSync(join(root, 'index.mjs')))
        return { root, entry: './plugin/index.mjs' };
    if (existsSync(join(root, 'index.js')))
        return { root, entry: './plugin/index.js' };
    if (existsSync(join(root, 'index.ts')))
        return { root, entry: './plugin/index.ts' };
    throw new Error('bundled anti-slop plugin entry is missing');
}
function pluginApiSource() {
    const entry = createRequire(import.meta.url).resolve('@oxlint/plugins');
    const manifest = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8'));
    if (manifest.version !== ANTI_SLOP_PLUGIN_API_VERSION) {
        throw new Error(`@oxlint/plugins ${manifest.version ?? 'unknown'} != pinned ${ANTI_SLOP_PLUGIN_API_VERSION}`);
    }
    return dirname(entry);
}
function makePluginApiTrackable(plugin, apiSource) {
    const files = readdirSync(plugin, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && PLUGIN_MODULE.test(entry.name));
    for (const entry of files) {
        const path = join(entry.parentPath, entry.name);
        const source = readFileSync(path, 'utf8');
        const rewritten = source.replaceAll('@oxlint/plugins', '#oxlint-plugins');
        if (rewritten !== source)
            writeFileAtomic(path, rewritten);
    }
    writeFileAtomic(join(plugin, 'package.json'), `${JSON.stringify({
        private: true,
        type: 'module',
        imports: { '#oxlint-plugins': './oxlint-plugins-api/index.js' },
    }, null, 2)}\n`);
    cpSync(apiSource, join(plugin, 'oxlint-plugins-api'), { recursive: true });
}
function readManifest(cwd) {
    const path = join(cwd, ANTI_SLOP_MANIFEST_REL);
    if (!existsSync(path))
        return null;
    try {
        const value = JSON.parse(readFileSync(path, 'utf8'));
        return value.schemaVersion === 1 &&
            value.upstreamCommit === ANTI_SLOP_UPSTREAM &&
            value.pluginApiVersion === ANTI_SLOP_PLUGIN_API_VERSION &&
            Array.isArray(value.ruleIds) &&
            value.ruleIds.every((id) => typeof id === 'string') &&
            typeof value.pluginDigest === 'string' &&
            typeof value.configDigest === 'string' &&
            typeof value.probeDigest === 'string' &&
            typeof value.probeConfigDigest === 'string'
            ? value
            : null;
    }
    catch {
        return null;
    }
}
/** Explain why an explicit request cannot activate in a non-repository mode. */
export function warnIfAntiSlopUnavailable(mode, requested) {
    if (!requested || mode !== 'overlay')
        return;
    console.warn(`devkit init --${mode}: --anti-slop is unavailable because it requires the tracked Oxc capability; skipping it.`);
}
function syncUnlocked(cwd, dryRun) {
    const source = pluginSource();
    const apiSource = pluginApiSource();
    const config = renderAntiSlopConfig(source.entry);
    if (dryRun) {
        console.log(`  [dry-run] sync ${ANTI_SLOP_MANAGED_REL}/ (15 rules; upstream ${ANTI_SLOP_UPSTREAM.slice(0, 12)})`);
        return null;
    }
    const managed = join(cwd, ANTI_SLOP_MANAGED_REL);
    const staging = `${managed}.staging-${process.pid}`;
    const previous = `${managed}.previous`;
    rmSync(staging, { recursive: true, force: true });
    if (!existsSync(managed) && existsSync(previous))
        renameSync(previous, managed);
    else
        rmSync(previous, { recursive: true, force: true });
    let movedPrevious = false;
    try {
        const plugin = join(staging, 'plugin');
        mkdirSync(plugin, { recursive: true });
        cpSync(source.root, plugin, { recursive: true });
        installExecutionModeWrapper(plugin, source.entry);
        makePluginApiTrackable(plugin, apiSource);
        cpSync(join(packageDir(), 'anti-slop', 'LICENSE'), join(staging, 'LICENSE'));
        writeFileAtomic(join(staging, 'oxlint.json'), config);
        writeFileAtomic(join(staging, 'probe.ts'), PROBE_SOURCE);
        writeFileAtomic(join(staging, '.oxlintrc.json'), PROBE_CONFIG_SOURCE);
        const manifest = {
            schemaVersion: 1,
            upstreamCommit: ANTI_SLOP_UPSTREAM,
            pluginApiVersion: ANTI_SLOP_PLUGIN_API_VERSION,
            ruleIds: [...ANTI_SLOP_RULE_IDS],
            pluginDigest: treeDigest(plugin),
            configDigest: digest(config),
            probeDigest: digest(PROBE_SOURCE),
            probeConfigDigest: digest(PROBE_CONFIG_SOURCE),
        };
        writeFileAtomic(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
        if (existsSync(managed)) {
            renameSync(managed, previous);
            movedPrevious = true;
        }
        renameSync(staging, managed);
        return {
            manifest,
            commit: () => rmSync(previous, { recursive: true, force: true }),
            rollback: () => {
                rmSync(managed, { recursive: true, force: true });
                if (movedPrevious && existsSync(previous))
                    renameSync(previous, managed);
            },
        };
    }
    catch (error) {
        rmSync(staging, { recursive: true, force: true });
        if (movedPrevious && !existsSync(managed) && existsSync(previous))
            renameSync(previous, managed);
        throw error;
    }
}
/** Install/upgrade the managed plugin without fetching or changing a consumer dependency stack. */
export function syncAntiSlopCapability(cwd, { dryRun = false } = {}) {
    if (dryRun) {
        assertOxcCapabilityReady(cwd);
        syncUnlocked(cwd, true);
        syncOxcCapability(cwd, { dryRun: true, antiSlop: true });
        return;
    }
    mkdirSync(join(cwd, '.devkit'), { recursive: true });
    withLock(join(cwd, ANTI_SLOP_LOCK_REL), () => {
        assertOxcCapabilityReady(cwd);
        const replacement = syncUnlocked(cwd, false);
        if (!replacement)
            throw new Error('anti-slop managed replacement was not prepared');
        try {
            syncOxcCapability(cwd, { antiSlop: true });
            replacement.commit();
            console.log(`  ✓ anti-slop: ${replacement.manifest.ruleIds.length} rules @ ${replacement.manifest.upstreamCommit.slice(0, 12)}`);
        }
        catch (error) {
            replacement.rollback();
            try {
                syncOxcCapability(cwd, {
                    antiSlop: existsSync(join(cwd, ANTI_SLOP_MANIFEST_REL)) &&
                        existsSync(join(cwd, ANTI_SLOP_CONFIG_REL)),
                });
            }
            catch {
                // Preserve the original sync failure; doctor can repair any residual managed Oxc drift.
            }
            throw error;
        }
    });
}
/** Serialize readers with managed-tree replacement; callers keep the lock through their Oxc run. */
export function withAntiSlopCapabilityLock(cwd, action) {
    return withLock(join(cwd, ANTI_SLOP_LOCK_REL), action);
}
function probeIntegration(cwd) {
    let runtime;
    try {
        runtime = resolveOxcRuntime('lint');
    }
    catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
    const probeRoot = mkdtempSync(join(tmpdir(), 'devkit-anti-slop-probe-'));
    const probePath = join(probeRoot, 'devkit-anti-slop-integration-probe.ts');
    let result;
    try {
        writeFileAtomic(probePath, PROBE_SOURCE);
        result = spawnSync(process.execPath, [
            runtime.binPath,
            '--format',
            'json',
            '--no-ignore',
            '--disable-nested-config',
            '--deny',
            PROBE_RULE,
            '--deny',
            'no-undef',
            probePath,
        ], {
            cwd,
            encoding: 'utf8',
            env: { ...process.env, [ANTI_SLOP_EXECUTION_MODE_ENV]: ANTI_SLOP_BASELINE_MODE },
            maxBuffer: PROBE_MAX_OUTPUT,
            timeout: 10_000,
        });
    }
    finally {
        rmSync(probeRoot, { recursive: true, force: true });
    }
    if (result.status === null) {
        return {
            ok: false,
            detail: result.error?.message ??
                (result.signal ? `probe terminated by ${result.signal}` : 'probe failed'),
        };
    }
    if (result.status !== 0 && result.status !== 1) {
        return {
            ok: false,
            detail: `integration probe rejected the managed rule: ${result.stderr.trim().split('\n')[0] || `Oxlint exit ${result.status}`}`,
        };
    }
    try {
        const payload = JSON.parse(result.stdout);
        const codes = new Set(payload.diagnostics?.map((diagnostic) => diagnostic.code));
        if (codes.has(BASE_PROBE_CODE)) {
            return {
                ok: false,
                detail: 'consumer config does not load the managed Oxlint base',
            };
        }
        if (!codes.has(PROBE_RULE_CODE)) {
            return {
                ok: false,
                detail: `consumer config does not register the managed ${PROBE_RULE} rule`,
            };
        }
        return {
            ok: true,
            detail: `consumer config loads the managed base and registers ${PROBE_RULE}`,
        };
    }
    catch (error) {
        return {
            ok: false,
            detail: `integration probe returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
function capabilityHealth(cwd) {
    const manifest = readManifest(cwd);
    if (!manifest) {
        return {
            manifest: null,
            rulesComplete: false,
            bytesOk: false,
            baseIntegrated: false,
            baseDetail: 'managed Oxc manifest is missing or invalid',
            runtimeIntegrated: false,
            runtimeDetail: 'managed manifest is missing or invalid',
        };
    }
    const plugin = join(cwd, ANTI_SLOP_MANAGED_REL, 'plugin');
    const config = join(cwd, ANTI_SLOP_CONFIG_REL);
    const probe = join(cwd, PROBE_REL);
    const probeConfig = join(cwd, ANTI_SLOP_MANAGED_REL, '.oxlintrc.json');
    const rulesComplete = manifest.ruleIds.length === ANTI_SLOP_RULE_IDS.length &&
        ANTI_SLOP_RULE_IDS.every((id) => manifest.ruleIds.includes(id));
    const bytesOk = existsSync(plugin) &&
        existsSync(config) &&
        existsSync(probe) &&
        existsSync(probeConfig) &&
        treeDigest(plugin) === manifest.pluginDigest &&
        digest(readFileSync(config)) === manifest.configDigest &&
        digest(readFileSync(probe)) === manifest.probeDigest &&
        digest(readFileSync(probeConfig)) === manifest.probeConfigDigest;
    const baseIssue = oxcBaseCapabilityIssue(cwd);
    const baseIntegrated = baseIssue === null;
    const runtime = rulesComplete && bytesOk && baseIntegrated
        ? probeIntegration(cwd)
        : {
            ok: false,
            detail: !rulesComplete || !bytesOk
                ? 'managed rule/plugin integrity failed before runtime probe'
                : (baseIssue ?? 'managed Oxlint base integration failed'),
        };
    return {
        manifest,
        rulesComplete,
        bytesOk,
        baseIntegrated,
        baseDetail: baseIssue ?? 'managed Oxlint base is current',
        runtimeIntegrated: runtime.ok,
        runtimeDetail: runtime.detail,
    };
}
/** Return why baseline operations must fail closed, or null when the full runtime chain is proved. */
export function antiSlopCapabilityIssue(cwd) {
    const health = capabilityHealth(cwd);
    if (!health.manifest)
        return 'managed manifest is missing or invalid';
    if (!health.rulesComplete)
        return 'managed rule registry is incomplete';
    if (!health.bytesOk)
        return 'managed plugin/config/probe bytes changed';
    if (!health.baseIntegrated)
        return health.baseDetail;
    return health.runtimeIntegrated ? null : health.runtimeDetail;
}
/** Check provenance, all managed bytes, rule completeness, and Oxc config integration. */
export function checkAntiSlopCapability(cwd) {
    if (!existsSync(join(cwd, '.devkit'))) {
        return [
            check('anti-slop manifest', 'MISSING', ANTI_SLOP_MANIFEST_REL, 'run `devkit doctor --fix`', true),
        ];
    }
    return withAntiSlopCapabilityLock(cwd, () => checkAntiSlopCapabilityUnlocked(cwd));
}
function checkAntiSlopCapabilityUnlocked(cwd) {
    const health = capabilityHealth(cwd);
    const manifest = health.manifest;
    if (!manifest) {
        return [
            check('anti-slop manifest', 'MISSING', ANTI_SLOP_MANIFEST_REL, 'run `devkit doctor --fix`', true),
        ];
    }
    return [
        health.rulesComplete
            ? check('anti-slop rules', 'OK', `${manifest.ruleIds.length} namespaced rules @ ${manifest.upstreamCommit.slice(0, 12)}`)
            : check('anti-slop rules', 'DRIFT', 'managed rule registry is incomplete', 'run `devkit doctor --fix`', true),
        health.bytesOk
            ? check('anti-slop plugin', 'OK', `self-contained @oxlint/plugins@${manifest.pluginApiVersion}`)
            : check('anti-slop plugin', 'DRIFT', 'managed plugin/config bytes changed', 'run `devkit doctor --fix`', true),
        health.runtimeIntegrated
            ? check('anti-slop Oxc integration', 'OK', health.runtimeDetail)
            : check('anti-slop Oxc integration', 'DRIFT', health.runtimeDetail, 'add "./.devkit/oxc/oxlint.base.json" to the consumer config extends array'),
    ];
}
/** Remove only managed plugin bytes. The repository baseline is consumer debt data and is kept. */
export function removeAntiSlopCapability(cwd, dryRun = false) {
    const managed = join(cwd, ANTI_SLOP_MANAGED_REL);
    if (!existsSync(managed))
        return;
    if (dryRun) {
        console.log(`  [dry-run] remove ${ANTI_SLOP_MANAGED_REL}/ (keep baseline)`);
        return;
    }
    withLock(join(cwd, ANTI_SLOP_LOCK_REL), () => {
        if (existsSync(join(cwd, '.devkit', 'oxc')))
            syncOxcCapability(cwd, { antiSlop: false });
        rmSync(managed, { recursive: true, force: true });
    });
    console.log(`  ✓ removed ${ANTI_SLOP_MANAGED_REL}/ (kept baseline)`);
}
