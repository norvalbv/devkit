/**
 * A workspace-write codex judge must not be able to write the consumer's checkout: its cwd is a
 * scratch dir, only `<repo>/.claude` is granted, and the scratch dir never outlives the spawn.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexExecArgs, judgeCliFor, NO_TEST_RUNS } from '../codex/result.mts';
import { prepareCodexSandbox } from '../codex/workspace.mts';
import { execJudge, execJudgeAsync, type JudgeOutage } from '../run-judge.mts';

const INVESTIGATING = ['-p', 'P', '--model', 'gpt-5.6-sol', '--allowedTools', 'Read,Grep'];
const READ_ONLY = ['-p', '--model', 'gpt-5.6-sol', '--disallowedTools', '*', 'P'];
const ENV_KEYS = ['GUARD_CODEX_BIN', 'DEVKIT_NO_TELEMETRY', 'DEVKIT_GATE_EVENTS'];
const saved: Record<string, string | undefined> = {};
let dir: string;
let repo: string;

const argAfter = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

/** A codex stand-in that records its `-C` dir, repo env and that dir's listing, then runs `tail`. */
function fakeCodex(tail = 'echo VERDICT'): string {
  const record = path.join(dir, 'record');
  const bin = path.join(dir, 'codex');
  writeFileSync(
    bin,
    `#!/bin/sh\ncat >/dev/null\nwhile [ $# -gt 0 ]; do [ "$1" = -C ] && S="$2"; shift; done\n{ echo "$S"; echo "$DEVKIT_JUDGE_REPO_ROOT"; echo "$TMPDIR"; ls "$S"; } > '${record}'\n${tail}\n`,
  );
  chmodSync(bin, 0o755);
  process.env.GUARD_CODEX_BIN = bin;
  return record;
}

/** One investigating judge spawn in the fixture repo. */
function judgeOpts(timeout = 30000) {
  return {
    label: 'review:x',
    args: INVESTIGATING,
    input: 'diff',
    timeout,
    cwd: repo,
    transcript: false,
  };
}

