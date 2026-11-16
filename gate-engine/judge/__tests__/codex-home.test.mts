/**
 * A codex judge never runs in the owner's CODEX_HOME: codex injects `$CODEX_HOME/AGENTS.md` into
 * every prompt, so a judge gets a devkit-owned home that shares only the owner's auth.json.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureCodexJudgeHome } from '../codex/home.mts';
import { prepareCodexSandbox } from '../codex/workspace.mts';
import { namedAgentMcpProfile, withNamedAgentMcpTools } from '../mcp/profile.mts';
import { execJudge, execJudgeAsync, type JudgeOutage } from '../run-judge.mts';

const READ_ONLY = ['-p', '--model', 'gpt-5.6-sol', '--disallowedTools', '*', 'P'];
const INVESTIGATING = ['-p', 'P', '--model', 'gpt-5.6-sol', '--allowedTools', 'Read,Grep'];
const ENV_KEYS = [
  'HOME',
  'CODEX_HOME',
  'GUARD_CODEX_BIN',
  'DEVKIT_NO_TELEMETRY',
  'DEVKIT_GATE_EVENTS',
  'DEVKIT_JUDGE_MCP_CONFIG',
  'TMPDIR',
];
const saved: Record<string, string | undefined> = {};
let dir: string;
let owner: string;
let repo: string;

const judgeHome = () => path.join(homedir(), '.devkit', 'codex-judge-home');

/** A codex stand-in that records its CODEX_HOME, that home's listing and auth link, and its argv. */
function fakeCodex(): string {
  const record = path.join(dir, 'record');
  const bin = path.join(dir, 'codex');
  writeFileSync(
    bin,
    `#!/bin/sh\ncat >/dev/null\n{ echo "$CODEX_HOME"; readlink "$CODEX_HOME/auth.json"; ls -A "$CODEX_HOME" | tr "\\n" " "; echo; for a; do echo "ARG:$a"; done; } > '${record}'\necho VERDICT\n`,
  );
  chmodSync(bin, 0o755);
  process.env.GUARD_CODEX_BIN = bin;
  return record;
}

function spawned(record: string) {
  const [home, link, ls, ...rest] = readFileSync(record, 'utf8').split('\n');
  const args = rest.filter((l) => l.startsWith('ARG:')).map((l) => l.slice(4));
  return { home, link, listing: ls.trim().split(' '), args };
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.DEVKIT_NO_TELEMETRY = '1';
  delete process.env.DEVKIT_GATE_EVENTS;
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'codex-home-')));
  owner = path.join(dir, 'owner-codex');
  mkdirSync(owner);
  writeFileSync(path.join(owner, 'auth.json'), '{}');
  writeFileSync(path.join(owner, 'AGENTS.md'), 'SENTINEL_OWNER_INSTRUCTIONS\n');
  process.env.CODEX_HOME = owner;
  repo = path.join(dir, 'repo');
  mkdirSync(repo);
  // The judge home lands under this test's own dir, never a shared or real HOME.
  process.env.HOME = path.join(dir, 'home');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('ensureCodexJudgeHome', () => {
  it('creates the home under ~/.devkit holding only an auth.json link to the owner file', () => {
    const home = ensureCodexJudgeHome({ CODEX_HOME: owner });
    expect(home).toBe(judgeHome());
    expect(readdirSync(home)).toEqual(['auth.json']);
    expect(readlinkSync(path.join(home, 'auth.json'))).toBe(path.join(owner, 'auth.json'));
  });

  it('links a missing owner auth anyway, and leaves a correct link untouched', () => {
    const fresh = path.join(dir, 'not-logged-in');
    const link = path.join(ensureCodexJudgeHome({ CODEX_HOME: fresh }), 'auth.json');
    expect(readlinkSync(link)).toBe(path.join(fresh, 'auth.json'));
    const before = lstatSync(link).ino;
    for (let i = 0; i < 20; i++) ensureCodexJudgeHome({ CODEX_HOME: fresh });
    expect(lstatSync(link).ino).toBe(before);
  });

  it('re-points the link when the owner home changes', () => {
    ensureCodexJudgeHome({ CODEX_HOME: owner });
    const other = path.join(dir, 'other');
    const link = path.join(ensureCodexJudgeHome({ CODEX_HOME: other }), 'auth.json');
    expect(readlinkSync(link)).toBe(path.join(other, 'auth.json'));
    expect(readdirSync(judgeHome())).toEqual(['auth.json']);
  });

  it('keeps a regular auth.json from a login made in the judge home', () => {
    mkdirSync(judgeHome(), { recursive: true });
    writeFileSync(path.join(judgeHome(), 'auth.json'), '{"fresh":true}');
    ensureCodexJudgeHome({ CODEX_HOME: owner });
    expect(readFileSync(path.join(judgeHome(), 'auth.json'), 'utf8')).toBe('{"fresh":true}');
  });

  it('never links the judge home to itself, however its path is spelled', () => {
    // HOME reached through a symlink, as macOS /var → /private/var does.
    mkdirSync(path.join(dir, 'home'));
    process.env.HOME = path.join(dir, 'alias');
    symlinkSync(path.join(dir, 'home'), process.env.HOME);
    const real = path.join(dir, 'home', '.devkit', 'codex-judge-home');
    for (const spelling of [judgeHome(), `${judgeHome()}/`, real]) {
      ensureCodexJudgeHome({ CODEX_HOME: spelling });
      expect(
        lstatSync(path.join(judgeHome(), 'auth.json'), { throwIfNoEntry: false }),
      ).toBeUndefined();
    }
  });

  it('resolves a relative CODEX_HOME to an absolute target, and falls back to $HOME/.codex', () => {
    const link = path.join(judgeHome(), 'auth.json');
    ensureCodexJudgeHome({ CODEX_HOME: 'rel-codex' });
    expect(readlinkSync(link)).toBe(path.resolve('rel-codex', 'auth.json'));
    ensureCodexJudgeHome({ HOME: dir });
    expect(readlinkSync(link)).toBe(path.join(dir, '.codex', 'auth.json'));
    // codex treats an empty CODEX_HOME as unset (utils/home-dir); `??` here would link <cwd>/auth.json.
    ensureCodexJudgeHome({ CODEX_HOME: '', HOME: owner });
    expect(readlinkSync(link)).toBe(path.join(owner, '.codex', 'auth.json'));
  });
});

