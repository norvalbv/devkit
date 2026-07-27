import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Every agent provider the staged provider stack knows how to model. */
export const SUPPORTED_AGENT_PROVIDERS = ['claude', 'codex', 'cursor'] as const;
export type AgentProvider = (typeof SUPPORTED_AGENT_PROVIDERS)[number];

/** Providers devkit could historically own before provider support was recorded explicitly. */
export const LEGACY_AGENT_PROVIDERS = [
  'claude',
  'cursor',
] as const satisfies readonly AgentProvider[];

/** Fresh-install defaults. Existing installs continue to honor their recorded provider set. */
export const FRESH_DEFAULT_AGENT_PROVIDERS = [
  'claude',
  'codex',
  'cursor',
] as const satisfies readonly AgentProvider[];

export type AgentAssetKind = 'skills' | 'agents' | 'hooks';

const ALL_AGENT_ASSET_KINDS = ['skills', 'agents', 'hooks'] as const;
const SUPPORTED_AGENT_PROVIDER_NAMES = new Set<string>(SUPPORTED_AGENT_PROVIDERS);

export function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === 'string' && SUPPORTED_AGENT_PROVIDER_NAMES.has(value);
}

/** Reject unknown providers, then de-duplicate valid providers in the supported stable order. */
export function requireAgentProviders(values: readonly unknown[]): AgentProvider[] {
  for (const value of values)
    if (!isAgentProvider(value))
      throw new Error(`Unsupported agent provider: ${JSON.stringify(value) ?? String(value)}`);
  const selected = new Set(values as AgentProvider[]);
  return SUPPORTED_AGENT_PROVIDERS.filter((provider) => selected.has(provider));
}

/** Validate and de-duplicate a recorded provider array without supplying defaults. */
export function normalizeAgentProviders(values: readonly unknown[]): AgentProvider[] {
  return [...new Set(values.filter(isAgentProvider))];
}

/**
 * Resolve providers for an existing install. A recorded array is authoritative even when empty.
 * Only a legacy config with no `agentTargets` key may infer ownership from disk, and that inference
 * is intentionally limited to historical Claude/Cursor paths. Arbitrary `.codex` or `.agents`
 * content may be user-owned and is never treated as devkit ownership evidence.
 */
export function resolveExistingAgentProviders(
  root: string,
  recorded?: readonly unknown[] | null,
  kinds: readonly AgentAssetKind[] = ALL_AGENT_ASSET_KINDS,
): AgentProvider[] {
  if (recorded != null) return normalizeAgentProviders(recorded);

  const inferred = LEGACY_AGENT_PROVIDERS.filter((provider) =>
    kinds.some((kind) => existsSync(join(root, `.${provider}`, kind))),
  );
  return inferred.length ? inferred : [...LEGACY_AGENT_PROVIDERS];
}
