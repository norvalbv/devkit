// The workflow tier's acceptance cases, scored over the committed families with synthetic sessions;
// no test here spawns claude or reaches the network.

import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePriorArt } from '../../eval/adapters.mts';
import { workflowMain } from '../eval/workflow/cli.mts';
import { loadFamilies, type Member, type Span } from '../eval/workflow/families.mts';
import { executionId } from '../eval/workflow/identity.mts';
import { scoreRun } from '../eval/workflow/score.mts';
import {
  aggregateCase,
  type CaseResult,
  type CaseRows,
  type ScoredRun,
  summarise,
} from '../eval/workflow/summary.mts';
import {
  fakeSpawn,
  member as fixtureMember,
  pinnedRepo,
  response,
  stream,
} from './workflow-fixtures.mts';

const WS = '/tmp/prior-art-wf-x';
const families = loadFamilies();
function byId(id: string): Member {
  const found = families.find((m) => m.id === id);
  if (!found) throw new Error(`no committed family member ${id}`);
  return found;
}
const shipResume = byId('wf-ship-resume');
const shipNoRefs = byId('wf-ship-resume-no-refs');
const SHIP = 'cli/lib/ship/ship-branch.sh';
const shipLines = Array.from({ length: 1100 }, (_, i) => `line ${i + 1}`);
shipLines[274] = 'ship_refuse_dir_paths "$ROOT" || exit 1';
shipLines[900] = 'if [ "$DEVKIT_SHIP_INTENT_RECORDED" -ne 1 ]; then';
const read = (_m: Member, root: string, file: string) =>
  root === 'consumer' && file === SHIP ? shipLines.join('\n') : null;

function scored(m: Member, raw: string, endorsed: Record<string, boolean> = {}): ScoredRun {
  return { score: scoreRun(m, 'search', stream({ result: raw }), WS, read), endorsed };
}

function caseOf(m: Member, raw: string, endorsed: Record<string, boolean> = {}): CaseResult {
  return aggregateCase(m, [scored(m, raw, endorsed)], 0);
}

