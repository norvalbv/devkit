import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import {
  isJsonObject,
  isJsonString,
  parseJson,
  type JsonObject,
  type JsonValue,
} from '../../comment-firewall/types.mts';
import { withoutGitEnv } from '../judge-isolation.mts';

const BASELINE_SERVER_NAMES = ['codebase', 'context7', 'autonomous_bugs'] as const;
// Claude Code matches server-wide MCP permissions with the explicit `__*` suffix.
// A bare `mcp__<server>` is an exact tool name, not a namespace grant.
const BASELINE_TOOL_PREFIXES = BASELINE_SERVER_NAMES.map((name) => `mcp__${name}__*`);
const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';
const REGISTRY_ENV = 'DEVKIT_JUDGE_MCP_CONFIG';

type JsonRecord = JsonObject;

interface McpServers {
  [name: string]: JsonRecord;
}

interface RegistryCacheEntry {
  stamp: string;
  value: JsonRecord | null;
}

const registryCache = new Map<string, RegistryCacheEntry>();
const warned = new Set<string>();

export interface NamedAgentMcpProfile {
  kind: 'named-agent';
  serverNames: readonly string[];
}

export type JudgeMcpProfile = { kind: 'none' } | NamedAgentMcpProfile;

export interface PreparedJudgeMcpProfile {
  args: string[];
  serverNames: string[];
  /** The selected server definitions themselves — the codex path translates these into
   * `-c mcp_servers.*` config (sc-2054) instead of the claude --mcp-config flags in `args`. */
  servers: McpServers;
  /** Secret-safe identity of the exact server definitions prepared for this spawn. */
  capabilityFingerprint: string;
  /** Set when THIS spawn runs without a verdict-bearing server (sc-2837) — the spawn's own truth. */
  degradedCause?: string;
  cleanup: () => void;
}

export interface PrepareJudgeMcpOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  registryPath?: string;
  projectRoots?: readonly string[];
  temporaryRoot?: string;
  /** Exact caller tool grants; included in the prepared capability identity when supplied. */
  allowedTools?: string;
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.error(message);
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function trustedRegistryPath(
  requested: string,
  cwd: string,
  explicit: boolean,
  projectRoots: readonly string[] = [],
): string | null {
  try {
    if (!path.isAbsolute(requested)) return null;
    const entry = lstatSync(requested);
    if (!entry.isFile() || entry.isSymbolicLink()) return null;
    const processUid = process.getuid?.();
    if (processUid !== undefined && entry.uid !== processUid) return null;
    if ((entry.mode & 0o022) !== 0) return null;
    const canonical = realpathSync(requested);
    if (explicit && [cwd, ...projectRoots].some((root) => isInside(realpathSync(root), canonical)))
      return null;
    return canonical;
  } catch {
    return null;
  }
}

function readRegistry(file: string): JsonRecord | null {
  try {
    const stat = statSync(file);
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    const cached = registryCache.get(file);
    if (cached?.stamp === stamp) return cached.value;
    const parsed = parseJson(readFileSync(file, 'utf8'));
    const value = isJsonObject(parsed) ? parsed : null;
    registryCache.set(file, { stamp, value });
    return value;
  } catch {
    return null;
  }
}

function validServer(value: JsonValue): JsonRecord | null {
  if (!isJsonObject(value) || value.disabled === true) return null;
  const command = value.command;
  const url = value.url;
  if (!isJsonString(command) && !isJsonString(url)) return null;
  const { disabled: _disabled, ...server } = value;
  return server;
}

function serverTable(value: JsonValue) {
  if (!isJsonObject(value)) return {};
  const result: McpServers = {};
  for (const [name, server] of Object.entries(value)) {
    const valid = validServer(server);
    if (valid) result[name] = valid;
  }
  return result;
}

function primaryCheckoutRoot(cwd: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd, env: withoutGitEnv(env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!common || path.basename(common) !== '.git') return null;
    return realpathSync(path.dirname(common));
  } catch {
    return null;
  }
}

function projectCandidates(
  cwd: string,
  env: NodeJS.ProcessEnv,
  supplied?: readonly string[],
): string[] {
  const candidates = supplied ?? [cwd, primaryCheckoutRoot(cwd, env)].filter(Boolean);
  const result: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const canonical = realpathSync(candidate);
      if (!result.includes(canonical)) result.push(canonical);
    } catch {
      const resolved = path.resolve(candidate);
      if (!result.includes(resolved)) result.push(resolved);
    }
  }
  return result;
}

