import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCache, loadCache, savePasses } from '../cache.mts';
import { MCP_DEGRADED_REMEDY } from '../evidence/base-context.mts';
import { FOUR_WAY_LENS_GROUPS, lensGroupId } from '../lens/split.mts';
import { runReviewGate } from '../run-review.mts';
import {
  cleanupReviewFixtures,
  consumerRepo,
  mkExec,
  trackReviewFixtureDir,
  writeArtifact,
} from './run-review-fixtures.mts';

// sc-2837: a reviewer that ran without the codebase MCP server must never print a bare PASS — not
// live, not split, not replayed — and the fleet warning must name the reviewers it weakened.

const ENV_KEYS = [
  'GUARD_AI_STRICT',
  'FRINK_AI_STRICT',
  'GUARD_REVIEW_SKIP',
  'GUARD_NO_REVIEW',
  'GUARD_REVIEW_CONCURRENCY',
  'DEVKIT_RUN_MODE',
  'DEVKIT_GATE_EVENTS',
  'DEVKIT_SHIP_ID',
  'DEVKIT_REVIEW_PROGRESS',
  'DEVKIT_JUDGE_MCP_CONFIG',
  'GUARD_CORRECTNESS_SPLIT',
];
const saved: Record<string, string | undefined> = {};
let stderr: string[];

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) if (k !== 'DEVKIT_JUDGE_MCP_CONFIG') delete process.env[k];
  process.env.GUARD_CORRECTNESS_SPLIT = 'off';
  stderr = [];
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    stderr.push(args.join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanupReviewFixtures();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const ALL = ['codebase', 'context7', 'autonomous_bugs'] as const;

/** A fresh trusted registry holding only `servers` — a NEW file per call, because the fleet warning
 * is once per registry state per process and a reused path would swallow this test's line. */
function useRegistry(servers: readonly string[]): string {
  const dir = trackReviewFixtureDir(mkdtempSync(join(tmpdir(), 'mcp-degraded-registry-')));
  const file = join(dir, 'registry.json');
  writeFileSync(
    file,
    JSON.stringify({
      mcpServers: Object.fromEntries(servers.map((n) => [n, { type: 'stdio', command: `x-${n}` }])),
    }),
    { mode: 0o600 },
  );
  process.env.DEVKIT_JUDGE_MCP_CONFIG = file;
  return file;
}

interface SinkRow {
  type?: string;
  judge?: string;
  cause?: string;
  detail?: string;
  reviewer?: string;
  status?: string;
  mcp_degraded_cause?: string;
  degraded_cause?: string;
}

function captureEvents(repo: string): () => SinkRow[] {
  const sink = join(repo, 'events.jsonl');
  process.env.DEVKIT_GATE_EVENTS = sink;
  process.env.DEVKIT_SHIP_ID = 'ship-2837';
  return () =>
    readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((l): SinkRow => JSON.parse(l));
}

const passJudge = (repo: string, verdict = 'VERDICT: PASS') =>
  mkExec(async ({ label }) => {
    writeArtifact(repo, label);
    return verdict;
  });

// Any reviewer completion/cache line whose PASS is not immediately marked (DEGRADED).
const barePasses = (lines: string[]) =>
  lines.filter((l) => /^guard-review: [\w-]+ — (cached )?PASS(?! \(DEGRADED\))/.test(l));

const fleetLines = (lines: string[]) =>
  lines.filter((l) => /guard-review: (DEGRADED — )?no MCP /.test(l));

describe('reviewer fleet without the codebase MCP server (sc-2837)', () => {
  it('every PASS reads DEGRADED, and ONE ⚠️ fleet line names the reviewers', async () => {
    useRegistry(['context7', 'autonomous_bugs']);
    const repo = consumerRepo({ backend: true });
    expect(await runReviewGate(repo, { exec: passJudge(repo) })).toBe(0);
    expect(barePasses(stderr)).toEqual([]);
    const fleet = fleetLines(stderr);
    expect(fleet).toHaveLength(1);
    expect(fleet[0]).toMatch(/^⚠️ {2}guard-review: DEGRADED — no MCP codebase for .*a judged PASS/);
    for (const name of ['commit-guard', 'correctness-reviewer', 'api-security-reviewer'])
      expect(fleet[0]).toContain(name);
    expect(stderr).toContainEqual(
      expect.stringMatching(/^guard-review: correctness-reviewer — PASS \(DEGRADED\) in \d+s/),
    );
    expect(stderr).toContainEqual(
      expect.stringMatching(
        /^⚠️ {2}guard-review: correctness-reviewer — DEGRADED: MCP codebase unavailable \(missing from the trusted MCP registry\)/,
      ),
    );
  });

  it('one gate_degraded per reviewer and mcp_degraded_cause on each review_result', async () => {
    useRegistry(['context7', 'autonomous_bugs']);
    const repo = consumerRepo({ backend: true });
    const events = captureEvents(repo);
    expect(await runReviewGate(repo, { exec: passJudge(repo) })).toBe(0);
    const all = events();
    const results = all.filter((e) => e.type === 'review_result');
    expect(results.length).toBeGreaterThan(1);
    expect(results.every((r) => r.mcp_degraded_cause?.startsWith('MCP codebase unavailable'))).toBe(
      true,
    );
    const degraded = all.filter((e) => e.type === 'gate_degraded').map((e) => e.judge);
    expect([...degraded].sort()).toEqual(results.map((r) => r.reviewer).sort());
  });

  it('strict ship mode stays exit 0 — DEGRADED is visible, not blocking (AC d)', async () => {
    useRegistry([]);
    process.env.GUARD_AI_STRICT = '1';
    const repo = consumerRepo({ backend: true });
    expect(await runReviewGate(repo, { exec: passJudge(repo) })).toBe(0);
    expect(stderr.join('\n')).toContain('PASS (DEGRADED)');
  });

  it('only autonomous_bugs missing: bare PASS, an informational line naming agents, no event', async () => {
    useRegistry(['codebase', 'context7']);
    const repo = consumerRepo({ backend: true });
    const events = captureEvents(repo);
    expect(await runReviewGate(repo, { exec: passJudge(repo) })).toBe(0);
    expect(stderr.join('\n')).not.toContain('DEGRADED');
    const fleet = fleetLines(stderr);
    expect(fleet).toHaveLength(1);
    expect(fleet[0]).toMatch(/^guard-review: no MCP autonomous_bugs for .*commit-guard/);
    expect(events().filter((e) => e.type === 'gate_degraded')).toEqual([]);
    expect(Object.values(loadCache(repo)).some((m) => 'mcp_degraded_cause' in m)).toBe(false);
  });

  it('an untrusted/absent registry (CI with no ~/.claude.json) degrades and says why', async () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'mcp-none-')), 'absent.json');
    trackReviewFixtureDir(join(missing, '..'));
    process.env.DEVKIT_JUDGE_MCP_CONFIG = missing;
    const repo = consumerRepo({ backend: true });
    expect(await runReviewGate(repo, { exec: passJudge(repo) })).toBe(0);
    expect(barePasses(stderr)).toEqual([]);
    expect(stderr).toContainEqual(
      expect.stringContaining(`(trusted MCP registry unavailable at ${missing})`),
    );
  });

  it('an unreadable registry (corrupt JSON) degrades rather than reading as full capability', async () => {
    const file = useRegistry(ALL);
    writeFileSync(file, '{ not json', { mode: 0o600 });
    const repo = consumerRepo({ backend: true });
    expect(await runReviewGate(repo, { exec: passJudge(repo) })).toBe(0);
    expect(barePasses(stderr)).toEqual([]);
    expect(stderr.join('\n')).toContain('(trusted MCP registry is unreadable)');
  });

  it('a FAIL is never marked DEGRADED and is never cached with an MCP cause', async () => {
    useRegistry([]);
    const repo = consumerRepo({ backend: true });
    const exec = mkExec(async ({ label }) => {
      const cg = label.startsWith('review:commit-guard');
      writeArtifact(repo, label, { failed: cg ? 1 : 0 });
      return cg
        ? 'src/fixture.ts:1 duplicates src/x.ts:1\nVERDICT: FAIL — duplicate'
        : 'VERDICT: PASS';
    });
    await runReviewGate(repo, { exec });
    expect(stderr.filter((l) => /commit-guard — FAIL.*DEGRADED/.test(l))).toEqual([]);
    expect(stderr.filter((l) => /commit-guard — DEGRADED/.test(l))).toEqual([]);
  });
});

