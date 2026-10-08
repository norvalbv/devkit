import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deterministicStrict } from '../../config.mts';
import { recheckCommand } from '../recheck.mts';
import { parseOpts, prefixCacheScope, runDeterministic, selectedIds } from '../run.mts';

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
  delete process.env.DEVKIT_RUN_MODE;
  delete process.env.DEVKIT_REVIEW_GUARDS;
  delete process.env.DEVKIT_REVIEW_MERGE_BASE;
  delete process.env.DEVKIT_REVIEW_RUNTIME_FINGERPRINT;
  delete process.env.DEVKIT_SHIP;
  delete process.env.DEVKIT_SHIP_DRY_GATES_CMD;
  delete process.env.GUARD_COVERAGE_OK;
  delete process.env.GUARD_NO_COVERAGE;
  delete process.env.GUARD_STRUCTURE_OK;
  delete process.env.GUARD_NO_STRUCTURE;
  delete process.env.GUARD_HOOK_PARITY_OK;
  delete process.env.GUARD_DECISIONS_INTEGRITY_OK;
  delete process.env.DEVKIT_SHIP_PR_BASE_SHA;
  delete process.env.DEVKIT_SHIP_BRANCH;
  // Both spellings: envVar() accepts the FRINK_ alias, and `devkit ship` exports strict envs that a
  // pre-push vitest inherits — a leak that would silently flip every fail-open assertion below.
  delete process.env.GUARD_DETERMINISTIC_STRICT;
  delete process.env.FRINK_DETERMINISTIC_STRICT;
  delete process.env.DEVKIT_GATE_EVENTS;
  vi.restoreAllMocks();
});

// A repo whose .devkit/config.json selects `guards` and, independently, anti-slop. Pass null with
// no antiSlop value for the missing-config path.
function repo(guards, antiSlop) {
  const d = mkdtempSync(join(tmpdir(), 'guard-det-'));
  dirs.push(d);
  if (guards || antiSlop !== undefined) {
    mkdirSync(join(d, '.devkit'), { recursive: true });
    writeFileSync(
      join(d, '.devkit', 'config.json'),
      JSON.stringify({
        components: {
          guards: guards ?? undefined,
          antiSlop,
        },
      }),
    );
  }
  return d;
}

// The cache_state of every deterministic gate_timing event written to `sink`.
const cacheStates = (sink) =>
  readFileSync(sink, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((e) => e.type === 'gate_timing' && e.gate === 'deterministic')
    .map((e) => e.cache_state);

// Fake `node <guard-module> <args>` runner: maps a guard module basename → exit code. Throws
// { status } for non-zero (like execFileSync), returns for 0. argv[0] is the resolved module path.
function mkExec(codeByModule) {
  return vi.fn((_node, argv) => {
    const mod = argv[0];
    const hit = Object.entries(codeByModule).find(([k]) => mod.includes(k));
    const code = hit ? hit[1] : 0;
    if (code !== 0) {
      const e = new Error(`exit ${code}`);
      e.status = code;
      throw e;
    }
  });
}

describe('runDeterministic — aggregation + trichotomy', () => {
  it('TWO real failures are BOTH reported in one aggregated report → single exit 1', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size', 'fanout', 'dup', 'clone']);
    const exec = mkExec({ 'size-disable': 1, matcher: 1 }); // size + dup fail
    expect(runDeterministic(d, { exec })).toBe(1);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('deterministic gates failed: guard-size guard-dup');
    expect(exec).toHaveBeenCalledTimes(4); // fanout + clone still ran (not fail-fast)
  });

  it('exit 2 = could-not-run → fail-open (not accumulated), whole set exits 0', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size', 'fanout', 'dup', 'clone']);
    const exec = mkExec({ 'size-disable': 2, 'folder-fanout': 2, matcher: 2, 'clone-detector': 2 });
    expect(runDeterministic(d, { exec })).toBe(0);
  });

  it('an unexpected non-{0,1,2} code is aggregated WITH the code named', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['fanout']);
    const exec = mkExec({ 'folder-fanout': 127 });
    expect(runDeterministic(d, { exec })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('guard-fanout(unexpected:127)');
  });

  it('127 says the BINARY did not resolve, not that the gate found something', () => {
    // sc-1243: a ship worktree that linked a node_modules with nothing installed made every gate exit
    // 127, and the report named only the gate — sending the reader after the linter, not the link.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['fanout']);
    expect(runDeterministic(d, { exec: mkExec({ 'folder-fanout': 127 }) })).toBe(1);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('exit 127 = command not found');
    expect(out).toMatch(/BINARY did not resolve/);
    expect(out).toMatch(/symlinked in/);
  });

  it('does not mention 127 when no gate exited 127', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['fanout']);
    expect(runDeterministic(d, { exec: mkExec({ 'folder-fanout': 1 }) })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).not.toContain('exit 127');
  });

  it('runs ONLY the selected guards (components.guards)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec({});
    expect(runDeterministic(repo(['size']), { exec })).toBe(0);
    expect(exec).toHaveBeenCalledTimes(1); // only size
  });

  it('a missing/unreadable config runs the WHOLE set (never silently skip a gate)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec({});
    expect(runDeterministic(repo(null), { exec })).toBe(0);
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it('an opted-in anti-slop exit 2 is a HARD failure and prevents a false-green prefix', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec({ 'cli/index.mts': 2 });
    expect(runDeterministic(repo([], true), { exec })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain(
      'deterministic gates failed: guard-anti-slop(unexpected:2)',
    );
    expect(exec).toHaveBeenCalledWith(
      'node',
      [expect.stringContaining('cli/index.mts'), 'anti-slop', 'check', '--staged'],
      expect.anything(),
    );
  });

  it('aggregates anti-slop with another deterministic failure in the same run', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec({ 'size-disable': 1, 'cli/index.mts': 1 });
    expect(runDeterministic(repo(['size'], true), { exec })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain(
      'deterministic gates failed: guard-size guard-anti-slop',
    );
  });
});

