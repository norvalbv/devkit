import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  judgeMcpCapabilityFingerprint,
  judgeMcpMissingServers,
  mcpDegradedCause,
  mcpSpawnTracker,
  namedAgentMcpProfile,
  prepareJudgeMcpProfile,
  reportMissingMcpServers,
  spawnDegradedCause,
  withNamedAgentMcpTools,
} from '../mcp/profile.mts';

const root = mkdtempSync(path.join(tmpdir(), 'judge-mcp-profile-'));
const repo = path.join(root, 'repo');
const registry = path.join(root, 'registry.json');
mkdirSync(repo);

interface RegistryFixtureOverrides {
  projects?: {
    [root: string]: {
      mcpServers: {
        [name: string]: {
          type: string;
          command: string;
          args: string[];
        };
      };
    };
  };
}

interface ParsedRegistry {
  mcpServers: object;
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeRegistry(extra: RegistryFixtureOverrides = {}): void {
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
      allowedTools: 'Read',
    });
    const configPath = prepared.args[1];
    const config: ParsedRegistry = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(Object.keys(config.mcpServers).sort()).toEqual([
      'autonomous_bugs',
      'codebase',
      'context7',
    ]);
    expect(config.mcpServers).not.toHaveProperty('unrelated');
    expect(statSync(path.dirname(configPath)).mode & 0o777).toBe(0o700);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(prepared.args.join(' ')).not.toContain('TOKEN_FILE');
    expect(prepared.capabilityFingerprint).toBe(
      judgeMcpCapabilityFingerprint(profile, 'Read', {
        cwd: repo,
        registryPath: registry,
        projectRoots: [repo],
      }),
    );
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
    const config: ParsedRegistry = JSON.parse(readFileSync(prepared.args[1], 'utf8'));
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
    const fixture = path.join(root, 'fixture');
    mkdirSync(fixture);
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
    const fromRepresentedRepo = prepareJudgeMcpProfile(namedAgentMcpProfile(), {
      cwd: fixture,
      projectRoots: [repo],
      registryPath: repositoryConfig,
    });
    expect(fromRepresentedRepo.serverNames).toEqual([]);

    writeRegistry();
    const link = path.join(root, 'registry-link.json');
    symlinkSync(registry, link);
    const fromLink = prepareJudgeMcpProfile(namedAgentMcpProfile(), {
      cwd: repo,
      registryPath: link,
    });
    expect(fromLink.serverNames).toEqual([]);
  });

  it('grants the complete named MCP server namespaces to named agents', () => {
    const tools = withNamedAgentMcpTools('Read,Grep', 'mcp__alternate__query');
    expect(tools.split(',')).toEqual([
      'Read',
      'Grep',
      'mcp__codebase__*',
      'mcp__context7__*',
      'mcp__autonomous_bugs__*',
      'mcp__alternate__query',
    ]);
  });
});

