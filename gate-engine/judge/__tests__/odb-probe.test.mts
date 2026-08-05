/**
 * sc-1366: an object-database fault must not read as a gate verdict.
 *
 * These pin the three properties the misreport actually turned on — that the probe NAMES what git
 * cannot read, that it distinguishes "I looked and the index is fine" from "I could not look at
 * all", and that its message never claims a defect. The last one matters most: the original
 * failure was indistinguishable from a real block, so an agent went looking for a code problem
 * that did not exist.
 *
 * NOT covered here, deliberately and worth knowing: the probe's child-process bounds (maxBuffer,
 * timeout, explicit stdin) are constants, and reproducing an overflow needs ~15k staged entries
 * while reproducing the EOF block needs an inherited descriptor no test runner gives us. They are
 * argued in the module docblock, not measured.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boundedPayload,
  EVENT_BUDGET,
  ODB_FAULT_EXIT,
  probeStagedObjects,
  reportGateInfraFailure,
} from '../odb-probe.mts';

const roots: string[] = [];
const sinks: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  for (const s of sinks.splice(0)) delete process.env[s];
});

const git = (cwd: string, args: string[]) =>
  spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '' } });

/** A repo whose cache-tree is already persisted — the state ship is in after it stages. */
function stagedRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'odb-probe-'));
  roots.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@t.t']);
  git(dir, ['config', 'user.name', 't']);
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  git(dir, ['add', 'base.txt']);
  git(dir, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);

  mkdirSync(join(dir, 'nested'), { recursive: true });
  writeFileSync(join(dir, 'one.txt'), 'one\n');
  writeFileSync(join(dir, 'nested', 'two.txt'), 'two\n');
  git(dir, ['add', 'one.txt', 'nested/two.txt']);
  git(dir, ['write-tree']); // persist the cache-tree, as ship_record_staged_state does
  return {
    dir,
    oidOf: (p: string) => git(dir, ['rev-parse', `:${p}`]).stdout.trim(),
    deleteObject: (oid: string) =>
      rmSync(join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2)), { force: true }),
  };
}

/** Capture the gate's stderr and the telemetry line it appends. */
function runReport(cwd: string, fallbackExit = 2, err?: Error) {
  const sinkDir = mkdtempSync(join(tmpdir(), 'odb-sink-'));
  roots.push(sinkDir);
  const sink = join(sinkDir, 'events.jsonl');
  process.env.DEVKIT_GATE_EVENTS = sink;
  sinks.push('DEVKIT_GATE_EVENTS');
  const lines: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')));
  const code = reportGateInfraFailure(
    'decisions',
    'decision-gate',
    err ?? new Error('Command failed: git diff --cached --numstat -M'),
    cwd,
    fallbackExit,
  );
  let events: Array<Record<string, unknown>> = [];
  try {
    events = readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    /* no sink written */
  }
  return { code, out: lines.join('\n'), events };
}

