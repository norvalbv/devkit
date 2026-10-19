/**
 * A workspace-write codex judge must not be able to write the consumer's checkout: its cwd is a
 * scratch dir, only its checklist state file is granted, and the scratch dir never outlives the spawn.
 */
import { execFileSync, spawnSync } from 'node:child_process';
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexPermissionArgs } from '../codex/permissions.mts';
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
const STATE = '.claude/.correctness-review.json';

/** A codex stand-in that records its `-C` dir, repo env and that dir's listing, then runs `tail`. */
function fakeCodex(tail = 'echo VERDICT'): string {
  const record = path.join(dir, 'record');
  const bin = path.join(dir, 'codex');
  writeFileSync(
    bin,
    `#!/bin/sh\ncat >/dev/null\nwhile [ $# -gt 0 ]; do [ "$1" = -C ] && S="$2"; shift; done\n{ echo "$S"; echo "$DEVKIT_JUDGE_REPO_ROOT"; ls "$S"; } > '${record}'\n${tail}\n`,
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

/** What the fake codex saw: its `-C` dir, DEVKIT_JUDGE_REPO_ROOT, and that dir's listing. */
function spawned(record: string) {
  const [cwd, repoEnv, ...rest] = readFileSync(record, 'utf8').split('\n');
  return { cwd, repoEnv, listing: rest.join('\n') };
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
  const stateFile = `/work/repo/${STATE}`;
  const workspace = { scratch: '/tmp/scratch', repoRoot: '/work/repo', stateFile };

  // `--sandbox` beside the profile silently wins, restoring a writable checkout.
  it('runs an investigating judge from scratch, grants only its state file, and names the repo', () => {
    const cli = judgeCliFor(INVESTIGATING, {}, false, workspace);
    expect(argAfter(cli.argv, '-C')).toBe('/tmp/scratch');
    expect(cli.argv).not.toContain('--add-dir');
    expect(cli.argv).not.toContain('--sandbox');
    expect(cli.argv.join(' ')).toContain(codexPermissionArgs(workspace).join(' '));
    expect(codexPermissionArgs(workspace)[3]).toBe(
      `permissions.devkit_judge.filesystem={":root"="read",":tmpdir"="write",":slash_tmp"="write","/tmp/scratch"="write","${stateFile}"="write"}`,
    );
    expect(cli.argv[cli.argv.length - 1]).toMatch(/^The repository under review is \/work\/repo\./);
    expect(cli.argv[cli.argv.length - 1]).toContain(`read-only to you except ${stateFile}.`);
    expect(cli.argv[cli.argv.length - 1]).toContain(NO_TEST_RUNS);
    expect(cli.argv[cli.argv.length - 1].endsWith('P')).toBe(true);
    expect(cli.extraEnv).toEqual({ DEVKIT_JUDGE_REPO_ROOT: '/work/repo' });
  });

  it('grants a judge with no checklist only its scratch and the temp dirs', () => {
    const cli = judgeCliFor(INVESTIGATING, {}, false, { scratch: '/s', repoRoot: '/work/repo' });
    expect(cli.argv.find((a) => a.startsWith('permissions.'))).not.toContain('/work/repo');
    expect(cli.argv.at(-1)).toContain('Its working tree is read-only to you. ');
  });

  it('leaves read-only judges, forced read-only judges and workspace-less calls unchanged', () => {
    const forced = judgeCliFor(INVESTIGATING, {}, true, workspace);
    expect(forced.argv).toEqual(judgeCliFor(INVESTIGATING, {}, true).argv);
    expect(judgeCliFor(READ_ONLY, {}, false, workspace).argv).toEqual(judgeCliFor(READ_ONLY).argv);
    for (const cli of [forced, judgeCliFor(INVESTIGATING)]) {
      expect(cli.argv).not.toContain('-C');
      expect(argAfter(cli.argv, '--sandbox')).toMatch(/^(read-only|workspace-write)$/);
      expect(cli.argv.some((a) => a.startsWith('default_permissions'))).toBe(false);
      expect(cli.extraEnv).toEqual({});
    }
    const parts = { model: 'gpt-5.6-sol', prompt: 'P', systemPrompt: null, readOnly: false };
    expect(codexExecArgs({ ...parts, allowedTools: null }).at(-1)).toBe('P');
  });
});

describe('prepareCodexSandbox', () => {
  it('creates a scratch dir carrying the root AGENTS.md, and removes it', () => {
    const sandbox = prepareCodexSandbox(INVESTIGATING, {}, repo);
    const scratch = sandbox.workspace?.scratch ?? '';
    expect(sandbox.workspace).toEqual({ scratch, repoRoot: repo, stateFile: undefined });
    expect(realpathSync(scratch)).toBe(scratch);
    expect(readFileSync(path.join(scratch, 'AGENTS.md'), 'utf8')).toBe('# rules\n');
    sandbox.cleanup();
    expect(existsSync(scratch)).toBe(false);
    expect(() => sandbox.cleanup()).not.toThrow();
  });

  // Linux bwrap drops a writable root that does not exist yet, so the file must exist at spawn.
  it('creates a missing state file empty, and leaves a seeded one untouched', () => {
    const fresh = prepareCodexSandbox(INVESTIGATING, { codexWritableFile: STATE }, repo);
    expect(fresh.workspace?.stateFile).toBe(path.join(repo, STATE));
    expect(readFileSync(path.join(repo, STATE), 'utf8')).toBe('');
    fresh.cleanup();
    writeFileSync(path.join(repo, STATE), '{"seeded":true}');
    prepareCodexSandbox(INVESTIGATING, { codexWritableFile: STATE }, repo).cleanup();
    expect(readFileSync(path.join(repo, STATE), 'utf8')).toBe('{"seeded":true}');
  });

  // No cleanup runs between a first pass and its escalation, so the first judge can plant this link.
  it('refuses a state file that is a symlink, creating nothing at its target', () => {
    mkdirSync(path.join(repo, '.claude'));
    const target = path.join(repo, '.git-index.lock');
    symlinkSync(target, path.join(repo, STATE));
    expect(() => prepareCodexSandbox(INVESTIGATING, { codexWritableFile: STATE }, repo)).toThrow();
    expect(existsSync(target)).toBe(false);
  });

  // codex refuses a writable root with a symlink component, so the grant names the real file.
  it('grants the real path of a state file under a symlinked .claude or a symlinked checkout', () => {
    const projected = path.join(dir, 'main-checkout', '.claude');
    mkdirSync(projected, { recursive: true });
    symlinkSync(projected, path.join(repo, '.claude'));
    const alias = path.join(dir, 'alias');
    symlinkSync(repo, alias);
    for (const cwd of [repo, alias]) {
      const sandbox = prepareCodexSandbox(INVESTIGATING, { codexWritableFile: STATE }, cwd);
      expect(sandbox.workspace?.repoRoot).toBe(cwd);
      expect(sandbox.workspace?.stateFile).toBe(path.join(projected, path.basename(STATE)));
      sandbox.cleanup();
    }
  });

  // A .claude linked onto the checkout once had to be refused: the whole directory was granted.
  it('grants one file, never a directory, when .claude links onto the checkout', () => {
    symlinkSync('.', path.join(repo, '.claude'));
    const sandbox = prepareCodexSandbox(INVESTIGATING, { codexWritableFile: STATE }, repo);
    expect(sandbox.workspace?.stateFile).toBe(path.join(repo, path.basename(STATE)));
    sandbox.cleanup();
  });

  it('removes scratch when a present project doc cannot be copied', () => {
    rmSync(path.join(repo, 'AGENTS.md'));
    mkdirSync(path.join(repo, 'AGENTS.md')); // a directory: copyFileSync fails with a non-ENOENT code
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('devkit-judge-')));
    expect(() => prepareCodexSandbox(INVESTIGATING, {}, repo)).toThrow();
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith('devkit-judge-'));
    expect(after.filter((n) => !before.has(n))).toEqual([]);
  });

  it('makes no workspace for a read-only, forced read-only or claude judge', () => {
    for (const [args, ro] of [
      [READ_ONLY, false],
      [INVESTIGATING, true],
      [['-p', 'P', '--model', 'sonnet', '--allowedTools', 'Read'], false],
    ] as const)
      expect(
        prepareCodexSandbox([...args], { codexReadOnly: ro, codexWritableFile: STATE }, repo)
          .workspace,
      ).toBeUndefined();
    expect(existsSync(path.join(repo, STATE))).toBe(false);
  });
});

