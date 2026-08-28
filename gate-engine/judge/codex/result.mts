/**
 * `codex exec --json` support: how devkit runs a judge on an OpenAI Codex subscription instead of
 * the `claude` CLI. Routing is BY MODEL ID — a `gpt-*` model (e.g. `gpt-5.6-sol`) spawns
 * `codex exec`; every other id keeps the claude path byte-for-byte, so execJudge's five callers
 * never change their argv. Since sc-2054 the gpt path is the SHIPPED DEFAULT (review.model in
 * gate-engine/config.mts), with MCP profiles injected codex-natively and staged-tree tamper
 * detection standing in for claude's tool-allowlist confinement. It originated as a bench-only seam (sc-2048).
 *
 * Why: ship-gate judge volume drains the owner's Claude subscription while the Codex subscription
 * has headroom (sc-2048). The two CLIs are near-isomorphic for a headless judge — prompt as argv,
 * evidence on stdin (codex appends piped stdin as a `<stdin>` block), JSON result envelope carrying
 * the final message and token usage — so the seam is argv translation + envelope parsing, not a
 * second judge pipeline.
 */

import { type JudgeUsage, withResultArgs } from '../claude-result.mts';

// ── the `codex exec --json` event contract ──────────────────────────────────────────────────────
// One ThreadEvent per stdout line (codex-rs/exec/src/exec_events.rs). Only the fields devkit reads
// are declared, and every one is optional so a foreign or truncated line degrades to a no-op event
// — a judge that works must never start failing because its accounting could not be read. The
// shape is pinned by a fixture captured VERBATIM from a real codex-cli 0.149 run (see the tests).

interface CodexEventItem {
  type?: string;
  text?: string;
}

interface CodexUsagePayload {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

interface CodexErrorPayload {
  message?: string;
}

interface CodexEvent {
  type?: string;
  item?: CodexEventItem;
  usage?: CodexUsagePayload;
  error?: CodexErrorPayload;
  message?: string;
}

/** Parse the JSONL stream ONCE at the I/O boundary; the verdict/usage/failure readers below all
 * branch on these domain events rather than re-scanning raw lines. */
function codexEventsOf(raw: string): CodexEvent[] {
  const events: CodexEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      // SAFETY: `codex exec --json` prints one ThreadEvent object per line
      // (codex-rs/exec/src/exec_events.rs); all fields are declared optional above, so a line that
      // is JSON but not a ThreadEvent reads as an event no consumer matches.
      events.push(JSON.parse(trimmed) as CodexEvent);
    } catch {
      // Non-JSON noise on stdout — skipped, mirroring unwrapClaudeResult's fail-safe contract.
    }
  }
  return events;
}

/** The routing predicate: OpenAI model ids are `gpt-*`; anything else stays on the claude path. */
export function isCodexModel(model: string | null): boolean {
  return model !== null && model.startsWith('gpt-');
}

/**
 * Claude judge argv comes in exactly two caller shapes (factory: `-p --model m <policy…> PROMPT`;
 * review gate: `-p PROMPT --model m <policy…>`), so extraction must not assume prompt position:
 * a non-flag token right after `-p` is the prompt, otherwise the trailing positional is.
 *
 * Every claude value-flag a judge caller uses MUST be listed here: an omitted one is skipped as a
 * bare flag and its VALUE is misread as the positional prompt. `--append-system-prompt` (the eval
 * harnesses' agent-brief seam) was the near-miss: omitting it would have run a gpt judge with no
 * brief while the bench still recorded agentHash as if the brief were used — a corrupted, not
 * failed, measurement.
 */
const VALUE_FLAGS = new Set([
  '--model',
  '--settings',
  '--allowedTools',
  '--disallowedTools',
  '--output-format',
  '--append-system-prompt',
]);

