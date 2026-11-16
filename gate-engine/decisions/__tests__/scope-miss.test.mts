import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { matchScope } from '../check-alignment.mts';
import {
  rescopeCommand,
  renderScopeMiss,
  scopeMiss,
  scopeMissAdvisory,
  soleRecordChange,
} from '../scope/scope-miss.mts';

const CLI = fileURLToPath(new URL('../cli.mts', import.meta.url));
const DIR = 'docs/decisions';
const AXIS = 'gate-verdict-attribution';
const GLOBS = [
  'gate-engine/review/run-review.mts',
  'gate-engine/review/runtime.mts',
  'gate-engine/judge/gate-events.mts',
  'gate-engine/judge/run-context.mts',
];
// The commit that motivated this check: a note on AXIS beside digest files its Scope never covered.
const DIGEST = ['blocking.mts', 'gate-digest.mts', 'trend.mts'].map(
  (f) => `cli/lib/ship/digest/${f}`,
);
const STAGED = [`${DIR}/${AXIS}.md`, ...DIGEST, 'cli/lib/ship/digest/trend.test.mts'];

const record = (slug: string, scope: string, notes: string[] = []) =>
  `---\nslug: ${slug}\ncreated: 2026-07-01\n---\n\n# ${slug}\n\n` +
  '## Target · 2026-07-01 — headline\n\n**Context:** c\n**Ruling:** r\n**Consequences:**\n' +
  `- Positive: p\n- Negative: n\n**Vision-fit:** n/a\n**Scope:** ${scope}\n**Source:** manual\n` +
  notes.map((n) => `- 2026-07-02 — ${n}\n`).join('');

describe('soleRecordChange', () => {
  it('picks the one record and its non-test source files', () => {
    expect(soleRecordChange(STAGED, DIR)).toEqual({
      record: `${DIR}/${AXIS}.md`,
      slug: AXIS,
      changed: STAGED.slice(1),
      files: DIGEST,
    });
  });

  it('is null for two records, INDEX.md alone, tests only, or no source', () => {
    expect(soleRecordChange([...STAGED, `${DIR}/other.md`], DIR)).toBeNull();
    expect(soleRecordChange([`${DIR}/INDEX.md`, ...DIGEST], DIR)).toBeNull();
    expect(
      soleRecordChange([`${DIR}/${AXIS}.md`, 'src/__tests__/x.mts', 'a.spec.ts'], DIR),
    ).toBeNull();
    expect(soleRecordChange([`${DIR}/${AXIS}.md`], DIR)).toBeNull();
  });

  it('does not count INDEX.md as a record or as source', () => {
    expect(soleRecordChange([...STAGED, `${DIR}/INDEX.md`], DIR)?.files).toEqual(DIGEST);
  });

  it('is null when a path would corrupt the prefilled glob list or shell argument', () => {
    expect(soleRecordChange([...STAGED, 'src/a,b.mts'], DIR)).toBeNull();
    expect(soleRecordChange([...STAGED, 'src/a"b.mts'], DIR)).toBeNull();
  });

  it('is null when a pasted command would expand a path or slug in the shell', () => {
    expect(soleRecordChange([...STAGED, 'src/$(x).mts'], DIR)).toBeNull();
    expect(soleRecordChange([...STAGED, 'src/`x`.mts'], DIR)).toBeNull();
    expect(soleRecordChange([`${DIR}/a$b.md`, ...DIGEST], DIR)).toBeNull();
    expect(soleRecordChange([`${DIR}/a;b.md`, ...DIGEST], DIR)).toBeNull();
  });

  it('is null for a path a pasted Scope would read as a glob, like a bracketed route', () => {
    expect(soleRecordChange([...STAGED, 'src/app/[id]/page.mts'], DIR)).toBeNull();
    expect(soleRecordChange([...STAGED, 'src/a?.mts'], DIR)).toBeNull();
  });

  it('treats only top-level markdown as the log when the corpus sits at the repo root', () => {
    expect(soleRecordChange(['a.md', 'src/b.mts'], '')).toEqual({
      record: 'a.md',
      slug: 'a',
      changed: ['src/b.mts'],
      files: ['src/b.mts'],
    });
  });
});

describe('scopeMiss', () => {
  const change = soleRecordChange(STAGED, DIR);
  if (!change) throw new Error('fixture must yield a change');

  it('reports a Scope that matches none of the files', () => {
    expect(scopeMiss(change, GLOBS, matchScope)).toEqual({
      slug: AXIS,
      globs: GLOBS,
      files: DIGEST,
    });
  });

  it('is silent when a glob matches, or the axis has no Scope', () => {
    expect(scopeMiss(change, [...GLOBS, 'cli/lib/ship/digest/**'], matchScope)).toBeNull();
    expect(scopeMiss(change, [], matchScope)).toBeNull();
  });

  it('is silent when an existing glob would break the pasted shell argument', () => {
    expect(scopeMiss(change, ['src/$(x)/**'], matchScope)).toBeNull();
  });

  it('is silent when the Scope covers a test file the commit changes', () => {
    expect(scopeMiss(change, ['cli/lib/ship/digest/*.test.mts'], matchScope)).toBeNull();
  });
});