// sc-2753: the judge-free comment budget aggregates here, so one fix pass sees every cheap finding.
describe('runDeterministic — comments joins the aggregated set', () => {
  const eventsOf = (sink) =>
    readFileSync(sink, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'gate_result');

  it('reports anti-slop AND comment-budget findings in ONE block (the sc-2753 two-attempt bug)', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec({ 'cli/index.mts': 1, 'comment-firewall/cli': 1 });
    expect(runDeterministic(repo(['comments'], true), { exec })).toBe(1);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('deterministic gates failed: guard-anti-slop guard-comments');
    expect(out).toContain(
      'On commit or ship, decision and reviewer gates run only after these pass.',
    );
    expect(exec).toHaveBeenCalledWith(
      'node',
      [expect.stringMatching(/comment-firewall[/\\]cli\.m[tj]s$/), 'gate'],
      expect.anything(),
    );
  });

  it('a clean comment budget adds no failure', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec({});
    expect(runDeterministic(repo(['size', 'comments']), { exec })).toBe(0);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('exit 4 blocks as unreadable-evidence — never unexpected:4, and could_not_run in telemetry', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['comments']);
    const sink = join(d, 'events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    expect(runDeterministic(d, { exec: mkExec({ 'comment-firewall/cli': 4 }) })).toBe(1);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('deterministic gates failed: guard-comments(unreadable-evidence)');
    expect(out).not.toContain('unexpected:4');
    expect(eventsOf(sink)).toEqual([
      expect.objectContaining({
        gate: 'comments',
        status: 'could_not_run',
        family: 'deterministic',
      }),
    ]);
  });

  it('a real comment finding is a fail in telemetry, never an unreadable-evidence label', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['comments']);
    const sink = join(d, 'events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    expect(runDeterministic(d, { exec: mkExec({ 'comment-firewall/cli': 1 }) })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).not.toContain('unreadable-evidence');
    expect(eventsOf(sink)).toEqual([expect.objectContaining({ gate: 'comments', status: 'fail' })]);
  });

  it('exit 2 is never an opt-out for comments — it blocks as unexpected, strict or not', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      runDeterministic(repo(['comments']), { exec: mkExec({ 'comment-firewall/cli': 2 }) }),
    ).toBe(1);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('guard-comments(unexpected:2)');
    expect(out).not.toContain('opted out');
  });

  it('strict mode keeps the unreadable-evidence label (it was never an opt-out)', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_DETERMINISTIC_STRICT = '1';
    expect(
      runDeterministic(repo(['comments']), { exec: mkExec({ 'comment-firewall/cli': 4 }) }),
    ).toBe(1);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('guard-comments(unreadable-evidence)');
    expect(out).not.toContain('could-not-run');
  });

  it("the exit-4 label is comments' own — another gate's exit 4 stays unexpected:4", () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec({ 'size-disable': 4, 'comment-firewall/cli': 4 });
    expect(runDeterministic(repo(['size', 'comments']), { exec })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain(
      'deterministic gates failed: guard-size(unexpected:4) guard-comments(unreadable-evidence)',
    );
  });

  // A caller-shaped `--extra` label must never decide the outcome: the exit code does (sc-2753).
  it.each(['x(unreadable-evidence)', 'y(unexpected:9)', 'z(could-not-run)'])(
    'an --extra gate labelled %s that exits 1 is a fail under its full label',
    (label) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const d = repo([]);
      const sink = join(d, 'events.jsonl');
      process.env.DEVKIT_GATE_EVENTS = sink;
      const exec = vi.fn(() => {
        const e = new Error('exit 1');
        e.status = 1;
        throw e;
      });
      expect(runDeterministic(d, { exec, extra: [{ label, cmd: 'lint-it' }] })).toBe(1);
      expect(eventsOf(sink)).toEqual([expect.objectContaining({ gate: label, status: 'fail' })]);
    },
  );

  it('--only comments is a known id and runs just the firewall', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec({});
    expect(runDeterministic(repo(['size', 'comments']), { exec, only: ['comments'] })).toBe(0);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][1][0]).toMatch(/comment-firewall/);
  });

  it('runs the REAL firewall end-to-end: a staged 3-line comment paragraph blocks in the aggregate', () => {
    const d = repo(['comments']);
    const git = (...a) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    git('add', '.devkit/config.json');
    git('commit', '-q', '-m', 'base');
    mkdirSync(join(d, 'src'), { recursive: true });
    writeFileSync(
      join(d, 'src', 'a.ts'),
      '// first line of prose\n// second line of prose\n// third line of prose\nexport const a = 1;\n',
    );
    git('add', 'src/a.ts');
    const runner = join(import.meta.dirname, '..', 'run.mts');
    let status = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [runner], { cwd: d, stdio: 'pipe', encoding: 'utf8' });
    } catch (e) {
      status = e.status;
      stderr = `${e.stderr}`;
    }
    expect(status).toBe(1);
    // The child's own first line stays byte-stable for the collector, then the aggregate names it.
    expect(stderr).toContain('guard-comments: 1 added/modified comment paragraph need a decision.');
    expect(stderr).toContain('✗ deterministic gates failed: guard-comments\n');
  });
});

