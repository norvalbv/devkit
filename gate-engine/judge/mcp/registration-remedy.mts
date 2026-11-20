import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { shellWord } from '../../review/valve/shell-word.mts';

/** search-code indexes a repo only when this file sits at its root (the engine's opt-in gate). */
export const SEARCH_CODE_CONFIG = 'search-code.config.json';

/** Registers the codebase server for `root` in ~/.claude.json, whatever CLAUDE_CONFIG_DIR says. The
 * root is pinned: a gate worktree under $TMPDIR may hold no search-code config to walk up to. */
export function codebaseRegisterCommand(root: string): string {
  const at = shellWord(root);
  return `cd ${at} && env -u CLAUDE_CONFIG_DIR claude mcp add -s local codebase -e SEMANTIC_SEARCH_ROOT=${at} -- search-code serve`;
}

function isClaudeRegistry(registryPath: string): boolean {
  const file = path.join(homedir(), '.claude.json');
  try {
    return realpathSync(file) === registryPath;
  } catch {
    return file === registryPath;
  }
}

/** How to restore codebase search for `root`. A repo search-code never indexed is told to opt in
 * first, since a bare registration clears DEGRADED while reviewers still have nothing to search. */
export function codebaseRemedy(root: string, registryPath: string): string {
  const fix = isClaudeRegistry(registryPath)
    ? `run \`${codebaseRegisterCommand(root)}\`, and remove \`codebase\` from this project's \`disabledMcpServers\` in ${registryPath} if it is listed there`
    : `add the \`codebase\` MCP server for this project in ${registryPath}, or remove it from that project's \`disabledMcpServers\``;
  if (!existsSync(path.join(root, SEARCH_CODE_CONFIG)))
    return `opt this repo into search-code first (\`devkit init --search-code\`, then \`search-code index\`), then ${fix}`;
  return fix;
}
