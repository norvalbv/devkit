import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { isJsonObject, isJsonString, parseJson, } from '../../comment-firewall/types.mjs';
import { withoutGitEnv } from '../judge-isolation.mjs';
const BASELINE_SERVER_NAMES = ['codebase', 'context7', 'autonomous_bugs'];
// Claude Code matches server-wide MCP permissions with the explicit `__*` suffix.
// A bare `mcp__<server>` is an exact tool name, not a namespace grant.
const BASELINE_TOOL_PREFIXES = BASELINE_SERVER_NAMES.map((name) => `mcp__${name}__*`);
const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';
const REGISTRY_ENV = 'DEVKIT_JUDGE_MCP_CONFIG';
const registryCache = new Map();
const warned = new Set();
function warnOnce(key, message) {
    if (warned.has(key))
        return;
    warned.add(key);
    console.error(message);
}
function isInside(root, candidate) {
    const rel = path.relative(root, candidate);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function trustedRegistryPath(requested, cwd, explicit, projectRoots = []) {
    try {
        if (!path.isAbsolute(requested))
            return null;
        const entry = lstatSync(requested);
        if (!entry.isFile() || entry.isSymbolicLink())
            return null;
        const processUid = process.getuid?.();
        if (processUid !== undefined && entry.uid !== processUid)
            return null;
        if ((entry.mode & 0o022) !== 0)
            return null;
        const canonical = realpathSync(requested);
        if (explicit && [cwd, ...projectRoots].some((root) => isInside(realpathSync(root), canonical)))
            return null;
        return canonical;
    }
    catch {
        return null;
    }
}
function readRegistry(file) {
    try {
        const stat = statSync(file);
        const stamp = `${stat.mtimeMs}:${stat.size}`;
        const cached = registryCache.get(file);
        if (cached?.stamp === stamp)
            return cached.value;
        const parsed = parseJson(readFileSync(file, 'utf8'));
        const value = isJsonObject(parsed) ? parsed : null;
        registryCache.set(file, { stamp, value });
        return value;
    }
    catch {
        return null;
    }
}
function validServer(value) {
    if (!isJsonObject(value) || value.disabled === true)
        return null;
    const command = value.command;
    const url = value.url;
    if (!isJsonString(command) && !isJsonString(url))
        return null;
    const { disabled: _disabled, ...server } = value;
    return server;
}
function serverTable(value) {
    if (!isJsonObject(value))
        return {};
    const result = {};
    for (const [name, server] of Object.entries(value)) {
        const valid = validServer(server);
        if (valid)
            result[name] = valid;
    }
    return result;
}
function primaryCheckoutRoot(cwd, env) {
    try {
        const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, env: withoutGitEnv(env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (!common || path.basename(common) !== '.git')
            return null;
        return realpathSync(path.dirname(common));
    }
    catch {
        return null;
    }
}
function projectCandidates(cwd, env, supplied) {
    const candidates = supplied ?? [cwd, primaryCheckoutRoot(cwd, env)].filter(Boolean);
    const result = [];
    for (const candidate of candidates) {
        if (!candidate)
            continue;
        try {
            const canonical = realpathSync(candidate);
            if (!result.includes(canonical))
                result.push(canonical);
        }
        catch {
            const resolved = path.resolve(candidate);
            if (!result.includes(resolved))
                result.push(resolved);
        }
    }
    return result;
}
function selectedServers(registry, serverNames, roots) {
    const selected = {};
    const rootServers = serverTable(registry.mcpServers);
    const projects = isJsonObject(registry.projects) ? registry.projects : {};
    const projectRows = roots.map((root) => projects[root]).filter(isJsonObject);
    for (const name of serverNames) {
        let server = rootServers[name] ?? null;
        for (const project of projectRows) {
            const disabled = Array.isArray(project.disabledMcpServers) ? project.disabledMcpServers : [];
            if (disabled.includes(name)) {
                server = null;
                continue;
            }
            const projectServer = serverTable(project.mcpServers)[name];
            if (projectServer)
                server = projectServer;
        }
        if (server)
            selected[name] = server;
    }
    return selected;
}
export function namedAgentMcpProfile() {
    return {
        kind: 'named-agent',
        serverNames: BASELINE_SERVER_NAMES,
    };
}
export function withNamedAgentMcpTools(tools, ...extraTools) {
    const values = [tools, ...BASELINE_TOOL_PREFIXES, ...extraTools]
        .flatMap((value) => value.split(','))
        .map((value) => value.trim())
        .filter(Boolean);
    return [...new Set(values)].join(',');
}
/**
 * Stable, secret-safe cache partition for the capabilities a named judge can actually receive.
 * The digest includes the declared tool set, trusted registry location, and selected definitions;
 * cache entries therefore never survive a capability change, while secret-bearing config is never
 * written to the cache itself.
 */
export function judgeMcpCapabilityFingerprint(profile, allowedTools, options) {
    const env = options.env ?? process.env;
    const explicit = options.registryPath !== undefined || env[REGISTRY_ENV] !== undefined;
    const requested = options.registryPath ?? env[REGISTRY_ENV] ?? path.join(homedir(), '.claude.json');
    const registryPath = trustedRegistryPath(requested, options.cwd, explicit, options.projectRoots);
    const registry = registryPath ? readRegistry(registryPath) : null;
    const servers = profile.kind === 'named-agent' && registry
        ? selectedServers(registry, profile.serverNames, projectCandidates(options.cwd, env, options.projectRoots))
        : {};
    return capabilityFingerprint(profile, allowedTools, registryPath ?? requested, servers);
}
function capabilityFingerprint(profile, allowedTools, registryPath, servers) {
    return createHash('sha256')
        .update(JSON.stringify({ allowedTools, profile, registryPath, servers }))
        .digest('hex');
}
function emptyProfile(capabilityFingerprint) {
    return {
        args: ['--mcp-config', EMPTY_MCP_CONFIG, '--strict-mcp-config'],
        serverNames: [],
        servers: {},
        capabilityFingerprint,
        cleanup: () => { },
    };
}
export function prepareJudgeMcpProfile(profile, options) {
    const allowedTools = options.allowedTools ?? '';
    if (profile.kind === 'none')
        return emptyProfile(judgeMcpCapabilityFingerprint(profile, allowedTools, options));
    const env = options.env ?? process.env;
    const explicit = options.registryPath !== undefined || env[REGISTRY_ENV] !== undefined;
    const requested = options.registryPath ?? env[REGISTRY_ENV] ?? path.join(homedir(), '.claude.json');
    const registryPath = trustedRegistryPath(requested, options.cwd, explicit, options.projectRoots);
    if (!registryPath) {
        warnOnce(`registry:${requested}`, `guard-review: trusted MCP registry unavailable at ${requested} — named agents continue with strict-empty MCP isolation`);
        return emptyProfile(capabilityFingerprint(profile, allowedTools, requested, {}));
    }
    const registry = readRegistry(registryPath);
    if (!registry) {
        warnOnce(`registry-json:${registryPath}`, 'guard-review: trusted MCP registry is unreadable — named agents continue with strict-empty MCP isolation');
        return emptyProfile(capabilityFingerprint(profile, allowedTools, registryPath, {}));
    }
    const roots = projectCandidates(options.cwd, env, options.projectRoots);
    const servers = selectedServers(registry, profile.serverNames, roots);
    const present = Object.keys(servers);
    const missing = profile.serverNames.filter((name) => !present.includes(name));
    if (missing.length > 0)
        warnOnce(`missing:${registryPath}:${missing.join(',')}`, `guard-review: named-agent MCP profile missing ${missing.join(', ')} — continuing with the configured subset under strict isolation`);
    if (present.length === 0)
        return emptyProfile(capabilityFingerprint(profile, allowedTools, registryPath, {}));
    let directory = null;
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
            cleanup: () => rmSync(privateDirectory, { recursive: true, force: true }),
        };
    }
    catch {
        if (directory)
            rmSync(directory, { recursive: true, force: true });
        warnOnce('temporary-config', 'guard-review: private MCP profile file could not be created — named agents continue with strict-empty MCP isolation');
        return emptyProfile(capabilityFingerprint(profile, allowedTools, registryPath, {}));
    }
}