export interface ClaudeArgvParts {
  model: string | null;
  prompt: string | null;
  /** `--append-system-prompt`'s payload (an agent brief). Codex exec has no system-prompt flag, so
   * the closest analog is prepending the brief to the prompt — see codexExecArgs. */
  systemPrompt: string | null;
  /** `--disallowedTools *` (JUDGE_READ_ONLY) maps to codex's read-only sandbox; an investigating
   * judge (`--allowedTools …`) needs workspace-write so it can run the checklist script (codex
   * cannot confine cwd — its writable-roots only ADD). The claude tool-allowlist's cannot-write
   * contract is replaced by run-review's staged-tree tamper detection (sc-2054). */
  readOnly: boolean;
  /** The claude `--allowedTools` grants, comma-split — the codex path maps `mcp__<server>__…`
   * entries onto per-server `enabled_tools` allowlists (sc-2054). */
  allowedTools: string[] | null;
}

/** What an actual CLI option looks like (`-x`, `--kebab-or_snake`). A judge PROMPT may also start
 * with '-' (a markdown-bullet brief) but then carries spaces/punctuation no option name has. */
const CLI_OPTION_RE = /^--?[\w-]+$/;

export function parseClaudeArgv(args: string[]): ClaudeArgvParts {
  let model: string | null = null;
  let prompt: string | null = null;
  let systemPrompt: string | null = null;
  let readOnly = false;
  let allowedTools: string[] | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '-p') {
      // Same rule as the trailing positional below: prompt TEXT may open on a dash (a markdown
      // bullet), so only a token that actually looks like a CLI option is refused here —
      // `startsWith('-')` alone silently dropped a dash-led prompt in this caller shape too.
      const next = args[i + 1];
      if (next !== undefined && !CLI_OPTION_RE.test(next)) {
        prompt = next;
        i += 1;
      }
      continue;
    }
    if (VALUE_FLAGS.has(token)) {
      if (token === '--model') model = args[i + 1] ?? null;
      if (token === '--append-system-prompt') systemPrompt = args[i + 1] ?? null;
      if (token === '--disallowedTools') readOnly = true;
      if (token === '--allowedTools')
        allowedTools = (args[i + 1] ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
      i += 1;
      continue;
    }
    if (token.startsWith('-')) {
      // The trailing positional is ALLOWED to start with '-' (a prompt opening on a markdown
      // bullet): a dash-led LAST token that is not flag-shaped is that prompt, not an option —
      // skipping it would leave prompt=null and misreport a working judge as an outage.
      if (prompt === null && i === args.length - 1 && !CLI_OPTION_RE.test(token)) prompt = token;
      continue;
    }
    prompt = token;
  }
  return { model, prompt, systemPrompt, readOnly, allowedTools };
}

/**
 * Translate a claude judge argv into the equivalent `codex exec` argv. Hermetic on purpose:
 * `--ignore-user-config` (auth still works, but the owner's MCP servers / notify hooks / desktop
 * integrations must not load into a judge), `--ignore-rules` (nor user execpolicy), `--ephemeral`
 * (the codex twin of `--no-session-persistence`), `--skip-git-repo-check` (bench scratch dirs are
 * not always repos). Evidence still arrives on stdin — codex appends it as a `<stdin>` block.
 */
/** Reasoning efforts codex accepts for `model_reasoning_effort` (codex-rs config). */
const REASONING_EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh']);

/** A judge model spec split into the codex model id and its optional reasoning effort. */
export interface ModelSpec {
  model: string;
  effort: string | null;
}

/**
 * `gpt-5.6-terra@high` → `{ model: 'gpt-5.6-terra', effort: 'high' }`; a bare id carries no
 * effort. Judges run `--ignore-user-config`, so a configured effort never applies — the suffix is
 * the ONLY way a spec reaches `-c model_reasoning_effort`. An unknown effort throws rather than
 * spawning at the wrong effort: the spec is config-owned (guard.config.json / GUARD_* envs), and a
 * silently-dropped suffix would make the judge look like the benched condition while not being it.
 */