function selectedServers(
  registry: JsonRecord,
  serverNames: readonly string[],
  roots: readonly string[],
) {
  const selected: McpServers = {};
  const rootServers = serverTable(registry.mcpServers);
  const projects = isJsonObject(registry.projects) ? registry.projects : {};
  const projectRows = roots.map((root) => projects[root]).filter(isJsonObject);

  for (const name of serverNames) {
    let server: JsonRecord | null = rootServers[name] ?? null;
    for (const project of projectRows) {
      const disabled = Array.isArray(project.disabledMcpServers) ? project.disabledMcpServers : [];
      if (disabled.includes(name)) {
        server = null;
        continue;
      }
      const projectServer = serverTable(project.mcpServers)[name];
      if (projectServer) server = projectServer;
    }
    if (server) selected[name] = server;
  }
  return selected;
}

export function namedAgentMcpProfile(): NamedAgentMcpProfile {
  return {
    kind: 'named-agent',
    serverNames: BASELINE_SERVER_NAMES,
  };
}

export function withNamedAgentMcpTools(tools: string, ...extraTools: string[]): string {
  const values = [tools, ...BASELINE_TOOL_PREFIXES, ...extraTools]
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values)].join(',');
}

/** Servers whose absence weakens a reviewer's VERDICT (sc-2837); the others are only narrated.
 * Why codebase alone: the judge-mcp-profiles decision note of 2026-10-01. */
export const VERDICT_BEARING_SERVER_NAMES: readonly string[] = ['codebase'];

/** Where a profile's servers resolved from, and which of them did not — computed without spawning. */
export interface JudgeMcpResolution {
  kind: 'unavailable' | 'unreadable' | 'resolved';
  /** The canonical trusted registry, or the requested path when it is not trustable. */
  registryPath: string;
  servers: McpServers;
  /** Requested servers the spawn will NOT receive; every one of them when there is no registry. */
  missing: string[];
  /** One warning identity per registry state, shared by every caller in this process. */
  warnKey: string;
}

function resolveJudgeMcp(
  serverNames: readonly string[],
  options: PrepareJudgeMcpOptions,
): JudgeMcpResolution {
  const env = options.env ?? process.env;
  const explicit = options.registryPath !== undefined || env[REGISTRY_ENV] !== undefined;
  const requested =
    options.registryPath ?? env[REGISTRY_ENV] ?? path.join(homedir(), '.claude.json');
  const registryPath = trustedRegistryPath(requested, options.cwd, explicit, options.projectRoots);
  if (!registryPath)
    return {
      kind: 'unavailable',
      registryPath: requested,
      servers: {},
      missing: [...serverNames],
      warnKey: `registry:${requested}`,
    };
  const registry = readRegistry(registryPath);
  if (!registry)
    return {
      kind: 'unreadable',
      registryPath,
      servers: {},
      missing: [...serverNames],
      warnKey: `registry-json:${registryPath}`,
    };
  const servers =
    serverNames.length === 0
      ? {}
      : selectedServers(
          registry,
          serverNames,
          projectCandidates(options.cwd, env, options.projectRoots),
        );
  const missing = serverNames.filter((name) => !Object.hasOwn(servers, name));
  return {
    kind: 'resolved',
    registryPath,
    servers,
    missing,
    warnKey: `missing:${registryPath}:${missing.join(',')}`,
  };
}

/** Which of a profile's servers a judge spawned now would run without (sc-2837). */
export function judgeMcpMissingServers(
  profile: JudgeMcpProfile,
  options: PrepareJudgeMcpOptions,
): JudgeMcpResolution {
  return resolveJudgeMcp(profile.kind === 'named-agent' ? profile.serverNames : [], options);
}

/** The verdict-bearing servers in a missing set — non-empty means a PASS is DEGRADED. */
export function verdictBearingMissing(resolution: Pick<JudgeMcpResolution, 'missing'>): string[] {
  return resolution.missing.filter((name) => VERDICT_BEARING_SERVER_NAMES.includes(name));
}

