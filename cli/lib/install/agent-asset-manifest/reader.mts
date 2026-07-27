import { firstDuplicateJsonKey } from '../../../../gate-engine/critique/json-duplicate-keys.mts';
import type { AgentAssetKind } from '../agent-providers.mts';
import { readBoundedRegularFile } from '../strict-bounded-file-read.mts';
import { type DecodedSyncManifest, decodeSyncManifest } from './codec.mts';

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