export function parseModelSpec(spec: string): ModelSpec {
  const at = spec.lastIndexOf('@');
  if (at < 0) return { model: spec, effort: null };
  const model = spec.slice(0, at);
  const effort = spec.slice(at + 1);
  if (model === '' || model.includes('@') || !REASONING_EFFORTS.has(effort))
    throw new Error(
      `codex judge: unknown reasoning effort ${JSON.stringify(effort)} in model spec ${JSON.stringify(spec)} — expected <model>@${[...REASONING_EFFORTS].join('|')}`,
    );
  return { model, effort };
}

export function codexExecArgs(parts: ClaudeArgvParts, mcpArgv: string[] = []): string[] {
  if (!parts.model || !parts.prompt)
    throw new Error('codex judge: argv carries no --model or no prompt — cannot translate');
  const spec = parseModelSpec(parts.model);
  // Codex exec has no system-prompt flag: an agent brief (`--append-system-prompt`) is prepended
  // to the prompt instead. A labeled block, so the model sees the brief/task boundary the two
  // claude message slots used to provide.
  const prompt = parts.systemPrompt
    ? `<agent-brief>\n${parts.systemPrompt}\n</agent-brief>\n\n${parts.prompt}`
    : parts.prompt;
  // `--json` is the same flag OpenAI's own SDK spawns as `--experimental-json` (an alias,
  // codex-rs/exec/src/cli.rs) — machine-readable but not promised frozen, which is why the parsers
  // here are pinned by a captured fixture and a failure-event test. Web search is disabled the way
  // the vendor SDK does it (`-c` override): no claude judge ever had a web tool, and a judge must
  // not browse.
  const argv = ['exec', '--model', spec.model];
  // TOML string, the same quoting the bench's effort wrappers used (`-c model_reasoning_effort="high"`).
  if (spec.effort !== null)
    argv.push('-c', `model_reasoning_effort=${JSON.stringify(spec.effort)}`);
  argv.push(
    '--sandbox',
    parts.readOnly ? 'read-only' : 'workspace-write',
    '-c',
    'web_search="disabled"',
    ...mcpArgv,
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--ephemeral',
    '--color',
    'never',
    '--json',
    prompt,
  );
  return argv;
}

export interface JudgeCli {
  bin: string;
  argv: string[];
  codex: boolean;
  /** Env additions for the judge SPAWN (mcp secret forwarding — values never ride argv). */
  extraEnv?: Record<string, string>;
}

/** One MCP server definition as the judge registry stores it (claude mcpServers shape). Typed as
 * EXPECTED at the JSON boundary — values are re-checked by representation below, never trusted
 * (the registry is a user-editable file). */