/** What the fake codex saw: its `-C` dir, DEVKIT_JUDGE_REPO_ROOT, TMPDIR and that dir's listing. */
function spawned(record: string) {
  const [cwd, repoEnv, tmpEnv, ...rest] = readFileSync(record, 'utf8').split('\n');
  return { cwd, repoEnv, tmpEnv, listing: rest.join('\n') };
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.DEVKIT_NO_TELEMETRY = '1';
  delete process.env.DEVKIT_GATE_EVENTS;
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'codex-workspace-')));
  repo = path.join(dir, 'repo');
  mkdirSync(repo);
  writeFileSync(path.join(repo, 'AGENTS.md'), '# rules\n');
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('codex judge argv — workspace confinement', () => {
  const workspace = { scratch: '/tmp/scratch', repoRoot: '/work/repo' };

  it('runs an investigating judge from scratch, grants only <repo>/.claude, and names the repo', () => {
    const cli = judgeCliFor(INVESTIGATING, {}, false, workspace);
    expect(argAfter(cli.argv, '-C')).toBe('/tmp/scratch');
    expect(argAfter(cli.argv, '--add-dir')).toBe('/work/repo/.claude');
    expect(cli.argv[cli.argv.length - 1]).toMatch(/^The repository under review is \/work\/repo\./);
    expect(cli.argv[cli.argv.length - 1]).toContain(NO_TEST_RUNS);
    expect(cli.argv[cli.argv.length - 1].endsWith('P')).toBe(true);
    expect(cli.extraEnv).toEqual({
      DEVKIT_JUDGE_REPO_ROOT: '/work/repo',
      TMPDIR: '/tmp/scratch',
      TMPPREFIX: '/tmp/scratch/zsh',
    });
  });

  // A checkout under /tmp or $TMPDIR stays writable unless both default temp roots are dropped.
  it('drops the /tmp and $TMPDIR writable roots for an investigating judge', () => {
    const argv = judgeCliFor(INVESTIGATING, {}, false, workspace).argv;
    for (const key of ['exclude_slash_tmp', 'exclude_tmpdir_env_var'])
      expect(argv[argv.indexOf(`sandbox_workspace_write.${key}=true`) - 1]).toBe('-c');
  });

  // Codex forwards server env by name from its own env, so a server cannot keep a different value.
  it('skips an MCP server that redefines a confined env key, and keeps the rest', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const servers = {
        tmp: { command: 'x', env: { TMPDIR: '/server/tmp' } },
        root: { command: 'y', env: { DEVKIT_JUDGE_REPO_ROOT: '/elsewhere' } },
        plain: { command: 'z', env: { TOKEN: 't' } },
      };
      const args = [...INVESTIGATING.slice(0, -1), 'Read,mcp__tmp__*,mcp__root__*,mcp__plain__*'];
      const cli = judgeCliFor(args, servers, false, workspace);
      expect(cli.mcpInjected).toEqual(['plain']);
      // A read-only judge redirects nothing, so it must not drop the same servers.
      expect(judgeCliFor(args, servers, true, workspace).mcpInjected).toEqual([
        'tmp',
        'root',
        'plain',
      ]);
      expect(cli.extraEnv).toMatchObject({ TMPDIR: '/tmp/scratch', TOKEN: 't' });
      expect(cli.extraEnv?.DEVKIT_JUDGE_REPO_ROOT).toBe('/work/repo');
      expect(err).toHaveBeenCalledWith(expect.stringContaining('mcp env TMPDIR collides'));
    } finally {
      err.mockRestore();
    }
  });

  it('leaves read-only judges, forced read-only judges and workspace-less calls unchanged', () => {
    const forced = judgeCliFor(INVESTIGATING, {}, true, workspace);
    expect(forced.argv).toEqual(judgeCliFor(INVESTIGATING, {}, true).argv);
    expect(judgeCliFor(READ_ONLY, {}, false, workspace).argv).toEqual(judgeCliFor(READ_ONLY).argv);
    for (const cli of [forced, judgeCliFor(INVESTIGATING)]) {
      expect(cli.argv).not.toContain('-C');
      expect(cli.argv).not.toContain('--add-dir');
      expect(cli.argv.join(' ')).not.toContain('sandbox_workspace_write');
      expect(cli.extraEnv).toEqual({});
    }
    const parts = { model: 'gpt-5.6-sol', prompt: 'P', systemPrompt: null, readOnly: false };
    expect(codexExecArgs({ ...parts, allowedTools: null }).at(-1)).toBe('P');
  });
});