describe('runDeterministic — --structure / --extra / --only', () => {
  it('--structure "guard-structure gate" runs the sibling module and keeps the trichotomy', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size']);
    const exec = mkExec({ 'structure/run.mts': 1 });
    expect(runDeterministic(d, { exec, structure: 'guard-structure gate' })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('structure-lint');
    // resolved as `node <sibling structure/run.mts> gate`, never via bunx/PATH
    const call = exec.mock.calls.find(([, argv]) => argv[0].includes('structure/run.mts'));
    expect(call[0]).toBe('node');
    expect(call[1][1]).toBe('gate');
    // exit 2 = could-not-run → fail-open for the guard form
    const exec2 = mkExec({ 'structure/run.mts': 2 });
    expect(runDeterministic(d, { exec: exec2, structure: 'guard-structure gate' })).toBe(0);
  });

  it('a non-guard structure command spawns via PATH and BLOCKS on exit 2 (eslint fatal ≠ opt-out)', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size']);
    const exec = vi.fn((bin) => {
      if (bin === 'bunx') {
        const e = new Error('exit 2');
        e.status = 2;
        throw e;
      }
    });
    expect(runDeterministic(d, { exec, structure: 'bunx eslint src' })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('structure-lint(unexpected:2)');
    expect(exec).toHaveBeenCalledWith('bunx', ['eslint', 'src'], expect.anything());
  });

  it.each(['GUARD_STRUCTURE_OK', 'GUARD_NO_STRUCTURE'])(
    '%s skips an arbitrary structure command but keeps the other deterministic gates active',
    (key) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const d = repo(['size']);
      const exec = mkExec({});
      process.env[key] = '1';

      expect(runDeterministic(d, { exec, structure: 'bunx eslint src' })).toBe(0);
      expect(exec).toHaveBeenCalledTimes(1); // size still ran; only structure was skipped
      expect(exec.mock.calls.some(([bin]) => bin === 'bunx')).toBe(false);
      expect(log.mock.calls.flat().join('\n')).toContain('Structure lint BYPASSED');
    },
  );

  it('records the structure bypass with the collector-supported non-run status', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const d = repo(['size']);
    const sink = join(d, 'events.jsonl');
    process.env.GUARD_STRUCTURE_OK = '1';
    process.env.DEVKIT_GATE_EVENTS = sink;

    expect(runDeterministic(d, { exec: mkExec({}), structure: 'bunx eslint src' })).toBe(0);
    const events = readFileSync(sink, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === 'gate_result');
    expect(events).toContainEqual(
      expect.objectContaining({
        gate: 'structure-lint',
        status: 'could_not_run',
        detail: 'structure-lint(bypassed:GUARD_STRUCTURE_OK)',
      }),
    );
  });

  it('a prefix-cached retry says which gates it did not re-run, instead of printing nothing', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const d = repo(['size']);
    execFileSync('git', ['init', '-q'], { cwd: d });
    execFileSync('git', ['add', '.'], { cwd: d });
    const exec = mkExec({});
    process.env.DEVKIT_SHIP = '1';
    process.env.DEVKIT_GATE_EVENTS = join(d, 'events.jsonl');

    expect(runDeterministic(d, { exec, extra: [{ label: 'hook-parity', cmd: 'true' }] })).toBe(0);
    expect(runDeterministic(d, { exec, extra: [{ label: 'hook-parity', cmd: 'true' }] })).toBe(0);

    expect(exec).toHaveBeenCalledTimes(2); // size + the extra, first run only
    expect(cacheStates(process.env.DEVKIT_GATE_EVENTS)).toEqual(['none', 'full']);
    const cached = log.mock.calls.flat().filter((l) => String(l).includes('not re-run'));
    expect(cached).toEqual([expect.stringMatching(/not re-run: guard-size hook-parity$/)]);
  });

  it('a cached retry of a bypassed run names the bypass, never only that it passed', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const d = repo(['size', 'coverage']);
    execFileSync('git', ['init', '-q'], { cwd: d });
    execFileSync('git', ['add', '.'], { cwd: d });
    const exec = mkExec({});
    process.env.DEVKIT_SHIP = '1';
    process.env.GUARD_STRUCTURE_OK = '1';
    process.env.GUARD_HOOK_PARITY_OK = '1';
    process.env.GUARD_NO_COVERAGE = '1'; // the alias spelling is the same bypass
    const opts = {
      exec,
      structure: 'bunx eslint src',
      extra: [{ label: 'hook-parity', cmd: 'true' }],
    };

    expect(runDeterministic(d, opts)).toBe(0);
    expect(runDeterministic(d, opts)).toBe(0);

    const cached = log.mock.calls.flat().filter((l) => String(l).includes('not re-run'));
    expect(cached).toEqual([
      expect.stringMatching(
        /not re-run: guard-size hook-parity structure-lint; bypassed for this run: GUARD_COVERAGE_OK GUARD_STRUCTURE_OK GUARD_HOOK_PARITY_OK$/,
      ),
    ]);
  });

  // A ship repo: coverage selected (plus `extra`), an artifact on disk, staged, DEVKIT_SHIP armed.
  function coverageShipRepo(extra = []) {
    const d = repo(['coverage', ...extra]);
    execFileSync('git', ['init', '-q'], { cwd: d });
    execFileSync('git', ['add', '.'], { cwd: d });
    mkdirSync(join(d, 'coverage'));
    writeFileSync(join(d, 'coverage', 'coverage-final.json'), '{"a":1}');
    process.env.DEVKIT_SHIP = '1';
    return { d, artifact: join(d, 'coverage', 'coverage-final.json') };
  }

  it('a cache hit still judges coverage, against whatever artifact is on disk now', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { d } = coverageShipRepo(['size']);
    process.env.DEVKIT_GATE_EVENTS = join(d, 'events.jsonl');
    const exec = mkExec({});
    expect(runDeterministic(d, { exec })).toBe(0);
    expect(exec).toHaveBeenCalledTimes(2);
    const failing = mkExec({ 'coverage/run': 1 });
    expect(runDeterministic(d, { exec: failing })).toBe(1);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(failing.mock.calls[0][1][0]).toMatch(/coverage[\\/]run\.m?ts$/);
    expect(cacheStates(process.env.DEVKIT_GATE_EVENTS)).toEqual(['none', 'partial']);
  });

  it('a run where a gate opted out is not cached, so a retry never calls that gate passed', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { d } = coverageShipRepo(['dup']);
    const exec = mkExec({ matcher: 2 });
    expect(runDeterministic(d, { exec })).toBe(0);
    expect(runDeterministic(d, { exec })).toBe(0);
    expect(exec).toHaveBeenCalledTimes(4);
    expect(log.mock.calls.flat().some((l) => String(l).includes('not re-run'))).toBe(false);
  });

  it('re-emits the structure bypass on a prefix-cached retry — every bypassed ATTEMPT counts', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const d = repo(['size']);
    execFileSync('git', ['init', '-q'], { cwd: d });
    execFileSync('git', ['add', '.'], { cwd: d });
    const sink = join(d, 'events.jsonl');
    const exec = mkExec({});
    process.env.DEVKIT_SHIP = '1';
    process.env.GUARD_STRUCTURE_OK = '1';
    process.env.DEVKIT_GATE_EVENTS = sink;

    expect(runDeterministic(d, { exec, structure: 'bunx eslint src' })).toBe(0);
    expect(runDeterministic(d, { exec, structure: 'bunx eslint src' })).toBe(0);

    expect(exec).toHaveBeenCalledTimes(1); // first run executes size; cached retry executes nothing
    expect(
      log.mock.calls.flat().filter((line) => String(line).includes('Structure lint BYPASSED')),
    ).toHaveLength(1);
    const bypassEvents = readFileSync(sink, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(
        (event) =>
          event.gate === 'structure-lint' &&
          event.status === 'could_not_run' &&
          event.detail === 'structure-lint(bypassed:GUARD_STRUCTURE_OK)',
      );
    expect(bypassEvents).toHaveLength(2);
  });

  it('a structure failure prints the explicit base-debt remedy', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size']);
    expect(
      runDeterministic(d, {
        exec: mkExec({ 'structure/run.mts': 1 }),
        structure: 'guard-structure gate',
      }),
    ).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('export GUARD_STRUCTURE_OK=1');
  });

  it('--extra gates run under their own label and aggregate with the built-ins', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size']);
    const exec = vi.fn((bin, argv) => {
      const key = [bin, ...argv].join(' ');
      if (key.includes('size-disable') || bin === 'bun') {
        const e = new Error('exit 1');
        e.status = 1;
        throw e;
      }
    });
    expect(runDeterministic(d, { exec, extra: [{ label: 'lint', cmd: 'bun run lint' }] })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain(
      'deterministic gates failed: guard-size lint',
    );
  });

  it('a malformed --extra (no command) BLOCKS as unrunnable — never silently skipped', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size']);
    expect(runDeterministic(d, { exec: mkExec({}), extra: [{ label: 'lint' }] })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('lint(unrunnable: empty command)');
  });

  it('guard.config.json extraGates run after the --extra gates and block on non-zero', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size']);
    writeFileSync(
      join(d, 'guard.config.json'),
      JSON.stringify({ extraGates: { knip: 'bun run knip', types: 'tsc --noEmit' } }),
    );
    const exec = vi.fn((bin, argv) => {
      if (bin === 'bun' && argv.includes('knip'))
        throw Object.assign(new Error('x'), { status: 1 });
    });
    const extra = [{ label: 'lint', cmd: 'oxlint' }];
    expect(runDeterministic(d, { exec, extra })).toBe(1);
    const ran = exec.mock.calls.map(([bin, argv]) => [bin, ...argv].join(' ')).slice(1);
    expect(ran).toEqual(['oxlint', 'bun run knip', 'tsc --noEmit']);
    expect(err.mock.calls.flat().join('\n')).toContain('deterministic gates failed: knip');
  });

  // Raw JSON text: a `__proto__` key in an object literal would never reach the file.
  it.each([
    ['a non-string command', '{ "knip": 42 }', 'extraGates.knip:'],
    ['an empty command', '{ "knip": "  " }', 'extraGates.knip:'],
    ['a non-object block', '["bun run knip"]', 'extraGates:'],
    ['a __proto__ label', '{ "__proto__": "bun run knip" }', 'extraGates.__proto__:'],
    ['an empty label', '{ "": "bun run knip" }', 'extraGates.:'],
    ['a built-in gate name', '{ "structure-lint": "eslint src" }', 'extraGates.structure-lint:'],
    ['a guard- prefix', '{ "guard-size": "true" }', 'extraGates.guard-size:'],
  ])('extraGates with %s BLOCKS as unrunnable — never silently skipped', (_, gates, where) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size']);
    writeFileSync(join(d, 'guard.config.json'), `{ "extraGates": ${gates} }`);
    const exec = mkExec({});
    expect(runDeterministic(d, { exec })).toBe(1);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain(`guard.config.json ${where}`);
    expect(out).toContain('extraGates(unrunnable: empty command)');
    expect(exec.mock.calls.map(([bin]) => bin)).toEqual(['node']); // size only, no partial set
  });

  it('an unreadable guard.config.json blocks instead of dropping its extraGates', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size']);
    writeFileSync(join(d, 'guard.config.json'), '{ "extraGates": ');
    expect(runDeterministic(d, { exec: mkExec({}) })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('guard.config.json(unreadable)');
  });

  it('declaring a new extraGate invalidates a cached all-green tree', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const d = repo(['size']);
    execFileSync('git', ['init', '-q'], { cwd: d });
    execFileSync('git', ['add', '.'], { cwd: d });
    process.env.DEVKIT_SHIP = '1';
    const exec = mkExec({});
    expect(runDeterministic(d, { exec })).toBe(0);
    writeFileSync(join(d, 'guard.config.json'), JSON.stringify({ extraGates: { knip: 'knip' } }));
    expect(runDeterministic(d, { exec })).toBe(0);
    expect(exec.mock.calls.map(([bin]) => bin)).toEqual(['node', 'node', 'knip']);
  });

  it('a malformed extraGates block blocks even when the tree is cached green', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size']);
    execFileSync('git', ['init', '-q'], { cwd: d });
    execFileSync('git', ['add', '.'], { cwd: d });
    process.env.DEVKIT_SHIP = '1';
    expect(runDeterministic(d, { exec: mkExec({}) })).toBe(0);
    // An untracked config leaves `git write-tree` unchanged, and null fingerprints like absent.
    writeFileSync(join(d, 'guard.config.json'), '{ "extraGates": null }');
    expect(runDeterministic(d, { exec: mkExec({}) })).toBe(1);
  });

  it('--only restricts the built-in set, overriding the config selection', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size', 'fanout', 'dup', 'clone']);
    const exec = mkExec({});
    expect(runDeterministic(d, { exec, only: ['size', 'fanout'] })).toBe(0);
    expect(exec).toHaveBeenCalledTimes(2);
    const mods = exec.mock.calls.map(([, argv]) => argv[0]).join(' ');
    expect(mods).toContain('size-disable');
    expect(mods).toContain('folder-fanout');
  });

  it('a typoed --only id fails CLOSED before running any gate (no silent drop)', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec({});
    // `siz` is a typo for `size` — must NOT silently run zero built-ins.
    expect(runDeterministic(repo(['size']), { exec, only: ['siz', 'fanout'] })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('unknown gate id(s): siz');
    expect(exec).not.toHaveBeenCalled(); // refused before the gate loop
  });

  it('an empty --only selection (e.g. `--only ,,` → []) fails CLOSED, never runs zero built-ins silently', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec({});
    expect(runDeterministic(repo(['size']), { exec, only: [] })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('empty selection');
    expect(exec).not.toHaveBeenCalled();
  });

  it('review --only cannot re-enable a gate outside the configured review allowlist', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec({});
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_GUARDS = 'size';

    expect(runDeterministic(repo(['size', 'fanout']), { exec, only: ['fanout'] })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('not enabled for review: fanout');
    expect(exec).not.toHaveBeenCalled();
  });

  it('review --only may narrow the allowlist and runs the canonical subset once', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec({});
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_GUARDS = 'fanout,size';

    expect(runDeterministic(repo(['clone']), { exec, only: ['fanout', 'fanout'] })).toBe(0);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][1][0]).toContain('folder-fanout');
  });
});

