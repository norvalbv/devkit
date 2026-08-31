/**
 * `guard-decisions integrity --staged` — the commit-time gate (sc-2198).
 *
 * The load-bearing case is "a finding that already exists at HEAD stays advisory even when its own
 * record is restaged". The real corpus carries one such finding permanently (overlay-self-heal's
 * 2026-07-14 re-target) and the decision log is append-only, so if that case ever blocks, devkit's
 * own repo is wedged with no in-place repair. Slug-level scoping passes every other test here and
 * fails that one — which is why it is written first.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { judgeStagedIntegrity, runStagedIntegrity } from '../integrity/staged-gate.mts';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** GUARD_DECISIONS_DIR is the documented override; restore it so one test cannot leak into others. */
function withDecisionsDir<T>(dir: string, run: () => T): T {
  const previous = process.env.GUARD_DECISIONS_DIR;
  process.env.GUARD_DECISIONS_DIR = dir;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.GUARD_DECISIONS_DIR;
    else process.env.GUARD_DECISIONS_DIR = previous;
  }
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

const target = (date: string, headline: string, evidenceChange = false) =>
  `## Target · ${date} — ${headline}\n\n` +
  '**Context:** c\n**Ruling:** r\n**Consequences:**\n- Positive: p\n' +
  (evidenceChange ? '**Evidence-change:** what changed\n' : '') +
  '**Source:** collab\n';

const record = (slug: string, created: string, blocks: string[]) =>
  `---\nslug: ${slug}\ncreated: ${created}\n---\n\n# ${slug}\n\n${blocks.join('\n')}`;

const index = (rows: Array<[string, string]>) =>
  '# Decision Index\n\n| Axis | Current ruling | Why (hook) | Updated |\n' +
  '|------|----------------|------------|---------|\n' +
  rows.map(([slug, updated]) => `| [${slug}](${slug}.md) | r | w | ${updated} |\n`).join('');

/** A repo whose HEAD carries `files`, ready for a staged edit on top. */
function seed(files: Record<string, string>, commit = true): string {
  const root = mkdtempSync(join(tmpdir(), 'devkit-integrity-staged-'));
  cleanup.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  write(root, files);
  if (commit) {
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'seed');
  }
  return root;
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, 'docs', 'decisions'), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}

/** Stages ONLY the named paths: `-A` would sweep in worktree-only edits a test set up deliberately. */
function stage(root: string, files: Record<string, string>): void {
  write(root, files);
  git(root, 'add', '--', ...Object.keys(files));
}

const D = 'docs/decisions';

