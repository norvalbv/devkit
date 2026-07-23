import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../atomic-write.mts';
import { AGENT_TARGETS } from '../components.mts';
import { packageDir, readJson, sha256, writeIfAbsent } from '../fs-helpers.mts';
import { isTracked } from '../git-tracked.mts';
import {
  bundledNames,
  findConflicts,
  removeManifested,
  type SyncManifest,
} from '../sync-manifest.mts';
import {
  assertLegacyAssetWriterCompatible,
  nextLegacyManifestGeneratedAt,
} from './agent-asset-manifest/compatibility.mts';
import {
  findProviderNativeAssetConflicts,
  isSafeAgentAssetPath,
  removeProviderNativeAssets,
  requiresProviderNativeLifecycle,
  syncProviderNativeAssets,
} from './agent-asset-manifest/lifecycle.mts';
import { readAgentAssetManifest } from './agent-asset-manifest/reader.mts';
import { agentAssetDir } from './agent-assets.mts';
import {
  type AgentProvider,
  LEGACY_AGENT_PROVIDERS,
  requireAgentProviders,
} from './agent-providers.mts';
import {
  encodeHookRegistrationLedger,
  HOOK_REGISTRATION_LEDGER_REL,
  type HookInstallScope,
  type HookRegistrationLedgerV1,
  type HookRegistrationOwnershipV1,
  hookRegistrationDestination,
} from './hook-registration-ledger/codec.mts';
import {
  checkProjectedHookRegistrations,
  installProjectedHookRegistrations,
  projectHookRegistrations,
  readHookRegistrationLedger,
  removeLedgerAuthorizedHookRegistrations,
  transferHookRegistrationScope,
  withAgentAssetLifecycleLock,
  writeHookRegistrationLedger,
} from './hook-registration-ledger/lifecycle.mts';
import { HOOK_REGISTRATIONS } from './hook-registrations.mts';

const hookDirs = (targets: string[]) => targets.map((target) => agentAssetDir(target, 'hooks'));
interface SyncHookScriptsOptions {
  dryRun?: boolean;
  targets?: string[];
  only?: string[];
  skipTracked?: (relPath: string) => boolean;
  override?: (kind: string, name: string) => boolean;
}

interface RemoveHookScriptsOptions {
  dryRun?: boolean;
  targets?: string[];
  dropManifest?: boolean;
  skipTracked?: (relPath: string) => boolean;
}

interface AgentHooksManifest extends SyncManifest {
  devkitRef: string | null;
  generatedAt: string;
}