describe('parseOpts — the argv tokenizer the real hook depends on', () => {
  it('captures --hook/--scope/--structure values and repeated --extra specs', () => {
    const o = parseOpts([
      '--hook',
      '/a b/pre-commit',
      '--scope',
      'frink-extra',
      '--structure',
      'guard-structure gate',
      '--extra',
      'lint=bun run lint',
      '--extra',
      'types=tsc -p .',
    ]);
    expect(o.hookPath).toBe('/a b/pre-commit');
    expect(o.scope).toBe('frink-extra');
    expect(o.structure).toBe('guard-structure gate');
    expect(o.extra).toEqual([
      { label: 'lint', cmd: 'bun run lint' },
      { label: 'types', cmd: 'tsc -p .' },
    ]);
  });

  it('a malformed --extra (no `=`) parses to a label-only spec (runDeterministic then blocks it)', () => {
    expect(parseOpts(['--extra', 'lint']).extra).toEqual([{ label: 'lint' }]);
  });

  it('--only splits/trims/drops blanks — `,,` yields [] (fail-closed at runDeterministic)', () => {
    expect(parseOpts(['--only', 'size, fanout ,']).only).toEqual(['size', 'fanout']);
    expect(parseOpts(['--only', ',,']).only).toEqual([]);
  });
});

describe('selectedIds', () => {
  // sc-2483 follow-through: .devkit/config.json is external JSON, so every layer is read as an own
  // property — an inherited `components`/`guards`/`antiSlop` must never change the gate set.
  it('ignores inherited properties at every layer of the config', () => {
    const proto = Object.prototype;
    Object.defineProperty(proto, 'components', {
      value: { antiSlop: true, guards: ['size'] },
      configurable: true,
    });
    Object.defineProperty(proto, 'antiSlop', { value: true, configurable: true });
    Object.defineProperty(proto, 'guards', { value: ['size'], configurable: true });
    try {
      expect(selectedIds(repo(null))).toEqual(['size', 'fanout', 'dup', 'clone']);
      expect(selectedIds(repo(['clone']))).toEqual(['clone']);
      expect(selectedIds(repo([], false))).toEqual([]);
    } finally {
      delete proto.components;
      delete proto.antiSlop;
      delete proto.guards;
    }
  });

  it('intersects components.guards with the deterministic set in fixed order, dropping AI ids', () => {
    const d = repo(['clone', 'size', 'review', 'decisions']); // review/decisions are AI (fail-fast)
    expect(selectedIds(d)).toEqual(['size', 'clone']);
  });

  it('runs an explicitly-selected opt-in guard (coverage)', () => {
    expect(selectedIds(repo(['size', 'coverage']))).toEqual(['size', 'coverage']);
  });

  it('EXCLUDES opt-in coverage from the missing-config fallback (unadopted repo never wedged)', () => {
    expect(selectedIds(repo(null))).toEqual(['size', 'fanout', 'dup', 'clone']);
  });

  it('selects anti-slop only from its explicit component bit, never components.guards', () => {
    expect(selectedIds(repo([], true))).toEqual(['anti-slop']);
    expect(selectedIds(repo(['anti-slop'], false))).toEqual([]);
    expect(selectedIds(repo(['anti-slop']))).toEqual([]);
  });

  it('keeps anti-slop out of missing and unreadable config fallbacks', () => {
    expect(selectedIds(repo(null))).not.toContain('anti-slop');
    const d = repo([], true);
    writeFileSync(join(d, '.devkit', 'config.json'), '{ nope');
    expect(selectedIds(d)).toEqual(['size', 'fanout', 'dup', 'clone']);
  });

  it('selects comments from components.guards, but keeps it out of both fallbacks (opt-in)', () => {
    expect(selectedIds(repo(['size', 'comments']))).toEqual(['size', 'comments']);
    expect(selectedIds(repo(['review', 'decisions']))).toEqual([]);
    expect(selectedIds(repo(null))).not.toContain('comments');
    const d = repo(['comments']);
    writeFileSync(join(d, '.devkit', 'config.json'), '{ nope');
    expect(selectedIds(d)).not.toContain('comments');
  });

  it('review mode honours comments in the explicit allowlist, and only there', () => {
    const d = repo(['size', 'comments']);
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_GUARDS = 'comments,review';
    expect(selectedIds(d)).toEqual(['comments']);
    process.env.DEVKIT_REVIEW_GUARDS = 'size,review';
    expect(selectedIds(d)).toEqual(['size']);
  });

  it('uses the explicit review allowlist instead of components.guards in review mode', () => {
    const d = repo(['size', 'fanout', 'dup', 'clone'], true);
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_GUARDS = ' clone, size ,decisions, anti-slop ';
    expect(selectedIds(d)).toEqual(['size', 'clone']);
    process.env.DEVKIT_REVIEW_GUARDS = '';
    expect(selectedIds(d)).toEqual([]);
    delete process.env.DEVKIT_REVIEW_GUARDS;
    expect(selectedIds(d)).toEqual([]);
  });
});

describe('coverage — opt-in wiring through runDeterministic', () => {
  it('spawns the coverage module when selected', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec({});
    expect(runDeterministic(repo(['size', 'coverage']), { exec })).toBe(0);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls.some(([, argv]) => argv[0].includes('coverage/run'))).toBe(true);
  });

  it('does NOT spawn coverage on the missing-config fallback', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec({});
    expect(runDeterministic(repo(null), { exec })).toBe(0);
    expect(exec.mock.calls.some(([, argv]) => argv[0].includes('coverage/run'))).toBe(false);
  });
});