describe('judgeStagedIntegrity', () => {
  it('reads nothing and passes when no decision record is staged', () => {
    const root = seed({ [`${D}/a.md`]: record('a', '2026-01-01', [target('2026-01-01', 'one')]) });
    stage(root, { 'unrelated.txt': 'hello' });
    const verdict = judgeStagedIntegrity(root);
    expect(verdict).toMatchObject({ code: 0, scoped: [], blocking: [], preexisting: [] });
  });

  it('blocks a new Target whose INDEX row was not bumped', () => {
    const root = seed({
      [`${D}/a.md`]: record('a', '2026-01-01', [target('2026-01-01', 'one')]),
      [`${D}/INDEX.md`]: index([['a', '2026-01-01']]),
    });
    stage(root, {
      [`${D}/a.md`]: record('a', '2026-01-01', [
        target('2026-01-01', 'one'),
        target('2026-02-01', 'two', true),
      ]),
    });
    const verdict = judgeStagedIntegrity(root);
    expect(verdict.code).toBe(1);
    expect(verdict.blocking.map((f) => f.check)).toContain('index-stale');
    expect(verdict.preexisting).toEqual([]);
  });

  // THE case slug-level scoping gets wrong. Without a HEAD diff this record can never be touched
  // again, because its finding predates the check and the log cannot be edited in place.
  it('keeps a finding that already exists at HEAD advisory when its record is restaged', () => {
    const withRetarget = [target('2026-01-01', 'one'), target('2026-02-01', 'two')];
    const root = seed({
      [`${D}/a.md`]: record('a', '2026-01-01', withRetarget),
      [`${D}/INDEX.md`]: index([['a', '2026-02-01']]),
    });
    stage(root, {
      [`${D}/a.md`]: `${record('a', '2026-01-01', withRetarget)}\n### Note · 2026-03-01\n\nunrelated\n`,
    });
    const verdict = judgeStagedIntegrity(root);
    expect(verdict.scoped).toEqual(['a']);
    expect(verdict.preexisting.map((f) => f.check)).toContain('retarget-missing-evidence-change');
    expect(verdict.blocking).toEqual([]);
    expect(verdict.code).toBe(0);
  });

  // The other half of that contract: keyed on (slug, check, BLOCK), so a NEW un-evidenced re-target
  // on the same axis carries a new key and is not swallowed as "already known".
  it('blocks a SECOND un-evidenced re-target on an axis that already has one', () => {
    const withRetarget = [target('2026-01-01', 'one'), target('2026-02-01', 'two')];
    const root = seed({
      [`${D}/a.md`]: record('a', '2026-01-01', withRetarget),
      [`${D}/INDEX.md`]: index([['a', '2026-02-01']]),
    });
    stage(root, {
      [`${D}/a.md`]: record('a', '2026-01-01', [...withRetarget, target('2026-03-01', 'three')]),
      [`${D}/INDEX.md`]: index([['a', '2026-03-01']]),
    });
    const verdict = judgeStagedIntegrity(root);
    expect(verdict.code).toBe(1);
    const blocked = verdict.blocking.filter((f) => f.check === 'retarget-missing-evidence-change');
    expect(blocked.map((f) => f.block)).toEqual(['2026-03-01']);
    // The older one is still reported, just not as this change's fault.
    expect(verdict.preexisting.map((f) => f.block)).toEqual(['2026-02-01']);
  });

  it('scopes a slug whose INDEX row changed even when the record itself is untouched', () => {
    const root = seed({
      [`${D}/a.md`]: record('a', '2026-01-01', [target('2026-02-01', 'one')]),
      [`${D}/INDEX.md`]: index([['a', '2026-02-01']]),
    });
    // Rolling the row BACK makes the untouched record stale — the INDEX edit is the change.
    stage(root, { [`${D}/INDEX.md`]: index([['a', '2026-01-01']]) });
    const verdict = judgeStagedIntegrity(root);
    expect(verdict.scoped).toEqual(['a']);
    expect(verdict.code).toBe(1);
    expect(verdict.blocking.map((f) => f.check)).toEqual(['index-stale']);
  });

  it('blames every finding on a brand-new record — there is no history to inherit', () => {
    const root = seed({ [`${D}/INDEX.md`]: index([]) });
    stage(root, {
      [`${D}/b.md`]: record('b', '2026-01-01', [
        target('2026-01-01', 'one'),
        target('2026-02-01', 'two'),
      ]),
    });
    const verdict = judgeStagedIntegrity(root);
    expect(verdict.code).toBe(1);
    expect(verdict.blocking.map((f) => f.check)).toContain('retarget-missing-evidence-change');
    expect(verdict.preexisting).toEqual([]);
  });

  it('scopes correctly when invoked from a subdirectory, not just the repo root', () => {
    const root = seed({
      [`${D}/a.md`]: record('a', '2026-01-01', [target('2026-01-01', 'one')]),
      [`${D}/INDEX.md`]: index([['a', '2026-01-01']]),
    });
    stage(root, {
      [`${D}/a.md`]: record('a', '2026-01-01', [
        target('2026-01-01', 'one'),
        target('2026-02-01', 'two', true),
      ]),
    });
    const verdict = judgeStagedIntegrity(join(root, 'docs', 'decisions'));
    expect(verdict.scoped).toEqual(['a']);
    expect(verdict.code).toBe(1);
  });

  // Cross-axis note ids must come from the index, not the worktree: a staged Amends pointer
  // resolved against an unstaged referent passes here and lands a dangling reference in the commit.
  it('resolves a cross-axis Amends pointer against the STAGED corpus, not the worktree', () => {
    const plain = (slug: string) => record(slug, '2026-01-01', [target('2026-01-01', 'one')]);
    const root = seed({
      [`${D}/a.md`]: plain('a'),
      [`${D}/b.md`]: plain('b'),
      [`${D}/INDEX.md`]: index([
        ['a', '2026-01-01'],
        ['b', '2026-01-01'],
      ]),
    });
    // b gains the referent note in the WORKTREE only — it is never staged.
    write(root, { [`${D}/b.md`]: `${plain('b')}\n- 2026-02-01 — referent note\n` });
    stage(root, {
      [`${D}/a.md`]: `${plain('a')}\n- 2026-03-01 — **Amends:** b#note:2026-02-01 — pointer\n`,
    });
    // Reading the worktree would resolve the pointer and pass; the index has no such note.
    const verdict = judgeStagedIntegrity(root);
    expect(verdict.blocking.map((f) => f.check)).toContain('note-amends-unresolvable');
    expect(verdict.code).toBe(1);
  });

  it('blames a dangling pointer created by REMOVING the note another axis references', () => {
    const withNote = (slug: string) =>
      `${record(slug, '2026-01-01', [target('2026-01-01', 'one')])}\n- 2026-02-01 — referent note\n`;
    const pointer = `${record('a', '2026-01-01', [target('2026-01-01', 'one')])}\n- 2026-03-01 — **Amends:** b#note:2026-02-01 — pointer\n`;
    const root = seed({
      [`${D}/a.md`]: pointer,
      [`${D}/b.md`]: withNote('b'),
      [`${D}/INDEX.md`]: index([
        ['a', '2026-01-01'],
        ['b', '2026-01-01'],
      ]),
    });
    // Drop b's note. a is unchanged, but its pointer now dangles — and it dangles only in the
    // staged tree, so a shared note map would find it at HEAD too and call it pre-existing.
    stage(root, {
      [`${D}/b.md`]: record('b', '2026-01-01', [target('2026-01-01', 'one')]),
      [`${D}/a.md`]: `${pointer}\n`,
    });
    const verdict = judgeStagedIntegrity(root);
    expect(verdict.blocking.map((f) => f.check)).toContain('note-amends-unresolvable');
    expect(verdict.code).toBe(1);
  });

  // The commit that removes a referent is the ONLY one that can catch the pointers it breaks, and
  // the axis holding them need not be part of the change.
  it('scopes an UNTOUCHED axis whose pointer this change orphaned', () => {
    const referent = `${record('b', '2026-01-01', [target('2026-01-01', 'one')])}\n- 2026-02-01 — referent note\n`;
    const pointer = `${record('a', '2026-01-01', [target('2026-01-01', 'one')])}\n- 2026-03-01 — **Amends:** b#note:2026-02-01 — pointer\n`;
    const root = seed({
      [`${D}/a.md`]: pointer,
      [`${D}/b.md`]: referent,
      [`${D}/INDEX.md`]: index([
        ['a', '2026-01-01'],
        ['b', '2026-01-01'],
      ]),
    });
    // ONLY b is staged. a is untouched, so slug scoping alone would never look at it.
    stage(root, { [`${D}/b.md`]: record('b', '2026-01-01', [target('2026-01-01', 'one')]) });
    const verdict = judgeStagedIntegrity(root);
    expect(verdict.scoped).toContain('a');
    expect(verdict.blocking.map((f) => f.check)).toContain('note-amends-unresolvable');
    expect(verdict.code).toBe(1);
  });

  // integrityFindingKey identifies a Target by DATE, so two Targets on one day share a key. Set
  // membership would call the second one pre-existing; counts do not.
  it('blocks a second same-day defective Target that shares a key with an existing one', () => {
    const one = target('2026-02-01', 'first re-target');
    const root = seed({
      [`${D}/a.md`]: record('a', '2026-01-01', [target('2026-01-01', 'origin'), one]),
      [`${D}/INDEX.md`]: index([['a', '2026-02-01']]),
    });
    stage(root, {
      [`${D}/a.md`]: record('a', '2026-01-01', [
        target('2026-01-01', 'origin'),
        one,
        target('2026-02-01', 'second re-target, same day'),
      ]),
    });
    const verdict = judgeStagedIntegrity(root);
    const retargets = verdict.blocking.filter(
      (f) => f.check === 'retarget-missing-evidence-change',
    );
    expect(retargets).toHaveLength(1);
    expect(verdict.preexisting.map((f) => f.check)).toContain('retarget-missing-evidence-change');
    expect(verdict.code).toBe(1);
  });

  // stagedSet's ACMR filter drops deletions, so scoping from it would make `git rm` of the record
  // that defines a note the one operation the gate never sees.
  it('scopes a DELETED record and the axis whose pointer it orphaned', () => {
    const referent = `${record('b', '2026-01-01', [target('2026-01-01', 'one')])}\n- 2026-02-01 — referent note\n`;
    const pointer = `${record('a', '2026-01-01', [target('2026-01-01', 'one')])}\n- 2026-03-01 — **Amends:** b#note:2026-02-01 — pointer\n`;
    const root = seed({
      [`${D}/a.md`]: pointer,
      [`${D}/b.md`]: referent,
      [`${D}/INDEX.md`]: index([
        ['a', '2026-01-01'],
        ['b', '2026-01-01'],
      ]),
    });
    git(root, 'rm', '-q', `${D}/b.md`);
    const verdict = judgeStagedIntegrity(root);
    expect(verdict.scoped).toContain('a');
    expect(verdict.blocking.map((f) => f.check)).toContain('note-amends-unresolvable');
    expect(verdict.code).toBe(1);
  });

  it('is inert — never blocking — when git cannot answer what is staged', () => {
    const root = mkdtempSync(join(tmpdir(), 'devkit-integrity-nogit-'));
    cleanup.push(root);
    mkdirSync(join(root, 'docs', 'decisions'), { recursive: true });
    const verdict = judgeStagedIntegrity(root);
    expect(verdict.code).toBe(0);
    expect(verdict.blocking).toEqual([]);
  });
});