export function syncHookScripts(
  root: string,
  {
    dryRun = false,
    targets = AGENT_TARGETS,
    only,
    skipTracked,
    override = () => false,
  }: SyncHookScriptsOptions = {},
) {
  return withAgentAssetLifecycleLock(root, dryRun, () => {
    const src = join(packageDir(), 'agents-hooks');
    const dirs = hookDirs(targets);
    let rels = readdirSync(src, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
    const manifestPath = join(root, '.devkit', 'agent-hooks-manifest.json');
    const decoded = readAgentAssetManifest(manifestPath, 'hooks');
    if (only?.length) {
      const unknown = only.filter((n) => !rels.includes(n));
      if (unknown.length)
        throw new Error(`sync-hooks --only: devkit ships no hook named ${unknown.join(', ')}`);
      rels = rels.filter((r) => only.includes(r));
    }
    const devkitPkg = readJson(join(packageDir(), 'package.json')) as { version?: string } | null;
    const devkitRef = devkitPkg ? `v${devkitPkg.version}` : null;
    if (requiresProviderNativeLifecycle(decoded, targets)) {
      const result = syncProviderNativeAssets({
        root,
        kind: 'hooks',
        manifestFilename: 'agent-hooks-manifest.json',
        sources: rels.map((logicalRel) => ({
          logicalRel,
          content: readFileSync(join(src, logicalRel)),
        })),
        targets,
        devkitRef,
        dryRun,
        skipTracked,
        override,
        retainUnspecified: Boolean(only?.length),
        fileMode: 0o755,
      });
      const reported = new Set<string>();
      for (const skip of result.skips) {
        if (reported.has(skip.unit)) continue;
        reported.add(skip.unit);
        console.log(
          skip.reason === 'tracked'
            ? `  ! skipping agent-hook "${skip.unit}" — git-tracked (left untouched)`
            : `  ! preserving non-devkit agent-hook "${skip.unit}" (left untouched — re-run with --force or select it to overwrite)`,
        );
      }
      console.log(
        `  ${dryRun ? '[dry-run] sync' : '✓ synced'} ${rels.length} agent-hook script(s) → ${hookDirs(targets).join(' + ')}`,
      );
      return result.manifest;
    }
    assertLegacyAssetWriterCompatible(decoded, targets, 'hooks');
    const prev = decoded?.manifest ?? null;
    const conflicts = new Set(findConflicts(root, src, rels, targets, 'hooks', prev));
    const files: Record<string, string> = only?.length ? { ...(prev?.files ?? {}) } : {};
    for (const rel of rels) {
      if (skipTracked && dirs.some((d) => skipTracked(`${d}/${rel}`))) {
        console.log(`  ! skipping agent-hook "${rel}" — git-tracked (left untouched)`);
        continue;
      }
      if (conflicts.has(rel) && !override('agent-hook', rel)) {
        console.log(
          `  ! preserving non-devkit agent-hook "${rel}" (left untouched — re-run with --force or select it to overwrite)`,
        );
        continue;
      }
      const content = readFileSync(join(src, rel));
      files[rel] = sha256(join(src, rel));
      if (dryRun) continue;
      for (const dir of dirs) {
        const dest = join(root, dir, rel);
        writeIfAbsent(dest, content, { force: true });
        chmodSync(dest, 0o755);
      }
    }
    const generatedAt = nextLegacyManifestGeneratedAt(prev, devkitRef, files);
    const manifest: AgentHooksManifest = {
      devkitRef,
      generatedAt,
      targets: [...targets],
      files,
    };
    if (dryRun) {
      console.log(`  [dry-run] sync ${rels.length} agent-hook script(s) → ${dirs.join(' + ')}`);
      return manifest;
    }
    writeIfAbsent(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { force: true });
    console.log(`  ✓ synced ${rels.length} agent-hook script(s) → ${dirs.join(' + ')}`);
    return manifest;
  });
}
export function detectHookConflicts(root: string, targets: string[] = AGENT_TARGETS): string[] {
  const src = join(packageDir(), 'agents-hooks');
  const rels = readdirSync(src, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
  const decoded = readAgentAssetManifest(
    join(root, '.devkit', 'agent-hooks-manifest.json'),
    'hooks',
  );
  if (requiresProviderNativeLifecycle(decoded, targets)) {
    return [
      ...new Set(
        findProviderNativeAssetConflicts({
          root,
          kind: 'hooks',
          manifestFilename: 'agent-hooks-manifest.json',
          sources: rels.map((logicalRel) => ({
            logicalRel,
            content: readFileSync(join(src, logicalRel)),
          })),
          targets,
        })
          .filter((conflict) => conflict.reason !== 'tracked')
          .map((conflict) => conflict.unit),
      ),
    ];
  }
  assertLegacyAssetWriterCompatible(decoded, targets, 'hooks');
  return findConflicts(root, src, rels, targets, 'hooks', decoded?.manifest ?? null);
}
export function removeHookScripts(
  root: string,
  { dryRun = false, targets, dropManifest = true, skipTracked }: RemoveHookScriptsOptions = {},
): void {
  withAgentAssetLifecycleLock(root, dryRun, () => {
    const native = removeProviderNativeAssets({
      root,
      kind: 'hooks',
      targets,
      dryRun,
      dropManifest,
      skipTracked,
    });
    if (native.handled) {
      console.log(
        `  ${dryRun ? '[dry-run] remove' : '✓ removed'} ${native.removed.length} synced agent-hook script(s)${dropManifest ? ' + manifest' : ''}`,
      );
      return;
    }
    const legacyTargets = (targets ?? [...LEGACY_AGENT_PROVIDERS]).filter((target) =>
      LEGACY_AGENT_PROVIDERS.includes(target as (typeof LEGACY_AGENT_PROVIDERS)[number]),
    );
    if (!legacyTargets.length) return;
    removeManifested(
      root,
      'agent-hooks-manifest.json',
      hookDirs(legacyTargets),
      'agent-hook script',
      dryRun,
      dropManifest,
      bundledNames('agents-hooks', (e) => e.isFile()),
      join(packageDir(), 'agents-hooks'),
      skipTracked,
    );
  });
}
interface HookRegistrationOptions {
  dryRun?: boolean;
  targets?: string[];
  overlay?: boolean;
  legacyOwnedComponentIds?: string[];
}
interface ProviderPlan {
  provider: AgentProvider;
  rel: string;
  document: unknown;
  changed: boolean;
  report?: boolean;
}
const ledgerOf = (entries: HookRegistrationOwnershipV1[] = []): HookRegistrationLedgerV1 => ({
  schemaVersion: 1,
  kind: 'agent_hook_registration_ownership',
  entries,
});
const ownedKey = (entry: HookRegistrationOwnershipV1) =>
  JSON.stringify([entry.provider, entry.destinationRel, entry.registrationId]);
function providerDocument(root: string, provider: AgentProvider, rel: string): unknown {
  const path = join(root, rel);
  if (!existsSync(path)) return provider === 'cursor' ? { version: 1 } : {};
  const document = readJson(path);
  if (document === null) throw new Error(`${rel} must contain a provider hook object`);
  return document;
}
function adopt(
  entries: HookRegistrationOwnershipV1[],
  candidates: readonly HookRegistrationOwnershipV1[],
) {
  const keys = new Set(entries.map(ownedKey));
  return [...entries, ...candidates.filter((candidate) => !keys.has(ownedKey(candidate)))];
}
function release(
  entries: HookRegistrationOwnershipV1[],
  removed: readonly HookRegistrationOwnershipV1[],
) {
  const keys = new Set(removed.map(ownedKey));
  return entries.filter((entry) => !keys.has(ownedKey(entry)));
}
function adoptExactLegacy(
  entries: HookRegistrationOwnershipV1[],
  document: unknown,
  componentIds: string[] | undefined,
  provider: AgentProvider,
  scope: HookInstallScope,
) {
  if (!componentIds || !LEGACY_AGENT_PROVIDERS.includes(provider as never)) return entries;
  const projection = projectHookRegistrations(componentIds, [provider], scope);
  const exact = checkProjectedHookRegistrations(
    document,
    projection,
    ledgerOf([...projection.entries]),
    provider,
    scope,
  );
  return adopt(entries, exact.present);
}
function skipProvider(root: string, provider: AgentProvider, rel: string, overlay: boolean) {
  if (overlay && provider !== 'claude' && isTracked(root, rel)) {
    console.log(`  ! ${rel} is git-tracked — skipping (can't hide a tracked edit)`);
    return true;
  }
  if (!isSafeAgentAssetPath(root, rel, true)) {
    console.log(`  ! ${rel} is unsafe — preserving it and its ownership state`);
    return true;
  }
  return false;
}
function writeProvider(root: string, plan: ProviderPlan) {
  if (!isSafeAgentAssetPath(root, plan.rel, true))
    throw new Error(`refusing unsafe hook destination: ${plan.rel}`);
  const path = join(root, plan.rel);
  mkdirSync(dirname(path), { recursive: true });
  if (!isSafeAgentAssetPath(root, plan.rel, true))
    throw new Error(`refusing unsafe hook destination: ${plan.rel}`);
  writeFileAtomic(path, `${JSON.stringify(plan.document, null, 2)}\n`);
}
function noteCodex(plan: ProviderPlan, dryRun: boolean) {
  if (plan.provider === 'codex' && plan.changed)
    console.log(
      `  ! ${dryRun ? '[dry-run] ' : ''}.codex/hooks.json changed — review and trust it with /hooks before Codex runs it`,
    );
}
function publishLedger(
  root: string,
  next: HookRegistrationLedgerV1,
  previous: HookRegistrationLedgerV1,
) {
  if (encodeHookRegistrationLedger(next) === encodeHookRegistrationLedger(previous)) return;
  if (!next.entries.length) rmSync(join(root, HOOK_REGISTRATION_LEDGER_REL), { force: true });
  else writeHookRegistrationLedger(root, next);
}
function publishPlan(
  root: string,
  plan: ProviderPlan,
  entries: HookRegistrationOwnershipV1[],
  previous: HookRegistrationLedgerV1,
  dryRun: boolean,
): HookRegistrationLedgerV1 {
  const next = ledgerOf(entries);
  if (!dryRun) {
    const intermediate = plan.changed ? ledgerOf(adopt([...next.entries], previous.entries)) : next;
    publishLedger(root, intermediate, previous);
    if (plan.changed) writeProvider(root, plan);
    publishLedger(root, next, intermediate);
  }
  noteCodex(plan, dryRun);
  return next;
}
export function installHookRegistrations(
  root: string,
  componentIds: string[],
  {
    dryRun = false,
    targets = AGENT_TARGETS,
    overlay = false,
    legacyOwnedComponentIds,
  }: HookRegistrationOptions = {},
): { wrote: string[] } {
  if (!componentIds.some((id) => HOOK_REGISTRATIONS[id]?.length)) return { wrote: [] };
  const scope: HookInstallScope = overlay ? 'overlay' : 'shared';
  return withAgentAssetLifecycleLock(root, dryRun, () => {
    const initial = readHookRegistrationLedger(root) ?? ledgerOf();
    let entries = [...initial.entries];
    let published = initial;
    const wrote: string[] = [];
    const obsoleteIds = Object.keys(HOOK_REGISTRATIONS).filter((id) => !componentIds.includes(id));
    for (const provider of requireAgentProviders(targets)) {
      const rel = hookRegistrationDestination(provider, scope);
      if (skipProvider(root, provider, rel, overlay)) continue;
      let document = providerDocument(root, provider, rel);
      entries = adoptExactLegacy(entries, document, legacyOwnedComponentIds, provider, scope);
      entries = transferHookRegistrationScope(entries, provider, scope);
      const removed = removeLedgerAuthorizedHookRegistrations(
        document,
        projectHookRegistrations(obsoleteIds, [provider], scope),
        ledgerOf(entries),
        provider,
        scope,
      );
      entries = release(entries, [...removed.removed, ...removed.alreadyAbsent]);
      document = removed.document;
      const installed = installProjectedHookRegistrations(
        document,
        projectHookRegistrations(componentIds, [provider], scope),
        ledgerOf(entries),
        provider,
        scope,
      );
      const unresolved =
        removed.blocked.length ||
        removed.drifted.length ||
        installed.blocked.length ||
        installed.collisions.length;
      if (unresolved) throw new Error(`${provider} hook registration conflicts require resolution`);
      entries = adopt(entries, installed.ownershipEntries);
      const plan: ProviderPlan = {
        provider,
        rel,
        document: installed.document,
        changed: removed.changed || installed.changed,
        report: removed.changed || installed.ownershipEntries.length > 0,
      };
      published = publishPlan(root, plan, entries, published, dryRun);
      if (plan.report) wrote.push(plan.rel);
    }
    if (wrote.length && published.entries.length) wrote.push(HOOK_REGISTRATION_LEDGER_REL);
    console.log(`  ${dryRun ? '[dry-run] merge' : '✓ registered'} hook registrations`);
    return { wrote: [...new Set(wrote)] };
  });
}
export function removeHookRegistrations(
  root: string,
  {
    dryRun = false,
    targets = AGENT_TARGETS,
    overlay = false,
    legacyOwnedComponentIds,
  }: HookRegistrationOptions = {},
): void {
  const scope: HookInstallScope = overlay ? 'overlay' : 'shared';
  withAgentAssetLifecycleLock(root, dryRun, () => {
    const storedLedger = readHookRegistrationLedger(root);
    if (!storedLedger && !legacyOwnedComponentIds) {
      console.log('  • no hook registration ledger — preserving provider settings');
      return;
    }
    const ledger = storedLedger ?? ledgerOf();
    let entries = [...ledger.entries];
    let published = ledger;
    const storedKeys = new Set(entries.map(ownedKey));
    for (const provider of requireAgentProviders(targets)) {
      const rel = hookRegistrationDestination(provider, scope);
      if (skipProvider(root, provider, rel, overlay)) continue;
      const document = providerDocument(root, provider, rel);
      entries = adoptExactLegacy(entries, document, legacyOwnedComponentIds, provider, scope);
      entries = transferHookRegistrationScope(entries, provider, scope);
      const removed = removeLedgerAuthorizedHookRegistrations(
        document,
        projectHookRegistrations(Object.keys(HOOK_REGISTRATIONS), [provider], scope),
        ledgerOf(entries),
        provider,
        scope,
      );
      entries = release(entries, [...removed.removed, ...removed.alreadyAbsent]);
      entries = entries.filter((entry) => storedKeys.has(ownedKey(entry)));
      const plan = { provider, rel, document: removed.document, changed: removed.changed };
      published = publishPlan(root, plan, entries, published, dryRun);
    }
    console.log(`  ${dryRun ? '[dry-run] remove' : '✓ removed'} hook registrations`);
  });
}
export function checkHookRegistrations(
  root: string,
  componentIds: string[],
  {
    overlay = false,
    targets = AGENT_TARGETS,
    legacyOwnedComponentIds,
  }: Pick<HookRegistrationOptions, 'overlay' | 'targets' | 'legacyOwnedComponentIds'> = {},
) {
  if (!componentIds.some((id) => HOOK_REGISTRATIONS[id]?.length)) return { ok: true, missing: [] };
  const scope: HookInstallScope = overlay ? 'overlay' : 'shared';
  const ledger = readHookRegistrationLedger(root);
  const missing: string[] = [];
  for (const provider of requireAgentProviders(targets)) {
    const rel = hookRegistrationDestination(provider, scope);
    if (!isSafeAgentAssetPath(root, rel, true)) {
      missing.push(`${provider}:unsafe-config`);
      continue;
    }
    const document = providerDocument(root, provider, rel);
    const effectiveLedger = legacyOwnedComponentIds?.length
      ? ledgerOf(
          adoptExactLegacy(
            [...(ledger?.entries ?? [])],
            document,
            legacyOwnedComponentIds,
            provider,
            scope,
          ),
        )
      : ledger;
    const result = checkProjectedHookRegistrations(
      document,
      projectHookRegistrations(componentIds, [provider], scope),
      effectiveLedger,
      provider,
      scope,
    );
    for (const [reason, candidates] of Object.entries({
      missing: result.missing,
      drifted: result.drifted,
      collision: result.collisions,
      blocked: result.blocked,
      'untrusted-ledger': result.untrustedLedgerEntries,
    }))
      for (const candidate of candidates)
        missing.push(`${provider}:${candidate.registrationId}:${reason}`);
  }
  return { ok: missing.length === 0, missing };
}
