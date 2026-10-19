/** True when the runtime representation is a real string (a JSON number/object is not its own
 * template image) — the same untrusted-boundary idiom gate-engine/config.mts uses. */
const isStr = (v) => v != null && `${v}` === v;
const MCP_NAME_RE = /^[\w-]+$/;
const tomlStr = (v) => JSON.stringify(v);
/**
 * Translate the judge's prepared MCP server map into codex-native per-invocation config
 * (`-c mcp_servers.*`). Hermeticity holds: with --ignore-user-config the injected
 * servers are the ONLY servers (codex's twin of --strict-mcp-config). Secrets never ride argv:
 * env VALUES go into the spawn environment and are forwarded by NAME via `env_vars` (codex
 * starts server children env_clear'ed, so nothing else leaks through). The claude
 * `--allowedTools mcp__<server>__<tool>` grants map onto `enabled_tools` — `mcp__<server>__*`
 * grants every tool; a server with NO grant is not injected at all.
 */
export function codexMcpArgs(servers, allowedTools, 
// The judge's own spawn env: one namespace with the servers', so a server redefining a key collides.
judgeEnv = {}) {
    const argv = [];
    const extraEnv = { ...judgeEnv };
    const injected = [];
    for (const [name, def] of Object.entries(servers)) {
        if (!MCP_NAME_RE.test(name)) {
            console.error(`codex judge: mcp server name ${JSON.stringify(name)} not addressable via -c — skipped`);
            continue;
        }
        const grants = (allowedTools ?? [])
            .filter((t) => t.startsWith(`mcp__${name}__`))
            .map((t) => t.slice(`mcp__${name}__`.length));
        if (allowedTools !== null && grants.length === 0)
            continue; // no grant → do not inject
        if (!isStr(def.command) || def.command === '') {
            // A url-typed server the claude profile admits is not yet expressible on the codex path
            // (StreamableHttp mapping unverified against the pinned binary) — a VISIBLE opt-out, never
            // a silent one: the judge runs without this server and the operator can see why.
            if (isStr(def.url))
                console.error(`codex judge: mcp server ${name} is url-typed — not yet mapped to codex config; judge runs without it`);
            continue;
        }
        // Buffered per server: a server that turns out inexpressible (env collision) must leave NO
        // trace in argv — a half-injected server is worse than an absent one.
        const serverArgv = ['-c', `mcp_servers.${name}.command=${tomlStr(def.command)}`];
        const serverEnv = {};
        const args = Array.isArray(def.args) ? def.args.filter(isStr) : [];
        if (args.length > 0)
            serverArgv.push('-c', `mcp_servers.${name}.args=[${args.map(tomlStr).join(',')}]`);
        let expressible = true;
        if (def.env && !Array.isArray(def.env)) {
            const names = [];
            for (const [key, value] of Object.entries(def.env)) {
                if (!isStr(value))
                    continue;
                if (key in extraEnv && extraEnv[key] !== value) {
                    console.error(`codex judge: mcp env ${key} collides with another server or the judge — ${name} skipped`);
                    expressible = false;
                    break;
                }
                serverEnv[key] = value;
                names.push(key);
            }
            if (expressible && names.length > 0)
                serverArgv.push('-c', `mcp_servers.${name}.env_vars=[${names.map(tomlStr).join(',')}]`);
        }
        if (!expressible)
            continue;
        if (grants.length > 0 && !grants.includes('*'))
            serverArgv.push('-c', `mcp_servers.${name}.enabled_tools=[${grants.map(tomlStr).join(',')}]`);
        serverArgv.push('-c', `mcp_servers.${name}.startup_timeout_sec=10`);
        // Exec's approval policy is `never`, so an unapproved MCP call is refused; a grant is the approval.
        if (allowedTools !== null)
            serverArgv.push('-c', `mcp_servers.${name}.default_tools_approval_mode="approve"`);
        argv.push(...serverArgv);
        Object.assign(extraEnv, serverEnv);
        injected.push(name);
    }
    return { argv, extraEnv, injected };
}
