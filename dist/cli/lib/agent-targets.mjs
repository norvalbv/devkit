import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_TARGETS, agentSurfaceDir, existingAgentTargets } from "./components.mjs";
const ALL_AGENT_ASSET_KINDS = ['skills', 'agents', 'hooks'];
/** Resolve an existing install without broadening it to the fresh all-provider default. */
export function resolveExistingAgentTargets(root, recorded, kinds = ALL_AGENT_ASSET_KINDS) {
    const inferred = AGENT_TARGETS.filter((target) => kinds.some((kind) => existsSync(join(root, agentSurfaceDir(target, kind)))));
    return existingAgentTargets(recorded, inferred);
}
