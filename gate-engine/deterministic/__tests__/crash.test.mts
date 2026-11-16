import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GATE_REASON_ENV } from '../reason.mts';
import { CRASH_EXIT } from '../registry.mts';
import { runDeterministic } from '../run.mts';

const HERE = import.meta.dirname;
const PRELOAD = pathToFileURL(join(HERE, '..', 'crash-exit.mts')).href;
const RUNNER = join(HERE, '..', 'run.mts');
const NO_JUDGEMENT = 'No gate above judged your diff';
const FIX_TOGETHER = 'Fix every failure above together';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.DEVKIT_GATE_EVENTS;
  vi.restoreAllMocks();
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'guard-crash-'));
  dirs.push(d);
  return d;
}

const reasonOf = (file: string) => {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
};

/** Spawn `node <args>` in a non-git dir with a reason file armed, as guard-deterministic does. */
function spawnGate(args: string[], reasonEnv: boolean | '' = true) {
  const d = tmp();
  const reason = join(d, 'reason.txt');
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: d, [GATE_REASON_ENV]: reason };
  if (reasonEnv === false) delete env[GATE_REASON_ENV];
  if (reasonEnv === '') env[GATE_REASON_ENV] = ''; // no usable TMPDIR: the gate still runs
  const r = spawnSync(process.execPath, args, { cwd: d, env, encoding: 'utf8' });
  return { status: r.status, reason: reasonOf(reason) };
}

describe('crash-exit preload', () => {
  it.each([
    ['a synchronous throw', "throw new Error('boom\\nsecond line');", 'boom'],
    ['an unhandled rejection', "Promise.reject(new Error('rejected'));", 'rejected'],
    ['a failed import', "import 'devkit-no-such-package-sc';", 'devkit-no-such-package-sc'],
    // A handler that read `.message` off a string would throw itself, and Node exits 7 instead.
    ['a thrown non-Error value', "throw 'thrown value\\nsecond line';", 'thrown value'],
  ])('%s exits CRASH_EXIT and records only the first error line', (_, source, first) => {
    const fixture = join(tmp(), 'gate.mjs');
    writeFileSync(fixture, source);
    const { status, reason } = spawnGate(['--import', PRELOAD, fixture]);
    expect(status).toBe(CRASH_EXIT);
    expect(reason).toContain(first);
    expect(reason).not.toContain('second line');
  });

  it('resolves its preload from its own install location, not the cwd, under a path with a space', async () => {
    const home = join(tmp(), 'with space');
    mkdirSync(home);
    for (const f of ['crash-exit.mts', 'reason.mts', 'registry.mts']) {
      copyFileSync(join(HERE, '..', f), join(home, f));
    }
    const { crashGuarded } = await import(pathToFileURL(join(home, 'reason.mts')).href);
    const fixture = join(tmp(), 'gate.mjs');
    writeFileSync(fixture, "throw new Error('spaced');");
    const { argv } = crashGuarded(['node', fixture]);
    expect(spawnGate(argv.slice(1))).toEqual({ status: CRASH_EXIT, reason: 'spaced' });
  });

  it('leaves a deliberate exit 1 (a verdict) untouched', () => {
    const fixture = join(tmp(), 'gate.mjs');
    writeFileSync(fixture, 'process.exit(1);');
    expect(spawnGate(['--import', PRELOAD, fixture])).toEqual({ status: 1, reason: '' });
  });
});

describe('gates that catch their own throw', () => {
  it('anti-slop through the devkit CLI exits CRASH_EXIT only when run as a gate', () => {
    const cli = join(HERE, '..', '..', '..', 'cli', 'index.mts');
    const args = [cli, 'anti-slop', 'check', '--staged'];
    const gate = spawnGate(args);
    expect(gate.status).toBe(CRASH_EXIT);
    expect(gate.reason).toContain('git');
    expect(spawnGate(args, '').status).toBe(CRASH_EXIT);
    expect(spawnGate(args, false).status).toBe(1);
  });

  it('decision-checks exits CRASH_EXIT on a throw', () => {
    const enforce = join(HERE, '..', '..', 'decisions', 'ruling-checks', 'enforce.mts');
    expect(spawnGate([enforce, 'gate']).status).toBe(CRASH_EXIT);
  });
});