describe('judgeStagedIntegrity — corpus layout', () => {
  // decisionsDir may legally be the repo root. A `<rel>/` prefix built from an empty relative path
  // is "/", which matches nothing — the gate would report zero findings and read as passing forever.
  it('scopes a corpus configured at the repository root', () => {
    const root = mkdtempSync(join(tmpdir(), 'devkit-integrity-rootdir-'));
    cleanup.push(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    writeFileSync(join(root, 'a.md'), record('a', '2026-01-01', [target('2026-01-01', 'one')]));
    writeFileSync(join(root, 'INDEX.md'), index([['a', '2026-01-01']]));
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'seed');
    writeFileSync(
      join(root, 'a.md'),
      record('a', '2026-01-01', [target('2026-01-01', 'one'), target('2026-02-01', 'two', true)]),
    );
    git(root, 'add', '--', 'a.md');

    const verdict = withDecisionsDir('.', () => judgeStagedIntegrity(root));
    expect(verdict.scoped).toEqual(['a']);
    expect(verdict.blocking.map((f) => f.check)).toContain('index-stale');
    expect(verdict.code).toBe(1);
  });

  // `docs/decisions/archive/old.md` is not the axis `old` — treating it as one would judge an
  // archived file against a live INDEX row and block on a finding nobody can act on.
  it('ignores a markdown file nested BELOW the decisions dir', () => {
    const root = seed({
      [`${D}/a.md`]: record('a', '2026-01-01', [target('2026-01-01', 'one')]),
      [`${D}/INDEX.md`]: index([['a', '2026-01-01']]),
    });
    mkdirSync(join(root, D, 'archive'), { recursive: true });
    const nested = `${D}/archive/a.md`;
    writeFileSync(
      join(root, nested),
      record('a', '2026-01-01', [target('2026-01-01', 'one'), target('2026-02-01', 'two')]),
    );
    git(root, 'add', '--', nested);
    const verdict = judgeStagedIntegrity(root);
    expect(verdict.scoped).toEqual([]);
    expect(verdict.code).toBe(0);
  });

  // Findings are matched by COUNT per key. Three same-day defects at HEAD and two staged means the
  // change REMOVED one — strictly an improvement, and it must not read as a new finding.
  it('does not block when a change reduces the number of same-key findings', () => {
    const defect = (n: string) => target('2026-02-01', `re-target ${n}`);
    const root = seed({
      [`${D}/a.md`]: record('a', '2026-01-01', [
        target('2026-01-01', 'origin'),
        defect('one'),
        defect('two'),
        defect('three'),
      ]),
      [`${D}/INDEX.md`]: index([['a', '2026-02-01']]),
    });
    stage(root, {
      [`${D}/a.md`]: record('a', '2026-01-01', [
        target('2026-01-01', 'origin'),
        defect('one'),
        defect('two'),
      ]),
    });
    const verdict = judgeStagedIntegrity(root);
    expect(verdict.blocking).toEqual([]);
    expect(verdict.preexisting).toHaveLength(2);
    expect(verdict.code).toBe(0);
  });
});