describe('prefixCacheScope', () => {
  it('salts review entries with mode and allowlist while leaving commit/ship scopes unchanged', () => {
    expect(prefixCacheScope()).toBeUndefined();
    expect(prefixCacheScope('custom')).toBe('custom');
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_GUARDS = 'size,decisions';
    expect(prefixCacheScope()).toBe('devkit-guards:review:size:base:unmanaged:runtime:unmanaged');
    expect(prefixCacheScope('custom')).toBe('custom:review:size:base:unmanaged:runtime:unmanaged');
  });

  it('canonicalizes the effective guard set so order and duplicates share one cache key', () => {
    process.env.DEVKIT_RUN_MODE = 'review';
    expect(prefixCacheScope(undefined, ['fanout', 'size', 'fanout'])).toBe(
      'devkit-guards:review:size,fanout:base:unmanaged:runtime:unmanaged',
    );
    expect(prefixCacheScope(undefined, ['size', 'fanout'])).toBe(
      'devkit-guards:review:size,fanout:base:unmanaged:runtime:unmanaged',
    );
  });

  it('keeps identical final trees on different resolved merge-bases in separate review entries', () => {
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_GUARDS = 'size';
    process.env.DEVKIT_REVIEW_MERGE_BASE = 'a'.repeat(40);
    const firstBase = prefixCacheScope();
    process.env.DEVKIT_REVIEW_MERGE_BASE = 'b'.repeat(40);
    const secondBase = prefixCacheScope();

    expect(firstBase).toBe(`devkit-guards:review:size:base:${'a'.repeat(40)}:runtime:unmanaged`);
    expect(secondBase).toBe(`devkit-guards:review:size:base:${'b'.repeat(40)}:runtime:unmanaged`);
    expect(secondBase).not.toBe(firstBase);
  });

  it('keeps identical trees under different dependency/asset runtimes in separate entries', () => {
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_GUARDS = 'size';
    process.env.DEVKIT_REVIEW_RUNTIME_FINGERPRINT = 'a'.repeat(40);
    const firstRuntime = prefixCacheScope();
    process.env.DEVKIT_REVIEW_RUNTIME_FINGERPRINT = 'b'.repeat(40);
    const secondRuntime = prefixCacheScope();

    expect(firstRuntime).not.toBe(secondRuntime);
    expect(firstRuntime).toContain(`:runtime:${'a'.repeat(40)}`);
    expect(secondRuntime).toContain(`:runtime:${'b'.repeat(40)}`);
  });

  // THE anti-laundering property. Without the salt a GUARD_COVERAGE_OK ship records an all-green key
  // that a later un-bypassed ship of the identical tree would HIT — skipping every gate, so coverage
  // never runs again. The two runs must never share a key.
  it.each(['GUARD_COVERAGE_OK', 'GUARD_NO_COVERAGE'])(
    '%s salts the scope away from a clean run',
    (key) => {
      const cleanDefault = prefixCacheScope();
      const cleanCustom = prefixCacheScope('custom');
      process.env[key] = '1';
      expect(prefixCacheScope()).toBe('devkit-guards:coverage-bypassed');
      expect(prefixCacheScope('custom')).toBe('custom:coverage-bypassed');
      expect(prefixCacheScope()).not.toBe(cleanDefault);
      expect(prefixCacheScope('custom')).not.toBe(cleanCustom);
    },
  );

  it('composes with the review salt rather than replacing it', () => {
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_GUARDS = 'size';
    process.env.GUARD_COVERAGE_OK = '1';
    expect(prefixCacheScope()).toBe(
      'devkit-guards:review:size:base:unmanaged:runtime:unmanaged:coverage-bypassed',
    );
  });

  it('a falsey value leaves the scope unsalted (envFlag semantics)', () => {
    process.env.GUARD_COVERAGE_OK = '0';
    expect(prefixCacheScope()).toBeUndefined();
    expect(prefixCacheScope('custom')).toBe('custom');
  });

  // Same anti-laundering property, for the self-host `--extra` gates (sc-2198). These live outside
  // the DETERMINISTIC registry, so nothing else would have salted them.
  it.each(['GUARD_HOOK_PARITY_OK', 'GUARD_DECISIONS_INTEGRITY_OK'])(
    '%s salts the scope away from a clean run',
    (key) => {
      const cleanDefault = prefixCacheScope();
      process.env[key] = '1';
      expect(prefixCacheScope()).not.toBe(cleanDefault);
      expect(prefixCacheScope()).toContain('-bypassed');
    },
  );

  it('gives each combination of extra bypasses its own key, order-independently', () => {
    process.env.GUARD_HOOK_PARITY_OK = '1';
    const one = prefixCacheScope();
    process.env.GUARD_DECISIONS_INTEGRITY_OK = '1';
    const both = prefixCacheScope();
    expect(both).not.toBe(one);
    // Sorted, so exporting the two flags in either order lands on the same key.
    expect(both).toBe('devkit-guards:DECISIONS_INTEGRITY_OK+HOOK_PARITY_OK-bypassed');
  });
  // The release-only dist extra's verdict depends on the PR base and branch, not the tree alone: a
  // release/vX PASS must never authorize the same tree shipped from a feature branch or base.
  it('keys a ship on its PR base and branch, which the release-only dist extra judges', () => {
    delete process.env.DEVKIT_SHIP_PR_BASE_SHA;
    expect(prefixCacheScope()).toBeUndefined();
    process.env.DEVKIT_SHIP_PR_BASE_SHA = 'a'.repeat(40);
    process.env.DEVKIT_SHIP_BRANCH = 'release/v9.9.9';
    const release = prefixCacheScope();
    process.env.DEVKIT_SHIP_BRANCH = 'feat/x';
    const feature = prefixCacheScope();
    process.env.DEVKIT_SHIP_PR_BASE_SHA = 'b'.repeat(40);
    const otherBase = prefixCacheScope();

    expect(release).toBe(`devkit-guards:pr-base:${'a'.repeat(40)}:branch:release/v9.9.9`);
    expect(new Set([release, feature, otherBase]).size).toBe(3);
  });

  it.each(['GUARD_STRUCTURE_OK', 'GUARD_NO_STRUCTURE'])(
    '%s salts the scope away from a normal structure run',
    (key) => {
      const cleanDefault = prefixCacheScope();
      const cleanCustom = prefixCacheScope('custom');
      process.env[key] = '1';
      expect(prefixCacheScope()).toBe('devkit-guards:structure-bypassed');
      expect(prefixCacheScope('custom')).toBe('custom:structure-bypassed');
      expect(prefixCacheScope()).not.toBe(cleanDefault);
      expect(prefixCacheScope('custom')).not.toBe(cleanCustom);
    },
  );

  it('the structure salt composes after strict and coverage salts', () => {
    process.env.GUARD_DETERMINISTIC_STRICT = '1';
    process.env.GUARD_COVERAGE_OK = '1';
    process.env.GUARD_STRUCTURE_OK = '1';
    expect(prefixCacheScope()).toBe(
      'devkit-guards:deterministic-strict:coverage-bypassed:structure-bypassed',
    );
  });
});

