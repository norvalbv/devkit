/**
 * Emitted-config reconcile logic — bring a consumer's EMITTED files up to the INSTALLED devkit's
 * shape. `devkit update` bumps the dep, but the files devkit emitted at init time are SNAPSHOTS that
 * don't move with the package; this reconciles them:
 *   - devkit-OWNED files (eslint.config.mjs — the generated shim / preset) are REPLACED when they drift.
 *   - YOUR data (guard.config.json) is MERGED: missing keys (e.g. the `structure` block) are added;
 *     your existing values are NEVER clobbered. NOTE: the `maxLines` line-growth cap is deliberately
 *     NOT template-merged — enabling it must grandfather current giants (a freeze), so it's offered by
 *     `devkit upgrade` (which freezes in the same step), never silently added here.
 *   - biome.jsonc / tsconfig.json need nothing — they `extends` the package, so they already track it.
 *
 * This was the `devkit migrate` command; the standalone verb was removed (a half-command that never
 * refreshed husky). `devkit upgrade` is the single entry point and calls computeMigration here.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageDir, readJson } from '../lib/fs-helpers.mjs';
// The current eslint.config source for a stack (mirrors init's STRUCTURE_TEMPLATE_FILES): every
// structure stack EXCEPT electron uses the shared universal shim; electron keeps its preset.
function eslintSrc(stack) {
    const tpl = join(packageDir(), 'templates');
    return stack === 'electron'
        ? join(tpl, 'electron', 'eslint.config.mjs')
        : join(tpl, '_shared', 'eslint.config.mjs');
}
// eslint.config.mjs is devkit-OWNED → replace when it drifts from the current shim/preset.
function eslintChange(cwd, stack) {
    const src = eslintSrc(stack);
    if (!existsSync(src))
        return null;
    const want = readFileSync(src, 'utf8');
    const dest = join(cwd, 'eslint.config.mjs');
    const have = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
    if (have === want)
        return null;
    return {
        file: 'eslint.config.mjs',
        kind: have === null ? 'create' : 'replace',
        why: stack === 'electron'
            ? 'electron preset (devkit-owned, regenerated)'
            : 'the universal shim (devkit-owned; imports the engine, so it auto-tracks future updates)',
        write: () => writeFileSync(dest, want),
    };
}
// guard.config.json is YOUR data → only ADD missing top-level keys from the stack template (+ their
// //-comment siblings); never overwrite an existing value.
function guardConfigChange(cwd, stack) {
    const dest = join(cwd, 'guard.config.json');
    const tpl = readJson(join(packageDir(), 'templates', stack, 'guard.config.json'));
    if (!existsSync(dest) || !tpl)
        return null;
    // guard.config.json is external data: a JSON object of arbitrary top-level keys.
    const have = JSON.parse(readFileSync(dest, 'utf8'));
    const missing = Object.keys(tpl).filter((k) => !k.startsWith('//') && !(k in have));
    if (!missing.length)
        return null;
    return {
        file: 'guard.config.json',
        kind: 'merge',
        why: `add missing key(s): ${missing.join(', ')} (existing values preserved)`,
        write: () => {
            const merged = { ...have };
            for (const k of missing) {
                if (tpl[`//${k}`] !== undefined)
                    merged[`//${k}`] = tpl[`//${k}`];
                merged[k] = tpl[k];
            }
            writeFileSync(dest, `${JSON.stringify(merged, null, 2)}\n`);
        },
    };
}
/** Compute the migration plan (the changes the installed devkit would make). */
export function computeMigration(cwd, stack) {
    return [eslintChange(cwd, stack), guardConfigChange(cwd, stack)].filter((c) => c !== null);
}
