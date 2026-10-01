// Overlay clean's last hook-document step: delete a devkit-created document left empty once its
// registrations are stripped — pruning the exclude line would otherwise expose it to git.

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../../fs-helpers.mts';
import { isTracked } from '../../git-tracked.mts';
import { withAgentAssetLifecycleLock } from '../agent-asset-manifest/lock.mts';
import { dataRecord } from './plain-data.mts';

// Each overlay hook document and the scaffold keys devkit writes into it.
const OVERLAY_HOOK_DOCUMENTS = [
  { rel: '.claude/settings.local.json', allowed: ['hooks'] },
  { rel: '.cursor/hooks.json', allowed: ['version', 'hooks'] },
  { rel: '.codex/hooks.json', allowed: ['hooks'] },
];

/** A hook document's top-level keys and its hook-event count (null: `hooks` is not an object). */
interface HookDocumentOutline {
  keys: string[];
  hookEvents: number | null;
}

function readHookDocumentOutline(path: string): HookDocumentOutline | null {
  const doc = dataRecord(readJson(path));
  if (!doc) return null;
  const hooks = doc.hooks === undefined ? {} : dataRecord(doc.hooks);
  return { keys: Object.keys(doc), hookEvents: hooks ? Object.keys(hooks).length : null };
}

// Nothing of the user's is left iff only scaffold keys remain and no hook event is registered.
const isEmptyScaffold = (doc: HookDocumentOutline | null, allowed: string[]): boolean =>
  doc?.hookEvents === 0 && doc.keys.every((key) => allowed.includes(key));

// Delete an untracked document left an empty scaffold only if this run stripped a trusted-projection
// registration from it: a ledger row alone is untrusted input and proves nothing (sc-1232).
export function removeEmptyOverlaySettings(
  gitRoot: string,
  dryRun: boolean,
  stripped: ReadonlySet<string>,
): void {
  // Under the lifecycle lock: an overlay install must not register into a file between read and rm.
  withAgentAssetLifecycleLock(gitRoot, dryRun, () => {
    const removable = OVERLAY_HOOK_DOCUMENTS.filter(
      ({ rel, allowed }) =>
        stripped.has(rel) &&
        isEmptyScaffold(readHookDocumentOutline(join(gitRoot, rel)), allowed) &&
        !isTracked(gitRoot, rel),
    );
    for (const { rel } of removable) {
      console.log(
        `  ${dryRun ? '[dry-run] remove' : '✓ removed'} ${rel} (devkit-created, now empty)`,
      );
      if (!dryRun) rmSync(join(gitRoot, rel), { force: true });
    }
  });
}