describe('execJudge — scratch lifecycle around a real spawn', () => {
  it('points codex -C at scratch, never the checkout, and removes scratch on success', () => {
    const record = fakeCodex();
    expect(execJudge(judgeOpts())?.trim()).toBe('VERDICT');
    const run = spawned(record);
    expect(run.cwd).toMatch(/devkit-judge-/);
    expect(run.repoEnv).toBe(repo);
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
  });
});

// Wiring: a refused sandbox must land on both twins' outage path, never throw past them or spawn.
describe('execJudge — a sandbox that cannot be prepared', () => {
  it('is an outage on both twins, and codex never runs unconfined', async () => {
    writeFileSync(path.join(repo, '.claude'), 'a file, so the state file cannot be created');
    const record = fakeCodex();
    const outages: JudgeOutage[] = [];
    const opts = {
      ...judgeOpts(),
      codexWritableFile: STATE,
      onOutage: (o: JudgeOutage) => outages.push(o),
    };
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
    const line = /`(r=\$\(pwd -P\) .*?echo "exit \$\?")`/.exec(readFileSync(skill, 'utf8'))?.[1];
    if (!line) throw new Error('commit-gates SKILL.md lost its codex sandbox one-liner');
    const bin = path.join(dir, 'bin');
    const record = path.join(dir, 'seen');
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, 'codex'),
      `#!/bin/sh\n{ pwd -P; ls -A "$CODEX_HOME" | wc -l; ls; for a; do echo "ARG:$a"; done; } > '${record}'\n`,
    );
    chmodSync(path.join(bin, 'codex'), 0o755);
    const out = execFileSync('bash', ['-c', line.replace('<cmd>', 'true')], {
      cwd: repo,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SHELL: '/bin/sh' },
      encoding: 'utf8',
    });
    return { out, seen: readFileSync(record, 'utf8').trim().split('\n') };
  }

  it('grants the same profile the judge argv does, for its own scratch and a state file', () => {
    const { out, seen } = replay();
    const args = seen.filter((l) => l.startsWith('ARG:')).map((l) => l.slice(4));
    const view = { scratch: seen[0], repoRoot: repo, stateFile: path.join(repo, STATE) };
    const judge = judgeCliFor(INVESTIGATING, {}, false, view).argv;
    expect(args.slice(0, 5)).toEqual(['sandbox', ...codexPermissionArgs(view)]);
    expect(judge.join(' ')).toContain(codexPermissionArgs(view).join(' '));
    expect(args.slice(-3)).toEqual(['/bin/sh', '-lc', 'true']);
    expect(out.trim()).toBe('exit 0');
  });

  it('runs from a scratch cwd holding the root AGENTS.md, with an empty CODEX_HOME', () => {
    const [cwd, homeEntries, ...listing] = replay().seen;
    expect(cwd).not.toBe(repo);
    expect(listing).toContain('AGENTS.md');
    expect(homeEntries.trim()).toBe('0');
  });
});

