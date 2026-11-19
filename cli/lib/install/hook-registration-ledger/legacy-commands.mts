/** Supersession — devkit changed the command of a STILL-LIVE registration; ruled in
 * docs/decisions/hook-command-supersession.md. Ledger rows only; stripReclaimedCommands walks. */

import type { AgentProvider } from '../agent-assets/agent-providers.mts';
import type { HookInstallScope, HookRegistrationOwnershipV1 } from './codec.mts';
import type { OwnedHandler } from './install-support.mts';
import { nativeProjection, recoverProjectionHome, scopeAnchor } from './projection.mts';
import { HOOK_REGISTRATIONS, SUPERSEDED_HOOK_COMMANDS } from './registrations.mts';

/** One prior spelling of a still-live registration, paired with the spelling that replaced it. */
export interface SupersededProjection {
  registrationId: string;
  ownerId: string;
  /** the provider-native command this registration was previously registered under */
  legacyCommand: string;
  /** the provider-native event/matcher/command it projects to now */
  native: HookRegistrationOwnershipV1['native'];
}

/** Project every prior spelling beside its replacement. Both sides run through the SAME
 * nativeProjection a live install uses, so codex/cursor spellings are never hand-transcribed. */
export function projectSupersededHookRegistrations(
  provider: AgentProvider,
  anchor: string | null = null,
): readonly SupersededProjection[] {
  const projections: SupersededProjection[] = [];
  const seen = new Set<string>();
  for (const row of SUPERSEDED_HOOK_COMMANDS) {
    const owned = Object.entries(HOOK_REGISTRATIONS).flatMap(([ownerId, registrations]) =>
      registrations
        .filter((registration) => registration.registrationId === row.registrationId)
        .map((registration) => ({ ownerId, registration })),
    );
    if (!owned.length)
      throw new Error(
        `superseded command names registration "${row.registrationId}", which no longer exists — retire it instead of superseding it`,
      );
    for (const { ownerId, registration } of owned) {
      const native = nativeProjection(provider, registration, anchor);
      // Table rows predate anchoring, so their prior spelling is always the unanchored one.
      const legacy = nativeProjection(provider, { ...registration, command: row.command }, null);
      if (!native || !legacy || legacy.command === native.command) continue;
      if (seen.has(legacy.command))
        throw new Error(
          `superseded command "${legacy.command}" is claimed by more than one registration for ${provider}`,
        );
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
const ownsSupersession = (
  entry: HookRegistrationOwnershipV1,
  projection: SupersededProjection,
  provider: AgentProvider,
  destinationRel: string,
) =>
  entry.provider === provider &&
  entry.destinationRel === destinationRel &&
  entry.registrationId === projection.registrationId &&
  entry.ownerId === projection.ownerId &&
  entry.native.event === projection.native.event &&
  entry.native.matcher === projection.native.matcher;

/** A row's move onto `anchor` from a prior spelling (unanchored, or a recovered overlay home); a row
 * already there still owns the unanchored handler a crashed first write left in the document. */
function anchorReconcile(
  entry: HookRegistrationOwnershipV1,
  provider: AgentProvider,
  destinationRel: string,
  anchor: string | null,
): { native: HookRegistrationOwnershipV1['native']; strip: OwnedHandler; moved: boolean } | null {
  if (entry.provider !== provider || entry.destinationRel !== destinationRel) return null;
  const owned = Object.hasOwn(HOOK_REGISTRATIONS, entry.ownerId)
    ? HOOK_REGISTRATIONS[entry.ownerId]
    : [];
  const registration = owned.find((candidate) => candidate.registrationId === entry.registrationId);
  const current = registration && nativeProjection(provider, registration, anchor);
  if (!current || current.event !== entry.native.event || current.matcher !== entry.native.matcher)
    return null;
  const unanchored = anchor === null ? null : nativeProjection(provider, registration, null);
  const anchors = unanchored !== null && unanchored.command !== current.command;
  if (current.command === entry.native.command)
    return anchors ? { native: current, strip: unanchored, moved: false } : null;
  const prior =
    (anchors && unanchored.command === entry.native.command) ||
    (entry.installScope === 'overlay' &&
      recoverProjectionHome(provider, registration, entry.native.command) !== null);
  return prior ? { native: current, strip: entry.native, moved: true } : null;
}

/** Carry superseded rows onto the current spelling; report what they authorise stripping. A row is
 * claimed holding EITHER spelling — the second arm recovers publishPlan's crash window. */
export function reconcileLegacyHookCommands(
  entries: readonly HookRegistrationOwnershipV1[],
  provider: AgentProvider,
  destinationRel: string,
  scope: HookInstallScope,
  home: string | null,
) {
  const anchor = scopeAnchor(scope, home);
  const projections = projectSupersededHookRegistrations(provider, anchor);
  const stripped: OwnedHandler[] = [];
  let ledgerChanged = false;
  const next = entries.map((entry) => {
    const owned = projections.filter((projection) =>
      ownsSupersession(entry, projection, provider, destinationRel),
    );
    const native = owned[0]?.native;
    if (
      !native ||
      !owned.some(
        (projection) =>
          entry.native.command === projection.legacyCommand ||
          entry.native.command === projection.native.command,
      )
    ) {
      const anchored = anchorReconcile(entry, provider, destinationRel, anchor);
      if (!anchored) return entry;
      stripped.push({ ...anchored.strip });
      if (!anchored.moved) return entry;
      ledgerChanged = true;
      return { ...entry, native: { ...anchored.native } };
    }
    // EVERY prior spelling, not just the one the row holds: a registration can have shipped more
    // than one, and a row already carrying the current command cannot say which the document has.
    for (const projection of owned)
      stripped.push({
        event: projection.native.event,
        matcher: projection.native.matcher,
        command: projection.legacyCommand,
      });
    // A superseded registration's row at the anchor owns the unanchored current spelling too.
    const atAnchor = anchorReconcile(entry, provider, destinationRel, anchor);
    if (atAnchor && !atAnchor.moved) stripped.push({ ...atAnchor.strip });
    if (entry.native.command === native.command) return entry;
    ledgerChanged = true;
    return { ...entry, native: { ...native } };
  });
  return { entries: next, stripped, ledgerChanged };
}
