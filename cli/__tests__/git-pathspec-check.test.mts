import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectShellArrays, main, scanShell, scanTs } from '../../scripts/git-pathspec-check.mts';
import { rootRegistry } from './_helpers.mts';

const ASSERT_STAGED_SET = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'lib',
  'ship',
  'assert-staged-set.sh',
);
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'git-pathspec-check.mts',
);
const { mkTmp, cleanup } = rootRegistry();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A git repo whose tracked files are `files`; `untracked` are written but never added. */
function repo(files: Record<string, string>, untracked: Record<string, string> = {}): string {
  const dir = mkTmp('pathspec-repo-');
  spawnSync('git', ['init', '-q'], { cwd: dir });
  for (const [name, body] of Object.entries({ ...files, ...untracked })) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  spawnSync('git', ['add', '--', ...Object.keys(files).map((f) => `:(literal)${f}`)], { cwd: dir });
  return dir;
}

const shell = (text: string, others: string[] = []) =>
  scanShell(text, 'x.sh', collectShellArrays([text, ...others])).map((h) => `${h.line} ${h.kind}`);

const noImports = () => undefined;
const tsHits = (text: string, load: (path: string) => string | undefined = noImports) =>
  scanTs(text, '/repo/x.mts', load).map((h) => `${h.line} ${h.kind} ${h.arg}`);

describe('scanShell', () => {
  it('flags a raw variable after -- on a pathspec subcommand, including inside $(…)', () => {
    expect(shell('git status --porcelain -- "$path"')).toEqual(['1 raw']);
    expect(shell('s=$(git -C "$wt" diff --cached -- "$f")')).toEqual(['1 raw']);
  });

  it('exempts literal and magic arguments, constants and plain-path subcommands', () => {
    expect(shell('git add -- ":(top,literal)$f"')).toEqual([]);
    expect(shell('git ls-files -- ":(top,glob)**/$b"')).toEqual([]);
    expect(shell('git diff -- docs/x.md')).toEqual([]);
    expect(
      shell('git hash-object -w -- "$p"; git ls-tree HEAD -- "$p"; git check-ignore -q -- "$p"'),
    ).toEqual([]);
  });

  it('exempts a call whose literal env sits on the continuation line above', () => {
    expect(
      shell('GIT_INDEX_FILE="$i" GIT_LITERAL_PATHSPECS=1 \\\n  git reset -q "$h" -- "${paths[@]}"'),
    ).toEqual([]);
    expect(shell('git --literal-pathspecs diff -- "$f"')).toEqual([]);
  });

  it('flags a literal-mode call that also passes :(literal)', () => {
    expect(shell('git --literal-pathspecs diff -- ":(literal)$f"')).toEqual(['1 mixed']);
  });

  it('resolves an array literal-built in another file, including += appends and the +"…" idiom', () => {
    const builder =
      'GIT_PATHS=()\nfor p in "${PATHS[@]}"; do GIT_PATHS+=(":(top,literal)$p"); done';
    expect(shell('git diff -- "${GIT_PATHS[@]}"', [builder])).toEqual([]);
    expect(shell('git diff -- ${GIT_PATHS[@]+"${GIT_PATHS[@]}"}', [builder])).toEqual([]);
  });

  it('flags an array with any raw assignment, or one only a builtin populates', () => {
    expect(shell('X+=(":(literal)$a")\nX+=("$b")\ngit add -- "${X[@]}"')).toEqual(['3 raw']);
    expect(shell('f() { local -a X=("$p"); git status -- "${X[@]}"; }')).toEqual(['1 raw']);
    expect(shell('read -ra X <<< "$l"\ngit status -- "${X[@]}"')).toEqual(['2 raw']);
    expect(shell('git status -- "${Unknown[@]}"')).toEqual(['1 raw']);
  });

  it('honours a pathspec marker with a reason, on the line or the line above', () => {
    expect(shell('git diff -- "$@" # pathspec: callers pass literal paths')).toEqual([]);
    expect(shell('# pathspec: callers pass literal paths\ngit diff -- "$@"')).toEqual([]);
    expect(shell('git diff -- "$@" # pathspec:')).toEqual(['1 raw']);
  });

  it('does not let a marker trailing one call exempt the call on the next line', () => {
    expect(
      shell('git diff -- "$@" # pathspec: callers pass literal paths\ngit add -- "$f"'),
    ).toEqual(['2 raw']);
  });

  it('flags a variable behind magic that is neither literal nor glob, since it still globs', () => {
    expect(shell('git add -- ":(top)$f"')).toEqual(['1 raw']);
    expect(shell('git diff -- ":(exclude)$f"')).toEqual(['1 raw']);
    expect(shell('git diff -- ":(top,exclude,literal)$f"')).toEqual([]);
    expect(shell('git --literal-pathspecs diff -- ":(top)$f"')).toEqual(['1 mixed']);
  });
});