// A gate that opts out proved nothing, but its own stderr scrolls past at the same weight as a gate
// that passed — which is how a repo runs for weeks with its duplication gate silently disabled.
describe('runDeterministic — opted-out gates are named, and strict refuses them', () => {
  it('names the opted-out gate on a GREEN run (exit 0, but not silent)', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size', 'dup']);
    const exec = mkExec({ matcher: 2 }); // dup opts out; size passes
    expect(runDeterministic(d, { exec })).toBe(0);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('1 deterministic gate opted out and did NOT run: guard-dup');
    expect(out).toContain('proved nothing');
    expect(out).not.toContain('deterministic gates failed');
  });

  it('emits a could_not_run telemetry event for a gate that opted out', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['dup']);
    const sink = join(d, 'events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    expect(runDeterministic(d, { exec: mkExec({ matcher: 2 }) })).toBe(0);
    const events = readFileSync(sink, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'gate_result');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ gate: 'dup', status: 'could_not_run' });
  });

  it('strict turns the opt-out into a failure, labelled could-not-run (exit 1)', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_DETERMINISTIC_STRICT = '1';
    const d = repo(['size', 'dup']);
    expect(runDeterministic(d, { exec: mkExec({ matcher: 2 }) })).toBe(1);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('guard-dup(could-not-run)');
    expect(out).not.toContain('unexpected:2');
  });

  it('strict is OFF by default — the same run fails open', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runDeterministic(repo(['dup']), { exec: mkExec({ matcher: 2 }) })).toBe(0);
  });

  // The regression that makes strict safe to add: `failOpen2` is a property of the GATE, strict is a
  // property of the RUN. An --extra/eslint exit 2 was never an opt-out, so strict must not relabel it
  // as one — that would downgrade a fatal config error to "a gate chose to skip".
  it('strict does NOT relabel an exit 2 that was never an opt-out', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_DETERMINISTIC_STRICT = '1';
    const d = repo(['size']);
    const exec = vi.fn((bin) => {
      if (bin === 'bunx') {
        const e = new Error('exit 2');
        e.status = 2;
        throw e;
      }
    });
    expect(runDeterministic(d, { exec, structure: 'bunx eslint src' })).toBe(1);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('structure-lint(unexpected:2)');
    expect(out).not.toContain('could-not-run');
    expect(out).not.toContain('opted out and did NOT run');
  });

  it('a strict could-not-run is telemetry could_not_run, never a fail', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_DETERMINISTIC_STRICT = '1';
    const d = repo(['dup']);
    const sink = join(d, 'events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    expect(runDeterministic(d, { exec: mkExec({ matcher: 2 }) })).toBe(1);
    const events = readFileSync(sink, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'gate_result');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ gate: 'dup', status: 'could_not_run' });
  });

  // The anti-laundering property, mirroring the coverage salt: without it, a NON-strict all-green key
  // would be hit by a later strict run of the identical tree, skipping every gate — so strict would
  // never see the opt-out it exists to reject.
  it.each(['GUARD_DETERMINISTIC_STRICT', 'FRINK_DETERMINISTIC_STRICT'])(
    '%s salts the prefix scope away from a non-strict run',
    (key) => {
      const cleanDefault = prefixCacheScope();
      const cleanCustom = prefixCacheScope('custom');
      process.env[key] = '1';
      expect(prefixCacheScope()).toBe('devkit-guards:deterministic-strict');
      expect(prefixCacheScope('custom')).toBe('custom:deterministic-strict');
      expect(prefixCacheScope()).not.toBe(cleanDefault);
      expect(prefixCacheScope('custom')).not.toBe(cleanCustom);
    },
  );

  it('the strict salt composes with the coverage salt rather than replacing it', () => {
    process.env.GUARD_DETERMINISTIC_STRICT = '1';
    process.env.GUARD_COVERAGE_OK = '1';
    expect(prefixCacheScope()).toBe('devkit-guards:deterministic-strict:coverage-bypassed');
  });

  it('no salt when strict is unset — an ordinary run keeps the plain scope', () => {
    expect(prefixCacheScope()).toBeUndefined();
    expect(prefixCacheScope('custom')).toBe('custom');
  });
});

// The interleavings the first pass missed: one gate opting out on an otherwise-green run was the
// only shape covered, so the plural wording and the fail+opt-out combination were never executed.
describe('runDeterministic — opt-out reporting across the other run shapes', () => {
  it('names EVERY gate that opted out, with plural wording', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size', 'fanout', 'dup', 'clone']);
    const exec = mkExec({ matcher: 2, 'clone-detector': 2 });
    expect(runDeterministic(d, { exec })).toBe(0);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('2 deterministic gates opted out and did NOT run:');
    expect(out).toContain('guard-dup');
    expect(out).toContain('guard-clone');
  });

  // A real failure must not swallow the opt-out report: the run exits 1 for the failure AND still
  // says the other gate proved nothing. Moving the skipped block below the failure branch (the
  // obvious "tidy-up") silently breaks exactly this.
  it('reports an opt-out ALONGSIDE a real failure, and still exits 1', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size', 'dup']);
    const exec = mkExec({ 'size-disable': 1, matcher: 2 });
    expect(runDeterministic(d, { exec })).toBe(1);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('1 deterministic gate opted out and did NOT run: guard-dup');
    expect(out).toContain('deterministic gates failed: guard-size');
  });

  it('separates the two in telemetry: the failure is a fail, the opt-out is could_not_run', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size', 'dup']);
    const sink = join(d, 'events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    expect(runDeterministic(d, { exec: mkExec({ 'size-disable': 1, matcher: 2 }) })).toBe(1);
    const byGate = Object.fromEntries(
      readFileSync(sink, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((e) => e.type === 'gate_result')
        .map((e) => [e.gate, e]),
    );
    expect(byGate.size).toMatchObject({ status: 'fail' });
    expect(byGate.dup).toMatchObject({ status: 'could_not_run', detail: 'guard-dup(opted-out)' });
  });

  it('says NOTHING when every gate actually ran — the block is conditional', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runDeterministic(repo(['size', 'dup']), { exec: mkExec({}) })).toBe(0);
    expect(err.mock.calls.flat().join('\n')).not.toContain('opted out');
  });
});

// Read per-call, and via envVar's GUARD_/FRINK_ pair. Both spellings are asserted because the
// FRINK_ alias has no other caller here and would rot silently.
describe('deterministicStrict', () => {
  it('is false unless asked for, and true under either spelling', () => {
    expect(deterministicStrict()).toBe(false);
    process.env.GUARD_DETERMINISTIC_STRICT = '1';
    expect(deterministicStrict()).toBe(true);
    delete process.env.GUARD_DETERMINISTIC_STRICT;
    process.env.FRINK_DETERMINISTIC_STRICT = '1';
    expect(deterministicStrict()).toBe(true);
  });

  it('treats an explicit falsey value as off, not as "set"', () => {
    process.env.GUARD_DETERMINISTIC_STRICT = '0';
    expect(deterministicStrict()).toBe(false);
  });
});