describe('missing-server resolution and reporting (sc-2837)', () => {
  let seq = 0;
  /** A fresh registry FILE per test: the warning dedupes per registry state per process. */
  function freshRegistry(text: string): string {
    const file = path.join(root, `registry-${process.pid}-${seq++}.json`);
    writeFileSync(file, text, { mode: 0o600 });
    return file;
  }
  const withServers = (...names: string[]) =>
    freshRegistry(
      JSON.stringify({
        mcpServers: Object.fromEntries(names.map((n) => [n, { type: 'stdio', command: n }])),
      }),
    );
  let stderr: string[] = [];
  const spyStderr = () => {
    stderr = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      stderr.push(args.join(' '));
    });
  };
  afterEach(() => vi.restoreAllMocks());

  it('names codebase as missing when a project row disables it, though the root defines it', () => {
    const registryPath = freshRegistry(
      JSON.stringify({
        mcpServers: {
          codebase: { command: 'search-code' },
          context7: { command: 'c7' },
          autonomous_bugs: { command: 'bugs' },
        },
        projects: { [realpathSync(repo)]: { disabledMcpServers: ['codebase'] } },
      }),
    );
    const res = judgeMcpMissingServers(namedAgentMcpProfile(), {
      cwd: repo,
      registryPath,
      projectRoots: [repo],
    });
    expect(res).toMatchObject({ kind: 'resolved', missing: ['codebase'] });
    expect(mcpDegradedCause(res)).toBe(
      'MCP codebase unavailable (missing from the trusted MCP registry) — reviewer ran without codebase search',
    );
  });

  it.each([
    ['unavailable (no such file)', () => path.join(root, 'never-written.json'), 'unavailable'],
    ['unreadable (corrupt JSON)', () => freshRegistry('{ nope'), 'unreadable'],
    ['unreadable (JSON array, not an object)', () => freshRegistry('[]'), 'unreadable'],
  ] as const)('%s: every requested server is missing, so the run is DEGRADED', (_, mk, kind) => {
    const res = judgeMcpMissingServers(namedAgentMcpProfile(), {
      cwd: repo,
      registryPath: mk(),
      projectRoots: [repo],
    });
    expect(res.kind).toBe(kind);
    expect(res.missing).toEqual(['codebase', 'context7', 'autonomous_bugs']);
    expect(mcpDegradedCause(res)).toMatch(/^MCP codebase unavailable \(trusted MCP registry/);
  });

  it('a pure judge (kind none) is never missing anything', () => {
    const res = judgeMcpMissingServers(
      { kind: 'none' },
      { cwd: repo, registryPath: withServers() },
    );
    expect(res.missing).toEqual([]);
    expect(mcpDegradedCause(res)).toBeUndefined();
  });

  it('a complete registry reports nothing and carries no cause', () => {
    spyStderr();
    const res = judgeMcpMissingServers(namedAgentMcpProfile(), {
      cwd: repo,
      registryPath: withServers('codebase', 'context7', 'autonomous_bugs'),
      projectRoots: [repo],
    });
    reportMissingMcpServers(res, ['commit-guard']);
    expect(res.missing).toEqual([]);
    expect(mcpDegradedCause(res)).toBeUndefined();
    expect(stderr).toEqual([]);
  });

  it('only non-verdict servers missing: names the agents, no ⚠️, no DEGRADED, no cause', () => {
    spyStderr();
    const res = judgeMcpMissingServers(namedAgentMcpProfile(), {
      cwd: repo,
      registryPath: withServers('codebase'),
      projectRoots: [repo],
    });
    reportMissingMcpServers(res, ['commit-guard', 'correctness-reviewer']);
    expect(mcpDegradedCause(res)).toBeUndefined();
    expect(stderr).toEqual([
      'guard-review: no MCP context7, autonomous_bugs for commit-guard, correctness-reviewer (missing from the trusted MCP registry) — continuing under strict isolation',
    ]);
  });

  it('an agent-named report silences the later anonymous per-spawn line for the same state', () => {
    spyStderr();
    const registryPath = withServers('context7');
    const options = { cwd: repo, registryPath, projectRoots: [repo], temporaryRoot: root };
    reportMissingMcpServers(judgeMcpMissingServers(namedAgentMcpProfile(), options), [
      'commit-guard',
    ]);
    const prepared = prepareJudgeMcpProfile(namedAgentMcpProfile(), options);
    prepared.cleanup();
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(
      /^⚠️ {2}guard-review: DEGRADED — no MCP codebase, autonomous_bugs for commit-guard /,
    );
  });

  it('with no agent report first, the per-spawn warning still carries ⚠️ and DEGRADED', () => {
    spyStderr();
    const prepared = prepareJudgeMcpProfile(namedAgentMcpProfile(), {
      cwd: repo,
      registryPath: withServers('context7', 'autonomous_bugs'),
      projectRoots: [repo],
      temporaryRoot: root,
    });
    prepared.cleanup();
    expect(stderr).toEqual([
      '⚠️  guard-review: named-agent MCP profile missing codebase — continuing with the configured subset under strict isolation — DEGRADED',
    ]);
  });

  it('a registry edited mid-process to lose a DIFFERENT server warns again (new state, new key)', () => {
    spyStderr();
    const registryPath = withServers('codebase', 'context7');
    const options = { cwd: repo, registryPath, projectRoots: [repo] };
    reportMissingMcpServers(judgeMcpMissingServers(namedAgentMcpProfile(), options), ['a']);
    writeFileSync(
      registryPath,
      JSON.stringify({
        mcpServers: { context7: { command: 'c7' }, autonomous_bugs: { command: 'b' } },
      }),
      { mode: 0o600 },
    );
    // Bump mtime past the registry cache's stamp resolution so the edit is observed.
    const later = new Date(Date.now() + 5000);
    utimesSync(registryPath, later, later);
    reportMissingMcpServers(judgeMcpMissingServers(namedAgentMcpProfile(), options), ['a']);
    expect(stderr).toHaveLength(2);
    expect(stderr[1]).toContain('DEGRADED — no MCP codebase for a ');
  });

  // The run-level read can disagree with what a spawn actually gets (review finding on sc-2837): the
  // prepared profile carries its OWN cause, which the cascade prefers.
  it('a spawn whose private profile file cannot be written carries its own DEGRADED cause', () => {
    spyStderr();
    const prepared = prepareJudgeMcpProfile(namedAgentMcpProfile(), {
      cwd: repo,
      registryPath: withServers('codebase', 'context7', 'autonomous_bugs'),
      projectRoots: [repo],
      temporaryRoot: path.join(root, 'no-such-dir', 'deeper'),
    });
    expect(prepared.serverNames).toEqual([]);
    // Its warning carries the same markers as every other degraded path (2nd ship review).
    expect(stderr).toContainEqual(
      expect.stringMatching(
        /^⚠️ {2}guard-review: private MCP profile file could not be created .* — DEGRADED$/,
      ),
    );
    expect(prepared.degradedCause).toBe(
      'MCP codebase unavailable (private MCP profile file could not be created) — reviewer ran without codebase search',
    );
  });

  it.each([
    ['all present', ['codebase', 'context7', 'autonomous_bugs'], undefined],
    ['codebase missing', ['context7'], /^MCP codebase unavailable \(missing from/],
    ['only autonomous_bugs missing', ['codebase', 'context7'], undefined],
  ] as const)('a prepared profile with %s carries the matching cause', (_, servers, cause) => {
    spyStderr();
    const prepared = prepareJudgeMcpProfile(namedAgentMcpProfile(), {
      cwd: repo,
      registryPath: withServers(...servers),
      projectRoots: [repo],
      temporaryRoot: root,
    });
    prepared.cleanup();
    if (cause === undefined) expect(prepared.degradedCause).toBeUndefined();
    else expect(prepared.degradedCause).toMatch(cause);
  });

  it('a pure judge profile never carries a cause', () => {
    expect(prepareJudgeMcpProfile({ kind: 'none' }, { cwd: repo }).degradedCause).toBeUndefined();
  });

  it.each([
    ['no spawn observed', [], 'same'],
    ['spawn matched the expected capabilities', [[undefined, 'EXPECTED']], 'same'],
    [
      'spawn differs with no cause: an unexplained registry race',
      [[undefined, 'OTHER']],
      'unexplained',
    ],
    ['spawn differs because it is degraded', [['CAUSE', 'OTHER']], 'degraded-spawn'],
  ] as const)('mcpSpawnTracker drift: %s', (_, spawns, expected) => {
    const tracker = mcpSpawnTracker(undefined, 'EXPECTED');
    for (const [cause, fingerprint] of spawns) tracker.observe(cause, fingerprint);
    expect(tracker.drift()).toBe(expected);
  });

  it('mcpSpawnTracker drift: a clean spawn after a degraded gate-start read is a recovery', () => {
    const tracker = mcpSpawnTracker('RUN-LEVEL CAUSE', 'EXPECTED');
    tracker.observe(undefined, 'OTHER');
    expect(tracker.drift()).toBe('recovered');
    expect(tracker.cause()).toBeUndefined();
  });

  it.each([
    ['profile cause wins', 'PROFILE', ['codebase'], undefined, /^PROFILE$/],
    [
      'claude path (no injection report) keeps the profile',
      undefined,
      ['codebase'],
      undefined,
      undefined,
    ],
    [
      'codex dropped codebase',
      undefined,
      ['codebase', 'context7'],
      ['context7'],
      /^MCP codebase unavailable \(dropped by the codex judge config/,
    ],
    ['codex dropped only context7', undefined, ['codebase', 'context7'], ['codebase'], undefined],
  ] as const)('spawnDegradedCause: %s', (_, degradedCause, serverNames, injected, expected) => {
    const cause = spawnDegradedCause({ degradedCause, serverNames: [...serverNames] }, injected);
    if (expected === undefined) expect(cause).toBeUndefined();
    else expect(cause).toMatch(expected);
  });

  it.each([
    ['no spawn reported (stub exec)', 'RUN', [], 'RUN'],
    ['a clean spawn clears a stale run-level cause', 'RUN', [undefined], undefined],
    ['a degraded spawn wins over a clean run-level read', undefined, ['SPAWN'], 'SPAWN'],
    [
      'first spawn clean, escalation degraded: still degraded',
      undefined,
      [undefined, 'SPAWN'],
      'SPAWN',
    ],
  ] as const)('mcpSpawnTracker: %s', (_, runLevel, spawns, expected) => {
    const tracker = mcpSpawnTracker(runLevel);
    for (const cause of spawns) tracker.observe(cause);
    expect(tracker.cause()).toBe(expected);
  });

  // completeness compares the precomputed fingerprint with the one observed at spawn and SKIPS on a
  // mismatch, so the resolver refactor must keep the two byte-identical on every degraded path too.
  it.each([
    ['missing subset', () => withServers('context7')],
    ['unavailable', () => path.join(root, 'absent-again.json')],
    ['unreadable', () => freshRegistry('nope')],
  ] as const)('precomputed and spawn-time fingerprints agree on the %s path', (_, mk) => {
    spyStderr();
    const options = { cwd: repo, registryPath: mk(), projectRoots: [repo], temporaryRoot: root };
    const prepared = prepareJudgeMcpProfile(namedAgentMcpProfile(), {
      ...options,
      allowedTools: 'Read',
    });
    prepared.cleanup();
    expect(prepared.capabilityFingerprint).toBe(
      judgeMcpCapabilityFingerprint(namedAgentMcpProfile(), 'Read', options),
    );
  });
});