// `--extra` runs with failOpen2:false, so every non-zero exit blocks the commit. These pin what the
// hook actually propagates, and that an advisory finding is visibly distinguished from a blocking one.
describe('runStagedIntegrity — printed verdict and exit code', () => {
  let out: string[];
  let err: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    out = [];
    err = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      out.push(a.join(' '));
    });
    errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      err.push(a.join(' '));
    });
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    delete process.env.GUARD_DECISIONS_INTEGRITY_OK;
  });

  const cleanRepo = () =>
    seed({
      [`${D}/a.md`]: record('a', '2026-01-01', [target('2026-01-01', 'one')]),
      [`${D}/INDEX.md`]: index([['a', '2026-01-01']]),
    });

  it('exits 0 and names the record count on a clean staged change', () => {
    const root = cleanRepo();
    stage(root, {
      [`${D}/a.md`]: record('a', '2026-01-01', [
        target('2026-01-01', 'one'),
        target('2026-02-01', 'two', true),
      ]),
      [`${D}/INDEX.md`]: index([['a', '2026-02-01']]),
    });
    expect(runStagedIntegrity(root)).toBe(0);
    expect(out.join('\n')).toContain('Decision integrity passed');
  });

  it('exits 1 and prints the finding plus its bypass on stderr', () => {
    const root = cleanRepo();
    stage(root, {
      [`${D}/a.md`]: record('a', '2026-01-01', [
        target('2026-01-01', 'one'),
        target('2026-02-01', 'two', true),
      ]),
    });
    expect(runStagedIntegrity(root)).toBe(1);
    // Blocking output goes to stderr; the pass line must NOT also appear.
    expect(err.join('\n')).toContain('Decision integrity broken');
    expect(err.join('\n')).toContain('index-stale');
    expect(err.join('\n')).toContain('export GUARD_DECISIONS_INTEGRITY_OK=1');
    expect(out.join('\n')).not.toContain('Decision integrity broken');
  });

  it('exits 0 and marks a pre-existing finding as NOT this change', () => {
    const withRetarget = [target('2026-01-01', 'one'), target('2026-02-01', 'two')];
    const root = seed({
      [`${D}/a.md`]: record('a', '2026-01-01', withRetarget),
      [`${D}/INDEX.md`]: index([['a', '2026-02-01']]),
    });
    stage(root, {
      [`${D}/a.md`]: `${record('a', '2026-01-01', withRetarget)}\n- 2026-03-01 — unrelated note\n`,
    });
    expect(runStagedIntegrity(root)).toBe(0);
    expect(out.join('\n')).toContain('(not this change)');
    expect(out.join('\n')).toContain('not blocked by it');
    expect(err).toEqual([]);
  });

  it('exits 0 and announces a bypass without reading the corpus', () => {
    process.env.GUARD_DECISIONS_INTEGRITY_OK = '1';
    const root = cleanRepo();
    stage(root, {
      [`${D}/a.md`]: record('a', '2026-01-01', [
        target('2026-01-01', 'one'),
        target('2026-02-01', 'two', true),
      ]),
    });
    expect(runStagedIntegrity(root)).toBe(0);
    expect(out.join('\n')).toContain('BYPASSED');
    expect(err).toEqual([]);
  });

  it('exits 0 rather than blocking when git cannot answer', () => {
    const root = mkdtempSync(join(tmpdir(), 'devkit-integrity-nogit-run-'));
    cleanup.push(root);
    mkdirSync(join(root, 'docs', 'decisions'), { recursive: true });
    expect(runStagedIntegrity(root)).toBe(0);
    expect(err).toEqual([]);
  });
});