// sc-1231: a failing gate's REASON reaches the aggregated verdict and the gate_result detail through
// the out-of-band DEVKIT_GATE_REASON_FILE, while stdio stays inherited.
describe('runDeterministic — failure reasons (sc-1231)', () => {
  // Like mkExec, but a gate may record a reason through the env the runner handed it — the real
  // channel, not a shortcut — and every call's options are kept for the isolation assertions.
  function mkReasonExec(byModule) {
    const calls = [];
    const exec = vi.fn((_node, argv, opts) => {
      calls.push(opts);
      const hit = Object.entries(byModule).find(([k]) => argv[0].includes(k));
      const { code = 0, reason } = hit ? hit[1] : {};
      if (reason) writeFileSync(opts.env.DEVKIT_GATE_REASON_FILE, reason);
      if (code !== 0) {
        const e = new Error(`exit ${code}`);
        e.status = code;
        throw e;
      }
    });
    return { exec, calls };
  }
  const events = (sink) =>
    readFileSync(sink, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'gate_result');
  const sinkIn = (d) => {
    process.env.DEVKIT_GATE_EVENTS = join(d, 'events.jsonl');
    return process.env.DEVKIT_GATE_EVENTS;
  };

  it('the reason survives later noisy gates: it sits UNDER the ✗ line and in the event detail', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size', 'fanout', 'dup', 'clone']);
    const sink = sinkIn(d);
    const { exec } = mkReasonExec({
      'size-disable': {
        code: 1,
        reason: '🚫 1 file(s) over\n   cli/commands/init.mts: 1320 lines (max 1319)\n',
      },
      matcher: { code: 0, reason: 'a PASSING gate that wrote a reason anyway' },
    });
    expect(runDeterministic(d, { exec })).toBe(1);
    const out = err.mock.calls.flat().join('\n');
    const verdict = out.indexOf('✗ deterministic gates failed: guard-size');
    expect(verdict).toBeGreaterThan(-1);
    expect(out.indexOf('cli/commands/init.mts: 1320 lines (max 1319)')).toBeGreaterThan(verdict);
    // A passing gate's reason is never attributed — it did not fail.
    expect(out).not.toContain('a PASSING gate');
    expect(out).not.toContain('listed above');
    const size = events(sink).find((e) => e.gate === 'size');
    expect(size.detail).toBe(
      'guard-size: 🚫 1 file(s) over · cli/commands/init.mts: 1320 lines (max 1319)',
    );
  });

  it('a failing gate that recorded nothing gets the fallback note, and its detail stays the bare label', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size']);
    const sink = sinkIn(d);
    const { exec } = mkReasonExec({ 'size-disable': { code: 1 } });
    expect(runDeterministic(d, { exec })).toBe(1);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('no reason summary from this gate');
    expect(out).toContain('guard-size reads the index');
    expect(events(sink).find((e) => e.gate === 'size').detail).toBe('guard-size');
  });

  it('two failing gates each report ONLY their own reason — no cross-attribution', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size', 'fanout']);
    const sink = sinkIn(d);
    const { exec, calls } = mkReasonExec({
      'size-disable': { code: 1, reason: 'SIZE-REASON' },
      'folder-fanout': { code: 1, reason: 'FANOUT-REASON' },
    });
    expect(runDeterministic(d, { exec })).toBe(1);
    const files = calls.map((o) => o.env.DEVKIT_GATE_REASON_FILE);
    expect(new Set(files).size).toBe(files.length);
    const byGate = new Map(events(sink).map((e) => [e.gate, e.detail]));
    expect(byGate.get('size')).toBe('guard-size: SIZE-REASON');
    expect(byGate.get('fanout')).toBe('guard-fanout: FANOUT-REASON');
    const out = err.mock.calls.flat().join('\n');
    expect(out.indexOf('SIZE-REASON')).toBeLessThan(out.indexOf('── guard-fanout ──'));
  });

  it("every gate still runs with stdio INHERITED (no pipe), and an outer run's reason file is overridden", () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size', 'dup']);
    process.env.DEVKIT_GATE_REASON_FILE = join(d, 'outer.txt'); // e.g. a nested guard-deterministic
    try {
      const { exec, calls } = mkReasonExec({ 'size-disable': { code: 1, reason: 'why' } });
      expect(runDeterministic(d, { exec })).toBe(1);
      for (const o of calls) {
        expect(o.stdio).toBe('inherit');
        expect(o.env.DEVKIT_GATE_REASON_FILE).not.toBe(join(d, 'outer.txt'));
      }
      expect(() => readFileSync(join(d, 'outer.txt'))).toThrow(); // the outer file was never written
    } finally {
      delete process.env.DEVKIT_GATE_REASON_FILE;
    }
  });

  it('the private reason dir is removed after the run — green, red, and a spawn crash alike', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen = [];
    const record = (opts) => seen.push(dirname(opts.env.DEVKIT_GATE_REASON_FILE));
    const d = repo(['size']);
    const green = vi.fn((_n, _a, o) => record(o));
    const red = vi.fn((_n, _a, o) => {
      record(o);
      writeFileSync(o.env.DEVKIT_GATE_REASON_FILE, 'x');
      throw Object.assign(new Error('x'), { status: 1 });
    });
    const crash = vi.fn((_n, _a, o) => {
      record(o);
      throw new Error('spawn ENOENT'); // no numeric status → treated as a real fail
    });
    expect(runDeterministic(d, { exec: green })).toBe(0);
    expect(runDeterministic(d, { exec: red })).toBe(1);
    expect(runDeterministic(d, { exec: crash })).toBe(1);
    expect(seen).toHaveLength(3);
    for (const dir of seen) expect(existsSync(dir)).toBe(false);
  });

  it('strict could-not-run and unexpected codes carry the reason too, and the gate name stays bare', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_DETERMINISTIC_STRICT = '1';
    const d = repo(['size', 'fanout']);
    const sink = sinkIn(d);
    const { exec } = mkReasonExec({
      'size-disable': { code: 2, reason: 'no baseline' },
      'folder-fanout': { code: 5, reason: 'boom' },
    });
    expect(runDeterministic(d, { exec })).toBe(1);
    const byGate = new Map(events(sink).map((e) => [e.gate, e]));
    expect(byGate.get('size')).toMatchObject({
      status: 'could_not_run',
      detail: 'guard-size(could-not-run): no baseline',
    });
    expect(byGate.get('fanout')).toMatchObject({
      status: 'could_not_run',
      detail: 'guard-fanout(unexpected:5): boom',
    });
  });

  it('an unusable TMPDIR never stops the gates: the verdict stands, reasons degrade to the note', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size', 'fanout']);
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = join(d, 'missing', 'tmp');
    try {
      const { exec, calls } = mkReasonExec({ 'size-disable': { code: 1 } });
      expect(runDeterministic(d, { exec })).toBe(1);
      expect(calls).toHaveLength(2); // every gate still ran
      expect(err.mock.calls.flat().join('\n')).toContain('no reason summary from this gate');
      expect(runDeterministic(d, { exec: mkReasonExec({}).exec })).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });

  it("an --extra spelled like a built-in label never gets the built-in size gate's hint", () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['fanout']);
    const exec = vi.fn((cmd) => {
      if (cmd === 'false') throw Object.assign(new Error('x'), { status: 1 });
    });
    const extra = [
      { label: 'guard-size(foo)', cmd: 'false' },
      { label: 'guard-size', cmd: 'false' },
    ];
    expect(runDeterministic(d, { exec, extra })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).not.toContain('reads the index');
  });

  it('a strict could-not-run built-in still carries its reason into the report and event', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_DETERMINISTIC_STRICT = '1';
    const d = repo(['dup']);
    const sink = sinkIn(d);
    const { exec } = mkReasonExec({ matcher: { code: 2, reason: 'co-occurrence index missing' } });
    expect(runDeterministic(d, { exec })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('co-occurrence index missing');
    expect(events(sink).find((e) => e.gate === 'dup').detail).toBe(
      'guard-dup(could-not-run): co-occurrence index missing',
    );
  });

  it('an unrunnable --extra never spawns, reports the fallback note, and does not crash the report', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size']);
    const { exec } = mkReasonExec({});
    expect(runDeterministic(d, { exec, extra: [{ label: 'lint' }] })).toBe(1);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('── lint(unrunnable: empty command) ──');
    expect(out).toContain('no reason summary from this gate');
  });

  it('a gate reason with ANSI colour and CRLF (Windows tooling) is stripped and split in both outputs', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size']);
    const sink = sinkIn(d);
    const { exec } = mkReasonExec({
      'size-disable': {
        code: 1,
        reason: '\u001b[31mred\u001b[0m\r\n  src\\a.ts: 9 lines (max 1)\r\n',
      },
    });
    expect(runDeterministic(d, { exec })).toBe(1);
    const out = err.mock.calls.flat().join('\n');
    expect(out).not.toContain('\u001b[');
    expect(out).not.toContain('\r');
    expect(events(sink).find((e) => e.gate === 'size').detail).toBe(
      'guard-size: red · src\\a.ts: 9 lines (max 1)',
    );
  });
});