function missingReason(resolution: JudgeMcpResolution): string {
  if (resolution.kind === 'unavailable')
    return `trusted MCP registry unavailable at ${resolution.registryPath}`;
  if (resolution.kind === 'unreadable') return 'trusted MCP registry is unreadable';
  return 'missing from the trusted MCP registry';
}

/** One-line cause a DEGRADED reviewer verdict carries, or undefined when nothing verdict-bearing is
 * missing. */
export function mcpDegradedCause(resolution: JudgeMcpResolution): string | undefined {
  return degradedCauseFor(resolution.missing, missingReason(resolution));
}

function degradedCauseFor(missing: readonly string[], reason: string): string | undefined {
  const lost = verdictBearingMissing({ missing: [...missing] });
  if (lost.length === 0) return undefined;
  return `MCP ${lost.join(', ')} unavailable (${reason}) — reviewer ran without codebase search`;
}

/** A spawn's own cause: its profile's, else a verdict-bearing server the codex translation dropped
 * (`injected` is codex-only; url-typed or env-colliding servers are not expressible there). */
export function spawnDegradedCause(
  prepared: Pick<PreparedJudgeMcpProfile, 'degradedCause' | 'serverNames'>,
  injected?: readonly string[],
): string | undefined {
  if (prepared.degradedCause !== undefined || injected === undefined) return prepared.degradedCause;
  const dropped = prepared.serverNames.filter((name) => !injected.includes(name));
  return degradedCauseFor(
    dropped,
    'dropped by the codex judge config — url-typed or inexpressible',
  );
}

/** Folds the MCP cause across one verdict's judge spawns: once any spawn reports, the spawns decide —
 * a clean spawn clears a stale run-level cause, and any degraded spawn degrades the verdict. */
export function mcpSpawnTracker(runLevelCause?: string, expectedFingerprint?: string) {
  let spawned = false;
  let spawnCause: string | undefined;
  let fingerprint: string | undefined;
  return {
    observe: (degradedCause?: string, spawnFingerprint?: string) => {
      spawned = true;
      spawnCause ??= degradedCause;
      fingerprint = spawnFingerprint;
    },
    cause: () => (spawned ? spawnCause : runLevelCause),
    /** Did the spawn get other capabilities than expected? A degraded spawn, or a clean one after a
     * degraded gate-start read (registry repaired), explains its own change. */
    drift: () => {
      if (fingerprint === undefined || fingerprint === expectedFingerprint) return 'same';
      if (spawnCause !== undefined) return 'degraded-spawn';
      return runLevelCause === undefined ? 'unexplained' : 'recovered';
    },
  };
}

/** The reviewer fleet's gate-start read: every cascade judge gets the same baseline profile, so one
 * resolution names them all, and the per-spawn warning shares its key and stays silent. */
export function reportFleetMcp(
  cwd: string,
  env: NodeJS.ProcessEnv,
  tasks: readonly { base: { reviewer: { name: string } } }[],
): string | undefined {
  const resolution = judgeMcpMissingServers(namedAgentMcpProfile(), { cwd, env });
  reportMissingMcpServers(resolution, [...new Set(tasks.map((t) => t.base.reviewer.name))]);
  return mcpDegradedCause(resolution);
}

/** Narrate the run-level state for `agents` (when one was read), then track their spawns from it. */
export function trackMcpSpawns(
  resolution: JudgeMcpResolution | undefined,
  agents: string[],
  expectedFingerprint?: string,
) {
  if (resolution) reportMissingMcpServers(resolution, agents);
  return mcpSpawnTracker(resolution && mcpDegradedCause(resolution), expectedFingerprint);
}

/** Narrate a missing-server state once per registry state per process; a caller naming the agents
 * goes first, so the per-spawn call shares its key and stays silent. Codebase gaps carry ⚠️ DEGRADED. */
