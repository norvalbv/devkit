/** Who owns a root Oxc config: an adopted consumer file, or a starter devkit wrote and may update. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { overlayInstall } from '../../../../gate-engine/overlay-mode.mjs';
import { writeFileAtomic } from '../../atomic-write.mjs';
import { digest } from '../../fs-helpers.mjs';
import { OVERLAY_ENTRY_REL } from './overlay-entry.mjs';
/** The names from `names` that exist in `cwd`. */
export function candidates(cwd, names) {
    return names.filter((name) => existsSync(join(cwd, name)));
}
/** Adopt the one existing config, refresh an untouched older starter, or write a fresh starter. */
export function ownershipFor(cwd, names, plan, previous, dryRun) {
    const found = candidates(cwd, names);
    if (found.length === 1) {
        const path = found[0];
        const kept = previous?.path === path ? previous : { path, createdDigest: null };
        const stale = () => plan.replaces !== undefined &&
            kept.createdDigest === digest(plan.replaces) &&
            existsSync(join(cwd, path)) &&
            digest(readFileSync(join(cwd, path))) === kept.createdDigest;
        if (!stale())
            return kept;
        const text = plan.starter();
        // Deriving a starter takes long enough for the consumer to edit the file meanwhile: re-check.
        return stale() ? write(cwd, path, text, dryRun) : kept;
    }
    // Last line of defence: makes a visible root config UNREACHABLE while the repo is still overlaid,
    // even with every mode signal lost. Both remedies are named — the caller's intent is ambiguous.
    if (overlayInstall(cwd)) {
        throw new Error(`refusing to create ${plan.starterPath} in an overlay install: overlay writes no tracked root config. To stay on overlay, run \`devkit init --overlay\` (restores ${OVERLAY_ENTRY_REL}). To convert this repo to a package install, run \`devkit clean\` first.`);
    }
    const text = plan.starter();
    // A config the consumer created while the starter was derived is theirs, as one found above is.
    const appeared = candidates(cwd, names);
    if (appeared.length > 0)
        return { path: appeared[0], createdDigest: null };
    return write(cwd, plan.starterPath, text, dryRun);
}
function write(cwd, path, text, dryRun) {
    if (!dryRun)
        writeFileAtomic(join(cwd, path), text);
    return { path, createdDigest: digest(text) };
}