describe('prepareCodexSandbox', () => {
  it('creates a scratch dir carrying the root AGENTS.md, ensures .claude, and removes scratch', () => {
    const sandbox = prepareCodexSandbox(INVESTIGATING, false, repo);
    const scratch = sandbox.workspace?.scratch ?? '';
    expect(sandbox.workspace?.repoRoot).toBe(repo);
    expect(readFileSync(path.join(scratch, 'AGENTS.md'), 'utf8')).toBe('# rules\n');
    expect(existsSync(path.join(repo, '.claude'))).toBe(true);
    sandbox.cleanup();
    expect(existsSync(scratch)).toBe(false);
    expect(() => sandbox.cleanup()).not.toThrow();
  });

  it('refuses a .claude link onto the checkout, allows one outside it', () => {
    symlinkSync('.', path.join(repo, '.claude'));
    expect(() => prepareCodexSandbox(INVESTIGATING, false, repo)).toThrow(
      /make the checkout writable/,
    );
    const projected = path.join(dir, 'main-checkout', '.claude');
    mkdirSync(projected, { recursive: true });
    const other = path.join(dir, 'worktree');
    mkdirSync(other);
    symlinkSync(projected, path.join(other, '.claude'));
    const sandbox = prepareCodexSandbox(INVESTIGATING, false, other);
    expect(sandbox.workspace?.repoRoot).toBe(other);
    sandbox.cleanup();
  });

  // Catches a check that only rejects the checkout itself or its children: `..` grants an ancestor.
  it('refuses a .claude link onto an ancestor of the checkout', () => {
    symlinkSync('..', path.join(repo, '.claude'));
    expect(() => prepareCodexSandbox(INVESTIGATING, false, repo)).toThrow(
      /make the checkout writable/,
    );
  });

  // The reporting swarm's layout: worktrees nested in the main checkout, `.claude` linked to its copy.
  it('allows a nested worktree whose .claude links to the enclosing main checkout', () => {
    mkdirSync(path.join(repo, '.claude'));
    const nested = path.join(repo, '.swarm-worktrees', 'seat-1');
    mkdirSync(nested, { recursive: true });
    symlinkSync(path.join(repo, '.claude'), path.join(nested, '.claude'));
    const sandbox = prepareCodexSandbox(INVESTIGATING, false, nested);
    expect(sandbox.workspace?.repoRoot).toBe(nested);
    sandbox.cleanup();
  });

  // Catches comparing the unresolved cwd with the resolved .claude: through an alias (macOS /tmp and
  // /var are links) a self-link then looks disjoint and is granted, unconfining the checkout.
  it('judges a checkout reached through a symlinked path by its real location', () => {
    const alias = path.join(dir, 'alias');
    symlinkSync(repo, alias);
    const sandbox = prepareCodexSandbox(INVESTIGATING, false, alias);
    expect(sandbox.workspace?.repoRoot).toBe(alias);
    sandbox.cleanup();
    rmSync(path.join(repo, '.claude'), { recursive: true });
    symlinkSync('.', path.join(repo, '.claude'));
    expect(() => prepareCodexSandbox(INVESTIGATING, false, alias)).toThrow(
      /make the checkout writable/,
    );
  });

  it('removes scratch when a present project doc cannot be copied', () => {
    rmSync(path.join(repo, 'AGENTS.md'));
    mkdirSync(path.join(repo, 'AGENTS.md')); // a directory: copyFileSync fails with a non-ENOENT code
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('devkit-judge-')));
    expect(() => prepareCodexSandbox(INVESTIGATING, false, repo)).toThrow();
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith('devkit-judge-'));
    expect(after.filter((n) => !before.has(n))).toEqual([]);
  });

  it('makes no workspace for a read-only, forced read-only or claude judge', () => {
    for (const [args, ro] of [
      [READ_ONLY, false],
      [INVESTIGATING, true],
      [['-p', 'P', '--model', 'sonnet', '--allowedTools', 'Read'], false],
    ] as const)
      expect(prepareCodexSandbox([...args], ro, repo).workspace).toBeUndefined();
  });
});

describe('execJudge — scratch lifecycle around a real spawn', () => {
  it('points codex -C at scratch, never the checkout, and removes scratch on success', () => {
    const record = fakeCodex();
    expect(execJudge(judgeOpts())?.trim()).toBe('VERDICT');
    const run = spawned(record);
    expect(run.cwd).toMatch(/devkit-judge-/);
    expect(run.repoEnv).toBe(repo);
    expect(run.tmpEnv).toBe(run.cwd);
    expect(run.listing).toContain('AGENTS.md');
    expect(existsSync(run.cwd)).toBe(false);
  });

  it('removes scratch after a non-zero exit and after a timeout kill', async () => {
    const failed = fakeCodex('exit 3');
    expect(execJudge(judgeOpts())).toBeNull();
    expect(existsSync(spawned(failed).cwd)).toBe(false);
    const killed = fakeCodex("trap '' TERM\nsleep 5");
    expect(await execJudgeAsync(judgeOpts(500))).toBeNull();
    expect(existsSync(spawned(killed).cwd)).toBe(false);
    // The async twin spawns with the same env: its shell's temp dir is that scratch too.
    expect(spawned(killed).tmpEnv).toBe(spawned(killed).cwd);
  });
});

