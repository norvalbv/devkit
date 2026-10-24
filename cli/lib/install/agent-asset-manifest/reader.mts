import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { firstDuplicateJsonKey } from '../../../../gate-engine/critique/json-duplicate-keys.mts';
import { agentAssetDir, projectedAssetRel } from '../agent-assets/agent-assets.mts';
import {
  type AgentAssetKind,
  type AgentProvider,
  LEGACY_AGENT_PROVIDERS,
  SUPPORTED_AGENT_PROVIDERS,
} from '../agent-assets/agent-providers.mts';
import { sha256 } from '../../fs-helpers.mts';
import { readBoundedRegularFile } from '../strict-bounded-file-read.mts';
import { type DecodedSyncManifest, decodeSyncManifest, type SyncManifestV2 } from './codec.mts';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Strictly read one optional agent-asset manifest without following its leaf path. */
export function readAgentAssetManifest(
  path: string,
  kind: AgentAssetKind,
): DecodedSyncManifest | null {
  const bytes = readBoundedRegularFile(path, {
    label: 'agent asset manifest',
    maxBytes: MAX_MANIFEST_BYTES,
    limitLabel: '1 MiB',
  });
  if (bytes === null) return null;
  try {
    return decodeAgentAssetManifestBytes(bytes, kind);
  } catch (error) {
    const conflicted = decodeConflictedManifest(path, bytes, kind);
    if (conflicted === null) throw error;
    return conflicted;
  }
}

/**
 * A manifest git left with conflict markers decodes as the union of both sides, so a regenerating
 * sync still owns what either branch recorded and this checkout holds. Null without markers.
 */
function decodeConflictedManifest(
  path: string,
  bytes: Uint8Array,
  kind: AgentAssetKind,
): DecodedSyncManifest | null {
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return null;
  }
  try {
    const sides = conflictSides(text);
    if (sides === null) return null;
    const decode = (side: string) => decodeAgentAssetManifestBytes(Buffer.from(side), kind);
    return unionManifests(dirname(dirname(path)), kind, decode(sides[0]), decode(sides[1]));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${path} has unresolved merge conflict markers and cannot be regenerated (${reason}). ` +
        `Take one side (git checkout --ours -- ${path}) and re-run the generator.`,
    );
  }
}

const CONFLICT_MARKER = /^(<{7}|\|{7}|={7}|>{7})(?: |$)/;
// Hunk state after a marker: `|||||||` opens the diff3/zdiff3 base section, which neither side keeps.
const CONFLICT_TRANSITIONS = new Map([
  ['top<', 'ours'],
  ['ours|', 'base'],
  ['ours=', 'theirs'],
  ['base=', 'theirs'],
  ['theirs>', 'top'],
]);

/** Split git conflict-marker text into its ours and theirs files; null when it has no markers. */
function conflictSides(text: string): [string, string] | null {
  const ours: string[] = [];
  const theirs: string[] = [];
  let state = 'top';
  let marked = false;
  for (const line of text.split(/\r?\n/)) {
    const marker = CONFLICT_MARKER.exec(line)?.[1][0];
    if (marker === undefined) {
      if (state === 'top' || state === 'ours') ours.push(line);
      if (state === 'top' || state === 'theirs') theirs.push(line);
      continue;
    }
    const next = CONFLICT_TRANSITIONS.get(`${state}${marker}`);
    if (next === undefined) throw new Error(`conflict marker ${marker.repeat(7)} is out of order`);
    state = next;
    marked = true;
  }
  if (!marked) return null;
  if (state !== 'top') throw new Error('a conflict hunk is unterminated');
  return [ours.join('\n'), theirs.join('\n')];
}

/** Both sides' records, ours winning a same-key hash clash; regeneration rewrites every hash anyway. */
function unionManifests(
  root: string,
  kind: AgentAssetKind,
  ours: DecodedSyncManifest,
  theirs: DecodedSyncManifest,
): DecodedSyncManifest {
  if (ours.version === 1 && theirs.version === 1) {
    const targets = [...new Set([...ours.manifest.targets, ...theirs.manifest.targets])];
    const files = unionRecords(ours.manifest.files, theirs.manifest.files, (rel, sha) =>
      targets.every((target) =>
        vouched(root, kind, target, projectedAssetRel(target, kind, rel), sha),
      ),
    );
    return { version: 1, manifest: { ...ours.manifest, files, targets } };
  }
  if (ours.version === 2 && theirs.version === 2) {
    const providers: SyncManifestV2['providers'] = {};
    for (const provider of SUPPORTED_AGENT_PROVIDERS) {
      const [mine, other] = [ours, theirs].map((side) => side.manifest.providers[provider]);
      if (mine || other)
        providers[provider] = {
          files: unionRecords(mine?.files ?? {}, other?.files ?? {}, (rel, sha) =>
            vouched(root, kind, provider, rel, sha),
          ),
        };
    }
    const files = unionRecords(ours.manifest.files, theirs.manifest.files, (rel) =>
      SUPPORTED_AGENT_PROVIDERS.some(
        (provider) => providers[provider]?.files[projectedAssetRel(provider, kind, rel)],
      ),
    );
    return { version: 2, manifest: { ...ours.manifest, files, providers } };
  }
  throw new Error('its two sides use different manifest schema versions');
}

/** A record only one side has is kept only while `owns` vouches for this checkout's copy of it. */
function unionRecords(
  ours: Record<string, string>,
  theirs: Record<string, string>,
  owns: (rel: string, sha: string) => boolean,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...theirs, ...ours }).filter(
      ([rel, sha]) => (Object.hasOwn(ours, rel) && Object.hasOwn(theirs, rel)) || owns(rel, sha),
    ),
  );
}

// The other branch's record cannot vouch for a same-named file the consumer wrote in this checkout.
function vouched(
  root: string,
  kind: AgentAssetKind,
  provider: AgentProvider,
  outputRel: string,
  sha: string,
): boolean {
  const path = join(root, agentAssetDir(provider, kind), outputRel);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return true;
  return stat.isFile() && sha256(path) === sha;
}

/** Decode manifest bytes already read from somewhere other than the working tree (a git tree). */
export function decodeAgentAssetManifestBytes(
  bytes: Uint8Array,
  kind: AgentAssetKind,
): DecodedSyncManifest {
  if (bytes.byteLength > MAX_MANIFEST_BYTES)
    throw new Error('agent asset manifest exceeds the 1 MiB limit');

  let raw: string;
  try {
    raw = UTF8.decode(bytes);
  } catch {
    throw new Error('agent asset manifest is not valid UTF-8');
  }
  const duplicate = firstDuplicateJsonKey(raw);
  if (duplicate !== null)
    throw new Error(`agent asset manifest has duplicate object field ${JSON.stringify(duplicate)}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('agent asset manifest is not valid JSON');
  }
  return decodeSyncManifest(parsed, kind);
}

/**
 * Legacy-provider slice of the requested (or manifest-recorded) target set — the providers a
 * pre-provider-aware devkit could have written to. Shared by the remove paths in
 * sync-manifest.mts and install-hooks.mts (was copy-pasted at three sites; sc-1414).
 */
export function resolveLegacyProviderTargets(
  decoded: DecodedSyncManifest | null,
  targets: string[] | undefined,
): string[] {
  const inferred = decoded?.version === 1 ? decoded.manifest.targets : [...LEGACY_AGENT_PROVIDERS];
  return (targets ?? inferred).filter((target) =>
    LEGACY_AGENT_PROVIDERS.includes(target as (typeof LEGACY_AGENT_PROVIDERS)[number]),
  );
}