describe('workflow acceptance', () => {
  it('rejects the wrong helper: closing the partial-fix ticket as solved by PR #701', () => {
    const raw = response({
      verdict: 'SOLVED_ELSEWHERE',
      resolved: 1,
      evidence: [{ source: SHIP, quote: 'if [ "$DEVKIT_SHIP_INTENT_RECORDED" -ne 1 ]; then' }],
    });
    const result = caseOf(shipResume, raw, { 'd-close-as-fixed': true });
    expect(result.verdictOk).toBe(false);
    expect(result.decoyEndorsed).toEqual({ 'd-close-as-fixed': true });
    expect(result.claims.decoy).toBe(1);
  });

  it('keeps genuine work genuine and credits the surviving exits as recalled', () => {
    const raw = response({
      verdict: 'GENUINE_NEW_WORK',
      resolved: 1,
      evidence: [{ source: SHIP, quote: 'ship_refuse_dir_paths "$ROOT" || exit 1' }],
    });
    const result = caseOf(shipResume, raw);
    expect(result).toMatchObject({
      verdictOk: true,
      legHonest: true,
      recalled: { 'g-surviving-exits': true },
    });
    const dissolved = caseOf(shipResume, response({ verdict: 'DISSOLVE_FRAME', resolved: 1 }));
    expect(dissolved.verdictOk).toBe(false);
  });

  it('tells a supported no-answer from a broken tool', () => {
    // Same verdict, two layouts: with a resolved checkout GENUINE_NEW_WORK is a valid answer...
    expect(
      caseOf(shipResume, response({ verdict: 'GENUINE_NEW_WORK', resolved: 1 })).valid.ok,
    ).toBe(1);
    // ...but with refs/ empty, claiming the local leg reached is contract-invalid, not a verdict.
    const laundered = caseOf(
      shipNoRefs,
      response({ verdict: 'GENUINE_NEW_WORK', resolved: 0, localStatus: 'reached' }),
    );
    expect(laundered).toMatchObject({ verdict: 'INVALID', verdictOk: false });
    const honest = caseOf(shipNoRefs, response({ verdict: 'INSUFFICIENT_EVIDENCE', resolved: 0 }));
    expect(honest).toMatchObject({ verdictOk: true, legHonest: true });
    // A count that misreports the layout is caught even when the verdict is right.
    const miscounted = caseOf(
      shipNoRefs,
      response({ verdict: 'INSUFFICIENT_EVIDENCE', resolved: 2, localStatus: 'unavailable' }),
    );
    expect(miscounted.legHonest).toBe(false);
  });

  it('splits by family and pairs each task across conditions', () => {
    const members = families.filter((m) => m.caseId === 'fam-ship-resume');
    const good = response({ verdict: 'GENUINE_NEW_WORK', resolved: 1 });
    const insufficient = response({ verdict: 'INSUFFICIENT_EVIDENCE', resolved: 0 });
    const wrong = response({
      verdict: 'SOLVED_ELSEWHERE',
      resolved: 1,
      evidence: [{ source: SHIP, quote: 'line 3' }],
    });
    const rows: CaseRows = {
      'wf-ship-resume': { supplied: caseOf(shipResume, good), search: caseOf(shipResume, wrong) },
      'wf-ship-resume-no-refs': {
        supplied: caseOf(shipNoRefs, insufficient),
        search: caseOf(shipNoRefs, insufficient),
      },
    };
    const block = summarise(members, rows, {
      model: 'opus',
      claudeVersion: '2',
      scorerHash: 'h',
      runs: 1,
      matchRuns: 1,
      total: 4,
    }).priorArtWorkflow;
    expect(block.paired).toEqual({
      bothCorrect: 1,
      retrievalFailure: 1,
      searchOnly: 0,
      interpretationFailure: 0,
      total: 2,
    });
    expect(block.families['fam-ship-resume']).toEqual({ supplied: true, search: false });
    expect(block.conditions.search.familiesBothSides).toEqual({ ok: 0, total: 1 });
    expect(block.conditions.search.insufficientArtificial).toEqual({ ok: 1, total: 1 });
  });

  it('takes a decoy majority only over the runs the matcher measured', () => {
    const raw = response({ verdict: 'GENUINE_NEW_WORK', resolved: 1 });
    const runs = [
      scored(shipResume, raw, { 'd-close-as-fixed': true }),
      scored(shipResume, raw),
      scored(shipResume, raw),
    ];
    expect(aggregateCase(shipResume, runs, 0).decoyEndorsed).toEqual({ 'd-close-as-fixed': true });
  });

  it('never credits a span whose runs tie (read once, missed once) as located', () => {
    const readCall = { name: 'Read', input: { file_path: `${WS}/consumer/${SHIP}` } };
    const raw = response({ verdict: 'GENUINE_NEW_WORK', resolved: 1 });
    const tied = (m: Member) =>
      aggregateCase(
        m,
        [
          {
            score: scoreRun(m, 'search', stream({ calls: [readCall], result: raw }), WS, read),
            endorsed: {},
          },
          scored(m, raw),
        ],
        0,
      );
    const result = tied(shipResume);
    expect(Object.values(result.spans)).toEqual(['NULL', 'NULL', 'NULL']);
    const block = summarise(
      [shipResume],
      { 'wf-ship-resume': { search: result, supplied: result } },
      {
        model: 'opus',
        claudeVersion: '2',
        scorerHash: 'h',
        runs: 2,
        matchRuns: 1,
        total: 2,
      },
    ).priorArtWorkflow;
    expect(block.conditions.search.spansLocated).toEqual({ ok: 0, total: 3 });
    expect(block.conditions.search.spansRead).toEqual({ ok: 0, total: 3 });
  });

  it('keys an execution on every input that shapes the call', () => {
    const base = {
      agent: { body: 'b', model: 'opus', raw: 'r' },
      member: shipResume,
      condition: 'search' as const,
      request: 'req',
      version: '2.1.302',
      userInstructions: 'absent',
      runnerClosure: 'closure',
    };
    const id = executionId(base);
    expect(executionId({ ...base })).toBe(id);
    const moved = { ...shipResume, refs: [{ ...shipResume.refs[0], tree: 'f'.repeat(40) }] };
    for (const changed of [
      { version: '2.1.303' },
      { request: 'req2' },
      { runnerClosure: 'other' },
      { condition: 'supplied' as const },
      { member: moved },
    ])
      expect(executionId({ ...base, ...changed })).not.toBe(id);
  });
});

