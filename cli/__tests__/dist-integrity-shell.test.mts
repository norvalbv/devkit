/**
 * The shell half of the dist-integrity walk: `source` and `exec bash` edges between shipped .sh.
 * Split from dist-integrity.test.mts for cohesion, as dist-integrity-resume.test.mts is. sc-2522.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectDistIntegrity, shellSourceEdges } from '../lib/ship/dist-integrity.mts';
import { rootRegistry } from './_helpers.mts';

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const SCRIPT_DIR = 'SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)';
const CLEAN = { active: true, unresolved: [], unbriefed: [], untracked: [], unlexable: [] };
const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  }).trim();
}

function write(root: string, file: string, body: string): void {
  mkdirSync(join(root, dirname(file)), { recursive: true });
  writeFileSync(join(root, file), body);
}

/** A devkit-shaped repo whose base commit already carries one tracked dist artifact. */
function repo() {
  const root = mkTmp('dist-integrity-shell-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'a@b.c');
  git(root, 'config', 'user.name', 'a');
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: '@norvalbv/devkit' })}\n`);
  writeFileSync(join(root, '.gitignore'), 'dist/\n');
  write(root, 'dist/index.mjs', 'export const ready = true;\n');
  git(root, 'add', 'package.json', '.gitignore');
  git(root, 'add', '-f', 'dist/index.mjs');
  git(root, 'commit', '-q', '-m', 'base');
  return { base: git(root, 'rev-parse', 'HEAD'), root };
}

/** `a.sh` sources a sibling; both exist on disk, only `a.sh`'s dist copy is tracked. */
function sourcingPair(directive = '. "$SCRIPT_DIR/b.sh"') {
  const { base, root } = repo();
  const caller = `${SCRIPT_DIR}\n${directive}\n`;
  for (const dir of ['cli/lib/ship', 'dist/cli/lib/ship']) {
    write(root, `${dir}/a.sh`, caller);
    write(root, `${dir}/b.sh`, 'echo b\n');
  }
  git(root, 'add', 'cli/lib/ship/a.sh', 'cli/lib/ship/b.sh');
  git(root, 'add', '-f', 'dist/cli/lib/ship/a.sh');
  git(root, 'commit', '-q', '-m', 'work');
  return { base, root };
}

describe('shellSourceEdges', () => {
  const edges = (body: string, importer = 'dist/cli/lib/ship/a.sh') =>
    shellSourceEdges(importer, body);

  it('resolves the three script-dir spellings the shipped scripts use', async () => {
    const body = [
      SCRIPT_DIR,
      '_LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)',
      '. "$SCRIPT_DIR/sibling.sh"',
      '. "$(dirname "${BASH_SOURCE[0]}")/inline.sh"',
      '. "$_LIB_DIR/../parent.sh"',
    ].join('\n');

    expect((await edges(body))?.map((edge) => edge.target)).toEqual([
      'dist/cli/lib/ship/sibling.sh',
      'dist/cli/lib/ship/inline.sh',
      'dist/cli/lib/parent.sh',
    ]);
  });

  it('reads command position past an assignment prefix', async () => {
    // Both real `exec bash` dispatches carry one, so a rule keyed on words[0] matches NEITHER.
    const body = `${SCRIPT_DIR}\nDEVKIT_SHIP_RESUME_DISPATCHED=1 exec bash "$SCRIPT_DIR/reship.sh" --resume "$BR"\n`;

    expect((await edges(body))?.map((edge) => edge.target)).toEqual([
      'dist/cli/lib/ship/reship.sh',
    ]);
  });

  it('keeps the raw operand as the specifier so a report line greps back to source', async () => {
    expect(await edges(`${SCRIPT_DIR}\n. "$SCRIPT_DIR/b.sh"\n`)).toEqual([
      {
        importer: 'dist/cli/lib/ship/a.sh',
        specifier: '"$SCRIPT_DIR/b.sh"',
        target: 'dist/cli/lib/ship/b.sh',
      },
    ]);
  });

  it('reads the $0 script-dir idiom the agent hooks use', async () => {
    const body = 'HOOK_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd)\nsource "$HOOK_DIR/lib.sh"\n';

    expect((await edges(body, 'dist/agents-hooks/check.sh'))?.map((edge) => edge.target)).toEqual([
      'dist/agents-hooks/lib.sh',
    ]);
  });

  it('ignores words that only look like directives', async () => {
    const body = [
      SCRIPT_DIR,
      '  local worktree source manifest status',
      '  node "$SETUP_RUNTIME_TOOL" source "$SETUP_MANIFEST" "$TARGET_ROOT"',
      "case $p in '' | . | ..) return 1 ;; esac",
      'if [ "$TARGET_RELATIVE" = . ]; then :; fi',
      '# . "$SCRIPT_DIR/commented.sh"',
    ].join('\n');

    expect(await edges(body)).toEqual([]);
  });

  it('ignores a system path, which is a real dependency but never a dist artifact', async () => {
    expect(await edges('. /etc/os-release\n. "$HOME/.devkit-env"\n')).toEqual([]);
  });

  it('refuses to guess a target behind an expansion it cannot prove is the script dir', async () => {
    // Resolving `$ROOT` as the script's own directory would invent a path and vouch for it.
    expect(await edges(`${SCRIPT_DIR}\n. "$ROOT/cli/lib/ship/b.sh"\n`)).toBeUndefined();
  });

  it('reads a script checked out with CRLF endings', async () => {
    // The preflight reads DISK, so an autocrlf checkout feeds it \r-terminated lines. JS regex
    // `.` excludes \r, so forgetting it turns every directive in the file into a blocking hole.
    const body = `${SCRIPT_DIR}\r\n. "$SCRIPT_DIR/b.sh"\r\n`;

    expect((await edges(body))?.map((edge) => edge.target)).toEqual(['dist/cli/lib/ship/b.sh']);
  });

  it('reads the braced ${VAR} spelling', async () => {
    expect((await edges(`${SCRIPT_DIR}\n. "\${SCRIPT_DIR}/b.sh"\n`))?.map((e) => e.target)).toEqual(
      ['dist/cli/lib/ship/b.sh'],
    );
  });

  it('reads a script-dir assignment split over a line continuation', async () => {
    const body =
      'SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" \\\n  && pwd)\n. "$SCRIPT_DIR/b.sh"\n';

    expect((await edges(body))?.map((edge) => edge.target)).toEqual(['dist/cli/lib/ship/b.sh']);
  });

  it('reads both directives when two share one line, and past a trailing comment', async () => {
    const body = `${SCRIPT_DIR}\n\t. "$SCRIPT_DIR/b.sh"; . "$SCRIPT_DIR/c.sh"  # load helpers\n`;

    expect((await edges(body))?.map((edge) => edge.target)).toEqual([
      'dist/cli/lib/ship/b.sh',
      'dist/cli/lib/ship/c.sh',
    ]);
  });

  it('reads a directive carrying arguments over a continuation', async () => {
    const body = `${SCRIPT_DIR}\n. "$SCRIPT_DIR/b.sh" \\\n  --flag\n`;

    expect((await edges(body))?.map((edge) => edge.target)).toEqual(['dist/cli/lib/ship/b.sh']);
  });

  it('finds the script behind bash options that still run one', async () => {
    // `-x` and `--noprofile` do not consume the path. Dropping the edge on ANY leading flag let an
    // omitted dist script through the walk entirely — the bypass both reviewers named.
    const body = [
      SCRIPT_DIR,
      'exec bash -x "$SCRIPT_DIR/b.sh"',
      'exec bash --noprofile "$SCRIPT_DIR/c.sh"',
      'exec bash -- "$SCRIPT_DIR/d.sh"',
    ].join('\n');

    expect((await edges(body))?.map((edge) => edge.target)).toEqual([
      'dist/cli/lib/ship/b.sh',
      'dist/cli/lib/ship/c.sh',
      'dist/cli/lib/ship/d.sh',
    ]);
  });

  it('blocks on a bash option it cannot classify rather than skipping the dispatch', async () => {
    expect(
      await edges(`${SCRIPT_DIR}\nexec bash --made-up-flag "$SCRIPT_DIR/b.sh"\n`),
    ).toBeUndefined();
  });

  it('reads a directive inside a compound command', async () => {
    // `if`/`then` head commandWords otherwise, so the sourced sibling is never demanded.
    const body = [
      SCRIPT_DIR,
      'if . "$SCRIPT_DIR/b.sh"; then :; fi',
      'if test -f x; then . "$SCRIPT_DIR/c.sh"; fi',
      'while read -r l; do . "$SCRIPT_DIR/d.sh"; done',
      '! . "$SCRIPT_DIR/e.sh"',
    ].join('\n');

    expect((await edges(body))?.map((edge) => edge.target)).toEqual([
      'dist/cli/lib/ship/b.sh',
      'dist/cli/lib/ship/c.sh',
      'dist/cli/lib/ship/d.sh',
      'dist/cli/lib/ship/e.sh',
    ]);
  });

  it('reads a directive behind a case arm or a function head', async () => {
    // `fast)` and `load()` are structure, not commands. Left in place they head commandWords and
    // the sourced sibling is never demanded.
    const body = [
      SCRIPT_DIR,
      'case $x in fast) . "$SCRIPT_DIR/b.sh" ;; esac',
      'case $x in a|b) . "$SCRIPT_DIR/c.sh" ;; esac',
      'load() { . "$SCRIPT_DIR/d.sh"; }',
      'time . "$SCRIPT_DIR/e.sh"',
    ].join('\n');

    expect((await edges(body))?.map((edge) => edge.target)).toEqual([
      'dist/cli/lib/ship/b.sh',
      'dist/cli/lib/ship/c.sh',
      'dist/cli/lib/ship/d.sh',
      'dist/cli/lib/ship/e.sh',
    ]);
  });

  it('reads a directive behind any command-position prefix', async () => {
    // Prefixes are open-ended, so command position is judged from the PRECEDING word. Anchoring on
    // the head of the statement missed a new shape every review round.
    const body = [
      SCRIPT_DIR,
      'case $x in fast | safe) . "$SCRIPT_DIR/b.sh" ;; esac',
      'command source "$SCRIPT_DIR/c.sh"',
      'builtin . "$SCRIPT_DIR/d.sh"',
      'cat x | source "$SCRIPT_DIR/e.sh"',
    ].join('\n');

    expect((await edges(body))?.map((edge) => edge.target)).toEqual([
      'dist/cli/lib/ship/b.sh',
      'dist/cli/lib/ship/c.sh',
      'dist/cli/lib/ship/d.sh',
      'dist/cli/lib/ship/e.sh',
    ]);
  });

  it('reads a directive nested in a command substitution', async () => {
    const body = `${SCRIPT_DIR}\nout=$(. "$SCRIPT_DIR/b.sh" && echo ok)\n`;

    expect((await edges(body))?.map((edge) => edge.target)).toEqual(['dist/cli/lib/ship/b.sh']);
  });

  it('reads past a quoted paren inside a command substitution', async () => {
    // An unquoted-paren scan closes the substitution early and never sees the directive after it.
    const body = `${SCRIPT_DIR}\nout=$(printf ')'; . "$SCRIPT_DIR/b.sh")\n`;

    expect((await edges(body))?.map((edge) => edge.target)).toEqual(['dist/cli/lib/ship/b.sh']);
  });

  it('reads a directive guarded by an AND-OR list', async () => {
    // `commandWords` heads these with `[` and `true`, so a whole-statement read misses the edge.
    const body = [
      SCRIPT_DIR,
      '[ -f "$SCRIPT_DIR/b.sh" ] && . "$SCRIPT_DIR/b.sh"',
      'true && . "$SCRIPT_DIR/c.sh"',
      '. "$SCRIPT_DIR/d.sh" || exit 1',
    ].join('\n');

    expect((await edges(body))?.map((edge) => edge.target)).toEqual([
      'dist/cli/lib/ship/b.sh',
      'dist/cli/lib/ship/c.sh',
      'dist/cli/lib/ship/d.sh',
    ]);
  });

  it('claims no file for an inline exec bash -c command that sources nothing', async () => {
    expect(await edges(`${SCRIPT_DIR}\nexec bash -c 'echo hi'\n`)).toEqual([]);
  });

  it('blocks on a directive inside an inline exec bash -c script', async () => {
    // The child shell sees neither this script's unexported $SCRIPT_DIR nor its own; skipping the
    // string entirely would let an omitted sibling pass, so the honest verdict is unverified.
    const body = `${SCRIPT_DIR}\nexec bash -c '. "$SCRIPT_DIR/b.sh"'\n`;

    expect(await edges(body)).toBeUndefined();
  });

  it('refuses a variable a bash -c child assigned, which cannot vouch for its parent', async () => {
    const body = 'bash -c \'D=$(cd "$(dirname "$0")" && pwd)\'\n. "$D/b.sh"\n';

    expect(await edges(body)).toBeUndefined();
  });

  it('reads a reassigned external-root name as the script dir it was given', async () => {
    // Provenance before the $HOME/$TMPDIR allowlist: this HOME IS the script's own directory.
    const body = 'HOME=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)\n. "$HOME/b.sh"\n';

    expect((await edges(body))?.map((edge) => edge.target)).toEqual(['dist/cli/lib/ship/b.sh']);
  });

  it('refuses a reassigned external-root name rather than waving it through', async () => {
    // `$HOME` is only an external root while this script leaves it alone.
    const body = `${SCRIPT_DIR}\nHOME="$SCRIPT_DIR"\n. "$HOME/b.sh"\n`;

    expect(await edges(body)).toBeUndefined();
  });

  it('reads a dispatch behind an exec or env wrapper', async () => {
    // Wrappers sit in front of the command, so a rule anchored on `exec bash` misses both of these.
    const body = [
      SCRIPT_DIR,
      'exec -a shipper bash "$SCRIPT_DIR/b.sh"',
      'env FOO=1 bash "$SCRIPT_DIR/c.sh"',
    ].join('\n');

    expect((await edges(body))?.map((edge) => edge.target)).toEqual([
      'dist/cli/lib/ship/b.sh',
      'dist/cli/lib/ship/c.sh',
    ]);
  });

  it('refuses a variable a builtin rewrote without an assignment', async () => {
    // `printf -v` writes SCRIPT_DIR with no Assignment node, so trust has to be withdrawn.
    const body = `${SCRIPT_DIR}\nprintf -v SCRIPT_DIR '%s' "$SCRIPT_DIR/sub"\n. "$SCRIPT_DIR/b.sh"\n`;

    expect(await edges(body)).toBeUndefined();
  });

  it('blocks on env -S, whose argument is a command line it cannot see into', async () => {
    expect(await edges(`${SCRIPT_DIR}\nenv -S 'bash "$SCRIPT_DIR/b.sh"'\n`)).toBeUndefined();
  });

  it('claims no file for a bundled bash -lc inline command', async () => {
    // `-lc` carries `-c`, so the next word is a SCRIPT; reading it as a path falsely blocks.
    expect(await edges(`${SCRIPT_DIR}\nbash -lc 'echo hi'\n`)).toEqual([]);
  });

  it('refuses a script-dir assignment that only runs inside a branch', async () => {
    // A nested assignment may never execute, so it cannot certify a directive that always does.
    const body = 'if x; then DIR=$(cd "$(dirname "$0")" && pwd); fi\n. "$DIR/b.sh"\n';

    expect(await edges(body)).toBeUndefined();
  });

  it('refuses a variable whose nearest preceding assignment is not the script dir', async () => {
    // Reassignment invalidates: at the directive, $SCRIPT_DIR is /tmp, not this script's folder.
    const body = `${SCRIPT_DIR}\nSCRIPT_DIR=/tmp\n. "$SCRIPT_DIR/b.sh"\n`;

    expect(await edges(body)).toBeUndefined();
  });

  it('refuses an assignment that only resembles the script-dir idiom', async () => {
    // `cd … && printf .; : pwd` mentions pwd without running it: DIR is `.`, not the script's dir,
    // so certifying it would resolve a cwd-relative dependency as an importer sibling.
    const body = 'DIR=$(cd "$(dirname "$0")" && printf .; : pwd)\n. "$DIR/b.sh"\n';

    expect(await edges(body)).toBeUndefined();
  });

  it('reads a bash dispatch that carries no exec', async () => {
    const body = `${SCRIPT_DIR}\nbash "$SCRIPT_DIR/b.sh" --flag\n`;

    expect((await edges(body))?.map((edge) => edge.target)).toEqual(['dist/cli/lib/ship/b.sh']);
  });

  it('refuses a variable assigned only AFTER the directive that uses it', async () => {
    // A later assignment cannot vouch for an earlier `source`; approving it would be fail-open.
    const body = `. "$SCRIPT_DIR/b.sh"\n${SCRIPT_DIR}\n`;

    expect(await edges(body)).toBeUndefined();
  });

  it('does not expand a single-quoted operand, which bash would not expand either', async () => {
    // `. '$SCRIPT_DIR/b.sh'` sources a path LITERALLY named $SCRIPT_DIR/b.sh. Resolving it as if
    // it were expanded invents a requirement on a file the script never asks for.
    expect(await edges(`${SCRIPT_DIR}\n. '$SCRIPT_DIR/b.sh'\n`)).toBeUndefined();
  });

  it('names a target that climbs out of the packaged dist tree', async () => {
    // dist/ IS the published package, so a target above it ENOENTs in every consumer install.
    // Named as an edge rather than swallowed — the verdict an .mjs import above dist already gets.
    expect(await edges(`${SCRIPT_DIR}\n. "$SCRIPT_DIR/../../../../outside.sh"\n`)).toEqual([
      {
        importer: 'dist/cli/lib/ship/a.sh',
        specifier: '"$SCRIPT_DIR/../../../../outside.sh"',
        target: 'outside.sh',
      },
    ]);
  });

  it('blocks the quote-then-literal spelling rather than guessing at it', async () => {
    // Valid bash that no shipped script uses. Supporting it needs the quote-segment parsing that
    // wrongly strips the inner quotes of the $(dirname …) idiom, so fail closed instead.
    expect(await edges(`${SCRIPT_DIR}\n. "$SCRIPT_DIR"/b.sh\n`)).toBeUndefined();
  });

  it('finds nothing to read in an empty or operand-less script', async () => {
    expect(await edges('')).toEqual([]);
    expect(await edges(`${SCRIPT_DIR}\n.\nsource\nVAR=1 OTHER=2\n`)).toEqual([]);
  });
});