describe('probeStagedObjects', () => {
  it('reports an intact index as intact', () => {
    expect(probeStagedObjects(stagedRepo().dir)).toEqual({ status: 'intact' });
  });

  it('names every missing object with the path that stages it', () => {
    const repo = stagedRepo();
    const one = repo.oidOf('one.txt');
    const two = repo.oidOf('nested/two.txt');
    repo.deleteObject(one);
    repo.deleteObject(two);

    const result = probeStagedObjects(repo.dir);
    expect(result.status).toBe('missing');
    if (result.status !== 'missing') return;
    // Both, not just the first — `git rev-list --objects` aborts on the first and is why this
    // probe exists at all.
    expect(result.objects).toHaveLength(2);
    expect(result.objects).toContainEqual({ oid: one, path: 'one.txt' });
    expect(result.objects).toContainEqual({ oid: two, path: 'nested/two.txt' });
  });

  it('control: git write-tree cannot see the same loss', () => {
    const repo = stagedRepo();
    const before = git(repo.dir, ['write-tree']).stdout.trim();
    repo.deleteObject(repo.oidOf('one.txt'));
    const after = git(repo.dir, ['write-tree']);
    // Same oid, exit 0 — the persisted cache-tree short-circuits the check. If this ever starts
    // failing, write-tree became sufficient and the probe could be simplified.
    expect(after.status).toBe(0);
    expect(after.stdout.trim()).toBe(before);
  });

  it('says probe-failed — never intact — when it cannot enumerate the index', () => {
    const dir = mkdtempSync(join(tmpdir(), 'odb-notrepo-'));
    roots.push(dir);
    const result = probeStagedObjects(dir); // not a git repository
    expect(result.status).toBe('probe-failed');
  });

  it('skips gitlinks, whose commits live in the submodule ODB by design', () => {
    const repo = stagedRepo();
    const sub = mkdtempSync(join(tmpdir(), 'odb-sub-'));
    roots.push(sub);
    git(sub, ['init', '-q', '-b', 'main']);
    git(sub, ['config', 'user.email', 't@t.t']);
    git(sub, ['config', 'user.name', 't']);
    writeFileSync(join(sub, 'f.txt'), 'f\n');
    git(sub, ['add', 'f.txt']);
    git(sub, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'sub']);
    const subOid = git(sub, ['rev-parse', 'HEAD']).stdout.trim();
    // A gitlink entry whose commit this repo's ODB has never seen.
    git(repo.dir, ['update-index', '--add', '--cacheinfo', `160000,${subOid},vendor/sub`]);

    expect(probeStagedObjects(repo.dir)).toEqual({ status: 'intact' });
  });
});

/**
 * Reviewer finding from the first ship: `gate_infra_failure` was the first gate event whose
 * payload scaled with repo content, and gate-events.mts documents concurrent-writer safety as
 * resting on sub-4KB atomic appends.
 */
describe('the telemetry payload is bounded in BYTES', () => {
  it('stays under the atomic-append budget however many objects are missing, and says what it dropped', () => {
    const repo = stagedRepo();
    // Many staged entries with long paths — the shape that would blow a count-based cap.
    for (let i = 0; i < 400; i++) {
      const p = join(repo.dir, `deeply/nested/directory/tree/for/payload/sizing/file-${i}.txt`);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, `content ${i}\n`);
    }
    git(repo.dir, ['add', '-A']);
    for (const line of git(repo.dir, ['ls-files', '-s']).stdout.trim().split('\n')) {
      const oid = line.split(/\s+/)[1] ?? '';
      if (oid) repo.deleteObject(oid);
    }

    const { events } = runReport(repo.dir);
    const ev = events.filter((e) => e.type === 'gate_infra_failure')[0];
    if (!ev) throw new Error('no gate_infra_failure event was emitted');
    // The single-line append must stay inside the 4KB atomicity window the sink relies on.
    expect(Buffer.byteLength(`${JSON.stringify(ev)}\n`, 'utf8')).toBeLessThan(4096);
    // And it must not read as a SMALLER fault than it was.
    const oids = ev.oids as string[];
    expect(ev.total).toBeGreaterThan(oids.length);
    expect(ev.omitted).toBeGreaterThan(0);
  });

  it.each([
    ['no objects, huge env + detail', 0, 50_000],
    ['one object', 1, 50_000],
    ['many objects', 500, 50_000],
    ['many objects, modest fields', 500, 100],
    ['non-ASCII paths — bytes, not UTF-16 units', 200, 2_000],
  ])('holds the budget at the floor: %s', (_name, count, fieldLen) => {
    // Third review finding: dropping oid/path pairs alone has no floor — at zero pairs the capped
    // odb_env plus detail could still exceed the budget on their own. The invariant is stated on
    // the payload, so it is asserted on the payload; going through the emitted event instead would
    // fold in the envelope and hide a payload that had already blown its own budget.
    const objects = Array.from({ length: count }, (_, i) => ({
      oid: `${i}`.padStart(40, '0'),
      // 3 bytes per code unit: a payload that measures 2048 "long" serializes to ~6KB, which is
      // exactly the gap between `.length` and the sink's byte limit.
      path: `深/路径/number-${i}/${'字'.repeat(300)}.ts`,
    }));
    const env = Object.fromEntries(
      [
        'git_common_dir',
        'objects_dir',
        'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES',
        'GIT_INDEX_FILE',
      ].map((k) => [k, 'v'.repeat(fieldLen)]),
    );
    const payload = boundedPayload(objects, env, 'e'.repeat(fieldLen));
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(EVENT_BUDGET);
    // However hard it was shrunk, it never reads as a smaller fault than it was.
    expect(payload.total).toBe(count);
  });

  it('bounds detail and odb_env too — a field cap is not a byte bound', () => {
    // Second review finding: capping only oids/paths left `detail` (a raw error message) and
    // GIT_ALTERNATE_OBJECT_DIRECTORIES (an arbitrarily long colon-separated list) unbounded.
    const repo = stagedRepo();
    repo.deleteObject(repo.oidOf('one.txt'));
    process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = 'x'.repeat(20000);
    sinks.push('GIT_ALTERNATE_OBJECT_DIRECTORIES');
    const { events } = runReport(repo.dir);
    const ev = events.filter((e) => e.type === 'gate_infra_failure')[0];
    if (!ev) throw new Error('no gate_infra_failure event was emitted');
    expect(Buffer.byteLength(`${JSON.stringify(ev)}\n`, 'utf8')).toBeLessThan(4096);
  });
});