export function reportMissingMcpServers(
  resolution: JudgeMcpResolution,
  agents: readonly string[] = [],
): void {
  if (resolution.missing.length === 0) return;
  const degraded = verdictBearingMissing(resolution).length > 0;
  const marker = degraded ? '⚠️  ' : '';
  const servers = resolution.missing.join(', ');
  if (agents.length > 0) {
    warnOnce(
      resolution.warnKey,
      degraded
        ? `${marker}guard-review: DEGRADED — no MCP ${servers} for ${agents.join(', ')} (${missingReason(resolution)}) under strict isolation; a judged PASS from them is marked DEGRADED`
        : `guard-review: no MCP ${servers} for ${agents.join(', ')} (${missingReason(resolution)}) — continuing under strict isolation`,
    );
    return;
  }
  const suffix = degraded ? ' — DEGRADED' : '';
  if (resolution.kind === 'unavailable')
    warnOnce(
      resolution.warnKey,
      `${marker}guard-review: trusted MCP registry unavailable at ${resolution.registryPath} — named agents continue with strict-empty MCP isolation${suffix}`,
    );
  else if (resolution.kind === 'unreadable')
    warnOnce(
      resolution.warnKey,
      `${marker}guard-review: trusted MCP registry is unreadable — named agents continue with strict-empty MCP isolation${suffix}`,
    );
  else
    warnOnce(
      resolution.warnKey,
      `${marker}guard-review: named-agent MCP profile missing ${servers} — continuing with the configured subset under strict isolation${suffix}`,
    );
}

/** Secret-safe cache partition over the declared tools, trusted registry and selected server
 * definitions: an entry never survives a capability change, and no secret reaches the cache. */
export function judgeMcpCapabilityFingerprint(
  profile: JudgeMcpProfile,
  allowedTools: string,
  options: PrepareJudgeMcpOptions,
): string {
  const resolution = judgeMcpMissingServers(profile, options);
  return capabilityFingerprint(profile, allowedTools, resolution.registryPath, resolution.servers);
}

function capabilityFingerprint(
  profile: JudgeMcpProfile,
  allowedTools: string,
  registryPath: string,
  servers: McpServers,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ allowedTools, profile, registryPath, servers }))
    .digest('hex');
}

function emptyProfile(
  capabilityFingerprint: string,
  degradedCause?: string,
): PreparedJudgeMcpProfile {
  return {
    args: ['--mcp-config', EMPTY_MCP_CONFIG, '--strict-mcp-config'],
    serverNames: [],
    servers: {},
    capabilityFingerprint,
    degradedCause,
    cleanup: () => {},
  };
}

export function prepareJudgeMcpProfile(
  profile: JudgeMcpProfile,
  options: PrepareJudgeMcpOptions,
): PreparedJudgeMcpProfile {
  const allowedTools = options.allowedTools ?? '';
  if (profile.kind === 'none')
    return emptyProfile(judgeMcpCapabilityFingerprint(profile, allowedTools, options));

  const resolution = judgeMcpMissingServers(profile, options);
  const { registryPath, servers } = resolution;
  reportMissingMcpServers(resolution);
  const present = Object.keys(servers);
  const degradedCause = mcpDegradedCause(resolution);
  if (present.length === 0)
    return emptyProfile(
      capabilityFingerprint(profile, allowedTools, registryPath, {}),
      degradedCause,
    );

  let directory: string | null = null;
  try {
    directory = mkdtempSync(path.join(options.temporaryRoot ?? tmpdir(), 'devkit-judge-mcp-'));
    chmodSync(directory, 0o700);
    const file = path.join(directory, 'mcp.json');
    writeFileSync(file, `${JSON.stringify({ mcpServers: servers })}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    const privateDirectory = directory;
    return {
      args: ['--mcp-config', file, '--strict-mcp-config'],
      serverNames: present,
      servers,
      capabilityFingerprint: capabilityFingerprint(profile, allowedTools, registryPath, servers),
      degradedCause,
      cleanup: () => rmSync(privateDirectory, { recursive: true, force: true }),
    };
  } catch {
    if (directory) rmSync(directory, { recursive: true, force: true });
    // Every requested server is lost here, whatever the registry held.
    const lostCause = degradedCauseFor(
      profile.serverNames,
      'private MCP profile file could not be created',
    );
    warnOnce(
      'temporary-config',
      `${lostCause ? '⚠️  ' : ''}guard-review: private MCP profile file could not be created — named agents continue with strict-empty MCP isolation${lostCause ? ' — DEGRADED' : ''}`,
    );
    return emptyProfile(capabilityFingerprint(profile, allowedTools, registryPath, {}), lostCause);
  }
}