describe('inspectDistIntegrity over shell edges', () => {
  it('blocks on a sibling this ship never mentions', async () => {
    const { base, root } = sourcingPair();

    const report = await inspectDistIntegrity(root, base, [
      'cli/lib/ship/a.sh',
      'dist/cli/lib/ship/a.sh',
    ]);

    // Only the shell walk discovers this: b.sh reaches `required` through no other route.
    expect(report.unresolved).toEqual([
      {
        importer: 'dist/cli/lib/ship/a.sh',
        specifier: '"$SCRIPT_DIR/b.sh"',
        target: 'dist/cli/lib/ship/b.sh',
      },
    ]);
    // Discovery also puts it in `required`, and it is on disk, so it lands in `untracked` too and
    // the remedy line offers the right `git add -f`. One problem, two buckets — as .mjs does.
    expect(report.untracked).toEqual(['dist/cli/lib/ship/b.sh']);
  });

  it('blocks on an omitted dist copy through the pre-existing path, not the shell walk', async () => {
    const { base, root } = sourcingPair();

    const report = await inspectDistIntegrity(root, base, [
      'cli/lib/ship/a.sh',
      'dist/cli/lib/ship/a.sh',
      'cli/lib/ship/b.sh',
    ]);

    // Briefing b.sh's SOURCE makes generatedPath map dist/.../b.sh into `required` on its own, so
    // this case already blocked before sc-2522. Kept to pin that the walk did not regress it.
    expect(report.untracked).toEqual(['dist/cli/lib/ship/b.sh']);
  });

  it('passes once the sourced sibling ships with its caller', async () => {
    const { base, root } = sourcingPair();

    const report = await inspectDistIntegrity(root, base, [
      'cli/lib/ship/a.sh',
      'dist/cli/lib/ship/a.sh',
      'cli/lib/ship/b.sh',
      'dist/cli/lib/ship/b.sh',
    ]);

    expect(report).toEqual(CLEAN);
  });

  it('follows an exec bash dispatch behind its assignment prefix', async () => {
    const { base, root } = sourcingPair(
      'DEVKIT_SHIP_RESUME_DISPATCHED=1 exec bash "$SCRIPT_DIR/b.sh" --resume',
    );

    const report = await inspectDistIntegrity(root, base, [
      'cli/lib/ship/a.sh',
      'dist/cli/lib/ship/a.sh',
    ]);

    expect(report.unresolved.map((edge) => edge.target)).toEqual(['dist/cli/lib/ship/b.sh']);
  });

  it('walks a shell chain past its first hop', async () => {
    const { base, root } = sourcingPair();
    // b.sh is briefed and shipping, so the walk must continue THROUGH it to reach c.sh.
    for (const dir of ['cli/lib/ship', 'dist/cli/lib/ship']) {
      write(root, `${dir}/b.sh`, `${SCRIPT_DIR}\n. "$SCRIPT_DIR/c.sh"\n`);
      write(root, `${dir}/c.sh`, 'echo c\n');
    }

    const report = await inspectDistIntegrity(root, base, [
      'cli/lib/ship/a.sh',
      'dist/cli/lib/ship/a.sh',
      'dist/cli/lib/ship/b.sh',
    ]);

    expect(report.unresolved.map((edge) => edge.target)).toEqual(['dist/cli/lib/ship/c.sh']);
  });

  it('reports a target absent from disk as unresolved only', async () => {
    const { base, root } = sourcingPair('. "$SCRIPT_DIR/never-built.sh"');

    const report = await inspectDistIntegrity(root, base, [
      'cli/lib/ship/a.sh',
      'dist/cli/lib/ship/a.sh',
    ]);

    // `untracked` filters the PHYSICAL tree, so a file the build never emitted cannot appear there.
    expect(report.unresolved.map((edge) => edge.target)).toEqual([
      'dist/cli/lib/ship/never-built.sh',
    ]);
    expect(report.untracked).toEqual([]);
  });

  it('does not walk a script whose deletion this ship stages', async () => {
    const { root } = repo();
    for (const dir of ['cli/lib/ship', 'dist/cli/lib/ship']) {
      write(root, `${dir}/a.sh`, `${SCRIPT_DIR}\n. "$SCRIPT_DIR/b.sh"\n`);
      write(root, `${dir}/b.sh`, 'echo b\n');
    }
    git(root, 'add', 'cli/lib/ship/a.sh', 'cli/lib/ship/b.sh');
    git(root, 'add', '-f', 'dist/cli/lib/ship/a.sh');
    git(root, 'commit', '-q', '-m', 'a.sh exists');
    const base = git(root, 'rev-parse', 'HEAD');
    // a.sh is leaving. Its own source edges leave with it, so b.sh is not a candidate to add back
    // — the same carve-out `deleted` already gives an .mjs importer.
    git(root, 'rm', '-q', '--cached', 'dist/cli/lib/ship/a.sh');

    const report = await inspectDistIntegrity(root, base, [
      'cli/lib/ship/a.sh',
      'dist/cli/lib/ship/a.sh',
    ]);

    expect(report.unresolved).toEqual([]);
    expect(report.untracked).toEqual(['dist/cli/lib/ship/a.sh']);
  });

  it('reports a newly tracked script this ship forgot to brief', async () => {
    const { base, root } = sourcingPair();
    // b.sh's dist copy was force-added after `base`, so it is new to the index — but the brief
    // never names it, which is the bucket that catches a half-updated ship path.
    git(root, 'add', '-f', 'dist/cli/lib/ship/b.sh');

    const report = await inspectDistIntegrity(root, base, [
      'cli/lib/ship/a.sh',
      'dist/cli/lib/ship/a.sh',
    ]);

    expect(report.unbriefed).toEqual(['dist/cli/lib/ship/b.sh']);
  });

  it('blocks a shipped script whose source target it cannot resolve', async () => {
    const { base, root } = sourcingPair('. "$ROOT/cli/lib/ship/b.sh"');

    const report = await inspectDistIntegrity(root, base, [
      'cli/lib/ship/a.sh',
      'dist/cli/lib/ship/a.sh',
    ]);

    expect(report.unlexable).toEqual(['dist/cli/lib/ship/a.sh']);
  });
});
