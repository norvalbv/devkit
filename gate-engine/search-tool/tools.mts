/**
 * Resolve the steered search/graph tool NAMES for the search-tool hooks.
 *
 * The two hooks (guard + counter) reference a consumer's semantic-search tool
 * (`searchTool`) and graph/impact tool (`graphTool`) by name in their steering
 * advice. Frink hardcoded "mcp__codebase__searchCode" / "graphify"; devkit must
 * not bake a frink tool name in.
 *
 * Resolution: prefer the value on the resolved guard config (so once the shared
 * loader surfaces `searchTool` / `graphTool` from guard.config.json + GUARD_*
 * env, those win), else fall back to the conventional MCP defaults below. This
 * keeps the engine self-contained while letting a consumer override per repo.
 */

import type { resolveGuardConfig } from '../config.mts';

// The resolved guard-config shape these hooks read (only searchTool/graphTool are used).
type ResolvedGuardConfig = ReturnType<typeof resolveGuardConfig>;

// The steered tool NAMES the guard + counter hooks reference in their advice.
export interface SearchTools {
  searchTool: string;
  graphTool: string;
}

// Conventional defaults — the de-facto MCP search-code tool + the graphify CLI.
// These are NAMES of tools the consumer is expected to have, not frink data.
export const DEFAULT_SEARCH_TOOL = 'mcp__codebase__searchCode';
export const DEFAULT_GRAPH_TOOL = 'graphify';

const nonEmpty = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

export function resolveSearchTools(cfg: ResolvedGuardConfig): SearchTools {
  return {
    searchTool: nonEmpty(cfg?.searchTool) ?? DEFAULT_SEARCH_TOOL,
    graphTool: nonEmpty(cfg?.graphTool) ?? DEFAULT_GRAPH_TOOL,
  };
}
