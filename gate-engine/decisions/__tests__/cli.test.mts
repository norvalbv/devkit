import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseIndex, renderIndex } from '../decision-format.mts';

// Never called: declares the spawned module to vitest's graph, so `vitest related` selects this file.
void (() => import('../cli.mts'));

// cli.mts (not decisions.mts) is the real `guard-decisions` bin — `categories` is dispatched there
// (see cli.mts's `run`), so this exercises the ACTUAL entrypoint a user invokes, not an internal fn.
const SCRIPT = fileURLToPath(new URL('../cli.mts', import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guard-decisions-cli-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[], script = SCRIPT) {
  return spawnSync('node', [script, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GUARD_DECISIONS_DIR: dir,
      DECISIONS_TODAY: '2026-07-26',
      DECISIONS_NO_EMBED: '1',
      DECISIONS_INDEX: join(dir, 'vec-index.json'),
    },
  });
}

/**
 * Hides the parser without touching the shared checkout (renaming it aside would race the parallel
 * suite). Preloaded before the entry LINKS, so it throws where the real bug does: ModuleJob._link.
 */
const HIDE_MDAST = `data:text/javascript,${encodeURIComponent(`
  import { registerHooks } from 'node:module';
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'mdast-util-from-markdown') {
        const err = new Error(
          \`Cannot find package 'mdast-util-from-markdown' imported from \${context.parentURL}\`,
        );
        err.code = 'ERR_MODULE_NOT_FOUND';
        throw err;
      }
      return nextResolve(specifier, context);
    },
  });
`)}`;

/**
 * As above, with a caller-chosen error so a test can vary the FAILURE rather than only the command.
 */
function hidingParser(code: string, message: string) {
  return `data:text/javascript,${encodeURIComponent(`
    import { registerHooks } from 'node:module';
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === 'mdast-util-from-markdown') {
          const err = new Error(${JSON.stringify(message)});
          err.code = ${JSON.stringify(code)};
          throw err;
        }
        return nextResolve(specifier, context);
      },
    });
  `)}`;
}

/** run(), with the parser failing in a caller-chosen way and an optional decisions dir override. */
function runWithFailure(args: string[], preload: string, decisionsDir = dir) {
  return spawnSync('node', ['--import', preload, SCRIPT, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GUARD_DECISIONS_DIR: decisionsDir,
      DECISIONS_TODAY: '2026-07-26',
      DECISIONS_NO_EMBED: '1',
      DECISIONS_INDEX: join(dir, 'vec-index.json'),
    },
  });
}

/** Same contract as run(), with the parser dependency unresolvable. */
function runWithoutParser(args: string[], env: Record<string, string> = {}) {
  return spawnSync('node', ['--import', HIDE_MDAST, SCRIPT, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GUARD_DECISIONS_DIR: dir,
      DECISIONS_TODAY: '2026-07-26',
      DECISIONS_NO_EMBED: '1',
      DECISIONS_INDEX: join(dir, 'vec-index.json'),
      ...env,
    },
  });
}

type Exit = Pick<ReturnType<typeof spawnSync>, 'status' | 'signal' | 'stderr'>;

/**
 * A signal kill leaves status null — never let it read as exit 0 or as a refusal (sc-2477).
 */
function expectExit(r: Exit, code: number) {
  expect(r.signal, String(r.stderr)).toBeNull();
  expect(r.status, String(r.stderr)).toBe(code);
}

/** A refusal is a real non-zero exit code, not merely "anything but 0" — null is a crash. */
function expectRefusal(r: Exit) {
  expect(r.signal, String(r.stderr)).toBeNull();
  expect(r.status, String(r.stderr)).toBeGreaterThan(0);
}

describe('expectExit / expectRefusal (sc-2477)', () => {
  const killed: Exit = { status: null, signal: 'SIGKILL', stderr: '' };
  // spawnSync's shape when the spawn itself fails (ENOENT, EACCES): no status AND no signal.
  const neverRan: Exit = { status: null, signal: null, stderr: '' };

  it('rejects a signal kill where a clean exit is expected', () => {
    expect(() => expectExit(killed, 0)).toThrow();
  });

  it('rejects a signal kill where a refusal is expected — a crash is not a refusal', () => {
    expect(() => expectRefusal(killed)).toThrow();
  });

  it('rejects a child that never ran, under either form', () => {
    expect(() => expectExit(neverRan, 0)).toThrow();
    expect(() => expectRefusal(neverRan)).toThrow();
  });

  it('accepts real exits and still tells 0 from non-zero', () => {
    expectExit({ status: 0, signal: null, stderr: '' }, 0);
    expectRefusal({ status: 1, signal: null, stderr: '' });
    expect(() => expectRefusal({ status: 0, signal: null, stderr: '' })).toThrow();
    expect(() => expectExit({ status: 1, signal: null, stderr: '' }, 0)).toThrow();
  });

  // The fixtures above are hand-built; this pins them to the shape spawnSync really returns. POSIX
  // only — Windows has no signal delivery, so a self-kill there reports an exit code instead.
  it.skipIf(process.platform === 'win32')('rejects a real child that a signal killed', () => {
    const r = spawnSync('node', ['-e', 'process.kill(process.pid, "SIGKILL")'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(r.signal).toBe('SIGKILL');
    expect(() => expectExit(r, 0)).toThrow();
    expect(() => expectRefusal(r)).toThrow();
  });
});

const reqFlags = (slug: string) => [
  '--context',
  `${slug} broke`,
  '--ruling',
  `${slug}-ruling`,
  '--consequences',
  `${slug} value`,
  '--tradeoff',
  `${slug} cost`,
  '--vision-fit',
  'n/a',
];

describe('guard-decisions categories (via cli.mts, the real bin)', () => {
  it('exits 0 and prints something sane for an empty log', () => {
    const r = run(['categories']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No decisions recorded.');
  });

  it('groups a recorded axis under its Category and still exits 0', () => {
    const add = run([
      'add',
      'my-axis',
      '--target',
      '--new',
      ...reqFlags('my-axis'),
      '--category',
      'ship-pipeline',
    ]);
    expect(add.status, add.stderr).toBe(0);

    const r = run(['categories']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('# ship-pipeline (1)');
    expect(r.stdout).toContain('- my-axis · my-axis-ruling');
  });

  it('still dispatches ordinary commands (unaffected by the new branch)', () => {
    expect(run(['list']).stdout).toContain('No decisions recorded.');
  });
});

describe('guard-decisions <command> --help (via cli.mts, the real bin)', () => {
  it('prints reindex usage instead of reindexing', () => {
    expectExit(run(['add', 'my-axis', '--target', '--new', ...reqFlags('my-axis')]), 0);
    const r = run(['reindex', '--help']);
    expectExit(r, 0);
    expect(r.stdout).toBe(
      'Usage:\n  guard-decisions reindex   rebuild the derived embedding cache\n',
    );
  });

  it('prints show usage instead of looking up an axis named --help', () => {
    const r = run(['show', '--help']);
    expectExit(r, 0);
    expect(r.stdout).toContain('guard-decisions show <slug>');
    expect(r.stderr).not.toContain('No decision axis');
  });

  it('says check takes a slug and only tests that its file exists', () => {
    const r = run(['check', '-h']);
    expectExit(r, 0);
    expect(r.stdout).toContain('guard-decisions check <slug>   exit 0 if axis <slug> has a file');
  });

  it('lists every command for a bare --help, and still refuses a missing command', () => {
    const r = run(['--help']);
    expectExit(r, 0);
    for (const cmd of ['add', 'query', 'reindex', 'show', 'check', 'detect', 'integrity'])
      expect(r.stdout).toContain(`guard-decisions ${cmd} `);
    const bare = run([]);
    expectRefusal(bare);
    expect(bare.stderr).toContain('guard-decisions check <slug>');
  });

  it('treats a --help after the slug as an argument, not a help request', () => {
    const r = run(['show', 'no-such-axis', '--help']);
    expectRefusal(r);
    expect(r.stderr).toContain('No decision axis "no-such-axis"');
  });
});

// The bin must CALL each sub-engine, never rely on its run-as-main guard: a module some import
// chain already loaded skips the guard, and the gate exits 0 having judged nothing.
describe('guard-decisions sub-engine dispatch (via cli.mts, the real bin)', () => {
  const engine = (name: string) => fileURLToPath(new URL(`../${name}.mts`, import.meta.url));
  const stage = (rel: string, body: string) => {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
    execFileSync('git', ['add', rel], { cwd: dir, stdio: 'pipe' });
  };
  const writeScopedAxis = () =>
    writeFileSync(
      join(dir, 'axis.md'),
      '---\nslug: axis\ncreated: 2026-01-01\n---\n\n# axis\n\n## Target · 2026-01-01 — r\n\n' +
        '**Context:** c\n**Ruling:** r\n**Vision-fit:** v\n**Scope:** src/**\n',
    );
  beforeEach(() => execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe' }));

  it('check-alignment scan names the scoped Target a staged file falls under, as a direct run does', () => {
    writeScopedAxis();
    stage('src/a.ts', 'export {};\n');
    const wrapped = run(['check-alignment', 'scan']);
    expectExit(wrapped, 0);
    expect(wrapped.stdout).toContain('axis: src/a.ts');
    expect(wrapped.stdout).toBe(run(['scan'], engine('check-alignment')).stdout);
  });

  // Inherited Object.prototype names are unknown subcommands too, not commands that pass silently.
  it.each(['bogus', 'toString', 'constructor'])(
    'check-alignment %s prints usage and exits 2, not a silent pass',
    (cmd) => {
      const r = run(['check-alignment', cmd]);
      expectExit(r, 2);
      expect(r.stderr).toContain('Usage: check-alignment.mjs --gate | scan');
    },
  );

  it('detect scan --files reads its flags from the bin argv, matching a direct run', () => {
    stage('package.json', '{"dependencies":{"a":"1.0.0"}}\n');
    const wrapped = run(['detect', 'scan', '--files']);
    expectExit(wrapped, 0);
    expect(wrapped.stdout).toBe('dep-change\tpackage.json\ta\n');
    expect(wrapped.stdout).toBe(run(['scan', '--files'], engine('detect')).stdout);
  });

  // decision-stop-check.sh runs `detect scan --working --files`: a dropped flag scans the index only
  // and the Stop hook stops nudging on every unstaged smell.
  it('detect scan honours --working from the bin argv, seeing an unstaged dep change', () => {
    stage('package.json', '{"dependencies":{"a":"1.0.0"}}\n');
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-qm', 'base'], {
      cwd: dir,
      stdio: 'pipe',
    });
    writeFileSync(join(dir, 'package.json'), '{"dependencies":{"a":"1.0.0","b":"2.0.0"}}\n');
    expect(run(['detect', 'scan', '--working', '--files']).stdout).toBe(
      'dep-change\tpackage.json\tb\n',
    );
    expect(run(['detect', 'scan', '--files']).stdout).toBe('');
  });

  // decision-scope-brief.mjs reads this JSON; its own tests stub the bin, so only this proves the
  // real bin waits for the async engine and prints the scope-matched Target.
  it('scoped-targets prints the governing Target as JSON through the bin', () => {
    writeScopedAxis();
    const r = run(['scoped-targets', '--files', 'src/a.ts']);
    expectExit(r, 0);
    expect(JSON.parse(r.stdout)).toEqual([
      { slug: 'axis', ruling: 'r', scope: 'src/**', via: 'scope-match' },
    ]);
  });
});

// The whole point of the integrity checks is that a record the CLI itself wrote passes them, and a
// record something else wrote does not. Asserting that end-to-end through the real bin — rather than
// calling scanCorpus() on a hand-built fixture, which integrity-checks.test.mts already covers — is
// what proves the two halves actually agree about the format.
describe('guard-decisions integrity (via cli.mts, the real bin)', () => {
  it('passes a record written by the CLI itself', () => {
    expect(run(['add', 'my-axis', '--target', '--new', ...reqFlags('my-axis')]).status).toBe(0);
    const r = run(['integrity']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('every record has the shape the CLI would have written');
  });

  it('exits 1 and names the check when a record is edited outside the CLI', () => {
    expect(run(['add', 'my-axis', '--target', '--new', ...reqFlags('my-axis')]).status).toBe(0);
    // A hand-edit of exactly the kind the CLI can never produce: the body H1 renamed while the
    // filename (and so the axis's identity everywhere else) stays put.
    const file = join(dir, 'my-axis.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^# my-axis$/m, '# renamed-by-hand'));

    const r = run(['integrity']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('h1-slug-mismatch');
    expect(r.stderr).toContain('my-axis');
  });

  // The hook invokes `integrity --staged`. If that dispatch ever silently fell through to the
  // whole-corpus variant, devkit's own repo would block on every commit — the corpus carries a
  // permanent, unrepairable finding that only the staged variant tolerates.
  it('routes --staged to the staged gate, not the whole-corpus scan', () => {
    expect(run(['add', 'my-axis', '--target', '--new', ...reqFlags('my-axis')]).status).toBe(0);
    const file = join(dir, 'my-axis.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^# my-axis$/m, '# renamed-by-hand'));

    // The whole-corpus scan sees the hand-edit and fails...
    expect(run(['integrity']).status).toBe(1);
    // ...while the staged variant finds nothing staged in a non-git fixture and stands down. The
    // two must not produce the same verdict, or the dispatch is not wired.
    const staged = run(['integrity', '--staged']);
    expectExit(staged, 0);
    expect(staged.stderr).not.toContain('h1-slug-mismatch');
  });

  it('reports a clean pass rather than an error when no decisions exist yet', () => {
    const r = run(['integrity']);
    expect(r.status, r.stderr).toBe(0);
  });

  // The check reads a whitespace-only Evidence-change as missing (it trims). If the WRITE guard did
  // not trim too, the CLI could write a re-target that its own integrity check then flags — the one
  // thing these checks promise can never happen. Guarded at the write end, not by loosening the check.
  it('refuses a whitespace-only --evidence-change rather than writing a record it would then flag', () => {
    expect(run(['add', 'my-axis', '--target', '--new', ...reqFlags('my-axis')]).status).toBe(0);

    const retarget = run([
      'add',
      'my-axis',
      '--target',
      ...reqFlags('my-axis'),
      '--evidence-change',
      '   ',
    ]);
    expectRefusal(retarget);
    expect(retarget.stderr).toContain('evidence-change');

    // …and the log it refused to write is still clean.
    expect(run(['integrity']).status).toBe(0);
  });
});

// One verb for "this replaces that": --supersedes on a --target writes **Supersedes:**, on a --note
// it writes **Amends:** — the note-level marker retrieval has keyed on since sc-1236. The flag was
// already parsed and silently ignored on the note path.
describe('guard-decisions add --note --supersedes (via cli.mts, the real bin)', () => {
  const seed = () =>
    expect(run(['add', 'my-axis', '--target', '--new', ...reqFlags('my-axis')]).status).toBe(0);

  it('writes an Amends-tagged note naming the note it replaces', () => {
    seed();
    expect(run(['add', 'my-axis', '--note', 'carry-on made real']).status).toBe(0);
    const r = run([
      'add',
      'my-axis',
      '--note',
      'deleted, it was a lie',
      '--supersedes',
      'note:2026-07-26',
    ]);
    expect(r.status, r.stderr).toBe(0);

    const file = readFileSync(join(dir, 'my-axis.md'), 'utf8');
    expect(file).toContain('**Amends:** note:2026-07-26 — deleted, it was a lie');
    expect(run(['integrity']).status).toBe(0);
  });

  // The sc-1282 lesson applied at a new write site: a CLI must never write a record its own check
  // then rejects. Both failures below are caught BEFORE anything reaches disk.
  it('refuses a pointer that names no note on the axis', () => {
    seed();
    const r = run(['add', 'my-axis', '--note', 'nope', '--supersedes', 'note:2020-01-01']);
    expectRefusal(r);
    expect(r.stderr).toContain('names no note on this axis');
    expect(run(['integrity']).status).toBe(0);
  });

  it('refuses a Target id — a note amends a NOTE, not a ruling', () => {
    seed();
    const r = run(['add', 'my-axis', '--note', 'nope', '--supersedes', 'target:2026-07-26']);
    expectRefusal(r);
    expect(r.stderr).toContain('is not a note id');
  });

  it('leaves an ordinary note untouched when no relation is declared', () => {
    seed();
    expect(run(['add', 'my-axis', '--note', 'plain convergence']).status).toBe(0);
    expect(readFileSync(join(dir, 'my-axis.md'), 'utf8')).not.toContain('**Amends:**');
  });

  it('refuses a pointer qualified with the axis own slug that names no note on it', () => {
    seed();
    const r = run(['add', 'my-axis', '--note', 'nope', '--supersedes', 'my-axis#note:2020-01-01']);
    expectRefusal(r);
    expect(r.stderr).toContain('names no note on this axis');
  });
});

// amend --note rewrites the newest draft note, so it must validate --supersedes exactly as add does,
// against the history BEFORE that draft: the draft can never be named as its own predecessor.
describe('guard-decisions amend --note --supersedes (via cli.mts, the real bin)', () => {
  const file = () => readFileSync(join(dir, 'my-axis.md'), 'utf8');
  // The reported shape: the superseded note is committed, the note being amended is still a draft.
  const seedTwoNotes = () => {
    const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git(['init', '-q']);
    expect(run(['add', 'my-axis', '--target', '--new', ...reqFlags('my-axis')]).status).toBe(0);
    expect(run(['add', 'my-axis', '--note', 'first']).status).toBe(0);
    git(['add', '-A']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base']);
    expect(run(['add', 'my-axis', '--note', 'draft']).status).toBe(0);
  };

  it.each(['note:2026-07-26', 'my-axis#note:2026-07-26'])(
    'writes the Amends marker for %s on the amended draft note',
    (id) => {
      seedTwoNotes();
      const r = run(['amend', 'my-axis', '--supersedes', id, '--note', 'draft v2']);
      expect(r.status, r.stderr).toBe(0);

      expect(file()).toContain(`- 2026-07-26 — **Amends:** ${id} — draft v2`);
      expect(file()).not.toContain('— draft\n');
      expect(run(['integrity']).status).toBe(0);
    },
  );

  // Only the corpus-wide scan can read another axis, so the write must not refuse a foreign pointer.
  it('still accepts a pointer into another axis unresolved', () => {
    seedTwoNotes();
    const r = run([
      'amend',
      'my-axis',
      '--supersedes',
      'other-axis#note:2020-01-01',
      '--note',
      'x',
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(file()).toContain('**Amends:** other-axis#note:2020-01-01 — x');
  });

  it.each([
    ['a note the axis does not have', 'note:2020-01-01'],
    ['the draft itself', 'note:2026-07-26~2'],
    ['the draft itself, slug-qualified', 'my-axis#note:2026-07-26~2'],
  ])('refuses %s and leaves the record unchanged', (_label, id) => {
    seedTwoNotes();
    const before = file();
    const r = run(['amend', 'my-axis', '--supersedes', id, '--note', 'draft v2']);
    expectRefusal(r);
    expect(r.stderr).toContain('names no note on this axis');
    expect(file()).toBe(before);
  });

  it('warns when re-amending a tagged draft drops its Amends marker', () => {
    seedTwoNotes();
    run(['amend', 'my-axis', '--supersedes', 'note:2026-07-26', '--note', 'draft v2']);
    const r = run(['amend', 'my-axis', '--note', 'draft v3']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('omits --supersedes');
    expect(file()).not.toContain('**Amends:**');
  });
});

// The Target half of --supersedes: a pointer drift would reject is refused before anything is written,
// so a prose value can no longer reach an append-only record where nobody can repair it.
describe('guard-decisions add/amend --target --supersedes (via cli.mts, the real bin)', () => {
  const file = () => readFileSync(join(dir, 'my-axis.md'), 'utf8');
  const addTarget = (...extra: string[]) =>
    run(['add', 'my-axis', '--target', ...reqFlags('my-axis'), ...extra]);

  it.each([
    ['prose', 'the 2026-07-01 note on this axis', 'is not a Target id'],
    ['the block being written', 'target:2026-07-26', 'names no Target on this axis'],
  ])('refuses %s on a new axis and writes nothing', (_label, id, message) => {
    const r = addTarget('--new', '--supersedes', id);
    expectRefusal(r);
    expect(r.stderr).toContain(message);
    expect(existsSync(join(dir, 'my-axis.md'))).toBe(false);
  });

  it('accepts a re-target naming the earlier same-day block, and drift resolves it', () => {
    expect(addTarget('--new').status).toBe(0);
    const r = addTarget('--evidence-change', 'new data', '--supersedes', 'target:2026-07-26');
    expect(r.status, r.stderr).toBe(0);
    expect(file()).toContain('**Supersedes:** target:2026-07-26');
    expect(run(['drift']).stderr).not.toContain('Supersedes');
  });

  it('refuses a same-axis id that names no block and leaves the record unchanged', () => {
    expect(addTarget('--new').status).toBe(0);
    const before = file();
    const r = addTarget(
      '--evidence-change',
      'new data',
      '--supersedes',
      'my-axis#target:1999-01-01',
    );
    expectRefusal(r);
    expect(r.stderr).toContain('names no Target on this axis');
    expect(file()).toBe(before);
  });

  it('amend --target refuses prose on a draft Target and leaves it unchanged', () => {
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe' });
    expect(addTarget('--new').status).toBe(0);
    const before = file();
    const r = run([
      'amend',
      'my-axis',
      '--target',
      ...reqFlags('my-axis'),
      '--supersedes',
      'prose',
    ]);
    expectRefusal(r);
    expect(r.stderr).toContain('is not a Target id');
    expect(file()).toBe(before);
  });

  // amend validates against the history BEFORE the draft: passing the whole body would let the
  // draft name itself, and drift would then read the live ruling as superseded by itself.
  it('amend --target refuses the draft naming itself but accepts an earlier block', () => {
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe' });
    expect(addTarget('--new').status).toBe(0);
    expect(addTarget('--evidence-change', 'new data').status).toBe(0);
    const amend = (id: string) =>
      run([
        'amend',
        'my-axis',
        '--target',
        ...reqFlags('my-axis'),
        '--evidence-change',
        'v2',
        '--supersedes',
        id,
      ]);

    const before = file();
    const self = amend('target:2026-07-26~2');
    expectRefusal(self);
    expect(self.stderr).toContain('names no Target on this axis');
    expect(file()).toBe(before);

    expect(amend('target:2026-07-26').status).toBe(0);
    expect(file()).toContain('**Supersedes:** target:2026-07-26');
    expect(run(['drift']).stderr).not.toContain('Supersedes');
  });
});

describe('retrieval unavailable (the parser dependency cannot resolve)', () => {
  it('names the outage on stderr, exits non-zero, and leaves stdout empty', () => {
    writeFileSync(join(dir, 'judge-verdict-cache-scope.md'), '# judge-verdict-cache-scope\n');
    const r = runWithoutParser(['query', 'cache scope']);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('decision engine UNAVAILABLE');
    expect(r.stderr).toContain('mdast-util-from-markdown');
    // The whole point: an agent must not be able to read this as an answer.
    expect(r.stderr).toContain('NOT "no governing Target"');
    // stdout stays EMPTY. A `[]` or an empty ranking here is exactly how an outage gets misread.
    expect(r.stdout).toBe('');
  });

  it('lists the axis files it could not search, alphabetically and without implying a rank', () => {
    writeFileSync(join(dir, 'zeta-axis.md'), '# zeta-axis\n');
    writeFileSync(join(dir, 'alpha-axis.md'), '# alpha-axis\n');
    writeFileSync(join(dir, 'INDEX.md'), '# INDEX\n');
    const r = runWithoutParser(['query', 'anything at all']);

    // Membership, never position: the listing is a candidate set, not a ranking.
    expect(r.stderr).toContain('alpha-axis');
    expect(r.stderr).toContain('zeta-axis');
    expect(r.stderr).toContain('not a ranking');
    // INDEX.md is a rendered view, not an axis.
    expect(r.stderr).not.toMatch(/^ {2}INDEX$/m);
    expect(r.stderr).toContain('2 axes');
  });

  it('says the log is empty rather than listing nothing at all', () => {
    const r = runWithoutParser(['query', 'anything']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('directory is empty');
  });

  it('answers --json with a well-formed envelope naming the outage', () => {
    const r = runWithoutParser(['query', 'anything', '--json']);

    expect(r.status).toBe(1);
    const envelope = JSON.parse(r.stdout);
    // UNAVAILABLE must be distinguishable from NO_RULING, and rows must stay empty so a consumer
    // that reads only rows degrades to "abstained" rather than to a confident answer.
    expect(envelope.state).toBe('UNAVAILABLE');
    expect(envelope.source).toBe('unavailable');
    expect(envelope.rows).toEqual([]);
  });

  it('still runs `categories`, whose import closure never reaches the parser', () => {
    const r = runWithoutParser(['categories']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('No decisions recorded.');
  });

  it('leaves the pre-commit gate command exit code alone', () => {
    // The safety property: no commit that passes today may newly block. detect --gate is the only
    // decisions command the generated pre-commit hook runs, and its code must not move.
    const withParser = run(['detect', '--gate']);
    const withoutParser = runWithoutParser(['detect', '--gate']);
    // Two crashes, or two failed spawns, both report status null — equal, and proving nothing.
    expect(withParser.signal, withParser.stderr).toBeNull();
    expect(withParser.status, withParser.stderr).toBeGreaterThanOrEqual(0);
    expect(withoutParser.signal, withoutParser.stderr).toBeNull();
    expect(withoutParser.status).toBe(withParser.status);
  });

  it('still reports a staged dependency smell when the parser cannot load', () => {
    const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git(['init', '-q']);
    writeFileSync(join(dir, 'package.json'), '{"dependencies":{"a":"1.0.0"}}\n');
    git(['add', 'package.json']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base']);
    writeFileSync(join(dir, 'package.json'), '{"dependencies":{"a":"1.0.0","b":"2.0.0"}}\n');
    git(['add', 'package.json']);

    const result = runWithoutParser(['detect', '--gate'], { GUARD_DECISION_NO_LLM: '1' });
    expectExit(result, 1);
    expect(result.stderr).toContain('decision smells: dep-change');
    expect(result.stderr).not.toContain('decision engine UNAVAILABLE');
  });
});

describe('retrieval unavailable — failure shapes and the contract other callers read', () => {
  it('does NOT claim an outage for a failure that is not a missing module', () => {
    // Positive-signal-only, per judge-outage-classified-not-blocked. A WRONG outage label is the
    // same class of harm as a missing one: it invites the reader to discount a real error.
    const r = runWithFailure(['query', 'anything'], hidingParser('EACCES', 'permission denied'));

    expect(r.stderr).not.toContain('decision engine UNAVAILABLE');
    expect(r.stderr).toContain('permission denied');
  });

  it('still names the outage when the error message identifies no package', () => {
    // A broken dist throws ERR_MODULE_NOT_FOUND with a shape this regex may not mine. The MARKER is
    // the load-bearing part; the package name is a courtesy and must not gate it.
    const r = runWithFailure(['query', 'anything'], hidingParser('ERR_MODULE_NOT_FOUND', 'opaque'));

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('decision engine UNAVAILABLE');
  });

  it('leaves stdout empty for scoped-targets, which the pre-edit brief hook parses', () => {
    // decision-scope-brief.mjs reads "exit 0 carrying a JSON array" as an answer. A `[]` here would
    // make it read a dead store as "nothing governs this file" — the exact defect, re-created.
    writeFileSync(join(dir, 'some-axis.md'), '# some-axis\n');
    const r = runWithoutParser(['scoped-targets', '--files', 'src/a.ts']);

    expectRefusal(r);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('decision engine UNAVAILABLE');
    // scoped-targets ANSWERS from the log, so it keeps the caveat.
    expect(r.stderr).toContain('no governing Target');
    expect(r.stderr).toContain('not a ranking');
  });

  it('reports a decisions directory that does not exist, without crashing on it', () => {
    // A consumer that has installed devkit but recorded nothing yet has no docs/decisions at all.
    const r = runWithFailure(
      ['query', 'anything'],
      hidingParser('ERR_MODULE_NOT_FOUND', "Cannot find package 'mdast-util-from-markdown'"),
      join(dir, 'no-such-dir'),
    );

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('decision engine UNAVAILABLE');
    expect(r.stderr).toContain('could not be resolved');
  });

  it('does not hand a non-retrieval command the retrieval caveat or the axis listing', () => {
    // `integrity` does not answer FROM the log, so its outage cannot be misread as "nothing rules".
    // Telling its caller "nothing was searched" and listing 74 axes is remediation for another bug.
    writeFileSync(join(dir, 'some-axis.md'), '# some-axis\n');
    const r = runWithoutParser(['integrity']);

    expect(r.stderr).toContain('decision engine UNAVAILABLE');
    expect(r.stderr).not.toContain('no governing Target');
    expect(r.stderr).not.toContain('not a ranking');
  });

  it('counts one axis as an axis', () => {
    writeFileSync(join(dir, 'lonely-axis.md'), '# lonely-axis\n');
    const r = runWithoutParser(['query', 'anything']);

    expect(r.stderr).toContain('1 axis, ALPHABETICAL');
  });
});

// Fixtures write axis FILES by hand, not through `add`: the sc-2332 bug only exists for a corpus
// the CLI did not write row-by-row. See decision-retrieval-candidate-set for why list reads them.
const axisFile = (slug: string, o: { context?: string; note?: string; target?: string } = {}) =>
  `---\nslug: ${slug}\ncreated: 2026-01-01\n---\n\n# ${slug}\n\n` +
  `## Target · ${o.target ?? '2026-01-01'} — ${slug} title\n\n` +
  `**Context:** ${o.context ?? `${slug} broke`}\n` +
  `**Ruling:** ${slug}-ruling\n` +
  '**Consequences:**\n- Positive: value\n**Tradeoff:** cost\n**Vision-fit:** n/a\n' +
  (o.note ? `${o.note}\n` : '');