/** A repo selecting size + fanout; `codes` maps a module fragment to its exit and crash reason. */
function stubRun(codes: Record<string, number>) {
  const d = tmp();
  mkdirSync(join(d, '.devkit'));
  writeFileSync(
    join(d, '.devkit', 'config.json'),
    JSON.stringify({ components: { guards: ['size', 'fanout'] } }),
  );
  process.env.DEVKIT_GATE_EVENTS = join(d, 'events.jsonl');
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exec = vi.fn((_node: string, argv: string[], opts: { env: NodeJS.ProcessEnv }) => {
    const code = Object.entries(codes).find(([k]) => argv[2].includes(k))?.[1] ?? 0;
    if (code === CRASH_EXIT) writeFileSync(String(opts.env[GATE_REASON_ENV]), 'boom\n');
    if (code !== 0) throw Object.assign(new Error(`exit ${code}`), { status: code });
  });
  const rc = runDeterministic(d, { exec });
  const events = readFileSync(process.env.DEVKIT_GATE_EVENTS, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === 'gate_result');
  return { rc, out: err.mock.calls.flat().join('\n'), events, exec };
}

describe('runDeterministic — a crashed gate', () => {
  it('is labelled (crashed), recorded could_not_run, and still blocks', () => {
    const { rc, out, events, exec } = stubRun({ 'size-disable': CRASH_EXIT });
    expect(rc).toBe(1);
    expect(out).toContain('✗ deterministic gates failed: guard-size(crashed)');
    expect(out).toContain(NO_JUDGEMENT);
    expect(out).not.toContain(FIX_TOGETHER);
    expect(events).toEqual([
      expect.objectContaining({
        gate: 'size',
        status: 'could_not_run',
        detail: 'guard-size(crashed): boom',
      }),
    ]);
    expect(exec.mock.calls[0][1].slice(0, 2)).toEqual(['--import', PRELOAD]);
    const recheck = out.split('\n').find((l) => l.includes('guard-size(crashed): env --'));
    expect(recheck).toBeDefined();
    expect(recheck).not.toContain('--import');
  });

  it('keeps the fix-together remedy when another gate reached a verdict', () => {
    const { out } = stubRun({ 'size-disable': CRASH_EXIT, 'folder-fanout': 1 });
    expect(out).toContain('✗ deterministic gates failed: guard-size(crashed) guard-fanout');
    expect(out).toContain(FIX_TOGETHER);
    expect(out).not.toContain(NO_JUDGEMENT);
  });

  it('the REAL guard-size crashing on a Git-ignored baseline reads as crashed, not a finding', () => {
    const d = tmp();
    const git = (...a: string[]) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
    const lines = (n: number) =>
      Array.from({ length: n }, (_, i) => `export const v${i} = ${i};\n`).join('');
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    mkdirSync(join(d, '.devkit', 'baselines'), { recursive: true });
    mkdirSync(join(d, 'src'));
    writeFileSync(join(d, '.gitignore'), '.devkit/\n');
    writeFileSync(join(d, 'guard.config.json'), '{"maxLines":5}');
    writeFileSync(join(d, '.devkit', 'config.json'), '{"components":{"guards":["size"]}}');
    writeFileSync(
      join(d, '.devkit', 'baselines', 'size-lines.json'),
      '{"files":{"src/big.ts":10}}',
    );
    writeFileSync(join(d, 'src', 'big.ts'), lines(10));
    git('add', '.gitignore', 'guard.config.json', 'src');
    git('add', '-f', '.devkit/baselines/size-lines.json');
    git('commit', '-q', '-m', 'base');
    // Shrinking grandfathered debt makes the gate rewrite the baseline Git would ignore.
    writeFileSync(join(d, 'src', 'big.ts'), lines(8));
    git('add', 'src');
    const r = spawnSync(process.execPath, [RUNNER], { cwd: d, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('✗ deterministic gates failed: guard-size(crashed)\n');
    expect(r.stderr).toContain('size-lines.json is ignored by Git');
    expect(r.stderr).toContain(NO_JUDGEMENT);
    expect(r.stderr).not.toContain(FIX_TOGETHER);
  });
});
