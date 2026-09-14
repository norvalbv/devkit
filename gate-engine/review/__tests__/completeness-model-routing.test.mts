import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCache, savePasses } from '../cache.mts';
import { runCompleteness } from '../completeness.mts';
import {
  cleanupReviewFixtures,
  consumerRepo,
  messageFile,
  mkExec,
} from './run-review-fixtures.mts';

const ENV_KEYS = [
  'GUARD_AI_STRICT',
  'GUARD_REVIEW_ESCALATION_MODEL',
  'GUARD_CODEX_BIN',
  'DEVKIT_GATE_EVENTS',
  'DEVKIT_SHIP_ID',
  'DEVKIT_SHIP_BRANCH',
] as const;

const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  cleanupReviewFixtures();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

describe('runCompleteness — configured strong-model routing', () => {
  it('uses Sol read-only by default and carries the full prompt', async () => {
    const repo = consumerRepo({ backend: true });
    delete process.env.GUARD_REVIEW_ESCALATION_MODEL;
    let captured: {
      args: string[];
      codexReadOnly?: boolean;
    };
    const exec = mkExec(async (opts) => {
      captured = opts;
      return 'VERDICT: PASS';
    });

    expect(await runCompleteness(messageFile(repo, 'feat: add db layer'), repo, { exec })).toBe(0);
    expect(captured.args[1]).toContain('feat: add db layer');
    expect(captured.args[1]).toContain('RELEVANT RECORDED TARGETS');
    expect(captured.args[1]).toContain('Brief for feature-completeness-reviewer.');
    expect(captured.args).toContain('gpt-5.6-sol');
    expect(captured.codexReadOnly).toBe(true);
  });

  it('keeps explicit file and environment escalation models on Opus', async () => {
    const fileRepo = consumerRepo({ backend: true });
    delete process.env.GUARD_REVIEW_ESCALATION_MODEL;
    const configPath = join(fileRepo, 'guard.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.review.escalationModel = 'opus';
    writeFileSync(configPath, JSON.stringify(config));
    let fileArgs: string[] = [];
    expect(
      await runCompleteness(messageFile(fileRepo, 'feat: file model'), fileRepo, {
        exec: mkExec(async (opts) => {
          fileArgs = opts.args;
          return 'VERDICT: PASS';
        }),
      }),
    ).toBe(0);
    expect(fileArgs).toContain('opus');

    const envRepo = consumerRepo({ backend: true });
    process.env.GUARD_REVIEW_ESCALATION_MODEL = 'opus';
    let envArgs: string[] = [];
    expect(
      await runCompleteness(messageFile(envRepo, 'feat: env model'), envRepo, {
        exec: mkExec(async (opts) => {
          envArgs = opts.args;
          return 'VERDICT: PASS';
        }),
      }),
    ).toBe(0);
    expect(envArgs).toContain('opus');
  });

  it('reports the selected model on a sticky cache hit', async () => {
    const repo = consumerRepo({ backend: true });
    delete process.env.GUARD_REVIEW_ESCALATION_MODEL;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec(async () => 'VERDICT: PASS');
    expect(await runCompleteness(messageFile(repo, 'feat: add db layer'), repo, { exec })).toBe(0);
    expect(Object.values(loadCache(repo)).map((entry) => entry.model)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-sol',
    ]);

    const sink = join(repo, 'events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    process.env.DEVKIT_SHIP_ID = 'ship-sticky';
    writeFileSync(join(repo, 'src', 'main', 'db.ts'), 'export const q = 9;\n');
    execSync('git add .', { cwd: repo });
    expect(await runCompleteness(messageFile(repo, 'feat: add db layer'), repo, { exec })).toBe(0);
    const events = readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.find((event) => event.type === 'cache_hit')).toMatchObject({
      judge: 'review:completeness',
      model: 'gpt-5.6-sol',
    });
    expect(events.find((event) => event.type === 'gate_timing')).toMatchObject({
      gate: 'completeness',
      cache_state: 'full',
    });
  });

  it('points a strict default-Sol outage at Codex rather than Claude', async () => {
    const repo = consumerRepo({ backend: true });
    delete process.env.GUARD_REVIEW_ESCALATION_MODEL;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_AI_STRICT = '1';
    expect(
      await runCompleteness(messageFile(repo, 'feat: x'), repo, {
        exec: mkExec(async () => null),
      }),
    ).toBe(3);
    const output = err.mock.calls.flat().join('\n');
    expect(output).toContain('check `codex` CLI auth/quota');
    expect(output).not.toContain('check `claude` CLI auth/quota');
  });

  it('misses both PASS identities after a completeness model change', async () => {
    const exactRepo = consumerRepo({ backend: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_REVIEW_ESCALATION_MODEL = 'opus';
    const exactExec = mkExec(async () => 'VERDICT: PASS');
    expect(
      await runCompleteness(messageFile(exactRepo, 'feat: exact'), exactRepo, { exec: exactExec }),
    ).toBe(0);
    process.env.GUARD_REVIEW_ESCALATION_MODEL = 'gpt-5.6-sol';
    expect(
      await runCompleteness(messageFile(exactRepo, 'feat: exact'), exactRepo, { exec: exactExec }),
    ).toBe(0);
    expect(exactExec).toHaveBeenCalledTimes(2);

    const stickyRepo = consumerRepo({ backend: true });
    process.env.GUARD_REVIEW_ESCALATION_MODEL = 'opus';
    const stickyExec = mkExec(async () => 'VERDICT: PASS');
    expect(
      await runCompleteness(messageFile(stickyRepo, 'feat: sticky'), stickyRepo, {
        exec: stickyExec,
      }),
    ).toBe(0);
    writeFileSync(join(stickyRepo, 'src', 'main', 'db.ts'), 'export const q = 99;\n');
    execSync('git add .', { cwd: stickyRepo });
    process.env.GUARD_REVIEW_ESCALATION_MODEL = 'gpt-5.6-sol';
    expect(
      await runCompleteness(messageFile(stickyRepo, 'feat: sticky'), stickyRepo, {
        exec: stickyExec,
      }),
    ).toBe(0);
    expect(stickyExec).toHaveBeenCalledTimes(2);
  });
});

/** sc-3175: a sticky hit still skips the judge, but says whether the staged diff is the one judged. */
describe('runCompleteness — sticky PASS diff fingerprint (sc-3175)', () => {
  const MSG = 'feat: add db layer';
  const stage = (repo: string, rel: string, content: string | Buffer) => {
    writeFileSync(join(repo, rel), content);
    // The path alone: `git add .` would also stage the event sink this test reads back.
    execSync(`git add -- '${rel}'`, { cwd: repo });
  };
  const hits = (sink: string) =>
    readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === 'cache_hit');

  async function earnPass(repo: string) {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sink = join(repo, 'events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    process.env.DEVKIT_SHIP_ID = 'ship-fingerprint';
    const exec = mkExec(async () => 'VERDICT: PASS');
    expect(await runCompleteness(messageFile(repo, MSG), repo, { exec })).toBe(0);
    const rerun = () => runCompleteness(messageFile(repo, MSG), repo, { exec });
    return { err, exec, rerun, sink };
  }

  it('an unchanged staged diff reports a matching intent hit', async () => {
    const repo = consumerRepo({ backend: true });
    const { exec, rerun, sink } = await earnPass(repo);
    expect(await rerun()).toBe(0);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(hits(sink)).toEqual([
      expect.objectContaining({
        judge: 'review:completeness',
        scope: 'intent',
        diff_matches: true,
      }),
    ]);
  });

  it('a reshaped diff still skips the judge, but reports the mismatch and says so', async () => {
    const repo = consumerRepo({ backend: true });
    const { err, exec, rerun, sink } = await earnPass(repo);
    stage(repo, 'src/main/db.ts', 'export const q = 41;\n');
    expect(await rerun()).toBe(0);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(hits(sink)).toEqual([expect.objectContaining({ scope: 'intent', diff_matches: false })]);
    expect(err.mock.calls.flat().join('\n')).toContain('judged on an earlier diff');
  });

  it('a diff reshaped and then restored byte-for-byte matches again', async () => {
    const repo = consumerRepo({ backend: true });
    const original = readFileSync(join(repo, 'src/main/db.ts'));
    const { rerun, sink } = await earnPass(repo);
    stage(repo, 'src/main/db.ts', 'export const q = 42;\n');
    expect(await rerun()).toBe(0);
    stage(repo, 'src/main/db.ts', original);
    expect(await rerun()).toBe(0);
    expect(hits(sink).map((hit) => hit.diff_matches)).toEqual([false, true]);
  });

  it('a same-size binary change is a different diff — "Binary files differ" is not an identity', async () => {
    const repo = consumerRepo({ backend: true });
    stage(repo, 'src/main/logo.bin', Buffer.from([0, 1, 2, 3, 0, 255]));
    const { rerun, sink } = await earnPass(repo);
    stage(repo, 'src/main/logo.bin', Buffer.from([0, 1, 2, 4, 0, 255]));
    expect(await rerun()).toBe(0);
    expect(hits(sink)).toEqual([expect.objectContaining({ diff_matches: false })]);
  });

  it("a consumer's diff config changed between attempts does not fake a reshape", async () => {
    const repo = consumerRepo({ backend: true });
    const { rerun, sink } = await earnPass(repo);
    for (const [key, value] of [
      ['diff.noprefix', 'true'],
      ['color.diff', 'always'],
      ['diff.renames', 'copies'],
      ['core.quotepath', 'false'],
    ]) {
      execSync(`git config ${key} ${value}`, { cwd: repo });
    }
    expect(await rerun()).toBe(0);
    expect(hits(sink)).toEqual([expect.objectContaining({ diff_matches: true })]);
  });

  it('a sticky PASS saved before fingerprints existed cannot vouch for this diff', async () => {
    const repo = consumerRepo({ backend: true });
    const { exec, rerun, sink } = await earnPass(repo);
    const legacy = Object.fromEntries(
      Object.entries(loadCache(repo)).map(([key, { diff_sha: _drop, ...meta }]) => [key, meta]),
    );
    expect(savePasses(repo, legacy)).toBe(true);
    expect(Object.values(loadCache(repo)).some((meta) => 'diff_sha' in meta)).toBe(false);
    expect(await rerun()).toBe(0);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(hits(sink)).toEqual([expect.objectContaining({ diff_matches: false })]);
  });
});

/** sc-3175 review follow-ups: the fingerprint must be byte-exact and must not outlive a moving index. */
describe('runCompleteness — fingerprint integrity (sc-3175)', () => {
  const MSG = 'feat: add db layer';
  const useSink = (repo: string) => {
    const sink = join(repo, 'events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    process.env.DEVKIT_SHIP_ID = 'ship-integrity';
    return sink;
  };
  const hitsIn = (sink: string) =>
    readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === 'cache_hit');

  it('distinct non-UTF-8 path bytes are distinct diffs — the hash reads bytes, not decoded text', async () => {
    const repo = consumerRepo({ backend: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sink = useSink(repo);
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: repo,
      input: 'raw-named\n',
    })
      .toString()
      .trim();
    // APFS refuses non-UTF-8 names on disk, so the paths go straight into the index as raw bytes.
    const entry = (mode: string, sha: string, lastByte: number) =>
      Buffer.concat([Buffer.from(`${mode} ${sha}\t`), Buffer.from([0x61, lastByte, 0])]);
    const stageRaw = (...entries: Buffer[]) =>
      execFileSync('git', ['update-index', '-z', '--index-info'], {
        cwd: repo,
        input: Buffer.concat(entries),
      });
    stageRaw(entry('100644', blob, 0x80));
    const exec = mkExec(async () => 'VERDICT: PASS');
    expect(await runCompleteness(messageFile(repo, MSG), repo, { exec })).toBe(0);
    stageRaw(entry('0', '0'.repeat(40), 0x80), entry('100644', blob, 0x81));
    expect(await runCompleteness(messageFile(repo, MSG), repo, { exec })).toBe(0);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(hitsIn(sink)).toEqual([expect.objectContaining({ diff_matches: false })]);
  });

  it('the fingerprint names the snapshot the judge was shown, however the index moves around it', async () => {
    const repo = consumerRepo({ backend: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sink = useSink(repo);
    const dbFile = join(repo, 'src', 'main', 'db.ts');
    const judged = readFileSync(dbFile);
    const stage = (content: string | Buffer) => {
      writeFileSync(dbFile, content);
      execSync("git add -- 'src/main/db.ts'", { cwd: repo });
    };
    let shown = '';
    const exec = mkExec(async (opts: { input: string }) => {
      if (!shown) {
        shown = opts.input;
        stage('export const q = 7;\n'); // a concurrent git add while the judge reads
      }
      return 'VERDICT: PASS';
    });
    expect(await runCompleteness(messageFile(repo, MSG), repo, { exec })).toBe(0);
    expect(shown).not.toContain('q = 7');
    expect(await runCompleteness(messageFile(repo, MSG), repo, { exec })).toBe(0);
    stage(judged); // back to the bytes the judge was actually shown
    expect(await runCompleteness(messageFile(repo, MSG), repo, { exec })).toBe(0);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(hitsIn(sink).map((hit) => hit.diff_matches)).toEqual([false, true]);
  });
  it('a commit landing mid-snapshot widens the judged evidence rather than splitting it', async () => {
    const repo = consumerRepo({ backend: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    const headBefore = git('rev-parse', 'HEAD').trim();
    // Another process commits the instant write-tree runs: a PATH shim at the real race site.
    const shimDir = mkdtempSync(join(tmpdir(), 'completeness-race-'));
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const fired = join(shimDir, 'fired');
    writeFileSync(
      join(shimDir, 'git'),
      [
        '#!/bin/sh',
        `if [ "$1" = write-tree ] && [ ! -e "${fired}" ]; then`,
        `  : > "${fired}"`,
        `  "${realGit}" -c core.hooksPath=/dev/null -c user.name=t -c user.email=t@t commit -qm race`,
        "  printf 'export const q = 8;\\n' > src/main/db.ts",
        `  "${realGit}" add -- src/main/db.ts`,
        'fi',
        `exec "${realGit}" "$@"`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    let shown = '';
    const exec = mkExec(async (opts: { input: string }) => {
      shown = opts.input;
      return 'VERDICT: PASS';
    });
    const savedPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${savedPath}`;
    let raced = false;
    try {
      expect(await runCompleteness(messageFile(repo, MSG), repo, { exec })).toBe(0);
    } finally {
      process.env.PATH = savedPath;
      raced = existsSync(fired);
      rmSync(shimDir, { recursive: true, force: true });
    }
    expect(raced).toBe(true);
    const tree = git('write-tree').trim();
    const patch = git(
      '-c',
      'diff.noprefix=false',
      '-c',
      'diff.mnemonicPrefix=false',
      'diff',
      headBefore,
      tree,
    );
    expect(shown).toBe(`${git('diff', '--stat', headBefore, tree)}\n${patch}`);
  });
});
