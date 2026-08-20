#!/usr/bin/env node
// Structure-lint gate — folder-structure enforcement run entirely from DEVKIT's own install, so a
// consumer needs NO eslint / eslint-plugin-project-structure / parser in their package.json (the
// point of the zero-consumer-dependency model). `buildStructureConfigs(cwd)` reads the CONSUMER's
// guard.config.json `structure` block + baselines and returns a runnable eslint flat-config that
// embeds the plugin as a LOADED OBJECT — so ESLint never resolves the plugin from the consumer.
//
//   guard-structure gate     # lint all declared structure roots (CI/manual)
//   guard-structure staged   # lint only staged structure input (generated pre-commit hook)
//
// PARAMETERIZED (W-3): the trees / roots / grammar / baselines all come from resolveGuardConfig(cwd)
// — the consumer's guard.config.json under the consumer cwd, never the package dir. Grandfathering is
// NOT done here: the baselines are frozen by `devkit init` (runStructureBaselines), same as the
// ratchets. Config-driven only — buildStructureConfigs skips electron preset trees (no `grammar`).
//
// Exit contract (the shared gate trichotomy guard-deterministic applies): 0 clean, 1 violations,
// 2 fail-open (could-not-run).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ESLint } from 'eslint'; // devkit's OWN eslint (now a dependency), never the consumer's
import { resolveGuardConfig } from "../config.mjs";
import { gitPrefix, splitNul } from "../ratchets/git-index.mjs";
import { buildStructureConfigs } from "./eslint-config.mjs";
// ESLint throws "No files matching the pattern" for an absent tree and "…are ignored" when every file
// in a present tree is ignored — both mean "nothing to lint" (clean), not a failure. Hoisted (perf).
const NOTHING_TO_LINT_RE = /No files matching|are ignored/i;
const ELECTRON_SOURCE_EXTENSIONS = ['ts', 'tsx', 'css'];
const POLICY_PATH_RE = /^(?:eslint\.config\.mjs|guard\.config\.json|eslint\/(?:domains\.mjs|baselines\/))/;
function pathInRoot(file, root) {
    const cleanRoot = root.replace(/\/+$/, '');
    if (cleanRoot === '.')
        return true;
    return Boolean(cleanRoot) && (file === cleanRoot || file.startsWith(`${cleanRoot}/`));
}
function pathInScope(file, scope) {
    return pathInRoot(file, scope.root) && scope.extensions.includes(extname(file).slice(1));
}
function isPolicyPath(file) {
    return POLICY_PATH_RE.test(file);
}
function unique(paths) {
    return [...new Set(paths)];
}
export function planStagedStructureLint(scopes, changed, destructive, unstaged) {
    const unstablePolicy = unstaged.some(isPolicyPath);
    const stagedPolicy = changed.some(isPolicyPath);
    const deferred = [];
    const probeScopes = new Map();
    const unstableScopes = new Set(scopes
        .filter((scope) => unstaged.some((file) => pathInScope(file, scope)))
        .map((scope) => scope.root));
    for (const scope of scopes) {
        const hasDestructiveChange = destructive.some((file) => pathInScope(file, scope));
        const hasRelevantInput = stagedPolicy || hasDestructiveChange || changed.some((file) => pathInScope(file, scope));
        if (!hasRelevantInput)
            continue;
        if (unstablePolicy || unstableScopes.has(scope.root)) {
            if (unstablePolicy)
                deferred.push('structure policy');
            if (hasDestructiveChange)
                deferred.push(scope.root);
            continue;
        }
        if (stagedPolicy || hasDestructiveChange)
            probeScopes.set(scope.root, scope);
    }
    const targets = [];
    for (const file of changed) {
        const scope = scopes.find((candidate) => pathInScope(file, candidate));
        if (!scope)
            continue;
        if (unstablePolicy || unstableScopes.has(scope.root)) {
            deferred.push(file);
            continue;
        }
        targets.push(file);
    }
    return {
        targets: unique(targets),
        probeScopes: [...probeScopes.values()],
        deferred: unique(deferred),
    };
}
function gitPaths(cwd, args) {
    return splitNul(execFileSync('git', args, { cwd, encoding: 'buffer' }).toString());
}
function untrackedPaths(cwd) {
    return gitPaths(cwd, ['ls-files', '--full-name', '--others', '--exclude-standard', '-z']);
}
function destructivePaths(cwd) {
    const fields = splitNul(execFileSync('git', ['diff', '--cached', '--name-status', '-z', '--diff-filter=DR'], {
        cwd,
        encoding: 'buffer',
    }).toString());
    const paths = [];
    for (let index = 0; index < fields.length;) {
        const status = fields[index++] ?? '';
        if (status.startsWith('R')) {
            paths.push(fields[index++] ?? '', fields[index++] ?? '');
        }
        else if (status.startsWith('D')) {
            paths.push(fields[index++] ?? '');
        }
    }
    return paths.filter(Boolean);
}
function toCwdPaths(paths, prefix) {
    if (!prefix)
        return paths;
    return paths.filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length));
}
function stagedScopes(cwd) {
    const cfg = resolveGuardConfig(cwd);
    const trees = cfg.structure?.trees ?? [];
    const configScopes = trees
        .filter((tree) => Boolean(tree.root))
        .map((tree) => ({
        root: tree.root,
        extensions: tree.sourceExtensions?.length ? tree.sourceExtensions : cfg.sourceExtensions,
    }));
    return configScopes.length
        ? configScopes
        : cfg.scanRoots.map((root) => ({ root, extensions: ELECTRON_SOURCE_EXTENSIONS }));
}
function firstProbeFile(cwd, scope, excluded) {
    const pending = [scope.root];
    while (pending.length) {
        const dir = pending.pop();
        let entries;
        try {
            entries = readdirSync(join(cwd, dir), { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const relative = `${dir}/${entry.name}`;
            if (entry.isDirectory())
                pending.push(relative);
            else if (entry.isFile() && pathInScope(relative, scope) && !excluded.has(relative)) {
                return relative;
            }
        }
    }
    return null;
}
export async function runStagedStructureGate(cwd = process.cwd()) {
    try {
        const prefix = gitPrefix(cwd);
        const changed = toCwdPaths(gitPaths(cwd, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']), prefix);
        // Name-status preserves both sides of a rename, unlike name-only. Either side can remove a
        // required sibling, so either must probe its containing structure root.
        const destructive = toCwdPaths(destructivePaths(cwd), prefix);
        // Untracked sources also change the tree observed by a topology parser, so they carry the
        // same deferral rule as tracked working-tree edits.
        const unstaged = unique(toCwdPaths([...gitPaths(cwd, ['diff', '--name-only', '-z']), ...untrackedPaths(cwd)], prefix));
        const plan = planStagedStructureLint(stagedScopes(cwd), changed, destructive, unstaged);
        if (plan.deferred.length) {
            console.error(`⚠️  Structure lint deferred mixed staged/unstaged input to CI: ${plan.deferred.join(', ')}`);
        }
        // A probe also reads worktree bytes. Do not select a dirty source as the representative file
        // for a deletion/rename check; its result would not describe the staged tree either.
        const unstableSources = new Set(unstaged);
        const probeTargets = plan.probeScopes
            .map((scope) => firstProbeFile(cwd, scope, unstableSources))
            .filter((target) => target !== null);
        const unprobedRoots = plan.probeScopes
            .filter((scope) => !probeTargets.some((target) => pathInScope(target, scope)))
            .map((scope) => scope.root);
        if (unprobedRoots.length) {
            console.error(`⚠️  Structure deletion probe deferred to CI (no remaining source file): ${unprobedRoots.join(', ')}`);
        }
        if (!plan.targets.length && !probeTargets.length)
            return { code: 0, errorCount: 0 };
        const cfg = resolveGuardConfig(cwd);
        const trees = cfg.structure?.trees ?? [];
        const configDriven = trees.some((tree) => Boolean(tree.grammar));
        if (configDriven)
            return runStructureGate(cwd, unique([...plan.targets, ...probeTargets]));
        const eslintBin = join(cwd, 'node_modules', 'eslint', 'bin', 'eslint.js');
        if (!existsSync(eslintBin)) {
            return {
                code: 1,
                errorCount: 0,
                text: 'guard-structure: electron structure lint needs the locally pinned eslint binary',
            };
        }
        try {
            execFileSync(process.execPath, ['--preserve-symlinks', eslintBin, '--', ...unique([...plan.targets, ...probeTargets])], { cwd, stdio: 'inherit' });
            return { code: 0, errorCount: 0 };
        }
        catch {
            return { code: 1, errorCount: 0, text: 'guard-structure: local eslint failed' };
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { code: 2, errorCount: 0, text: `guard-structure: ${message}` };
    }
}
/**
 * Run the folder-structure gate over a repo's declared structure roots. `cwd` is the consumer root
 * (holds guard.config.json + eslint/baselines/). Result code: 0 = clean / nothing to lint,
 * 1 = violations, 2 = fail-open (internal error).
 */
export async function runStructureGate(cwd = process.cwd(), targets) {
    try {
        const cfg = resolveGuardConfig(cwd);
        // Lint only roots that EXIST on disk (an absent root has nothing to enforce yet).
        const trees = cfg.structure?.trees ?? [];
        const roots = (targets ??
            trees.map((t) => t.root).filter((r) => (r ? existsSync(join(cwd, r)) : false))).filter((target) => existsSync(join(cwd, target)));
        // Nothing declared / nothing present (generic guard.config, electron-only preset, empty tree).
        if (!roots.length)
            return { code: 0, errorCount: 0 };
        const baseConfig = await buildStructureConfigs(cwd);
        if (!baseConfig.length)
            return { code: 0, errorCount: 0 }; // no grammar trees (preset-only)
        const eslint = new ESLint({ cwd, overrideConfigFile: true, baseConfig });
        // Lint each root INDEPENDENTLY. ESLint 10's lintFiles fail-fasts on the FIRST unmatched/all-ignored
        // pattern, so a single ignored/empty root in a batched `lintFiles(roots)` would throw and mask a
        // violation in a sibling root. Per-root: a root that's all-ignored / matches nothing is that root's
        // own "clean" (skip it), while other roots still get enforced.
        const allResults = [];
        for (const root of roots) {
            try {
                allResults.push(...(await eslint.lintFiles([root])));
            }
            catch (e) {
                // Nothing-to-lint for THIS root → clean; any other throw is a real failure → fail-open below.
                const message = e instanceof Error ? e.message : '';
                if (NOTHING_TO_LINT_RE.test(message))
                    continue;
                throw e;
            }
        }
        const errorCount = allResults.reduce((n, r) => n + r.errorCount, 0);
        if (errorCount === 0)
            return { code: 0, errorCount: 0 };
        const text = await (await eslint.loadFormatter('stylish')).format(allResults);
        return { code: 1, errorCount, text };
    }
    catch (e) {
        // Fail OPEN (exit 2), like the ratchet gates when their baseline is missing — a structure gate
        // that can't run must never wedge a commit. guard-deterministic treats 2 as fail-open (continue).
        const message = e instanceof Error ? e.message : String(e);
        return { code: 2, errorCount: 0, text: `guard-structure: ${message}` };
    }
}
export async function runCli(cmd = 'gate') {
    if (cmd !== 'gate' && cmd !== 'staged') {
        console.error('usage: guard-structure <gate|staged>');
        process.exit(2);
    }
    const { code, text } = cmd === 'staged'
        ? await runStagedStructureGate(process.cwd())
        : await runStructureGate(process.cwd());
    if (code === 1) {
        if (text)
            console.error(text);
        console.error('🚫 Structure violations (folder-structure). Rename/relocate the file(s) to match the declared grammar, or (if intentional) re-grandfather via `devkit init`.');
    }
    else if (code === 2 && text) {
        console.error(text); // fail-open notice on stderr; still exits 2 (pass)
    }
    process.exit(code);
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    runCli(process.argv[2]);
}