// Wiring: a refused sandbox must land on both twins' outage path, never throw past them or spawn.
describe('execJudge — a sandbox that cannot be confined', () => {
  it('is an outage on both twins, and codex never runs unconfined', async () => {
    symlinkSync('.', path.join(repo, '.claude'));
    const record = fakeCodex();
    const outages: JudgeOutage[] = [];
    const opts = { ...judgeOpts(), onOutage: (o: JudgeOutage) => outages.push(o) };
    expect(execJudge(opts)).toBeNull();
    expect(await execJudgeAsync(opts)).toBeNull();
    expect(outages).toHaveLength(2);
    expect(existsSync(record)).toBe(false);
  });
});

describe('checklist scripts under a confined judge', () => {
  it('review-roots.mjs moves a script started in scratch into DEVKIT_JUDGE_REPO_ROOT', () => {
    const helper = fileURLToPath(
      new URL('../../../skills/_devkit/review-roots.mjs', import.meta.url),
    );
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(helper)}); console.log(process.cwd())`,
      ],
      { cwd: dir, env: { ...process.env, DEVKIT_JUDGE_REPO_ROOT: repo }, encoding: 'utf8' },
    );
    expect(out.trim()).toBe(repo);
  });
});

describe('the commit-gates skill replay of a workspace-write judge sandbox', () => {
  const skill = fileURLToPath(new URL('../../../skills/commit-gates/SKILL.md', import.meta.url));

  /** Run the skill's documented one-liner from the repo root against a codex stand-in that records its view. */
  function replay() {
    const line = /`(r=\$PWD .*?echo "exit \$\?")`/.exec(readFileSync(skill, 'utf8'))?.[1];
    if (!line) throw new Error('commit-gates SKILL.md lost its codex sandbox one-liner');
    const bin = path.join(dir, 'bin');
    const record = path.join(dir, 'seen');
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, 'codex'),
      `#!/bin/sh\n{ pwd -P; ls -A "$CODEX_HOME" | wc -l; ls; echo "TMP:$(cd "$TMPDIR" && pwd -P) $TMPPREFIX"; for a; do echo "ARG:$a"; done; } > '${record}'\n`,
    );
    chmodSync(path.join(bin, 'codex'), 0o755);
    const out = execFileSync('bash', ['-c', line.replace('<cmd>', 'true')], {
      cwd: repo,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SHELL: '/bin/sh' },
      encoding: 'utf8',
    });
    return { out, seen: readFileSync(record, 'utf8').trim().split('\n') };
  }

  it('grants the same <repo>/.claude root and sandbox mode the judge argv does, not the scratch dir', () => {
    const { out, seen } = replay();
    const judge = judgeCliFor(INVESTIGATING, {}, false, { scratch: '/s', repoRoot: repo }).argv;
    const args = seen.filter((l) => l.startsWith('ARG:')).map((l) => l.slice(4));
    expect(args).toContain(`sandbox_mode="${argAfter(judge, '--sandbox')}"`);
    expect(args).toContain(
      `sandbox_workspace_write.writable_roots=["${argAfter(judge, '--add-dir')}"]`,
    );
    expect(args.slice(-3)).toEqual(['/bin/sh', '-lc', 'true']);
    expect(out.trim()).toBe('exit 0');
    const judgeTmpKeys = judge.filter((a) => a.startsWith('sandbox_workspace_write.exclude_'));
    expect(judgeTmpKeys).toHaveLength(2);
    for (const key of judgeTmpKeys) expect(args).toContain(key);
  });

  it('points the shell temp dirs into the scratch cwd, as the judge env does', () => {
    const [cwd, , ...rest] = replay().seen;
    const tmp = rest
      .find((l) => l.startsWith('TMP:'))
      ?.slice(4)
      .split(' ');
    expect(tmp?.[0]).toBe(cwd);
    expect(tmp?.[1]).toMatch(/\/zsh$/);
  });

  it('runs from a scratch cwd holding the root AGENTS.md, with an empty CODEX_HOME', () => {
    const [cwd, homeEntries, ...listing] = replay().seen;
    expect(cwd).not.toBe(repo);
    expect(listing).toContain('AGENTS.md');
    expect(homeEntries.trim()).toBe('0');
  });
});
