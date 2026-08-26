import { describe, expect, it, vi } from 'vitest';
import { codexMcpArgs, judgeCliFor } from '../codex/result.mts';

// sc-2054: gpt judges get the SAME role-scoped MCP servers as claude judges, via codex-native
// per-invocation config. Contracts pinned here: secrets ride the spawn env (never argv), the
// claude --allowedTools grants become per-server enabled_tools allowlists, and an ungranted
// server is not injected at all.

const SERVERS = {
  codebase: {
    command: 'node',
    args: ['/abs/search-server.mjs', '--index', '/abs/index.db'],
    env: { SEARCH_TOKEN: 's3cret' },
  },
  context7: { command: 'npx', args: ['context7-mcp'] },
};

describe('codexMcpArgs', () => {
  it('injects command/args, forwards env by NAME only, and scopes tools from the grants', () => {
    const { argv, extraEnv } = codexMcpArgs(SERVERS, [
      'mcp__codebase__searchCode',
      'mcp__context7__*',
      'Bash(node /x/checklist.mjs:*)',
    ]);
    const joined = argv.join(' ');
    expect(joined).toContain('mcp_servers.codebase.command="node"');
    expect(joined).toContain(
      'mcp_servers.codebase.args=["/abs/search-server.mjs","--index","/abs/index.db"]',
    );
    expect(joined).toContain('mcp_servers.codebase.env_vars=["SEARCH_TOKEN"]');
    expect(joined).toContain('mcp_servers.codebase.enabled_tools=["searchCode"]');
    expect(joined).toContain('mcp_servers.context7.command="npx"');
    // `mcp__context7__*` grants everything — no allowlist emitted for it.
    expect(joined).not.toContain('mcp_servers.context7.enabled_tools');
    // The secret VALUE never rides argv; it rides the spawn env under its real name.
    expect(joined).not.toContain('s3cret');
    expect(extraEnv).toEqual({ SEARCH_TOKEN: 's3cret' });
  });

  it('a server with NO grant is not injected; a null grant list (bench path) injects all', () => {
    const granted = codexMcpArgs(SERVERS, ['mcp__codebase__*']);
    expect(granted.argv.join(' ')).not.toContain('context7');
    const bench = codexMcpArgs(SERVERS, null);
    expect(bench.argv.join(' ')).toContain('mcp_servers.context7.command');
  });

  it('refuses what codex config cannot express: dotted names and cross-server env collisions', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const dotted = codexMcpArgs({ 'bad.name': { command: 'x' } }, null);
      expect(dotted.argv).toEqual([]);
      const collide = codexMcpArgs(
        { a: { command: 'x', env: { TOKEN: 'one' } }, b: { command: 'y', env: { TOKEN: 'two' } } },
        null,
      );
      expect(collide.argv.join(' ')).toContain('mcp_servers.a.');
      expect(collide.argv.join(' ')).not.toContain('mcp_servers.b.');
      expect(collide.extraEnv).toEqual({ TOKEN: 'one' });
    } finally {
      err.mockRestore();
    }
  });
});

describe('judgeCliFor with servers', () => {
  const argvFor = (model: string) => [
    '-p',
    'JUDGE THIS',
    '--model',
    model,
    '--allowedTools',
    'mcp__codebase__searchCode',
  ];

  it('a gpt judge carries the -c mcp config and the extraEnv; a claude judge is untouched', () => {
    const codex = judgeCliFor(argvFor('gpt-5.6-sol'), SERVERS);
    expect(codex.codex).toBe(true);
    expect(codex.argv.join(' ')).toContain('mcp_servers.codebase.command="node"');
    expect(codex.extraEnv).toEqual({ SEARCH_TOKEN: 's3cret' });
    // Injection precedes --ignore-user-config: the injected servers are the ONLY servers.
    expect(codex.argv.indexOf('--ignore-user-config')).toBeGreaterThan(
      codex.argv.findIndex((a) => a.startsWith('mcp_servers.codebase.command')),
    );
    const claude = judgeCliFor(argvFor('sonnet'), SERVERS);
    expect(claude.codex).toBe(false);
    expect(claude.argv.join(' ')).not.toContain('mcp_servers');
  });
});
