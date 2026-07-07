/**
 * devkit migrate — bring a consumer's EMITTED files up to the INSTALLED devkit's shape.
 *
 *   devkit migrate            # DRY-RUN: show exactly what differs + what each change is (default)
 *   devkit migrate --apply    # write the changes
 *
 * `devkit --update` bumps the dep, but the files devkit emitted at init time are SNAPSHOTS — they
 * don't move with the package. This reconciles them, transparently:
 *   - devkit-OWNED files (eslint.config.mjs — the generated shim / preset) are REPLACED when they drift.
 *   - YOUR data (guard.config.json) is MERGED: missing keys (e.g. the `structure` block, `maxLines`)
 *     are added; your existing values are NEVER clobbered.
 *   - biome.jsonc / tsconfig.json need nothing — they `extends` the package, so they already track it.
 *   - the .husky/pre-commit devkit-guards region is refreshed by `devkit init` (noted, not done here).
 *
 * Nothing is written without --apply. You SEE every change first. TypeScript source, shipped as prebuilt .mjs.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectStack } from "../lib/detect-stack.mjs";
import { packageDir, readJson } from "../lib/fs-helpers.mjs";
const STRUCTURE_STACKS = new Set(['electron', 'react-app', 'component-lib']);
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
export const meta = {
    name: 'migrate',
    summary: 'Reconcile your emitted files with the installed devkit.',
    help: `devkit migrate — after an update, reconcile your EMITTED files with the installed devkit.

Usage:
  devkit migrate [--apply]

DRY-RUN by default — shows every change (devkit-owned files like eslint.config.mjs replaced; your
guard.config.json values merged, never clobbered). --apply to write.`,
};
// Reason: flat CLI shell — stack guard, empty-plan early-out, the per-change report/apply loop, two
// trailing notes; near-zero nesting. The real logic (computeMigration + each *Change builder) is
// extracted and unit-tested (migrate.test.mjs); CRAP is the static estimate for this thin printer.
// fallow-ignore-next-line complexity
export default async function migrate(args, cwd) {
    const apply = args.includes('--apply');
    const cfg = readJson(join(cwd, '.devkit', 'config.json'));
    const stack = cfg?.stack ?? detectStack(cwd);
    if (!STRUCTURE_STACKS.has(stack)) {
        console.log(`devkit migrate: stack "${stack}" has no structure preset — nothing to migrate.`);
        return 0;
    }
    const changes = computeMigration(cwd, stack);
    if (!changes.length) {
        console.log('✓ devkit migrate: emitted files already match the installed devkit. Nothing to do.');
        console.log('  (biome.jsonc / tsconfig.json track the package via `extends` — never migrated.)');
        return 0;
    }
    console.log(`devkit migrate — ${changes.length} change(s) for stack "${stack}"${apply ? ':' : ' (DRY-RUN; pass --apply to write):'}\n`);
    for (const c of changes) {
        console.log(`  ${apply ? '✓' : '•'} ${c.file}  [${c.kind}]  — ${c.why}`);
        if (apply)
            c.write();
    }
    console.log(`\n  .husky/pre-commit: re-run \`devkit init --stack ${stack}\` to refresh the devkit-guards region (e.g. the structure-lint line).`);
    if (!apply)
        console.log('\n  Review above, then run: devkit migrate --apply');
    return 0;
}
