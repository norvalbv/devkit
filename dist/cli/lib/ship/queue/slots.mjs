// How many ships this machine may run at once, and which slot directories exist. Capacity comes from
// <queue root>/config.json only (never env): a capacity knob the owner sets, not a way to skip.
import { lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
/** Hard cap: the memory profile of N concurrent ships is unmeasured past a few. */
export const MAX_SLOTS = 4;
/** Slot 0 keeps the pre-slots name, so a ship from an older devkit holding `slot` still counts. */
const SLOT_NAME = /^slot(?:-([1-9]\d*))?$/;
export const slotName = (index) => (index === 0 ? 'slot' : `slot-${index}`);
export const configFile = (root) => join(root, 'config.json');
/** Every existing slot directory, whatever the configured count: shrinking N must still see them. */
export function slotDirs(root) {
    try {
        // Real directories only: a stray file or symlink named `slot` is not a claim.
        return readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && SLOT_NAME.test(entry.name))
            .map((entry) => join(root, entry.name));
    }
    catch {
        return [];
    }
}
/**
 * Caller holds the queue lock. The lowest-numbered free slot within the configured count; a stray
 * non-directory at a slot name (never a claim) is removed, not followed, so it cannot wedge the head.
 */
export function takeFreeSlot(root, slots) {
    for (let index = 0; index < slots; index++) {
        const dir = join(root, slotName(index));
        let isDirectory;
        try {
            isDirectory = lstatSync(dir).isDirectory();
        }
        catch {
            return dir;
        }
        if (isDirectory)
            continue;
        rmSync(dir, { force: true });
        return dir;
    }
    return undefined;
}
// Strict: a present file must say exactly what it means; `{}` or a typo'd key warns, never silently 1.
const SlotsConfig = z.object({ slots: z.number().int().min(1).max(MAX_SLOTS) }).strict();
const warnedContents = new Set();
/** Configured concurrent ships: missing file → 1; invalid → 1, warned once per distinct content
 * (only a read that can warn marks content warned, so a silent `--queue` read swallows nothing). */
export function readSlotCount(root, warn) {
    let text;
    try {
        text = readFileSync(configFile(root), 'utf8');
    }
    catch {
        return 1;
    }
    let parsed;
    try {
        parsed = SlotsConfig.safeParse(JSON.parse(text));
    }
    catch {
        parsed = undefined;
    }
    if (parsed?.success)
        return parsed.data.slots;
    if (warn && !warnedContents.has(text)) {
        warnedContents.add(text);
        warn(`ship: ignoring ${configFile(root)} — "slots" must be a whole number 1..${MAX_SLOTS}; running one ship at a time`);
    }
    return 1;
}
