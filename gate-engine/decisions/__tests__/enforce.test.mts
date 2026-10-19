/**
 * guard-decisions enforce: Check links on decision Targets and the decision-checks commit gate, run
 * against real git fixture repos so HEAD, the index and the working tree each say what they say.
 */
import { execFileSync } from 'node:child_process';
import {
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkCheck, report, runGate, type Spawn } from '../ruling-checks/enforce.mts';
import { liveLink } from '../ruling-checks/links.mts';

const REC = 'docs/decisions/demo.md';
const CHECK = 'node check.mjs';
// Fails when the scoped source says "bad": the violation the linked Check exists to catch.
const CHECK_JS =
  "import { readFileSync } from 'node:fs';\nprocess.exit(readFileSync('src/a.txt', 'utf8').includes('bad') ? 1 : 0);\n";

let roots: string[] = [];
let out: string[] = [];
let err: string[] = [];
beforeEach(() => {
  process.env.DEVKIT_NO_TELEMETRY = '1';
  vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')));
});
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
  out = [];
  err = [];
  delete process.env.GUARD_DECISION_CHECKS_OK;
  delete process.env.DEVKIT_GATE_EVENTS;
  delete process.env.GUARD_DECISIONS_DIR;
  vi.restoreAllMocks();
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

function target(date: string, scope: string, notes: string[] = []): string {
  const scopeLine = scope ? `**Scope:** ${scope}\n` : '';
  const bullets = notes.map((n) => `- ${date} — ${n}\n`).join('');
  return `## Target · ${date} — demo\n\n**Ruling:** Never ship a bad a.txt (${date}).\n${scopeLine}${bullets}`;
}

const record = (...targets: string[]) =>
  `---\nslug: demo\ncreated: 2026-10-01\n---\n\n# demo\n\n${targets.join('\n')}`;

function write(root: string, files: Record<string, string>): void {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
}

function stage(root: string, files: Record<string, string>): void {
  write(root, files);
  git(root, 'add', '-A');
}

// A committed repo whose `demo` Target links CHECK over src/**, unless `notes` says otherwise.
function repo(notes = [`**Check:** ${CHECK} — pins the ruling`], commit = true): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'enforce-')));
  roots.push(root);
  git(root, 'init', '-q');
  const rec = record(target('2026-10-01', 'src/**', notes));
  stage(root, { [REC]: rec, 'check.mjs': CHECK_JS, 'src/a.txt': 'good\n' });
  if (commit) git(root, 'commit', '-qm', 'init');
  return root;
}

// A spawn that never runs anything: it reports `status`, or the spawn error named by `code`.
function stubSpawn(status: number | null = 0, code = '') {
  const error = code ? Object.assign(new Error(code), { code }) : undefined;
  return vi.fn<Spawn>(() => ({ status, error }));
}

describe('liveLink', () => {
  const body = (...t: string[]) => t.join('\n');

  it('reads the newest Check note under the live Target, without its reason', () => {
    const b = body(target('2026-10-01', 'src/**', ['**Check:** a — one', '**Check:** b c — two']));
    expect(liveLink(b)?.cmd).toBe('b c');
  });

  it('reads `none` as unlinked', () => {
    const b = body(target('2026-10-01', 'src/**', ['**Check:** a — one', '**Check:** none — off']));
    expect(liveLink(b)?.cmd).toBe('');
  });

  it('ignores a Check note under a superseded Target', () => {
    const b = body(
      target('2026-10-01', 'src/**', ['**Check:** a — one']),
      target('2026-10-05', ''),
    );
    expect(liveLink(b)?.cmd).toBe('');
  });

  it('takes the Scope a rescope note set, and is null without a Target', () => {
    const b = body(target('2026-10-01', 'src/**', ['**Scope:** lib/**, x.ts — moved']));
    expect(liveLink(b)?.globs).toEqual(['lib/**', 'x.ts']);
    expect(liveLink('# no target\n')).toBeNull();
  });
});