describe('reportGateInfraFailure', () => {
  it('names the fault as infrastructure, not a finding, and returns the ODB exit code', () => {
    const repo = stagedRepo();
    const oid = repo.oidOf('one.txt');
    repo.deleteObject(oid);

    const { code, out, events } = runReport(repo.dir);
    expect(code).toBe(ODB_FAULT_EXIT);
    expect(out).toContain('not a review finding');
    expect(out).toContain('No defect was named');
    expect(out).toContain(oid);
    expect(out).toContain('one.txt');
    // It must not assert a deletion: sc-1420 left "different object database" equally live.
    expect(out).not.toMatch(/delet/i);

    const infra = events.filter((e) => e.type === 'gate_infra_failure');
    expect(infra).toHaveLength(1);
    expect(infra[0]?.fault).toBe('staged_object_unreadable_by_gate');
    expect(infra[0]?.oids).toEqual([oid]);
    // The discriminator: ship's view vs the gate's stripped view.
    expect(infra[0]?.odb_env).toBeDefined();
  });

  it('keeps the caller exit code and message when nothing is classified', () => {
    const { code, out, events } = runReport(stagedRepo().dir);
    expect(code).toBe(2);
    expect(out).toContain('could not run');
    expect(out).not.toContain('not a review finding');
    // Must not claim the staged set was verified clean — the probe never reads HEAD-side objects.
    expect(out).toContain('HEAD-side objects');
    expect(events.filter((e) => e.type === 'gate_infra_failure')[0]?.fault).toBe('unclassified');
  });

  it('keeps the caller exit code when the probe ITSELF fails — no evidence, no hardening', () => {
    const dir = mkdtempSync(join(tmpdir(), 'odb-notrepo-'));
    roots.push(dir);
    const { code, out, events } = runReport(dir); // not a git repository
    expect(code).toBe(2); // the caller's fail-open, NOT ODB_FAULT_EXIT
    expect(out).toContain('could not check why');
    expect(out).toContain('not a review finding');
    expect(events.filter((e) => e.type === 'gate_infra_failure')[0]?.fault).toBe(
      'staged_index_unenumerable_by_gate',
    );
  });

  it('emits no gate_result row — a gate that could not run produced no outcome', () => {
    const repo = stagedRepo();
    repo.deleteObject(repo.oidOf('one.txt'));
    expect(runReport(repo.dir).events.filter((e) => e.type === 'gate_result')).toHaveLength(0);
  });
});
