/** Supersession — devkit changed the command of a STILL-LIVE registration; ruled in
 * docs/decisions/hook-command-supersession.md. Ledger rows only; stripReclaimedCommands walks. */
import { nativeProjection } from './lifecycle.mjs';
import { HOOK_REGISTRATIONS, SUPERSEDED_HOOK_COMMANDS } from './registrations.mjs';
/** Project every prior spelling beside its replacement. Both sides run through the SAME
 * nativeProjection a live install uses, so codex/cursor spellings are never hand-transcribed. */
export function projectSupersededHookRegistrations(provider) {
    const projections = [];
    const seen = new Set();
    for (const row of SUPERSEDED_HOOK_COMMANDS) {
        const owned = Object.entries(HOOK_REGISTRATIONS).flatMap(([ownerId, registrations]) => registrations
            .filter((registration) => registration.registrationId === row.registrationId)
            .map((registration) => ({ ownerId, registration })));
        if (!owned.length)
            throw new Error(`superseded command names registration "${row.registrationId}", which no longer exists — retire it instead of superseding it`);
        for (const { ownerId, registration } of owned) {
            const native = nativeProjection(provider, registration);
            const legacy = nativeProjection(provider, { ...registration, command: row.command });
            if (!native || !legacy || legacy.command === native.command)
                continue;
            if (seen.has(legacy.command))
                throw new Error(`superseded command "${legacy.command}" is claimed by more than one registration for ${provider}`);
            seen.add(legacy.command);
            projections.push({
                registrationId: row.registrationId,
                ownerId,
                legacyCommand: legacy.command,
                native,
            });
        }
    }
    return projections;
}
/** True iff this ledger row is the one devkit recorded for `projection` in `destinationRel`. */
const ownsSupersession = (entry, projection, provider, destinationRel) => entry.provider === provider &&
    entry.destinationRel === destinationRel &&
    entry.registrationId === projection.registrationId &&
    entry.ownerId === projection.ownerId &&
    entry.native.event === projection.native.event &&
    entry.native.matcher === projection.native.matcher;
/** Carry superseded rows onto the current spelling; report what they authorise stripping. A row is
 * claimed holding EITHER spelling — the second arm recovers publishPlan's crash window. */
export function reconcileLegacyHookCommands(entries, provider, destinationRel) {
    const projections = projectSupersededHookRegistrations(provider);
    const stripped = [];
    let ledgerChanged = false;
    const next = entries.map((entry) => {
        const owned = projections.filter((projection) => ownsSupersession(entry, projection, provider, destinationRel));
        const native = owned[0]?.native;
        if (!native ||
            !owned.some((projection) => entry.native.command === projection.legacyCommand ||
                entry.native.command === projection.native.command))
            return entry;
        // EVERY prior spelling, not just the one the row holds: a registration can have shipped more
        // than one, and a row already carrying the current command cannot say which the document has.
        for (const projection of owned)
            stripped.push({
                event: projection.native.event,
                matcher: projection.native.matcher,
                command: projection.legacyCommand,
            });
        if (entry.native.command === native.command)
            return entry;
        ledgerChanged = true;
        return { ...entry, native: { ...native } };
    });
    return { entries: next, stripped, ledgerChanged };
}
