import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os, { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reviewBriefPath } from '../../../../../cascade/consumer-assets.mts';
import type { runCascade } from '../../../../../cascade/reviewer.mts';
import { failedItems, runReplay, type ReplayOpts } from '../replay.mts';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function write(file: string, contents: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

function commit(repo: string, message: string) {
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

interface Fixture {
  home: string;
  repo: string;
  base: string;
  diffSha: string;
  sink: string;
}

/** A repo whose staged change to `file` is archived as a commit-guard FAIL diff on its HEAD base. */
function fixture(o: { file?: string; config?: object; baseSha?: boolean } = {}): Fixture {
  const file = o.file ?? 'src/a.ts';
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'replay-home-')));
  homes.push(home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  const repo = join(home, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '--quiet', '--initial-branch=main']);
  git(repo, ['config', 'user.email', 'fixture@example.invalid']);
  git(repo, ['config', 'user.name', 'Fixture']);
  write(join(repo, file), 'export const a = 1;\n');
  write(join(repo, '.claude/agents/commit-guard.md'), 'base brief\n');
  if (o.config) write(join(repo, 'guard.config.json'), JSON.stringify(o.config));
  const base = commit(repo, 'base');
  write(join(repo, file), 'export const a = 2;\n');
  const diffText = `${git(repo, ['diff'])}\n`;
  git(repo, ['checkout', '--', file]);
  const diffSha = sha256(diffText);
  mkdirSync(join(home, '.devkit/telemetry/diffs'), { recursive: true });
  writeFileSync(join(home, '.devkit/telemetry/diffs', `${diffSha}.diff.gz`), gzipSync(diffText));
  const sink = join(home, '.devkit/telemetry/gate-events.jsonl');
  const rows = [
    {
      type: 'review_scope',
      reviewer: 'commit-guard',
      diff_sha256: diffSha,
      base_sha: o.baseSha === false ? null : base,
      ship_id: 'SHIP-1',
      prompt_identity: 'p'.repeat(64),
      ts: '2026-10-14T00:00:00.000Z',
    },
    {
      type: 'review_result',
      reviewer: 'commit-guard',
      status: 'fail',
      model: 'orig-model',
      item_tally: { fail: 1 },
      ship_id: 'SHIP-1',
      ts: '2026-10-14T00:01:00.000Z',
    },
  ];
  // The torn tail line stands for a kill mid-append; the resolver must skip it.
  writeFileSync(
    sink,
    `${rows.map((r) => JSON.stringify(r)).join('\n')}\n{"type":"review_scope","reviewer":"commit-guard",${diffSha}`,
  );
  return { home, repo, base, diffSha, sink };
}

/** A cascade that reads the brief the judge would read, then drives a first pass and an escalation. */
function fakeCascade(seenBriefs: string[], { contractRetry = false } = {}) {
  return vi.fn<typeof runCascade>(async (sel, opts) => {
    seenBriefs.push(readFileSync(reviewBriefPath(opts.cwd, opts.cfg, sel.reviewer.name), 'utf8'));
    const state = { files: [{ path: 'src/a.ts', status: 'fail', issues: ['duplicates b'] }] };
    writeFileSync(join(opts.cwd, sel.reviewer.stateFile ?? ''), JSON.stringify(state));
    const exec = opts.exec!;
    await exec({ label: 'review:commit-guard', args: ['--model', 'first-m'], cwd: opts.cwd });
    if (contractRetry)
      await exec({ label: 'review:commit-guard', args: ['--model', 'first-m'], cwd: opts.cwd });
    await exec({
      label: 'review:commit-guard:escalate',
      args: ['--model', 'esc-m'],
      cwd: opts.cwd,
    });
    return { name: sel.reviewer.name, status: 'fail', reason: 'dup', escalated: true };
  });
}

const judge = vi.fn(async () => 'VERDICT: FAIL — duplicates b');
const replayWorktrees = (repo: string) =>
  git(repo, ['worktree', 'list'])
    .split('\n')
    .filter((line) => line.includes('.devkit/research'));

function opts(fx: Fixture, extra: Partial<ReplayOpts> = {}): ReplayOpts {
  return {
    ref: fx.diffSha,
    reviewer: 'commit-guard',
    repo: fx.repo,
    runs: 1,
    log: () => {},
    ...extra,
  };
}

