import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_TARGETS, agentSurfaceDir, existingAgentTargets } from './components.mts';

export type AgentAssetKind = 'skills' | 'agents' | 'hooks';

const ALL_AGENT_ASSET_KINDS: AgentAssetKind[] = ['skills', 'agents', 'hooks'];

/** Resolve an existing install without broadening it to the fresh all-provider default. */
export function resolveExistingAgentTargets(
  root: string,
  recorded?: string[],
  kinds: AgentAssetKind[] = ALL_AGENT_ASSET_KINDS,
): string[] {
  const inferred = AGENT_TARGETS.filter((target) =>
    kinds.some((kind) => existsSync(join(root, agentSurfaceDir(target, kind)))),
  );
  return existingAgentTargets(recorded, inferred);
}
