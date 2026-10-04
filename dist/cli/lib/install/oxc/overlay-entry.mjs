/** Overlay's root entry config: the Devkit base, scoped by the consumer's own Oxlint ignores. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { check } from '../../doctor/check-result.mjs';
import { parseJsonc } from '../../husky/format-identity/jsonc.mjs';
/**
 * Overlay's entry config — deliberately NOT an Oxlint discovery name. It must stay at the package
 * ROOT: oxlint resolves `overrides[].files` globs against the ENTRY config's directory.
 */
export const OVERLAY_ENTRY_REL = 'oxlint.devkit.json';
const BASE_POINTER = './.devkit/oxc/oxlint.base.json';
/** Consumer configs whose ignores devkit can read; a JS/TS config would have to be executed. */
const READABLE = new Set(['.oxlintrc.json', '.oxlintrc.jsonc']);
/** Only the ignores matter to the overlay entry; every other consumer key passes through unread. */
const consumerConfigSchema = z.looseObject({ ignorePatterns: z.array(z.string()).optional() });
const unreadable = (reason) => ({ patterns: [], unreadable: reason });
function readText(path) {
    try {
        return readFileSync(path, 'utf8');
    }
    catch {
        return null;
    }
}
/** Read the single consumer Oxlint config once; every way it can mislead the entry is unreadable. */
export function readConsumerIgnores(cwd, consumer) {
    if (consumer.length > 1)
        return unreadable(`it has more than one Oxlint config (${consumer.join(', ')})`);
    const [name] = consumer;
    if (!name)
        return { patterns: [], unreadable: null };
    if (!READABLE.has(name))
        return unreadable(`devkit cannot read the ignores in its own ${name}`);
    const text = readText(join(cwd, name));
    if (text === null)
        return unreadable(`its own ${name} could not be read`);
    const parsed = consumerConfigSchema.safeParse(parseJsonc(text));
    if (!parsed.success)
        return unreadable(`its own ${name} is not a JSON object, or its ignorePatterns is not a string list`);
    return { patterns: parsed.data.ignorePatterns ?? [], unreadable: null };
}
/** The entry `-c` points at: the base plus the consumer's ignores. The gate keeps only anti-slop
 * diagnostics, and a consumer config built for a newer Oxlint would not load, so it is not extended. */
export function overlayEntry(patterns) {
    const entry = { extends: [BASE_POINTER] };
    if (patterns.length > 0)
        entry.ignorePatterns = patterns;
    return `${JSON.stringify(entry, null, 2)}\n`;
}
/** Doctor row: while anti-slop reads the entry, does it carry the consumer's ignores as they read today? */
export function overlayDiscoveryRow(cwd, consumer, antiSlop) {
    if (!antiSlop)
        return check('oxlint discovery', 'OK', 'anti-slop is off, so nothing reads the entry');
    const ignores = readConsumerIgnores(cwd, consumer);
    if (ignores.unreadable) {
        return check('oxlint discovery', 'DRIFT', `the overlay gate cannot honour this repo's Oxlint ignores: ${ignores.unreadable}`, 'keep one JSON Oxlint config (.oxlintrc.json or .oxlintrc.jsonc), then run `devkit init --overlay`');
    }
    const path = join(cwd, OVERLAY_ENTRY_REL);
    const onDisk = existsSync(path) ? readText(path) : null;
    if (onDisk !== overlayEntry(ignores.patterns)) {
        return check('oxlint discovery', 'DRIFT', `${OVERLAY_ENTRY_REL} is missing or stale against ${consumer[0] ?? 'the removed consumer config'}`, 'run `devkit init --overlay` to refresh it');
    }
    const detail = consumer[0]
        ? `honours the ignores in ${consumer[0]}`
        : 'no consumer Oxlint config to honour';
    return check('oxlint discovery', 'OK', detail);
}