// The real CLI, with no model call. The fixture's $TMPDIR is a sibling of the repo, so the
// profile's :tmpdir grant cannot cover the repo.
const codexOnPath = spawnSync('codex', ['--version'], { stdio: 'ignore' }).status === 0;

/** Exit status of `sh -c cmd` in the sandbox prepareCodexSandbox grants a judge reviewing `cwd`. */
function sandboxed(cmd: string, cwd = repo): number | null {
  const sandbox = prepareCodexSandbox(INVESTIGATING, { codexWritableFile: STATE }, cwd);
  try {
    const workspace = sandbox.workspace;
    if (!workspace) throw new Error('an investigating codex judge got no confined workspace');
    for (const d of ['tmp', 'home']) mkdirSync(path.join(dir, d), { recursive: true });
    const argv = ['sandbox', ...codexPermissionArgs(workspace), '--', '/bin/sh', '-c', cmd];
    return spawnSync('codex', argv, {
      cwd: workspace.scratch,
      env: { ...process.env, TMPDIR: path.join(dir, 'tmp'), CODEX_HOME: path.join(dir, 'home') },
      stdio: 'ignore',
    }).status;
  } finally {
    sandbox.cleanup();
  }
}

describe.skipIf(!codexOnPath || process.platform !== 'darwin')(
  'a confined judge under real codex',
  () => {
    // Spaces, as in macOS's `Application Support`. A `"` breaks codex's own Seatbelt escaping.
    beforeEach(() => {
      repo = path.join(dir, 'Application Support', 'my repo');
      mkdirSync(path.join(repo, '.claude', 'skills', 'x'), { recursive: true });
      writeFileSync(path.join(repo, '.claude', 'settings.json'), '{}');
      writeFileSync(path.join(repo, '.claude', '.correctness-review-g+c1.json'), '');
    });

    it('denies every other .claude and checkout write', () => {
      // Guards the denials below: a sandbox that fails to start also exits non-zero.
      expect(sandboxed(`: > '${path.join(repo, STATE)}'`)).toBe(0);
      for (const rel of [
        '.claude/settings.json',
        '.claude/skills/x/SKILL.md',
        '.claude/other.json',
        '.claude/.correctness-review-g+c1.json',
        'src.mts',
      ])
        expect(sandboxed(`echo x > '${path.join(repo, rel)}'`), rel).not.toBe(0);
      expect(readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8')).toBe('{}');
    });

    it('lets the judge write, remove and recreate its own state file', () => {
      const state = path.join(repo, STATE);
      expect(
        sandboxed(`echo '{"a":1}' > '${state}' && rm '${state}' && echo '{}' > '${state}'`),
      ).toBe(0);
      expect(readFileSync(state, 'utf8')).toBe('{}\n');
    });

    it('denies writing through a symlink planted at the state path', () => {
      const state = path.join(repo, STATE);
      const settings = path.join(repo, '.claude', 'settings.json');
      expect(
        sandboxed(`rm '${state}' && ln -s '${settings}' '${state}' && echo pwned > '${state}'`),
      ).not.toBe(0);
      expect(readFileSync(settings, 'utf8')).toBe('{}');
    });

    // The projected-worktree layout: a judge writes through the link, the grant names the target.
    it('lets the judge write its state file through a symlinked .claude, and nothing beside it', () => {
      const projected = path.join(dir, 'main checkout', '.claude');
      mkdirSync(projected, { recursive: true });
      writeFileSync(path.join(projected, 'settings.json'), '{}');
      const linked = path.join(dir, 'worktree');
      mkdirSync(linked);
      symlinkSync(projected, path.join(linked, '.claude'));
      expect(sandboxed(`echo '{}' > '${path.join(linked, STATE)}'`, linked)).toBe(0);
      expect(
        sandboxed(`echo x > '${path.join(linked, '.claude/settings.json')}'`, linked),
      ).not.toBe(0);
      expect(readFileSync(path.join(projected, 'settings.json'), 'utf8')).toBe('{}');
    });
  },
);
