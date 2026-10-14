import { spawn } from 'node:child_process';
import {
  chmodSync,
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
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  testExecFileSync as execFileSync,
  processAlive,
  testSpawnSync,
  waitForPath,
} from '../../../__tests__/_helpers.mts';
import { attributeToBase } from './base-attribution.mts';

const MODULE = fileURLToPath(new URL('./base-attribution.mts', import.meta.url));
const RUNNER = fileURLToPath(
  new URL('../../../../gate-engine/deterministic/run.mts', import.meta.url),
);
const SHIP_ID = 'base-attribution-test';
const LONG = 'a\nb\nc\nd\ne\n';
const SHORT = 'a\n';
// Fails when any top-level .txt is over three lines. Appends to the events sink when it can see
// one, so a rerun that inherited the ship's telemetry context is caught by the row count.
const CHECK = `import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
if (process.env.DEVKIT_GATE_EVENTS) appendFileSync(process.env.DEVKIT_GATE_EVENTS, '{"type":"leak"}\\n');
const long = readdirSync('.').filter((f) => f.endsWith('.txt') && readFileSync(f, 'utf8').split('\\n').length > 4);
for (const f of long) console.log('too long: ' + f + ' ship=' + (process.env.DEVKIT_SHIP_ID ?? 'none'));
process.exit(long.length > 0 ? 1 : 0);
`;
const created: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

interface FixtureOptions {
  /** guard.config.json `extraGates` in force for the gate worktree. */
  gates?: Record<string, string>;
  /** Commit the config at the base instead of linking an untracked one (the default). */
  trackedGates?: Record<string, string>;
  baseText?: string;
  /** Extra files committed at the base. */
  files?: Record<string, string>;
  /** Sink rows for this ship, oldest first; the default is one failed `max-lines` verdict. */
  rows?: Row[];
}

interface Row {
  type: string;
  gate?: string;
  family?: string;
  status?: string;
  outcome?: string;
}

const failRow = (gate: string, status = 'fail'): Row => ({
  type: 'gate_result',
  gate,
  family: 'deterministic',
  status,
});

function writeConfig(dir: string, gates: Record<string, string>): void {
  writeFileSync(join(dir, 'guard.config.json'), JSON.stringify({ extraGates: gates }));
}

/** Tracked at the base: the worktree's copy changes. Otherwise untracked, linked in as ship does. */
function linkOrOverrideConfig(
  root: string,
  wt: string,
  gates: Record<string, string>,
  tracked: boolean,
): void {
  if (tracked) {
    writeConfig(wt, gates);
    return;
  }
  writeConfig(root, gates);
  symlinkSync(join(root, 'guard.config.json'), join(wt, 'guard.config.json'));
}

/** A repo, a gate worktree cut from its HEAD with one staged long file, and the ship's env. */
function fixture(options: FixtureOptions = {}) {
  const gates = options.gates ?? { 'max-lines': 'node check.mjs' };
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'base-attribution-')));
  created.push(tmp);
  const root = join(tmp, 'root');
  const wt = join(tmp, 'wt');
  const sink = join(tmp, 'telemetry', 'gate-events.jsonl');
  const outPrefix = join(tmp, 'telemetry', 'logs', SHIP_ID);
  mkdirSync(join(tmp, 'telemetry', 'logs'), { recursive: true });
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'trunk');
  git(root, 'config', 'user.email', 'devkit@example.com');
  git(root, 'config', 'user.name', 'Devkit Test');
  const files = { 'check.mjs': CHECK, 'base.txt': options.baseText ?? LONG, ...options.files };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  if (options.trackedGates) writeConfig(root, options.trackedGates);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  const sha = git(root, 'rev-parse', 'HEAD');
  git(root, 'worktree', 'add', '-q', '--detach', wt, sha);
  linkOrOverrideConfig(root, wt, gates, options.trackedGates !== undefined);
  writeFileSync(join(wt, 'mine.txt'), LONG);
  git(wt, 'add', 'mine.txt');
  const rows = options.rows ?? [failRow('max-lines')];
  writeFileSync(sink, rows.map((r) => `${JSON.stringify({ ...r, ship_id: SHIP_ID })}\n`).join(''));
  vi.stubEnv('DEVKIT_GATE_EVENTS', sink);
  vi.stubEnv('DEVKIT_SHIP_ID', SHIP_ID);
  vi.stubEnv('DEVKIT_SHIP_BASE_SHA', sha);
  const types = () =>
    readFileSync(sink, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line): Row => JSON.parse(line));
  const worktrees = () =>
    git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)?.length;
  return { tmp, root, wt, sha, sink, outPrefix, types, worktrees };
}