describe('decision-checks gate', () => {
  it('passes without running anything when no record links a Check', async () => {
    const root = repo(['plain note, naming a `**Check:**` only in prose']);
    stage(root, { 'src/a.txt': 'bad\n' });
    const exec = stubSpawn(1);
    expect(await runGate(root, exec)).toBe(0);
    expect(exec).not.toHaveBeenCalled();
  });

  it('runs nothing when no staged file matches the Scope', async () => {
    const root = repo();
    stage(root, { 'other/x.txt': 'x\n' });
    const exec = stubSpawn(1);
    expect(await runGate(root, exec)).toBe(0);
    expect(exec).not.toHaveBeenCalled();
  });

  it('passes, running nothing, when decisionsDir sits outside the repository', async () => {
    const root = repo();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'enforce-outside-')));
    roots.push(outside);
    write(outside, {
      'demo.md': record(target('2026-10-01', 'src/**', [`**Check:** ${CHECK} — x`])),
    });
    process.env.GUARD_DECISIONS_DIR = outside;
    stage(root, { 'src/a.txt': 'bad\n' });
    const exec = stubSpawn(1);
    expect(await runGate(root, exec)).toBe(0);
    expect(exec).not.toHaveBeenCalled();
  });

  it('still runs a link when decisionsDir names the repository through a symlink', async () => {
    const root = repo();
    const aliasDir = realpathSync(mkdtempSync(join(tmpdir(), 'enforce-alias-')));
    roots.push(aliasDir);
    symlinkSync(root, join(aliasDir, 'repo'));
    process.env.GUARD_DECISIONS_DIR = join(aliasDir, 'repo', 'docs', 'decisions');
    stage(root, { 'src/a.txt': 'bad\n' });
    const exec = stubSpawn(1);
    expect(await runGate(root, exec)).toBe(1);
    expect(exec).toHaveBeenCalled();
  });

  it('runs the Check argv-split with no shell and no stdin, and passes on exit 0', async () => {
    const root = repo([`**Check:** node  check.mjs   --flag — spaced`]);
    stage(root, { 'src/a.txt': 'fine\n' });
    const exec = stubSpawn(0);
    expect(await runGate(root, exec)).toBe(0);
    const [bin, args, opts] = exec.mock.calls[0];
    expect([bin, args]).toEqual(['node', ['check.mjs', '--flag']]);
    expect(opts).toMatchObject({ cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
    expect(opts.shell).toBeUndefined();
    expect(opts.timeout).toBe(120_000);
  });

  it('blocks on a failing Check and prints the slug, command, ruling and remedy', async () => {
    const root = repo();
    stage(root, { 'src/a.txt': 'bad\n' });
    expect(await runGate(root)).toBe(1);
    const text = err.join('\n');
    expect(text).toContain(`demo: \`${CHECK}\` exited 1`);
    expect(text).toContain('Ruling (demo): Never ship a bad a.txt (2026-10-01).');
    expect(text).toContain('do not weaken the check');
    expect(text).not.toContain('unlinked in this commit');
  });

  it.each([
    ['a missing command', 'ENOENT', 'could not run: command not found'],
    ['a timeout', 'ETIMEDOUT', 'could not run: no exit within 120s'],
    ['any other spawn error', 'EACCES', 'could not run: EACCES'],
  ])('blocks %s as unrunnable, naming the Check', async (_, code, said) => {
    const root = repo();
    stage(root, { 'src/a.txt': 'fine\n' });
    expect(await runGate(root, stubSpawn(null, code))).toBe(1);
    expect(err.join('\n')).toContain(`demo: \`${CHECK}\` ${said}`);
  });

  it('runs a Check whose argv names a staged file, and says the commit edits it', async () => {
    const root = repo();
    stage(root, { 'check.mjs': `${CHECK_JS}// edited\n` });
    const exec = stubSpawn(0);
    expect(await runGate(root, exec)).toBe(0);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(err.join('\n')).toContain('this commit edits check.mjs, which the demo Check runs');
  });

  it('says the Check judged the working tree when its Scope has unstaged edits', async () => {
    const root = repo();
    stage(root, { 'src/b.txt': 'new\n' });
    write(root, { 'src/a.txt': 'edited, not staged\n' });
    expect(await runGate(root, stubSpawn(0))).toBe(0);
    expect(err.join('\n')).toContain("unstaged edits in demo's Scope (src/a.txt)");
  });

  it('a bypass runs nothing and writes a could_not_run row', async () => {
    const root = repo();
    const sink = join(root, 'events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    process.env.GUARD_DECISION_CHECKS_OK = '1';
    stage(root, { 'src/a.txt': 'bad\n' });
    const exec = stubSpawn(1);
    expect(await runGate(root, exec)).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    const row = JSON.parse(readFileSync(sink, 'utf8').trim());
    expect(row).toMatchObject({ gate: 'decision-checks', status: 'could_not_run' });
  });

  it('reads an unborn HEAD as linking nothing and runs the index link', async () => {
    const root = repo(undefined, false);
    const exec = stubSpawn(0);
    expect(await runGate(root, exec)).toBe(0);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe('decision-checks gate: HEAD and the index together', () => {
  const unlinks: Array<[string, (root: string) => Record<string, string>]> = [
    ['an unlink', () => ({ [REC]: record(target('2026-10-01', 'src/**', linked('none'))) })],
    [
      'a re-Target',
      () => ({ [REC]: record(target('2026-10-01', 'src/**', linked()), target('2026-10-05', '')) }),
    ],
    [
      'a rescope away',
      () => ({
        [REC]: record(target('2026-10-01', 'src/**', [...linked(), '**Scope:** x/** — m'])),
      }),
    ],
    [
      'a weaker re-link',
      () => ({ [REC]: record(target('2026-10-01', 'src/**', linked('node -e 0'))) }),
    ],
  ];

  function linked(next?: string): string[] {
    const first = `**Check:** ${CHECK} — pins the ruling`;
    return next ? [first, `**Check:** ${next} — changed`] : [first];
  }

  it.each(unlinks)('still runs HEAD’s Check when the violation carries %s', async (_, edit) => {
    const root = repo();
    stage(root, { 'src/a.txt': 'bad\n', ...edit(root) });
    expect(await runGate(root)).toBe(1);
    const text = err.join('\n');
    expect(text).toContain("this commit unlinks or changes the Check on demo; HEAD's Check still");
    expect(text).toContain(`\`${CHECK}\` exited 1`);
  });

  it('labels a failing link only HEAD still has', async () => {
    const root = repo();
    stage(root, { 'src/a.txt': 'bad\n', ...unlinks[0][1](root) });
    expect(await runGate(root)).toBe(1);
    expect(err.join('\n')).toContain('demo (unlinked in this commit):');
  });

  it('passes the same violation once the unlink is committed on its own first', async () => {
    const root = repo();
    stage(root, unlinks[0][1](root));
    git(root, 'commit', '-qm', 'unlink');
    stage(root, { 'src/a.txt': 'bad\n' });
    expect(await runGate(root)).toBe(0);
  });

  it.each([
    ['renamed', 'docs/decisions/demo-moved.md'],
    ['moved out of the decisions directory', 'old/demo.md'],
  ])(
    'still runs HEAD’s Check when the record is %s and unlinked with the violation',
    async (_, to) => {
      const root = repo();
      git(root, 'rm', '-q', REC);
      stage(root, {
        [to]: record(target('2026-10-01', 'src/**', linked('none'))),
        'src/a.txt': 'bad\n',
      });
      expect(await runGate(root)).toBe(1);
      expect(err.join('\n')).toContain('demo (unlinked in this commit):');
    },
  );

  it('reads paths relative to a package cwd, as a monorepo package hook runs it', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'enforce-pkg-')));
    roots.push(root);
    git(root, 'init', '-q');
    const rec = record(target('2026-10-01', 'src/**', linked()));
    stage(root, { [`pkg/${REC}`]: rec, 'pkg/check.mjs': CHECK_JS, 'pkg/src/a.txt': 'good\n' });
    git(root, 'commit', '-qm', 'init');
    stage(root, { 'pkg/src/a.txt': 'bad\n' });
    expect(await runGate(join(root, 'pkg'))).toBe(1);
    expect(err.join('\n')).toContain(`demo: \`${CHECK}\` exited 1`);
  });
});

describe('enforce link', () => {
  const linkIn = (root: string, cmd: string, exec = stubSpawn(0)) =>
    linkCheck('demo', cmd, 'pins it', root, exec);

  it.each([
    ['an unknown slug', 'nope', (r: string) => r],
    ['an axis with no Target', 'demo', (r: string) => (write(r, { [REC]: '# demo\n' }), r)],
  ])('refuses %s', async (_, slug, prep) => {
    const root = prep(repo(['plain']));
    expect(await linkCheck(slug, CHECK, 'why', root, stubSpawn(0))).toBe(1);
  });

  it('refuses an axis with no Scope and leaves the record byte-unchanged', async () => {
    const root = repo(['plain']);
    write(root, { [REC]: record(target('2026-10-01', '', ['plain'])) });
    const before = readFileSync(join(root, REC), 'utf8');
    const exec = stubSpawn(0);
    expect(await linkIn(root, CHECK, exec)).toBe(1);
    expect(err.join('\n')).toContain('no Scope');
    expect(readFileSync(join(root, REC), 'utf8')).toBe(before);
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses a Check that fails on the current tree and writes nothing', async () => {
    const root = repo(['plain']);
    const before = readFileSync(join(root, REC), 'utf8');
    expect(await linkIn(root, CHECK, stubSpawn(1))).toBe(1);
    expect(readFileSync(join(root, REC), 'utf8')).toBe(before);
  });

  it('writes a passing Check as a note the gate then reads', async () => {
    const root = repo(['plain']);
    expect(await linkIn(root, CHECK)).toBe(0);
    expect(readFileSync(join(root, REC), 'utf8')).toMatch(
      /- \d{4}-\d{2}-\d{2} — \*\*Check:\*\* node check\.mjs — pins it\n$/,
    );
    expect(liveLink(readFileSync(join(root, REC), 'utf8'))?.cmd).toBe(CHECK);
  });

  it.each([
    'node check.mjs — x',
    'node check.mjs\t—\tx',
    'node check.mjs\n— x',
    'node check.mjs —',
  ])('refuses a bare em-dash argument the note would split off as its reason: %j', async (cmd) => {
    const root = repo(['plain']);
    const before = readFileSync(join(root, REC), 'utf8');
    const exec = stubSpawn(0);
    expect(await linkIn(root, cmd, exec)).toBe(1);
    expect(err.join('\n')).toContain('bare "—" argument');
    expect(readFileSync(join(root, REC), 'utf8')).toBe(before);
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(['node check.mjs a—b', 'node check.mjs ——'])(
    'reads back an em-dash inside an argument as the command it linked: %j',
    async (cmd) => {
      const root = repo(['plain']);
      expect(await linkIn(root, cmd)).toBe(0);
      expect(liveLink(readFileSync(join(root, REC), 'utf8'))?.cmd).toBe(cmd);
    },
  );

  it('writes `none` without running anything', async () => {
    const root = repo();
    const exec = stubSpawn(1);
    expect(await linkIn(root, 'none', exec)).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    expect(liveLink(readFileSync(join(root, REC), 'utf8'))?.cmd).toBe('');
  });
});

describe('enforce report', () => {
  it('counts enforced and prose-only axes and lists links that cannot run', async () => {
    const root = repo();
    const d = 'docs/decisions';
    write(root, {
      [`${d}/prose.md`]: `${record(target('2026-10-01', 'lib/**'))}Mentions a \`**Check:**\` note.\n`,
      [`${d}/dropped.md`]: record(
        target('2026-10-01', 'a/**', ['**Check:** x — y']),
        target('2026-10-04', 'a/**'),
      ),
      [`${d}/unscoped.md`]: record(target('2026-10-01', '', ['**Check:** x — y'])),
    });
    expect(await report(root)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('Decision checks: 1 enforced, 2 prose-only, of 3 scoped axes.');
    expect(text).toContain(`enforced    demo — ${CHECK}`);
    expect(out).toContain('⚠ Check note but no live link (re-Targeted or unlinked): dropped');
    expect(text).toContain('Linked but never run, no Scope: unscoped');
  });
});