describe('rendering', () => {
  it('builds a rescope that keeps the existing globs', () => {
    expect(rescopeCommand('s', ['a/**', 'b.mts'], ['c.mts'], 'why')).toBe(
      'guard-decisions rescope s --scope "a/**,b.mts,c.mts" --reason "why"',
    );
  });

  it('asks rather than asserts, and appends the exact files', () => {
    const line = renderScopeMiss({ slug: AXIS, globs: GLOBS, files: DIGEST });
    expect(line).toContain(`--scope "${[...GLOBS, ...DIGEST].join(',')}"`);
    expect(line).toContain('If it governs them:');
    expect(line).toContain('if not, ignore this.');
  });
});

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function write(root: string, files: Record<string, string>) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
}

/** A repo whose one commit carries `base`, then `staged` written and staged on top of it. */
function repo(staged: Record<string, string>, base: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'devkit-scope-miss-'));
  cleanup.push(root);
  git(root, 'init', '-q');
  write(root, { 'package.json': '{}\n', ...base });
  git(root, 'add', '.');
  git(root, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base');
  write(root, staged);
  git(root, 'add', '.');
  return root;
}

const DECISIONS_ENV_KEYS = ['GUARD_DECISIONS_DIR', 'GUARD_AI_STRICT'];

function gate(cwd: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GUARD_DECISION_NO_LLM: '1',
    DEVKIT_NO_TELEMETRY: '1',
  };
  for (const key of DECISIONS_ENV_KEYS) delete env[key];
  return spawnSync('node', [CLI, 'detect', '--gate'], { cwd, encoding: 'utf8', env });
}

describe('detect --gate prints the advisory (real git repo)', () => {
  const noteBesideCode = (prefix = '') => ({
    [`${prefix}docs/decisions/a.md`]: record('a', `${prefix}src/a/**`),
    [`${prefix}src/b.mts`]: 'export const b = 1;\n',
    [`${prefix}src/b.test.mts`]: '',
  });

  it('names the record and the uncovered file, and leaves the exit code at 0', () => {
    const r = gate(repo(noteBesideCode()));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain(
      'guard-decisions rescope a --scope "src/a/**,src/b.mts" --reason "this commit records a ruling on these files"',
    );
  });

  it('fires from a package subdirectory, where staged paths stay toplevel-relative', () => {
    const root = repo(noteBesideCode('packages/x/'));
    writeFileSync(join(root, 'packages/x/package.json'), '{}\n');
    const r = gate(join(root, 'packages/x'));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('--scope "packages/x/src/a/**,packages/x/src/b.mts"');
  });

  it('is silent once a staged rescope note covers the file', () => {
    const root = repo({
      ...noteBesideCode(),
      'docs/decisions/a.md': record('a', 'src/a/**', ['**Scope:** src/a/**,src/b.mts — moved']),
    });
    expect(gate(root).stderr).not.toContain('decision-gate: a');
  });

  it('never prefills a file the commit deletes, which would add a dead glob', () => {
    const root = repo(noteBesideCode(), { 'src/old.mts': 'export const old = 1;\n' });
    git(root, 'rm', '-q', 'src/old.mts');
    expect(gate(root).stderr).toContain('--scope "src/a/**,src/b.mts" --reason');
  });

  it('judges the staged record, not an unstaged rescope in the working tree', () => {
    const root = repo(noteBesideCode());
    write(root, { 'docs/decisions/a.md': record('a', 'src/a/**', ['**Scope:** src/** — wider']) });
    expect(gate(root).stderr).toContain('decision-gate: a');
  });

  it('reads the index `commit -a` builds, not the default index', async () => {
    const root = repo({}, noteBesideCode());
    write(root, { 'docs/decisions/a.md': record('a', 'src/a/**', ['edited']), 'src/b.mts': '' });
    const lock = join(root, '.git', 'index.lock');
    copyFileSync(join(root, '.git', 'index'), lock);
    execFileSync('git', ['add', '-A'], {
      cwd: root,
      env: { ...process.env, GIT_INDEX_FILE: lock },
    });
    Object.assign(process.env, {
      DEVKIT_COMMIT_INDEX_FILE: lock,
      DEVKIT_COMMIT_GIT_DIR: join(root, '.git'),
    });
    try {
      expect(await scopeMissAdvisory(root)).toContain('--scope "src/a/**,src/b.mts"');
    } finally {
      delete process.env.DEVKIT_COMMIT_INDEX_FILE;
      delete process.env.DEVKIT_COMMIT_GIT_DIR;
    }
    expect(await scopeMissAdvisory(root)).toBe('');
  });

  it('adds nothing to stderr in a repository with no decision log', () => {
    const r = gate(repo({ 'src/b.mts': 'export const b = 1;\n' }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/ℹ decision-gate|fatal|Error/);
  });

  it('returns nothing outside a git repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devkit-scope-miss-nogit-'));
    cleanup.push(root);
    expect(await scopeMissAdvisory(root)).toBe('');
  });
});