describe('prepareCodexSandbox', () => {
  it('gives every codex judge the judge home, and a claude judge nothing', () => {
    for (const args of [READ_ONLY, INVESTIGATING]) {
      const sandbox = prepareCodexSandbox(args, false, repo, { CODEX_HOME: owner });
      expect(sandbox.env).toEqual({ CODEX_HOME: judgeHome() });
      sandbox.cleanup();
    }
    const claude = prepareCodexSandbox(['-p', '--model', 'sonnet', 'P'], false, repo);
    expect(claude.env).toBeUndefined();
  });
});

describe('a spawned codex judge', () => {
  const opts = (args: string[]) => ({
    label: 'review:x',
    args,
    input: 'diff',
    timeout: 30000,
    cwd: repo,
    transcript: false,
  });

  it('sees the judge home, not the owner instructions, on both twins and in both sandboxes', async () => {
    const record = fakeCodex();
    for (const args of [READ_ONLY, INVESTIGATING]) {
      for (const run of [() => execJudge(opts(args)), () => execJudgeAsync(opts(args))]) {
        expect((await run())?.trim()).toBe('VERDICT');
        const seen = spawned(record);
        expect(seen.home).toBe(judgeHome());
        expect(seen.link).toBe(path.join(owner, 'auth.json'));
        expect(seen.listing).toEqual(['auth.json']);
        expect(seen.args).toContain('skills.include_instructions=false');
      }
    }
  });

  it('takes the owner home from the caller env rather than process.env', () => {
    const record = fakeCodex();
    const elsewhere = path.join(dir, 'caller-codex');
    execJudge({ ...opts(READ_ONLY), env: { ...process.env, CODEX_HOME: elsewhere } });
    expect(spawned(record).link).toBe(path.join(elsewhere, 'auth.json'));
  });

  it('keeps the judge home when an MCP server env forwards CODEX_HOME', async () => {
    const registry = path.join(dir, 'registry.json');
    const server = { type: 'stdio', command: 'node', env: { CODEX_HOME: owner } };
    writeFileSync(registry, JSON.stringify({ mcpServers: { codebase: server } }), { mode: 0o600 });
    process.env.DEVKIT_JUDGE_MCP_CONFIG = registry;
    const record = fakeCodex();
    const tools = withNamedAgentMcpTools('Read');
    const args = ['-p', 'P', '--model', 'gpt-5.6-sol', '--allowedTools', tools];
    await execJudgeAsync({ ...opts(args), mcpProfile: namedAgentMcpProfile() });
    const seen = spawned(record);
    expect(seen.args.join(' ')).toContain('mcp_servers.codebase.env_vars=["CODEX_HOME"]');
    expect(seen.home).toBe(judgeHome());
  });

  // The home is made before mkdtemp; reordering leaks a scratch dir per failed spawn.
  it('is an outage on both twins when the home cannot be made, leaving no scratch dir', async () => {
    const record = fakeCodex();
    mkdirSync(path.dirname(judgeHome()), { recursive: true });
    writeFileSync(judgeHome(), 'not a directory');
    process.env.TMPDIR = mkdtempSync(path.join(dir, 'tmp-'));
    const outages: JudgeOutage[] = [];
    const run = { ...opts(INVESTIGATING), onOutage: (o: JudgeOutage) => outages.push(o) };
    expect(execJudge(run)).toBeNull();
    expect(await execJudgeAsync(run)).toBeNull();
    expect(outages).toHaveLength(2);
    expect(existsSync(record)).toBe(false);
    expect(readdirSync(process.env.TMPDIR)).toEqual([]);
  });
});