export interface CodexMcpServerDef {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

/** The codex-native translation of a judge MCP profile: `-c` argv plus spawn-env additions. */
export interface CodexMcpInjection {
  argv: string[];
  extraEnv: Record<string, string>;
}

/** True when the runtime representation is a real string (a JSON number/object is not its own
 * template image) — the same untrusted-boundary idiom gate-engine/config.mts uses. */
const isStr = (v: string | undefined): v is string => v != null && `${v}` === v;

const MCP_NAME_RE = /^[\w-]+$/;
const tomlStr = (v: string): string => JSON.stringify(v);

/**
 * Translate the judge's prepared MCP server map into codex-native per-invocation config
 * (`-c mcp_servers.*`, sc-2054). Hermeticity holds: with --ignore-user-config the injected
 * servers are the ONLY servers (codex's twin of --strict-mcp-config). Secrets never ride argv:
 * env VALUES go into the spawn environment and are forwarded by NAME via `env_vars` (codex
 * starts server children env_clear'ed, so nothing else leaks through). The claude
 * `--allowedTools mcp__<server>__<tool>` grants map onto `enabled_tools` — `mcp__<server>__*`
 * grants every tool; a server with NO grant is not injected at all.
 */
export function codexMcpArgs(
  servers: Record<string, CodexMcpServerDef>,
  allowedTools: string[] | null,
): CodexMcpInjection {
  const argv: string[] = [];
  const extraEnv: Record<string, string> = {};
  for (const [name, def] of Object.entries(servers)) {
    if (!MCP_NAME_RE.test(name)) {
      console.error(
        `codex judge: mcp server name ${JSON.stringify(name)} not addressable via -c — skipped`,
      );
      continue;
    }
    const grants = (allowedTools ?? [])
      .filter((t) => t.startsWith(`mcp__${name}__`))
      .map((t) => t.slice(`mcp__${name}__`.length));
    if (allowedTools !== null && grants.length === 0) continue; // no grant → do not inject
    if (!isStr(def.command) || def.command === '') {
      // A url-typed server the claude profile admits is not yet expressible on the codex path
      // (StreamableHttp mapping unverified against the pinned binary) — a VISIBLE opt-out, never
      // a silent one: the judge runs without this server and the operator can see why.
      if (isStr(def.url))
        console.error(
          `codex judge: mcp server ${name} is url-typed — not yet mapped to codex config; judge runs without it`,
        );
      continue;
    }
    // Buffered per server: a server that turns out inexpressible (env collision) must leave NO
    // trace in argv — a half-injected server is worse than an absent one.
    const serverArgv: string[] = ['-c', `mcp_servers.${name}.command=${tomlStr(def.command)}`];
    const serverEnv: Record<string, string> = {};
    const args = Array.isArray(def.args) ? def.args.filter(isStr) : [];
    if (args.length > 0)
      serverArgv.push('-c', `mcp_servers.${name}.args=[${args.map(tomlStr).join(',')}]`);
    let expressible = true;
    if (def.env && !Array.isArray(def.env)) {
      const names: string[] = [];
      for (const [key, value] of Object.entries(def.env)) {
        if (!isStr(value)) continue;
        if (key in extraEnv && extraEnv[key] !== value) {
          console.error(`codex judge: mcp env ${key} collides across servers — ${name} skipped`);
          expressible = false;
          break;
        }
        serverEnv[key] = value;
        names.push(key);
      }
      if (expressible && names.length > 0)
        serverArgv.push('-c', `mcp_servers.${name}.env_vars=[${names.map(tomlStr).join(',')}]`);
    }
    if (!expressible) continue;
    if (grants.length > 0 && !grants.includes('*'))
      serverArgv.push('-c', `mcp_servers.${name}.enabled_tools=[${grants.map(tomlStr).join(',')}]`);
    serverArgv.push('-c', `mcp_servers.${name}.startup_timeout_sec=10`);
    argv.push(...serverArgv);
    Object.assign(extraEnv, serverEnv);
  }
  return { argv, extraEnv };
}

/** The codex binary to spawn: overridable so an operator can pin ONE build when several sit on
 * PATH (measured on this machine: 0.149.0-alpha and 0.146.0 resolve depending on hook PATH
 * order, and the JSONL schema is per-version). */
const codexBin = (): string => process.env.GUARD_CODEX_BIN || 'codex';

/**
 * The ONE routing decision, taken from the caller's untouched claude-shaped argv — every consumer
 * (spawn, outage wording, output parsing) derives from this, so first-vs-last `--model` ambiguity
 * cannot make two call sites disagree about which binary ran. The claude branch reproduces the
 * pre-adapter spawn exactly (withResultArgs included), which the routing test pins.
 */
export function judgeCliFor(
  args: string[],
  mcpServers: Record<string, CodexMcpServerDef> = {},
  // A tool-equipped judge that never WRITES (decision-alignment: Read/Grep/Glob/git diff) maps to
  // codex's read-only sandbox even though its claude argv has no `--disallowedTools *` — without
  // this, routing it to codex silently upgrades it to workspace-write on a gate (decisions) that
  // has no staged-tree tamper detection. Callers assert read-only; the flag never widens access.
  forceReadOnlySandbox = false,
): JudgeCli {
  const parsed = parseClaudeArgv(args);
  const parts = forceReadOnlySandbox ? { ...parsed, readOnly: true } : parsed;
  if (!isCodexModel(parts.model))
    return { bin: 'claude', argv: withResultArgs(args), codex: false };
  const mcp = codexMcpArgs(mcpServers, parts.allowedTools);
  return {
    bin: codexBin(),
    argv: codexExecArgs(parts, mcp.argv),
    codex: true,
    extraEnv: mcp.extraEnv,
  };
}

/** The binary NAME for outage wording — must never throw (it runs inside catch blocks, including
 * when argv translation itself threw), so it derives from the same parse but skips translation. */
export function judgeBinFor(args: string[]): string {
  return judgeBinForModel(parseClaudeArgv(args).model);
}

/** Same contract, keyed on a bare model id — for callers that hold the model, not an argv. */
export function judgeBinForModel(model: string | null): string {
  return isCodexModel(model) ? codexBin() : 'claude';
}

/** The verdict text: the LAST completed `agent_message` in the JSONL stream, or null when none
 * parses — the spawn layer then falls back to the raw bytes, same fail-safe as the claude path. */
export function unwrapCodexResult(raw: string | null): string | null {
  if (raw === null) return null;
  let last: string | null = null;
  for (const event of codexEventsOf(raw)) {
    if (event.type !== 'item.completed' || event.item?.type !== 'agent_message') continue;
    const text = event.item.text;
    if (text !== undefined && text.trim()) last = text;
  }
  return last;
}

/**
 * A terminal failure event, or null on a healthy stream. `turn.failed` (error.message) and the
 * top-level `error` event (message) are first-class in codex's taxonomy
 * (codex-rs/exec/src/exec_events.rs: TurnFailedEvent, ThreadErrorEvent) — a stream carrying one
 * must land on the OUTAGE path, never fall through to "no agent_message → raw JSONL as verdict,
 * outcome ok", which is how the naive parsers in the wild get it wrong.
 */
export function codexFailure(raw: string | null): string | null {
  if (raw === null) return null;
  let failure: string | null = null;
  for (const event of codexEventsOf(raw)) {
    if (event.type === 'turn.failed') failure = event.error?.message ?? 'turn.failed';
    else if (event.type === 'error') failure = event.message ?? 'error event';
  }
  return failure;
}

/** A subscription-billed judge's spend: `cost_usd` is 0 because no per-call price exists (never
 * because the judge was free) — the marker lets cost aggregates EXCLUDE these rows instead of
 * summing a fabricated zero. Declared here, not on JudgeUsage, so the claude envelope module
 * stays untouched by provider concerns. */
export interface CodexJudgeUsage extends JudgeUsage {
  billing: 'subscription';
}

const count = (value?: number): number =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0;

/**
 * Spend from the LAST `turn.completed` event, mapped onto the collector's claude-shaped columns:
 * codex's `input_tokens` INCLUDES the cached portion — codex's own accessor is
 * `non_cached_input() = (input_tokens - cached_input()).max(0)` (codex-rs/protocol/src/protocol.rs)
 * — while claude's excludes it, so the cached slice is subtracted to keep `input_tokens` meaning
 * "uncached input" in every row; reasoning tokens are billed output and fold into `output_tokens`.
 * Null when no usage event parses — never a zero-filled row (see parseJudgeUsage on why).
 */
export function parseCodexUsage(raw: string | null): CodexJudgeUsage | null {
  if (raw === null) return null;
  let usage: CodexUsagePayload | null = null;
  for (const event of codexEventsOf(raw))
    if (event.type === 'turn.completed' && event.usage) usage = event.usage;
  if (!usage) return null;
  const input = count(usage.input_tokens);
  const cached = count(usage.cached_input_tokens);
  return {
    input_tokens: Math.max(0, input - cached),
    output_tokens: count(usage.output_tokens) + count(usage.reasoning_output_tokens),
    cache_creation: count(usage.cache_write_input_tokens),
    cache_read: cached,
    cost_usd: 0,
    billing: 'subscription',
  };
}
