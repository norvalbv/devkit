import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseIndex, renderIndex } from '../decision-format.mts';

// cli.mts (not decisions.mts) is the real `guard-decisions` bin — `categories` is dispatched there
// (see cli.mts's `run`), so this exercises the ACTUAL entrypoint a user invokes, not an internal fn.
const SCRIPT = fileURLToPath(new URL('../cli.mts', import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guard-decisions-cli-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[]) {
  return spawnSync('node', [SCRIPT, ...args], {
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
function runWithoutParser(args: string[]) {
  return spawnSync('node', ['--import', HIDE_MDAST, SCRIPT, ...args], {
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
    expect(staged.status ?? 0).toBe(0);
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
    expect(retarget.status).not.toBe(0);
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
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('names no note on this axis');
    expect(run(['integrity']).status).toBe(0);
  });

  it('refuses a Target id — a note amends a NOTE, not a ruling', () => {
    seed();
    const r = run(['add', 'my-axis', '--note', 'nope', '--supersedes', 'target:2026-07-26']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('is not a note id');
  });

  it('leaves an ordinary note untouched when no relation is declared', () => {
    seed();
    expect(run(['add', 'my-axis', '--note', 'plain convergence']).status).toBe(0);
    expect(readFileSync(join(dir, 'my-axis.md'), 'utf8')).not.toContain('**Amends:**');
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
    expect(withoutParser.status).toBe(withParser.status);
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

    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('decision engine UNAVAILABLE');
    // scoped-targets ANSWERS from the log, so it keeps the caveat. Its dispatch rewrites
    // process.argv before importing, so the command must be captured before run() to survive.
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