describe('attributeToBase', () => {
  it('names a config gate that also exits 1 at the cut commit, and keeps its base output', async () => {
    const f = fixture();
    const lines = await attributeToBase(f.wt, f.outPrefix);

    const outFile = `${f.outPrefix}.base-max-lines.log`;
    expect(lines).toEqual([
      `ship: max-lines also exits 1 at ${f.sha.slice(0, 7)}, the commit this gate worktree was cut from (run with this checkout's linked node_modules). Base run output: ${outFile}`,
    ]);
    // The base run saw the base's file, not the staged one, and none of the ship's context.
    expect(readFileSync(outFile, 'utf8')).toBe('too long: base.txt ship=none\n');
    expect(lines[0]).not.toContain('trunk');
    expect(f.worktrees()).toBe(2);
    // Removing the base worktree must unlink its mirrored links, never follow them.
    expect(existsSync(join(f.root, 'guard.config.json'))).toBe(true);
    expect(f.types().map((r) => r.type)).toEqual(['gate_result', 'base_attribution']);
    expect(f.types()[1]).toMatchObject({ gate: 'max-lines', outcome: 'also-fails' });
  });

  it('prints the line through the CLI the ship script shells', () => {
    const f = fixture();
    const run = testSpawnSync(process.execPath, [MODULE, f.wt, f.outPrefix], { encoding: 'utf8' });

    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^ship: max-lines also exits 1 at [0-9a-f]{7}, .*\n$/);
  });

  // The producer half: without this, a renamed field in the runner's row silences the feature unseen.
  it('reads the verdict row the deterministic gate runner really writes', async () => {
    const f = fixture({ rows: [] });
    const gate = testSpawnSync(process.execPath, [RUNNER, '--only', 'size'], {
      cwd: f.wt,
      encoding: 'utf8',
    });

    expect(gate.status, gate.stderr).toBe(1);
    expect(gate.stderr).toContain('✗ deterministic gates failed: max-lines');
    expect(await attributeToBase(f.wt, f.outPrefix)).toHaveLength(1);
  });

  it('says nothing when only the staged change fails the gate', async () => {
    const f = fixture({ baseText: SHORT });

    expect(await attributeToBase(f.wt, f.outPrefix)).toEqual([]);
    expect(f.types()[1]).toMatchObject({ type: 'base_attribution', outcome: 'not-reproduced' });
    expect(existsSync(`${f.outPrefix}.base-max-lines.log`)).toBe(false);
    expect(f.worktrees()).toBe(2);
  });

  it.each([
    ['exit 2', 'process.exit(2)'],
    ['exit 124', 'process.exit(124)'],
    ['its own SIGTERM', "process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000)"],
  ])('says nothing when the base run ends with %s', async (_name, body) => {
    const f = fixture({
      gates: { odd: 'node odd.mjs' },
      files: { 'odd.mjs': body },
      rows: [failRow('odd')],
    });

    expect(await attributeToBase(f.wt, f.outPrefix)).toEqual([]);
    expect(f.types()[1]).toMatchObject({ outcome: 'not-reproduced' });
  });

  // Split any other way, the extra empty argument makes node itself exit 1 at a green base.
  it('splits a multi-space command the way the gate runner does', async () => {
    const f = fixture({ baseText: SHORT, gates: { 'max-lines': 'node   check.mjs' } });

    expect(await attributeToBase(f.wt, f.outPrefix)).toEqual([]);
    expect(f.types()[1]).toMatchObject({ outcome: 'not-reproduced' });
  });

  // An unhandled spawn error would leave the rerun waiting out the whole budget.
  it('says nothing, at once, when the command does not resolve at the base', async () => {
    const f = fixture({ gates: { gone: 'no-such-gate-binary' }, rows: [failRow('gone')] });

    expect(await attributeToBase(f.wt, f.outPrefix)).toEqual([]);
    expect(f.types()[1]).toMatchObject({ gate: 'gone', outcome: 'not-reproduced' });
  });

  it('removes the base worktree when the run fails part-way', async () => {
    const f = fixture();

    await expect(attributeToBase(f.wt, join(f.tmp, 'no-such-dir', 'ship'))).rejects.toThrow();
    expect(f.worktrees()).toBe(2);
  });

  // The narration contract: an unfinished run is non-zero and silent, never a partial answer.
  it('the CLI exits non-zero and prints nothing when the run fails', () => {
    const f = fixture();
    const outPrefix = join(f.tmp, 'no-such-dir', 'ship');
    const run = testSpawnSync(process.execPath, [MODULE, f.wt, outPrefix], { encoding: 'utf8' });

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
  });

  it.each([
    ['adds the gate', {}],
    ['changes the gate command', { 'max-lines': 'node check.mjs --all' }],
  ])('says nothing when the staged change %s', async (_name, trackedGates) => {
    const f = fixture({ trackedGates });

    expect(await attributeToBase(f.wt, f.outPrefix)).toEqual([]);
    expect(f.types().map((r) => r.type)).toEqual(['gate_result']);
    expect(f.worktrees()).toBe(2);
  });

  it.each([
    ['the failed gate is not a config extraGate', { rows: [failRow('structure-lint')] }],
    ['the gate reached no verdict', { rows: [failRow('max-lines', 'could_not_run')] }],
    [
      'the command is devkit-resolved guard-structure',
      { gates: { 'max-lines': 'guard-structure staged' } },
    ],
    ['the sink has no row for this ship', { rows: [] }],
    [
      'the failure belongs to an earlier attempt',
      { rows: [failRow('max-lines'), { type: 'ship_attempt' }, failRow('fanout')] },
    ],
  ])('runs nothing when %s', async (_name, options) => {
    const f = fixture(options);

    expect(await attributeToBase(f.wt, f.outPrefix)).toEqual([]);
    expect(f.types().some((r) => r.type === 'base_attribution')).toBe(false);
  });

  it.each([
    ['is unset', ''],
    ['is not the worktree HEAD', '0'.repeat(40)],
  ])('runs nothing when the cut commit %s', async (_name, sha) => {
    const f = fixture();
    vi.stubEnv('DEVKIT_SHIP_BASE_SHA', sha);

    expect(await attributeToBase(f.wt, f.outPrefix)).toEqual([]);
    expect(f.types().map((r) => r.type)).toEqual(['gate_result']);
  });

  it('resolves a bare binary through a relatively linked node_modules/.bin', async () => {
    const f = fixture({ gates: { bare: 'bare-gate' }, rows: [failRow('bare')] });
    mkdirSync(join(f.root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(f.root, 'node_modules', '.bin', 'bare-gate'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(f.root, 'node_modules', '.bin', 'bare-gate'), 0o755);
    // Relative on purpose: copied verbatim into a worktree elsewhere, the link would dangle.
    symlinkSync('../root/node_modules', join(f.wt, 'node_modules'));

    expect(await attributeToBase(f.wt, f.outPrefix)).toHaveLength(1);
    expect(existsSync(join(f.root, 'node_modules', '.bin', 'bare-gate'))).toBe(true);
  });

  // A gate that never ends on its own, and records the pid of a process it leaves in its group.
  function slowFixture() {
    const pidFile = join(tmpdir(), `base-attribution-pid-${process.pid}-${Date.now()}`);
    created.push(pidFile);
    vi.stubEnv('BASE_ATTRIBUTION_PID_FILE', pidFile);
    const slow = `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn('sleep', ['300'], { stdio: 'ignore' });
writeFileSync(process.env.BASE_ATTRIBUTION_PID_FILE, String(child.pid));
setInterval(() => {}, 1000);
`;
    const f = fixture({
      gates: { slow: 'node slow.mjs', 'max-lines': 'node check.mjs' },
      files: { 'slow.mjs': slow },
      rows: [failRow('slow'), failRow('max-lines')],
    });
    return { ...f, pidFile };
  }

  it('kills a rerun that outlives the cap, starts no further gate, and leaves no worktree', async () => {
    const f = slowFixture();

    expect(await attributeToBase(f.wt, f.outPrefix, 10_000)).toEqual([]);
    const attributed = f.types().filter((r) => r.type === 'base_attribution');
    expect(attributed).toHaveLength(1);
    expect(attributed[0]).toMatchObject({ gate: 'slow', outcome: 'timeout' });
    expect(processAlive(Number(readFileSync(f.pidFile, 'utf8')))).toBe(false);
    expect(f.worktrees()).toBe(2);
  }, 60_000);

  it('a signal ends the rerun, prints nothing, and still removes the worktree', async () => {
    const f = slowFixture();
    const cli = spawn(process.execPath, [MODULE, f.wt, f.outPrefix], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    cli.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    const exited = new Promise<number | null>((done) => cli.once('exit', done));
    try {
      await waitForPath(f.pidFile, 60_000, cli);
      cli.kill('SIGTERM');
      expect(await exited).toBe(1);
    } finally {
      cli.kill('SIGKILL');
    }
    expect(stdout).toBe('');
    expect(processAlive(Number(readFileSync(f.pidFile, 'utf8')))).toBe(false);
    expect(f.worktrees()).toBe(2);
  }, 120_000);
});
