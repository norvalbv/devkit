import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  judgeMcpCapabilityFingerprint,
  namedAgentMcpProfile,
  prepareJudgeMcpProfile,
  withNamedAgentMcpTools,
} from '../mcp/profile.mts';

const root = mkdtempSync(path.join(tmpdir(), 'judge-mcp-profile-'));
const repo = path.join(root, 'repo');
const registry = path.join(root, 'registry.json');
mkdirSync(repo);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeRegistry(extra: Record<string, unknown> = {}): void {
  writeFileSync(
    registry,
    JSON.stringify({
      mcpServers: {
        context7: { type: 'stdio', command: 'context7', args: [] },
        autonomous_bugs: { type: 'stdio', command: 'bugs', env: { TOKEN_FILE: '/secret/path' } },
        unrelated: { type: 'stdio', command: 'heavy-server' },
      },
      projects: {
        [realpathSync(repo)]: {
          mcpServers: {
            codebase: { type: 'stdio', command: 'search-code', args: ['mcp'] },
            alternate: { type: 'http', url: 'https://example.test/mcp' },
          },
        },
      },
      ...extra,
    }),
    { mode: 0o600 },
  );
}

describe('judge MCP profiles', () => {
  it('uses a strict empty config without reading any registry for pure judges', () => {
    const prepared = prepareJudgeMcpProfile({ kind: 'none' }, { cwd: repo });
    expect(prepared.args).toEqual(['--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config']);
    expect(prepared.serverNames).toEqual([]);
  });

  it('selects only baseline servers from a trusted machine registry', () => {
    writeRegistry();
    const profile = namedAgentMcpProfile();
    const prepared = prepareJudgeMcpProfile(profile, {
      cwd: repo,
      registryPath: registry,
      projectRoots: [repo],
      temporaryRoot: root,
    });
    const configPath = prepared.args[1] as string;
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(config.mcpServers).sort()).toEqual([
      'autonomous_bugs',
      'codebase',
      'context7',
    ]);
    expect(config.mcpServers).not.toHaveProperty('unrelated');
    expect(statSync(path.dirname(configPath)).mode & 0o777).toBe(0o700);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(prepared.args.join(' ')).not.toContain('TOKEN_FILE');
    prepared.cleanup();
    expect(() => statSync(configPath)).toThrow();
  });

  it('does not let an allowed repository-configured tool activate another MCP server', () => {
    writeRegistry();
    const profile = namedAgentMcpProfile();
    const prepared = prepareJudgeMcpProfile(profile, {
      cwd: repo,
      registryPath: registry,
      projectRoots: [repo],
      temporaryRoot: root,
    });
    const config = JSON.parse(readFileSync(prepared.args[1] as string, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(withNamedAgentMcpTools('Read', 'mcp__alternate__query')).toContain(
      'mcp__alternate__query',
    );
    expect(config.mcpServers).not.toHaveProperty('alternate');
    prepared.cleanup();
  });

  it('changes the capability fingerprint when a selected trusted server definition changes', () => {
    writeRegistry();
    const options = { cwd: repo, registryPath: registry, projectRoots: [repo] };
    const first = judgeMcpCapabilityFingerprint(namedAgentMcpProfile(), 'Read', options);
    writeRegistry({
      projects: {
        [realpathSync(repo)]: {
          mcpServers: { codebase: { type: 'stdio', command: 'search-code', args: ['mcp', 'v2'] } },
        },
      },
    });
    expect(judgeMcpCapabilityFingerprint(namedAgentMcpProfile(), 'Read', options)).not.toBe(first);
  });

  it('never trusts a repository-controlled config or a symlinked override', () => {
    const repositoryConfig = path.join(repo, '.mcp.json');
    writeFileSync(
      repositoryConfig,
      JSON.stringify({ mcpServers: { codebase: { command: 'malicious' } } }),
      { mode: 0o600 },
    );
    const fromRepo = prepareJudgeMcpProfile(namedAgentMcpProfile(), {
      cwd: repo,
      registryPath: repositoryConfig,
    });
    expect(fromRepo.serverNames).toEqual([]);

    writeRegistry();
    const link = path.join(root, 'registry-link.json');
    symlinkSync(registry, link);
    const fromLink = prepareJudgeMcpProfile(namedAgentMcpProfile(), {
      cwd: repo,
      registryPath: link,
    });
    expect(fromLink.serverNames).toEqual([]);
  });

  it('grants the complete autonomous_bugs server namespace to named agents', () => {
    const tools = withNamedAgentMcpTools('Read,Grep', 'mcp__alternate__query');
    expect(tools.split(',')).toEqual(
      expect.arrayContaining([
        'Read',
        'Grep',
        'mcp__codebase',
        'mcp__context7',
        'mcp__autonomous_bugs',
        'mcp__alternate__query',
      ]),
    );
  });
});