// sc-3443: every failed gate names the command that re-checks it, rendered from the argv that ran.
describe('runDeterministic — local re-check hint on failure', () => {
  const RECHECK = 'Re-check a fix locally';
  const errOut = (err) => err.mock.calls.flat().join('\n');

  it('names each failed gate with the exact argv it ran, relative to the repo', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size', 'fanout', 'dup']);
    const exec = mkExec({ 'size-disable': 1, matcher: 1 });
    expect(runDeterministic(d, { exec })).toBe(1);
    const out = errOut(err);
    for (const [, argv] of exec.mock.calls.filter(([, a]) => /size-disable|matcher/.test(a[0]))) {
      expect(out).toContain(recheckCommand(['node', ...argv], d));
    }
    // A gate that passed gets no line.
    expect(out).not.toMatch(/guard-fanout:/);
    expect(out).toMatch(/guard-size: env -- node .*size-disable\.m[jt]s gate/);
    expect(out).toMatch(/guard-dup: env -- node .*matcher\.m[jt]s scan --new --changed --gate/);
  });

  it('keeps the grepped failure line byte-identical and ahead of the hint', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runDeterministic(repo(['size']), { exec: mkExec({ 'size-disable': 1 }) })).toBe(1);
    const lines = err.mock.calls.map((c) => c.join(' '));
    const failIdx = lines.indexOf('✗ deterministic gates failed: guard-size');
    expect(failIdx).toBeGreaterThanOrEqual(0);
    expect(lines.findIndex((l) => l.includes(RECHECK))).toBeGreaterThan(failIdx);
  });

  it('prints nothing about re-checking on a green run', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runDeterministic(repo(['size']), { exec: mkExec({}) })).toBe(0);
    expect(errOut(err)).not.toContain(RECHECK);
  });

  it('anti-slop also names the documented `devkit anti-slop check --staged` form', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo([], true);
    expect(runDeterministic(d, { exec: mkExec({ index: 1 }) })).toBe(1);
    const out = errOut(err);
    expect(out).toMatch(/guard-anti-slop: env -- node .*index\.m[jt]s anti-slop check --staged/);
    expect(out).toContain('devkit anti-slop check --staged');
  });

  it('an --extra gate prints the argv it ran; an unrunnable one gets no command', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = vi.fn((bin) => {
      if (bin === 'bun') {
        const e = new Error('exit 1');
        e.status = 1;
        throw e;
      }
    });
    const extra = [{ label: 'lint', cmd: '  bun run lint  ' }, { label: 'broken' }];
    expect(runDeterministic(repo(['size']), { exec, extra })).toBe(1);
    const out = errOut(err);
    expect(out).toMatch(/lint: env -- bun run lint$/m);
    expect(out).toContain('broken(unrunnable: empty command)');
    expect(out).not.toMatch(/broken[^\n(]*:/);
  });

  it('a gate whose binary never resolved (127) still names its re-check', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runDeterministic(repo(['size']), { exec: mkExec({ 'size-disable': 127 }) })).toBe(1);
    expect(errOut(err)).toMatch(/guard-size\(unexpected:127\): env -- node .*size-disable/);
  });

  it("prints ship's exact command only when a new ship handed one over", () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec({ 'size-disable': 1 });
    // `devkit review` and --pr run with DEVKIT_SHIP=1 but no command: no ship lines at all.
    process.env.DEVKIT_SHIP = '1';
    expect(runDeterministic(repo(['size']), { exec })).toBe(1);
    expect(errOut(err)).not.toMatch(/approximate|--dry-gates/);
    err.mockClear();
    process.env.DEVKIT_SHIP_DRY_GATES_CMD = "devkit ship feat/x 't' --dry-gates -- a.ts";
    expect(runDeterministic(repo(['size']), { exec })).toBe(1);
    expect(errOut(err)).toContain('approximate');
    expect(errOut(err)).toContain("     devkit ship feat/x 't' --dry-gates -- a.ts");
  });
});

describe('recheckCommand', () => {
  it('relativises a module under cwd and leaves plain args alone', () => {
    const d = repo();
    expect(recheckCommand(['node', join(d, 'gate-engine', 'x.mts'), 'gate'], d)).toBe(
      'env -- node gate-engine/x.mts gate',
    );
  });

  it('keeps a module outside cwd absolute — including a sibling that shares the prefix', () => {
    const d = repo();
    const sibling = `${d}-other/x.mjs`;
    expect(recheckCommand(['node', sibling, 'gate'], d)).toBe(`env -- node ${sibling} gate`);
  });

  it('quotes a path with a space so the printed line runs as-is', () => {
    const d = repo();
    const outside = '/opt/Personal and learning/devkit/dist/x.mjs';
    expect(recheckCommand(['node', outside], d)).toBe(`env -- node '${outside}'`);
    expect(recheckCommand(['node', join(d, 'a b', "it's.mjs")], d)).toBe(
      `env -- node 'a b/it'\\''s.mjs'`,
    );
  });

  it('relativises through a symlinked cwd (macOS /var → /private/var)', () => {
    const real = realpathSync(repo());
    const link = `${real}-link`;
    symlinkSync(real, link);
    dirs.push(link);
    expect(recheckCommand(['node', join(real, 'm.mjs')], link)).toBe('env -- node m.mjs');
  });
});

// The class behind a reviewer counterexample: whatever a shell would parse differently from the
// whitespace split that RUNS must come back quoted, so pasting the hint re-runs the same argv.
describe('--extra re-check round-trips through a shell to the argv that ran', () => {
  const CASES = [
    'false || true',
    'node -e process.exit(1)',
    'echo $HOME',
    'echo `id`',
    'a;b',
    'x>out',
    "it's",
    'glob*?[x]',
    'a&b|c',
    'tilde ~/x',
    'brace {a,b}',
    'hash #not-a-comment',
  ];
  it.each(CASES)('%s', (cmd) => {
    const argv = cmd.split(/\s+/).filter(Boolean);
    const d = repo();
    const printed = recheckCommand(argv, d);
    const echoed = execFileSync('sh', ['-c', `for a in ${printed}; do printf '%s\\n' "$a"; done`], {
      cwd: d,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: '/should-not-expand' },
    });
    expect(echoed.split('\n').slice(0, -1)).toEqual(['env', '--', ...argv]);
  });
});

// Command position is its own class: a shell reads a bare leading `NAME=value` as an assignment and a
// reserved word as syntax. A stub named after argv[0] proves the pasted line runs THAT executable.
describe('--extra re-check keeps argv[0] the executable', () => {
  it.each([
    'A=b',
    'if',
    'time',
    'while',
    'do',
    'function',
    'in',
    ':',
    'command',
    'true',
    'echo',
    'cd',
  ])('%s x', (cmd0) => {
    const d = repo();
    const bin = join(d, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, cmd0), '#!/bin/sh\nprintf "%s|" "$(basename "$0")" "$@"\n', {
      mode: 0o755,
    });
    const out = execFileSync('sh', ['-c', recheckCommand([cmd0, 'x'], d)], {
      cwd: d,
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH}` },
    });
    expect(out).toBe(`${cmd0}|x|`);
  });
});

describe('recheckCommand — repo-written argv is never rewritten', () => {
  it('an absolute executable and an absolute argument under the repo stay byte-exact', () => {
    const d = repo();
    const tool = join(d, 'tool');
    writeFileSync(tool, '#!/bin/sh\nprintf "local|%s|" "$@"\n', { mode: 0o755 });
    const printed = recheckCommand([tool, join(d, 'out.json')]);
    expect(printed).toBe(`${tool} ${join(d, 'out.json')}`);
    expect(execFileSync('sh', ['-c', printed], { cwd: d, encoding: 'utf8' })).toBe(
      `local|${join(d, 'out.json')}|`,
    );
  });

  it('an --extra gate keeps its absolute argument; only a module path is relativised', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size']);
    const exec = vi.fn((bin) => {
      if (bin === 'tool') {
        const e = new Error('exit 1');
        e.status = 1;
        throw e;
      }
    });
    const extra = [{ label: 'probe', cmd: `tool ${join(d, 'cfg.json')}` }];
    expect(runDeterministic(d, { exec, extra })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain(`probe: env -- tool ${join(d, 'cfg.json')}`);
  });
});