describe('the spawn-time profile wins over the run-level read (sc-2837 review findings)', () => {
  const SPAWN_CAUSE =
    'MCP codebase unavailable (private MCP profile file could not be created) — reviewer ran without codebase search';

  it('a clean pre-spawn read + a degraded spawn (registry race, mkdtemp failure) still marks DEGRADED', async () => {
    useRegistry(ALL);
    const repo = consumerRepo({ backend: true });
    const events = captureEvents(repo);
    const exec = mkExec(async ({ label, onMcpPrepared }) => {
      writeArtifact(repo, label);
      if (label.startsWith('review:commit-guard')) onMcpPrepared?.('fingerprint', SPAWN_CAUSE);
      else onMcpPrepared?.('fingerprint', undefined);
      return 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(fleetLines(stderr)).toEqual([]); // the run-level read saw nothing missing
    expect(stderr).toContainEqual(
      expect.stringMatching(/^guard-review: commit-guard — PASS \(DEGRADED\) in/),
    );
    expect(stderr).toContainEqual(`⚠️  guard-review: commit-guard — DEGRADED: ${SPAWN_CAUSE}`);
    expect(stderr).toContainEqual(
      expect.stringMatching(/^guard-review: correctness-reviewer — PASS in/),
    );
    const row = events().find((e) => e.type === 'review_result' && e.reviewer === 'commit-guard');
    expect(row?.mcp_degraded_cause).toBe(SPAWN_CAUSE);
  });

  it('a registry repaired before spawn: clean spawns clear the stale run-level cause (bare PASS)', async () => {
    useRegistry(['context7', 'autonomous_bugs']);
    const repo = consumerRepo({ backend: true });
    const exec = mkExec(async ({ label, onMcpPrepared }) => {
      writeArtifact(repo, label);
      onMcpPrepared?.('fingerprint', undefined);
      return 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(fleetLines(stderr)).toHaveLength(1); // the gate-start read was degraded, and says so
    expect(barePasses(stderr).length).toBeGreaterThan(0);
    expect(stderr.filter((l) => / — DEGRADED: /.test(l))).toEqual([]);
  });

  it('the spawn cause is preferred over a different run-level cause', async () => {
    useRegistry(['context7', 'autonomous_bugs']);
    const repo = consumerRepo({ backend: true });
    const exec = mkExec(async ({ label, onMcpPrepared }) => {
      writeArtifact(repo, label);
      onMcpPrepared?.('fingerprint', SPAWN_CAUSE);
      return 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(stderr).toContainEqual(`⚠️  guard-review: commit-guard — DEGRADED: ${SPAWN_CAUSE}`);
  });
});

describe('commit-guard: the MCP cause is independent of retrieval (sc-2837 × sc-2317)', () => {
  it('retrieval ok + codebase missing: DEGRADED live, cache keeps BOTH stamps, replay names MCP + remedy', async () => {
    useRegistry(['context7', 'autonomous_bugs']);
    const repo = consumerRepo({ backend: true });
    await runReviewGate(repo, { exec: passJudge(repo) });
    const cg = Object.values(loadCache(repo)).filter((m) => m.retrieval === 'ok');
    expect(cg).toHaveLength(1);
    expect(cg[0].mcp_degraded_cause).toMatch(/^MCP codebase unavailable/);
    expect(cg[0]).not.toHaveProperty('degraded_cause');

    stderr.length = 0;
    const events = captureEvents(repo);
    const exec = mkExec(async () => 'VERDICT: PASS');
    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    expect(stderr).toContainEqual(
      expect.stringMatching(
        /^guard-review: commit-guard — cached PASS \(DEGRADED\) \(identical diff/,
      ),
    );
    expect(stderr).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^⚠️ {2}guard-review: commit-guard — DEGRADED: MCP codebase .* — ${MCP_DEGRADED_REMEDY}`,
        ),
      ),
    );
    // Retrieval ran: the replay must not invent a retrieval degradation.
    expect(stderr.join('\n')).not.toContain('semantic retrieval');
    expect(
      events().filter((e) => e.type === 'gate_degraded' && e.judge === 'commit-guard'),
    ).toHaveLength(1);
    // Fully cached: no judge spawns, so no fleet "ran without" line either.
    expect(fleetLines(stderr)).toEqual([]);
  });

  it('both causes at once: two distinct ⚠️ lines and two gate_degraded rows, one DEGRADED token', async () => {
    useRegistry([]);
    const repo = consumerRepo({ backend: true });
    const events = captureEvents(repo);
    const exec = mkExec(async ({ label }) => {
      writeArtifact(repo, label, {
        retrieval: { status: 'unavailable', cause: 'remote embeddings unreachable' },
      });
      return 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(0);
    const line = stderr.filter((l) => /^guard-review: commit-guard — PASS/.test(l));
    expect(line).toHaveLength(1);
    expect(line[0]).toMatch(/PASS \(DEGRADED\) in/);
    expect(line[0]).not.toMatch(/DEGRADED\).*DEGRADED/);
    const rows = events().filter((e) => e.type === 'gate_degraded' && e.judge === 'commit-guard');
    expect(rows.map((r) => r.cause)).toEqual([
      'remote embeddings unreachable',
      expect.stringMatching(/^MCP codebase unavailable/),
    ]);
    const result = events().find(
      (e) => e.type === 'review_result' && e.reviewer === 'commit-guard',
    );
    expect(result).toMatchObject({
      degraded_cause: 'remote embeddings unreachable',
      mcp_degraded_cause: expect.stringMatching(/^MCP codebase/),
    });
  });
});

describe('cache replay across a registry change (sc-2837)', () => {
  it('a PASS judged without codebase still replays DEGRADED after codebase returns (truthful, with remedy)', async () => {
    useRegistry(['context7']);
    const repo = consumerRepo({ backend: true });
    await runReviewGate(repo, { exec: passJudge(repo) });
    useRegistry(ALL);
    stderr.length = 0;
    expect(await runReviewGate(repo, { exec: mkExec(async () => 'VERDICT: PASS') })).toBe(0);
    expect(barePasses(stderr)).toEqual([]);
    expect(stderr.join('\n')).toContain(MCP_DEGRADED_REMEDY);
  });

  it('a full-capability PASS replays bare even if codebase later disappears (it WAS judged with it)', async () => {
    useRegistry(ALL);
    const repo = consumerRepo({ backend: true });
    await runReviewGate(repo, { exec: passJudge(repo) });
    useRegistry([]);
    stderr.length = 0;
    expect(await runReviewGate(repo, { exec: mkExec(async () => 'VERDICT: PASS') })).toBe(0);
    expect(stderr.join('\n')).not.toContain('DEGRADED');
  });

  it('a malformed stored mcp_degraded_cause is ignored rather than throwing or marking', async () => {
    useRegistry(ALL);
    const repo = consumerRepo({ backend: true });
    await runReviewGate(repo, { exec: passJudge(repo) });
    for (const [key, meta] of Object.entries(loadCache(repo)))
      savePasses(repo, { [key]: { ...meta, mcp_degraded_cause: 42 } });
    stderr.length = 0;
    expect(await runReviewGate(repo, { exec: mkExec(async () => 'VERDICT: PASS') })).toBe(0);
    expect(stderr.join('\n')).not.toContain('DEGRADED');
  });
});

describe('split correctness lenses without codebase (sc-2837)', () => {
  const lensJudge = (repo: string) =>
    mkExec(async ({ label, args }) => {
      writeArtifact(repo, label);
      const group = FOUR_WAY_LENS_GROUPS.find((g) => args[1].includes(g[0]));
      if (label === 'review:correctness-reviewer' && group)
        writeFileSync(
          join(repo, `.claude/.correctness-review-${lensGroupId(group)}.json`),
          JSON.stringify({
            items: [{ name: group[0], category: 'X', status: 'pass', issues: [] }],
          }),
        );
      return 'VERDICT: PASS';
    });

  it('per-part lines DEGRADED, ONE gate_degraded for the reviewer, merged row carries the cause', async () => {
    delete process.env.GUARD_CORRECTNESS_SPLIT; // the shipped four-way default
    useRegistry(['context7', 'autonomous_bugs']);
    const repo = consumerRepo({ backend: true });
    const events = captureEvents(repo);
    expect(await runReviewGate(repo, { exec: lensJudge(repo) })).toBe(0);
    const parts = stderr.filter((l) => /^guard-review: correctness-reviewer \[/.test(l));
    expect(parts).toHaveLength(FOUR_WAY_LENS_GROUPS.length);
    expect(parts.every((l) => l.includes('PASS (DEGRADED)'))).toBe(true);
    const all = events();
    expect(
      all.filter((e) => e.type === 'gate_degraded' && e.judge === 'correctness-reviewer'),
    ).toHaveLength(1);
    const rows = all.filter(
      (e) => e.type === 'review_result' && e.reviewer === 'correctness-reviewer',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].mcp_degraded_cause).toMatch(/^MCP codebase/);
    // The fleet line names the reviewer once, never its group-qualified part labels.
    const fleet = fleetLines(stderr)[0];
    expect(fleet.match(/correctness-reviewer/g)).toHaveLength(1);
    expect(fleet).not.toContain('[');
  });

  it('a fully-cached split replays DEGRADED whichever ONE group was judged degraded', async () => {
    delete process.env.GUARD_CORRECTNESS_SPLIT;
    useRegistry(ALL);
    const repo = consumerRepo({ backend: true });
    await runReviewGate(repo, { exec: lensJudge(repo) });
    const clean = loadCache(repo);
    // Lens-part entries are the ones carrying the spill-safe item aggregates (sc-1475).
    const parts = Object.keys(clean).filter(
      (k) => 'itemCount' in clean[k] || 'itemTally' in clean[k],
    );
    expect(parts).toHaveLength(FOUR_WAY_LENS_GROUPS.length);
    // Cache-key order is opaque, so degrade each group in turn: reading only the first part's entry
    // would replay a bare PASS for three of these four.
    for (const degradedKey of parts) {
      for (const k of parts)
        savePasses(repo, {
          [k]:
            k === degradedKey
              ? { ...clean[k], mcp_degraded_cause: 'MCP codebase unavailable (x)' }
              : clean[k],
        });
      stderr.length = 0;
      expect(await runReviewGate(repo, { exec: mkExec(async () => 'VERDICT: PASS') })).toBe(0);
      expect(stderr).toContainEqual(
        expect.stringMatching(/^guard-review: correctness-reviewer — cached PASS \(DEGRADED\)/),
      );
    }
  });

  it('a cached degraded group merged with a live clean one reports as a REPLAY, with the remedy', async () => {
    delete process.env.GUARD_CORRECTNESS_SPLIT;
    useRegistry(ALL);
    const repo = consumerRepo({ backend: true });
    await runReviewGate(repo, { exec: lensJudge(repo) });
    const cache = loadCache(repo);
    const parts = Object.keys(cache).filter(
      (k) => 'itemCount' in cache[k] || 'itemTally' in cache[k],
    );
    expect(parts).toHaveLength(FOUR_WAY_LENS_GROUPS.length);
    const [degraded, rejudged, ...rest] = parts;
    const kept = Object.fromEntries(rest.map((k) => [k, cache[k]]));
    kept[degraded] = { ...cache[degraded], mcp_degraded_cause: 'MCP codebase unavailable (x)' };
    // Drop one group so it is judged live (clean registry) beside the replayed degraded group.
    clearCache(repo);
    savePasses(repo, kept);
    expect(rejudged).toBeDefined();
    stderr.length = 0;
    expect(await runReviewGate(repo, { exec: lensJudge(repo) })).toBe(0);
    expect(stderr).toContainEqual(
      `⚠️  guard-review: correctness-reviewer — DEGRADED: MCP codebase unavailable (x) — ${MCP_DEGRADED_REMEDY}`,
    );
  });
});