let savedEnv: NodeJS.ProcessEnv;
const homes: string[] = [];
beforeEach(() => {
  savedEnv = { ...process.env };
});
afterEach(() => {
  process.env = savedEnv;
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('runReplay', () => {
  it('interleaves control and --brief arms, keeping both passes with their models', async () => {
    const fx = fixture();
    const brief = join(fx.home, 'edited.md');
    writeFileSync(brief, 'edited brief\n');
    const seen: string[] = [];
    const lines: string[] = [];
    const { runs, outDir } = await runReplay(
      opts(fx, { brief, runs: 2, log: (line) => lines.push(line) }),
      { executeCascade: fakeCascade(seen), judge },
    );
    expect(runs.map((r) => r.arm)).toEqual(['control', 'treatment', 'control', 'treatment']);
    expect(seen).toEqual(['base brief\n', 'edited brief\n', 'base brief\n', 'edited brief\n']);
    expect(runs[0].briefSha).toBe(sha256('base brief\n'));
    expect(runs[1].briefSha).toBe(sha256('edited brief\n'));
    expect(runs[1].passes).toEqual([
      {
        label: 'first',
        model: 'first-m',
        verdict: 'FAIL',
        ms: expect.any(Number),
        failed: [{ id: 'src/a.ts', issues: ['duplicates b'] }],
      },
      expect.objectContaining({ label: 'escalate', model: 'esc-m' }),
    ]);
    expect(readdirSync(outDir)).toHaveLength(4);
    expect(lines.some((l) => l.startsWith('original run: fail by orig-model'))).toBe(true);
    expect(lines.at(-2)).toMatch(/^summary: .* control brief \w{12}: fail 2\/2 · treatment/);
    expect(replayWorktrees(fx.repo)).toEqual([]);
  });

  it('writes nothing to the telemetry sink, an inherited sink or the repo', async () => {
    const fx = fixture();
    const inherited = join(fx.home, 'inherited.jsonl');
    process.env.DEVKIT_GATE_EVENTS = inherited;
    process.env.DEVKIT_SHIP_ID = 'LEAK';
    // An inherited waiver must not turn a pinned reviewer's replayed FAIL into a waived PASS.
    process.env.OVERRIDE_abc123_RATIONALE = 'waived';
    const sinkBefore = readFileSync(fx.sink, 'utf8');
    let inheritedWaiver: string | undefined = 'unset';
    const base = fakeCascade([]);
    const cascade = vi.fn<typeof runCascade>((sel, o) => {
      inheritedWaiver = process.env.OVERRIDE_abc123_RATIONALE;
      return base(sel, o);
    });
    await runReplay(opts(fx), { executeCascade: cascade, judge });
    expect(inheritedWaiver).toBeUndefined();
    expect(readFileSync(fx.sink, 'utf8')).toBe(sinkBefore);
    expect(readdirSync(join(fx.home, '.devkit/telemetry')).sort()).toEqual([
      'diffs',
      'gate-events.jsonl',
    ]);
    expect(existsSync(inherited)).toBe(false);
    expect(existsSync(join(fx.repo, '.devkit'))).toBe(false);
  });

  it('resolves a ship id to its archived diff', async () => {
    const fx = fixture();
    const { runs } = await runReplay(opts(fx, { ref: 'SHIP-1' }), {
      executeCascade: fakeCascade([]),
      judge,
    });
    expect(runs).toHaveLength(1);
  });

  it('resolves the 12-hex diff prefix the summary line prints', async () => {
    const fx = fixture();
    const { runs } = await runReplay(opts(fx, { ref: fx.diffSha.slice(0, 12) }), {
      executeCascade: fakeCascade([]),
      judge,
    });
    expect(runs).toHaveLength(1);
  });

  it('accepts --base as a ref name and judges at its full commit', async () => {
    const fx = fixture();
    const lines: string[] = [];
    await runReplay(opts(fx, { base: 'main', log: (l) => lines.push(l) }), {
      executeCascade: fakeCascade([]),
      judge,
    });
    expect(lines[0]).toContain(`base ${fx.base.slice(0, 12)}`);
  });

  it('writes --brief into a configured review.agentsDir and removes it for the control arm', async () => {
    const fx = fixture({ config: { review: { agentsDir: 'briefs' } } });
    const brief = join(fx.home, 'edited.md');
    writeFileSync(brief, 'edited brief\n');
    const seen: string[] = [];
    const { runs } = await runReplay(opts(fx, { brief, runs: 2 }), {
      executeCascade: fakeCascade(seen),
      judge,
    });
    expect(seen[1]).toBe('edited brief\n');
    expect(runs[1].briefSha).toBe(sha256('edited brief\n'));
    // No consumer brief at base: the control arm must fall back to the packaged brief every time.
    expect(seen[2]).toBe(seen[0]);
    expect(runs[2].briefSha).toBe(runs[0].briefSha);
  });

  it('labels a checklist-contract retry apart from the first pass', async () => {
    const fx = fixture();
    const { runs } = await runReplay(opts(fx), {
      executeCascade: fakeCascade([], { contractRetry: true }),
      judge,
    });
    expect(runs[0].passes.map((p) => p.label)).toEqual(['first', 'retry', 'escalate']);
  });

  it('removes the replay worktree when the process exits mid-run', () => {
    const fx = fixture();
    const replayModule = fileURLToPath(new URL('../replay.mts', import.meta.url));
    const child = `import os from 'node:os';
os.homedir = () => process.argv[1];
const { runReplay } = await import(${JSON.stringify(replayModule)});
await runReplay(JSON.parse(process.argv[2]), {
  executeCascade: async () => process.exit(3),
});`;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        child,
        fx.home,
        JSON.stringify(opts(fx, { log: undefined })),
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    expect(result.status).toBe(3);
    expect(replayWorktrees(fx.repo)).toEqual([]);
    const replayRoot = join(fx.home, '.devkit/research/replay');
    for (const stamp of readdirSync(replayRoot))
      expect(existsSync(join(replayRoot, stamp, 'ctx'))).toBe(false);
  });

  it('replays the same diff twice in a row (fresh worktree each time)', async () => {
    const fx = fixture();
    const brief = join(fx.home, 'edited.md');
    writeFileSync(brief, 'edited brief\n');
    const deps = { executeCascade: fakeCascade([]), judge };
    await runReplay(opts(fx, { brief }), deps);
    const { runs } = await runReplay(opts(fx, { brief }), deps);
    expect(runs).toHaveLength(2);
  });

  it('flags arms that differ on retrieval degradation', async () => {
    const fx = fixture();
    const brief = join(fx.home, 'edited.md');
    writeFileSync(brief, 'edited brief\n');
    const base = fakeCascade([]);
    let calls = 0;
    const cascade = vi.fn<typeof runCascade>(async (sel, o) => {
      const res = await base(sel, o);
      calls += 1;
      return calls === 2 ? { ...res, degraded: { cause: 'retrieval unavailable' } } : res;
    });
    const lines: string[] = [];
    const { runs } = await runReplay(opts(fx, { brief, log: (l) => lines.push(l) }), {
      executeCascade: cascade,
      judge,
    });
    expect(runs[1].degraded).toBe('retrieval unavailable');
    expect(lines.some((l) => l.startsWith('warning: retrieval degradation differs'))).toBe(true);
  });

  it('dry-run prints the plan and spawns nothing', async () => {
    const fx = fixture();
    const cascade = fakeCascade([]);
    const lines: string[] = [];
    await runReplay(opts(fx, { dryRun: true, log: (l) => lines.push(l) }), {
      executeCascade: cascade,
      judge,
    });
    expect(cascade).not.toHaveBeenCalled();
    expect(lines.some((l) => l.startsWith('plan: 1×1 cascade(s), up to 2 judge calls'))).toBe(true);
  });
});

describe('runReplay refusals', () => {
  const refuses = async (fx: Fixture, extra: Partial<ReplayOpts>, message: RegExp) => {
    const cascade = fakeCascade([]);
    await expect(runReplay(opts(fx, extra), { executeCascade: cascade, judge })).rejects.toThrow(
      message,
    );
    expect(cascade).not.toHaveBeenCalled();
    expect(replayWorktrees(fx.repo)).toEqual([]);
  };

  it('names the FAIL-only archive when the diff was never archived', async () => {
    const fx = fixture();
    rmSync(join(fx.home, '.devkit/telemetry/diffs'), { recursive: true });
    await refuses(fx, {}, /only FAIL diffs are archived/);
  });

  it('refuses a corrupt archive', async () => {
    const fx = fixture();
    writeFileSync(join(fx.home, '.devkit/telemetry/diffs', `${fx.diffSha}.diff.gz`), 'not gzip');
    await refuses(fx, {}, /invalid-diff-archive/);
  });

  it('asks for --base when no base was recorded', async () => {
    await refuses(fixture({ baseSha: false }), {}, /pass --base/);
  });

  it('refuses a base the repo does not have', async () => {
    await refuses(fixture(), { base: 'f'.repeat(40) }, /is not a commit in/);
  });

  it('refuses when the diff only applies at a different commit', async () => {
    const fx = fixture();
    write(join(fx.repo, 'src/a.ts'), 'export const a = 3;\n');
    const moved = commit(fx.repo, 'moved');
    await refuses(fx, { base: moved }, /does not apply at recorded base/);
  });

  it('names the FAIL-only archive for a ship with no archived diff', async () => {
    await refuses(
      fixture(),
      { ref: 'SHIP-UNKNOWN' },
      /no archived commit-guard diff matches SHIP-UNKNOWN/,
    );
  });

  it('points correctness-reviewer at scale-bench', async () => {
    await refuses(fixture(), { reviewer: 'correctness-reviewer' }, /scale-bench/);
  });

  it('refuses a reviewer the diff does not select', async () => {
    await refuses(fixture({ file: 'docs/notes.md' }), {}, /not selected/);
  });
});

describe('failedItems', () => {
  it('reads domain reviewers keyed by items[].name as well as commit-guard files[].path', () => {
    expect(
      failedItems({
        files: [],
        items: [
          { name: 'sql-injection', status: 'fail', issues: ['raw query'] },
          { name: 'auth', status: 'pass', issues: [] },
        ],
      }),
    ).toEqual([{ id: 'sql-injection', issues: ['raw query'] }]);
  });
});
