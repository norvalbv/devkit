/** Derive a consumer's `.oxfmtrc.json` from its Biome config, so Oxfmt writes the bytes Biome did. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { parseJsonc } from '../../husky/format-identity/jsonc.mjs';
import { resolveOxcRuntime } from './runtime.mjs';
/** What init wrote before configs were derived; an untouched copy is replaced by the derived one. */
export const LEGACY_OXFMT_STARTER = '{}\n';
const Setting = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);
const Settings = z.record(z.string(), Setting);
const Section = z.object({ formatter: Settings.optional() });
// Only the keys `oxfmt --migrate=biome` reads. Zod drops the rest (linter, assist, overrides — the
// last cannot be migrated and only ever carries lint settings in devkit's presets and templates).
const BiomeConfig = z.object({
    extends: z.union([z.string(), z.array(z.string())]).optional(),
    formatter: Settings.optional(),
    javascript: Section.optional(),
    json: Section.optional(),
    css: Section.optional(),
    files: z.object({ includes: z.array(z.string()).optional() }).optional(),
});
const Migrated = z.object({ ignorePatterns: z.array(z.string()).optional() }).catchall(Setting);
// Frozen from biome/base.jsonc (react.jsonc only adds lint rules), so a repo still extending the
// published presets migrates the same way after devkit stops shipping them.
const DEVKIT_FORMAT_PRESET = {
    formatter: {
        enabled: true,
        indentStyle: 'space',
        indentWidth: 2,
        lineEnding: 'lf',
        lineWidth: 100,
        attributePosition: 'auto',
        bracketSpacing: true,
    },
    javascript: {
        formatter: {
            arrowParentheses: 'always',
            bracketSameLine: false,
            bracketSpacing: true,
            jsxQuoteStyle: 'double',
            quoteProperties: 'asNeeded',
            quoteStyle: 'single',
            semicolons: 'always',
            attributePosition: 'auto',
        },
    },
    json: { formatter: { trailingCommas: 'none' } },
    css: { formatter: { quoteStyle: 'double' } },
};
const BIOME_CONFIGS = ['biome.json', 'biome.jsonc'];
const DEVKIT_PRESET_RE = /(?:^@norvalbv\/devkit\/biome\/|(?:^|\/)\.devkit\/biome\/)(?:base|react)(?:\.jsonc?)?$/;
const section = (base, over) => ({
    formatter: { ...base?.formatter, ...over?.formatter },
});
/** Later wins key by key, as Biome's `extends` does for the formatter settings migrate reads. */
function merge(base, over) {
    return {
        formatter: { ...base.formatter, ...over.formatter },
        javascript: section(base.javascript, over.javascript),
        json: section(base.json, over.json),
        css: section(base.css, over.css),
        files: over.files ?? base.files,
    };
}
/**
 * One Biome config with its `extends` chain applied; devkit's own presets resolve to the frozen copy.
 * `ancestors` is the current path only, so a file two parents share is applied by both, in order.
 */
function flatten(path, ancestors) {
    if (ancestors.has(path))
        return {};
    const parsed = BiomeConfig.safeParse(parseJsonc(readFileSync(path, 'utf8')));
    if (!parsed.success)
        throw new Error(`${path} is not a readable Biome config`);
    const { extends: parents = [], ...own } = parsed.data;
    const chain = new Set([...ancestors, path]);
    let flat = {};
    for (const parent of [parents].flat()) {
        const local = resolve(dirname(path), parent);
        if (DEVKIT_PRESET_RE.test(parent))
            flat = merge(flat, DEVKIT_FORMAT_PRESET);
        else if (existsSync(local))
            flat = merge(flat, flatten(local, chain));
        else
            console.warn(`  • oxfmt config: could not resolve Biome extends "${parent}"; skipped`);
    }
    return merge(flat, own);
}
function oxfmt(binPath, args, cwd) {
    const run = spawnSync(process.execPath, [binPath, ...args], { cwd, encoding: 'utf8' });
    return run.status === 0 ? null : (run.stderr || run.stdout || `exit ${run.status}`).trim();
}
/** Migrate one flattened config with the pinned Oxfmt, then format the result with itself. */
function migrateBiome(flat) {
    const dir = mkdtempSync(join(tmpdir(), 'devkit-oxfmt-derive-'));
    try {
        writeFileSync(join(dir, 'biome.json'), JSON.stringify(flat));
        const { binPath } = resolveOxcRuntime('fmt');
        const failed = oxfmt(binPath, ['--migrate=biome'], dir);
        const out = join(dir, '.oxfmtrc.json');
        // `--migrate` exits 0 even when it found nothing, so the written file is the only real signal.
        const migrated = existsSync(out)
            ? Migrated.safeParse(JSON.parse(readFileSync(out, 'utf8')))
            : null;
        if (failed || !migrated?.success)
            throw new Error(`oxfmt --migrate=biome failed: ${failed ?? 'no readable .oxfmtrc.json written'}`);
        writeFileSync(out, `${JSON.stringify(restoreBiomeDefaults(migrated.data, flat))}\n`);
        // Formatted by the config it now holds, so the consumer's first format pass leaves it unchanged.
        const unformatted = oxfmt(binPath, ['--write', '.oxfmtrc.json'], dir);
        if (unformatted)
            throw new Error(`oxfmt could not format the derived config: ${unformatted}`);
        return readFileSync(out, 'utf8');
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
/** The `.oxfmtrc.json` text for `cwd`: its own Biome style, or devkit's house style when it has none. */
export function deriveOxfmtConfig(cwd) {
    const source = BIOME_CONFIGS.map((name) => join(cwd, name)).find((path) => existsSync(path));
    const flat = source ? flatten(source, new Set()) : DEVKIT_FORMAT_PRESET;
    if (flat.formatter?.enabled === false || flat.javascript?.formatter?.enabled === false)
        return '{ "ignorePatterns": ["**"] }\n';
    return migrateBiome(flat);
}
function restoreBiomeDefaults(migrated, flat) {
    const { ignorePatterns = [], ...settings } = migrated;
    // Biome never sorted package.json, kept JSON commas per `json.formatter`, quoted CSS per
    // `css.formatter` and never formatted Markdown; migrate drops all four, so restore them here.
    return {
        ...settings,
        sortPackageJson: false,
        overrides: [
            {
                files: ['**/*.json', '**/*.jsonc'],
                options: {
                    trailingComma: flat.json?.formatter?.trailingCommas === 'all' ? 'all' : 'none',
                },
            },
            {
                files: ['**/*.css', '**/*.scss', '**/*.less'],
                options: { singleQuote: flat.css?.formatter?.quoteStyle === 'single' },
            },
        ],
        ignorePatterns: [...new Set([...ignorePatterns, '**/*.md'])],
    };
}
