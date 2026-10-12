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

  it('auto-approves exactly the granted servers; a null grant list approves nothing', () => {
    const approval = (name: string) => `mcp_servers.${name}.default_tools_approval_mode="approve"`;
    const granted = codexMcpArgs(SERVERS, ['mcp__codebase__searchCode']).argv;
    expect(granted).toContain(approval('codebase'));
    expect(granted).not.toContain(approval('context7'));
    expect(codexMcpArgs(SERVERS, null).argv.join(' ')).not.toContain('default_tools_approval_mode');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const collide = codexMcpArgs(
        { a: { command: 'x', env: { TOKEN: 'one' } }, b: { command: 'y', env: { TOKEN: 'two' } } },
        ['mcp__a__*', 'mcp__b__*'],
      );
      expect(collide.argv).toContain(approval('a'));
      expect(collide.argv).not.toContain(approval('b'));
    } finally {
      err.mockRestore();
    }
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
      // sc-2837: what was dropped is reported, so the gate can mark the verdict DEGRADED.
      expect(collide.injected).toEqual(['a']);
      expect(dotted.injected).toEqual([]);
      const url = codexMcpArgs(
        { codebase: { url: 'https://x.test/mcp' }, c7: { command: 'x' } },
        null,
      );
      expect(url.injected).toEqual(['c7']);
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

  it("approves a reviewer's wildcard grant end to end, so its MCP calls are not refused", () => {
    // commit-guard's real grant shape; a lost grant parse would revert to "approval policy is never".
    const argv = [...argvFor('gpt-5.6-terra').slice(0, -1), 'Read,mcp__codebase__*'];
    const codex = judgeCliFor(argv, SERVERS);
    expect(codex.argv).toContain('mcp_servers.codebase.default_tools_approval_mode="approve"');
    expect(codex.argv.join(' ')).not.toContain('mcp_servers.codebase.enabled_tools');
    expect(codex.argv.join(' ')).not.toContain('mcp_servers.context7');
  });
});

describe('judgeCliFor MCP injection report (sc-2837)', () => {
  it('names the injected servers on the codex path and leaves the claude path unreported', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const servers = { codebase: { url: 'https://x.test/mcp' }, context7: { command: 'npx' } };
      const args = ['-p', 'x', '--allowedTools', 'mcp__codebase__*,mcp__context7__*'];
      const codex = judgeCliFor([...args, '--model', 'gpt-5.6-sol'], servers);
      expect(codex.codex).toBe(true);
      expect(codex.mcpInjected).toEqual(['context7']);
      expect(judgeCliFor([...args, '--model', 'sonnet'], servers).mcpInjected).toBeUndefined();
    } finally {
      err.mockRestore();
    }
  });
});