describe('workflow CLI over a fixture corpus', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  interface CliFixture {
    members: Member[];
    materialize: { cacheRoot: string; sourceRepo: string };
    checkpoint: string;
  }

  function fixture(): CliFixture {
    const { repo, pin } = pinnedRepo({ 'a.ts': 'export const a = 1;\n' });
    dirs.push(repo);
    return {
      members: [fixtureMember({ consumer: pin, refs: [pin] })],
      materialize: { cacheRoot: path.join(repo, '.cache'), sourceRepo: repo },
      checkpoint: path.join(repo, 'bank.jsonl'),
    };
  }

  function cliDeps(fx: CliFixture, fake: ReturnType<typeof fakeSpawn>, lines: string[] = []) {
    return {
      families: fx.members,
      materialize: fx.materialize,
      checkpoint: fx.checkpoint,
      results: path.join(path.dirname(fx.checkpoint), 'results.json'),
      version: () => '2.1.302',
      matcher: async () => [],
      log: (line: string) => lines.push(line),
      spawnFn: fake.spawnFn,
    };
  }

  /** Answers every session with a valid response, under the tools its argv granted (plus `extra`). */
  function answering(extra: string[] = []) {
    return fakeSpawn({
      stdoutFor: (args) => {
        const granted = args.at(-1)?.split(',').filter(Boolean) ?? [];
        const tools = granted.length ? [...granted, ...extra] : granted;
        return stream({ tools, result: response({ verdict: 'GENUINE_NEW_WORK', resolved: 1 }) });
      },
    });
  }

  it('never banks a session that got a tool outside the frozen profile; it reruns as an outage', async () => {
    const fx = fixture();
    const lines: string[] = [];
    const leaky = answering(['Bash']);
    expect(await workflowMain(['--dev', '--yes'], cliDeps(fx, leaky, lines))).toBe(0);
    expect(readFileSync(fx.checkpoint, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(lines.some((line) => /harness fault m1\/search#0/.test(line))).toBe(true);
    await workflowMain(['--dev', '--yes'], cliDeps(fx, leaky, lines));
    expect(leaky.calls).toHaveLength(3);
  });

  it('drops a matcher outage instead of scoring the decoy clean', async () => {
    const fx = fixture();
    fx.members[0] = { ...fx.members[0], decoys: [{ id: 'd-x', desc: 'adopt it', spans: [] }] };
    const outage = { slotId: 'd-x', kind: 'decoy' as const, match: 0, stable: false, outage: true };
    const deps = { ...cliDeps(fx, answering()), matcher: async () => [outage] };
    await workflowMain(['--baseline', '--yes'], deps);
    const block = JSON.parse(readFileSync(deps.results, 'utf8')).priorArtWorkflow;
    expect(block.rows.m1.search.decoyEndorsed).toEqual({});
    expect(block.conditions.search.decoyEndorsements.total).toBe(0);
  });

  it('refuses a labelled span the pinned snapshot does not hold, before spawning anything', async () => {
    const fx = fixture();
    const spans: Span[] = [
      { root: 'consumer', path: 'a.ts', lines: [5, 9] },
      { root: 'src', path: 'gone.ts', lines: [1, 1] },
    ];
    fx.members[0] = { ...fx.members[0], gold: [{ id: 'g', desc: 'd', spans }] };
    const fake = answering();
    await expect(workflowMain(['--dev'], cliDeps(fx, fake))).rejects.toThrow(
      /consumer:a\.ts:5-9[\s\S]*src:gone\.ts:1-1/,
    );
    expect(fake.calls).toHaveLength(0);
  });

  it('a --only run over part of the corpus never reads as an accepted baseline', async () => {
    vi.stubEnv('BENCH_RUNS', '3');
    const fx = fixture();
    fx.members.push({ ...fx.members[0], id: 'm2' });
    const deps = cliDeps(fx, answering());
    await workflowMain(['--baseline', '--yes', '--only', 'm1'], deps);
    const partial = JSON.parse(readFileSync(deps.results, 'utf8'));
    expect(partial.priorArtWorkflow.cases).toEqual({ executed: 2, total: 4 });
    expect(parsePriorArt(partial).acceptance.accepted).toBe(false);
    await workflowMain(['--baseline', '--yes'], deps);
    expect(parsePriorArt(JSON.parse(readFileSync(deps.results, 'utf8'))).acceptance.accepted).toBe(
      true,
    );
  });

  it('spawns nothing without --yes, then banks streams and rescores them without a new call', async () => {
    const { members, materialize, checkpoint } = fixture();
    const lines: string[] = [];
    const fake = fakeSpawn({
      stdoutFor: (args) => {
        const tools = args.at(-1)?.split(',').filter(Boolean) ?? [];
        return stream({ tools, result: response({ verdict: 'GENUINE_NEW_WORK', resolved: 1 }) });
      },
    });
    const deps = {
      families: members,
      materialize,
      checkpoint,
      version: () => '2.1.302',
      matcher: async () => [],
      log: (line: string) => lines.push(line),
      spawnFn: fake.spawnFn,
    };
    expect(await workflowMain(['--dev'], deps)).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect(lines.at(-1)).toMatch(/dry run: nothing spawned/);

    expect(await workflowMain(['--dev', '--yes'], deps)).toBe(0);
    expect(fake.calls).toHaveLength(2);
    expect(readFileSync(checkpoint, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(lines.some((line) => /m1 \[search\] ✓ GENUINE_NEW_WORK/.test(line))).toBe(true);

    expect(await workflowMain(['--dev', '--yes'], deps)).toBe(0);
    expect(fake.calls).toHaveLength(2);
    expect(await workflowMain(['--dev', '--yes'], { ...deps, version: () => '2.1.303' })).toBe(0);
    expect(fake.calls).toHaveLength(4);
  });
});