describe('scanTs', () => {
  it('flags a raw identifier passed to a spawned git or a git wrapper', () => {
    expect(tsHits("spawnSync('git', ['add', '--', rel], { cwd });")).toEqual(['1 raw rel']);
    expect(tsHits("gitWrite(root, ['-C', root, 'diff', '--cached', '--', ...files]);")).toEqual([
      '1 raw ...files',
    ]);
  });

  it('ignores non-git argv and plain-path subcommands', () => {
    expect(tsHits("spawnSync('devkit', ['ship', '--', ...paths]);")).toEqual([]);
    expect(tsHits("execFileSync('git', ['hash-object', '--', p]);")).toEqual([]);
  });

  it('resolves same-file constants, literal() helpers and .map() chains', () => {
    const text = [
      "const PATHS = ['cli/lib/ship', 'x.mts'] as const;",
      'const literal = (f: string) => `:(top,literal)${f}`;',
      'function run(files: string[]) {',
      '  const pathspecs = files.map((f) => `:(literal)${f}`);',
      "  git(cwd, ['diff', '--', ...PATHS]);",
      "  git(cwd, ['diff', '--', ...pathspecs]);",
      "  git(cwd, ['diff', '--', literal(files[0]), ...files.filter(Boolean).map(literal)]);",
      '}',
    ].join('\n');
    expect(tsHits(text)).toEqual([]);
  });

  it('treats a wrapper that passes --literal-pathspecs as literal mode, same file or imported', () => {
    const wrapper =
      "export function git(root: string, args: string[]) { return spawnSync('git', ['--literal-pathspecs', ...args]); }";
    expect(tsHits(`${wrapper}\ngit(root, ['log', '--', path]);`)).toEqual([]);
    expect(tsHits(`${wrapper}\ngit(root, ['log', '--', \`:(literal)\${path}\`]);`)).toEqual([
      '2 mixed `:(literal)${path}`',
    ]);
    const imported = "import { git } from './provenance.mts';\ngit(top, ['diff', '--', ...spec]);";
    const load = (path: string) => (path === '/repo/provenance.mts' ? wrapper : undefined);
    expect(tsHits(imported, load)).toEqual([]);
    expect(tsHits(imported)).toEqual(['2 raw ...spec']);
  });

  it('honours a pathspec marker on the line above', () => {
    expect(
      tsHits("// pathspec: devkit-owned baseline path\nspawnSync('git', ['add', '--', rel]);"),
    ).toEqual([]);
  });

  it('does not let a trailing marker exempt the next line, nor a non-literal template prefix', () => {
    expect(
      tsHits(
        "spawnSync('git', ['add', '--', a]); // pathspec: fixed name\nspawnSync('git', ['add', '--', b]);",
      ),
    ).toEqual(['2 raw b']);
    expect(tsHits("spawnSync('git', ['add', '--', `:(top)${f}`]);")).toEqual([
      '1 raw `:(top)${f}`',
    ]);
  });

  it('does not see argv pushed after construction (known limit)', () => {
    expect(
      tsHits("const args = ['diff'];\nargs.push('--', file);\nspawnSync('git', args);"),
    ).toEqual([]);
  });
});

describe('main', () => {
  it('scans tracked roots only, resolves arrays across files and skips __tests__', () => {
    const dir = repo(
      {
        'cli/build.sh': 'P=()\nfor p in "$@"; do P+=(":(literal)$p"); done\n',
        'cli/use.sh': 'git diff -- "${P[@]}"\n',
        'cli/__tests__/fixture.sh': 'git add -- "$f"\n',
        'scripts/run.mts':
          "import { spawnSync } from 'node:child_process';\nspawnSync('git', ['add', '--', f]);\n",
        'docs/outside.sh': 'git add -- "$f"\n',
      },
      { 'cli/untracked.sh': 'git add -- "$f"\n' },
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(main(dir)).toBe(1);
    const rows = errors.mock.calls
      .map(([line]) => String(line))
      .filter((l) => !l.startsWith('git-pathspec:'));
    expect(rows).toEqual(['scripts/run.mts:2  raw pathspec  git add -- f']);
  });

  it('runs as a script from a path containing a space, so the gate cannot silently pass', () => {
    const dir = repo({ 'cli/x.sh': 'git status -- "$p"\n' });
    const spaced = join(mkTmp('pathspec-link-'), 'with space');
    mkdirSync(spaced);
    symlinkSync(dirname(SCRIPT), join(spaced, 'scripts'));
    const run = spawnSync(process.execPath, [join(spaced, 'scripts', 'git-pathspec-check.mts')], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toContain('cli/x.sh:1  raw pathspec');
  });
});

describe('a fixed site', () => {
  it('_ship_path_matches_base reads a glob-named path literally, so a dirty sibling does not leak in', () => {
    const dir = mkTmp('pathspec-');
    const git = (args: string[]) =>
      spawnSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '' },
      });
    git(['init', '-q', '-b', 'main']);
    writeFileSync(join(dir, 'a[b]'), 'glob-named\n');
    writeFileSync(join(dir, 'ab'), 'sibling\n');
    git(['add', '--', ':(literal)a[b]', 'ab']);
    git([
      '-c',
      'user.email=t@t.t',
      '-c',
      'user.name=t',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'base',
    ]);
    writeFileSync(join(dir, 'ab'), 'dirty\n');
    const probe = spawnSync(
      'bash',
      ['-c', '. "$1"; _ship_path_matches_base "$2" HEAD "a[b]"', 'probe', ASSERT_STAGED_SET, dir],
      { encoding: 'utf8' },
    );
    expect(probe.status).toBe(0);
  });
});