const indexRow = (slug: string) => ({
  slug,
  ruling: `${slug}-ruling`,
  why: `${slug} broke`,
  updated: '2026-01-01',
});

/** The rendered spine, read back through the format's own parser. */
const listRows = () => {
  const r = run(['list']);
  expect(r.status, r.stderr).toBe(0);
  return { rows: parseIndex(r.stdout), stdout: r.stdout };
};

describe('guard-decisions list (directory-sourced spine, sc-2332)', () => {
  it('lists every axis file when no INDEX.md exists at all', () => {
    writeFileSync(join(dir, 'alpha.md'), axisFile('alpha'));
    writeFileSync(join(dir, 'beta.md'), axisFile('beta'));

    const { rows, stdout } = listRows();
    expect(rows.map((row) => row.slug)).toEqual(['alpha', 'beta']);
    expect(stdout).not.toContain('No decisions recorded.');
    // The deterministic, backend-free cross-check — `categories` already read the directory.
    expect(run(['categories']).stdout).toContain('# uncategorised (2)');
  });

  it('lists an axis the INDEX.md spine omits', () => {
    writeFileSync(join(dir, 'alpha.md'), axisFile('alpha'));
    writeFileSync(join(dir, 'beta.md'), axisFile('beta'));
    writeFileSync(join(dir, 'INDEX.md'), renderIndex([indexRow('alpha')]));

    expect(listRows().rows.map((row) => row.slug)).toEqual(['alpha', 'beta']);
  });

  it('omits an INDEX row whose axis file is gone (drift is doctor’s business)', () => {
    writeFileSync(join(dir, 'alpha.md'), axisFile('alpha'));
    writeFileSync(join(dir, 'INDEX.md'), renderIndex([indexRow('alpha'), indexRow('gone')]));

    expect(listRows().rows.map((row) => row.slug)).toEqual(['alpha']);
  });

  // amend's regenerateIndex drops an axis with no parseable Target and no prior INDEX row. A `list`
  // built on that precedent would hide exactly the legacy-schema axis a real consumer still carries.
  it('keeps a Target-less legacy axis as a well-formed row', () => {
    writeFileSync(
      join(dir, 'legacy.md'),
      '---\nslug: legacy\ncreated: 2026-01-01\n---\n\n# legacy\n\n## Ruling · 2026-01-02\n\nbody\n',
    );

    const { rows } = listRows();
    expect(rows.map((row) => row.slug)).toEqual(['legacy']);
    expect(rows[0].ruling).toBe('');
  });

  // loadAxisRows is a RETRIEVAL shape: `why` is the axis's whole Context. The INDEX writers clamp it
  // through whyHook, so rendering the rows raw would blow the spine open on every row.
  it('clamps the why cell to a hook, as the INDEX writers do', () => {
    writeFileSync(join(dir, 'alpha.md'), axisFile('alpha', { context: 'x'.repeat(200) }));

    const why = listRows().rows[0].why;
    expect(why.length).toBeLessThanOrEqual(70);
    expect(why.endsWith('…')).toBe(true);
  });

  // retrieval's `updated` is the last date anywhere in the body; INDEX records the Target's own.
  it('dates a row by its Target, not by a later note', () => {
    writeFileSync(
      join(dir, 'alpha.md'),
      axisFile('alpha', { note: '- 2026-06-01 — later convergence note', target: '2026-01-01' }),
    );

    expect(listRows().rows[0].updated).toBe('2026-01-01');
  });

  // The other branch of that narrowing: liveRulingId is `entry:<date>`, not `target:<date>`.
  it('dates a legacy dated-heading row by its entry, not by a later note', () => {
    writeFileSync(
      join(dir, 'legacy-dated.md'),
      '---\nslug: legacy-dated\ncreated: 2026-01-01\n---\n\n# legacy-dated\n\n' +
        '## 2026-01-02 — legacy entry\n\n**Ruling:** the legacy ruling\n\n' +
        '- 2026-08-08 — a much later note\n',
    );

    const { rows } = listRows();
    expect(rows[0].ruling).toBe('the legacy ruling');
    expect(rows[0].updated).toBe('2026-01-02');
  });

  // Cells used to be sanitized at WRITE time inside `add`; arbitrary file prose reaches the table
  // now, and a leaked pipe shifts every following cell — one axis's why becomes another's updated.
  it('survives a ruling and context carrying table-breaking characters', () => {
    writeFileSync(
      join(dir, 'piped.md'),
      axisFile('piped', { context: 'cells | with pipes' }).replace(
        '**Ruling:** piped-ruling',
        '**Ruling:** choose A | not B | and never C',
      ),
    );

    const { rows, stdout } = listRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe('piped');
    expect(rows[0].ruling).toBe('choose A not B and never C');
    expect(rows[0].why).toBe('cells with pipes');
    // Four cells means four separators — a leaked pipe would silently make it five.
    const row = stdout.split('\n').find((line) => line.startsWith('| [piped]'));
    expect(row?.match(/\|/g)).toHaveLength(5);
  });

  // A half-created axis (touched, never written) must not take the whole command down with it — one
  // unparseable file among many would otherwise turn a working log into a stack trace.
  it('renders an empty axis file as a blank row instead of throwing', () => {
    writeFileSync(join(dir, 'empty.md'), '');
    writeFileSync(join(dir, 'alpha.md'), axisFile('alpha'));

    const { rows } = listRows();
    expect(rows.map((row) => row.slug)).toEqual(['alpha', 'empty']);
    expect(rows[1]).toMatchObject({ ruling: '', updated: '', why: '' });
  });
});

// `list` parses markdown now, so sc-2692's outage contract is load-bearing here: "could not run"
// and "nothing is decided" are the exact pair sc-2332 was filed about.
describe('guard-decisions list under a broken bundle', () => {
  it('names the outage and never claims the log is empty', () => {
    writeFileSync(join(dir, 'alpha.md'), axisFile('alpha'));
    const r = runWithoutParser(['list']);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('decision engine UNAVAILABLE');
    expect(r.stdout).not.toContain('No decisions recorded.');
  });
});
