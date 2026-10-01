/**
 * sc-2701: the consumer formatter is stated once (CONSUMER_FORMATTER) and RENDERED into the step and
 * scripts; the gate checks the rest (agent hooks, presets, devkit-written configs) by exact comparison.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultSelection } from '../lib/components.mts';
import {
  CONSUMER_FORMATTER,
  type ConsumerFormatter,
  FORMAT_TOOL_SETUP,
  renderAgentHookLines,
  renderToolSetup,
} from '../lib/husky/format-fragment.mts';
import {
  checkFormatterIdentity,
  currentFormatterIdentityInput,
  type FormatterIdentityInput,
  isFormatterIdentityPath,
  judgeFormatterIdentity,
  sourceChangedSince,
  sourceSplit,
  touchedIn,
  withoutComment,
} from '../lib/husky/format-identity/formatter-identity.mts';
import { parseJsonc } from '../lib/husky/format-identity/jsonc.mts';
import { buildFullHook } from '../lib/husky/husky-block.mts';
import { patchPackageJson } from '../lib/install/package-json.mts';

const REPO = join(import.meta.dirname, '..', '..');
const TREE = spawnSync('git', ['write-tree'], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
const OXFMT: ConsumerFormatter = {
  ...CONSUMER_FORMATTER,
  tool: 'oxfmt',
  configProbes: ['oxfmt.json'],
};

describe('rendered from CONSUMER_FORMATTER', () => {
  it('the step is rendered, and its bytes are the ones sc-2524 shipped (toSelfHost still matches)', () => {
    expect(FORMAT_TOOL_SETUP).toBe(renderToolSetup(CONSUMER_FORMATTER));
    expect(FORMAT_TOOL_SETUP).toBe(`    if [ ! -f biome.json ] && [ ! -f biome.jsonc ]; then
        echo "🎨 No biome config here (biome.json / biome.jsonc) — staged files left as authored."
        return 0
    fi
    FMT_TOOL=biome; FMT_BIN="$__dk_package_bin_dir/biome"
    __dk_fmt_run() { xargs -0 "$__dk_package_bin_dir/biome" format --write; }`);
    expect(buildFullHook({ ...defaultSelection(), biome: true })).toContain(FORMAT_TOOL_SETUP);
  });

  it('sc-2524 regression: changing the formatter changes the probe, banner AND binary together', () => {
    const setup = renderToolSetup(OXFMT);
    expect(setup).toContain('[ ! -f oxfmt.json ]');
    expect(setup).toContain('FMT_TOOL=oxfmt');
    expect(setup).toContain('"$__dk_package_bin_dir/oxfmt"');
    expect(setup).not.toMatch(/biome/);
  });

  it('package.json wiring writes exactly the descriptor scripts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fmt-identity-pkg-'));
    writeFileSync(join(dir, 'package.json'), '{"name":"c"}\n');
    patchPackageJson(dir, 'v0', 'git+x', defaultSelection(), false, false, 'generic');
    const pkg = parseJsonc(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg?.scripts).toMatchObject(CONSUMER_FORMATTER.scripts);
  });
});

describe('the gate — exact comparisons', () => {
  const current = currentFormatterIdentityInput(REPO, TREE);
  const withHook = (path: string, edit: (t: string) => string | null): FormatterIdentityInput => ({
    ...current,
    agentHooks: current.agentHooks.map((h) =>
      h.path === path ? { ...h, text: h.text === null ? null : edit(h.text) } : h,
    ),
  });

  it('the shipped state agrees', () => {
    expect(checkFormatterIdentity(current)).toEqual([]);
  });

  it('both agent hooks carry every rendered line today, verbatim', () => {
    for (const [path, lines] of Object.entries(renderAgentHookLines(CONSUMER_FORMATTER)))
      for (const line of lines)
        expect(readFileSync(join(REPO, path), 'utf8').split('\n'), path).toContain(line);
  });

  it('an invocation with an extra flag is not the rendered line (`check --unsafe` fails)', () => {
    const bad = withHook('agents-hooks/format-after-edit.sh', (t) =>
      t.replace(
        'bun run biome check --write "$file_path"',
        'bun run biome check --write --unsafe "$file_path"',
      ),
    );
    const out = checkFormatterIdentity(bad).join('\n');
    expect(out).toMatch(/no longer carries `bun run biome check --write "\$file_path"/);
    expect(out).toMatch(
      /runs biome in a line the descriptor does not render: `bun run biome check --write --unsafe/,
    );
  });

  it('a BARE, `command`-wrapped or backslash-continued invocation is not a rendered line', () => {
    for (const extra of [
      'biome check --unsafe .',
      'command biome check .',
      'bun run \\\n  biome check --unsafe .',
    ]) {
      const bad = withHook('agents-hooks/lint-check.sh', (t) => `${t}\n${extra}\n`);
      expect(checkFormatterIdentity(bad).join('\n'), extra).toMatch(
        /runs biome in a line the descriptor does not render/,
      );
    }
  });

  it('`biome_files` and `biome.json` do not count as running biome outside the rendered lines', () => {
    expect(checkFormatterIdentity(current)).toEqual([]);
  });

  it('an ADDED formatter invocation fails even while the rendered lines stay', () => {
    const bad = withHook(
      'agents-hooks/lint-check.sh',
      (t) => `${t}\nbunx biome check --unsafe .\n`,
    );
    expect(checkFormatterIdentity(bad).join('\n')).toMatch(
      /runs biome in a line the descriptor does not render/,
    );
  });

  it('an inline comment naming another formatter is a comment; a `#` inside quotes or ${#x} is not', () => {
    expect(withoutComment('true # prettier compatibility note')).toBe('true ');
    expect(withoutComment('true;# prettier compatibility note')).toBe('true;');
    expect(withoutComment('a &&# prettier')).toBe('a &&');
    expect(withoutComment('echo "a # b" && prettier')).toBe('echo "a # b" && prettier');
    // An escaped quote does not close the string, so the `#` inside it is not a comment.
    expect(withoutComment('printf "\\" #"; biome check --unsafe .')).toBe(
      'printf "\\" #"; biome check --unsafe .',
    );
    expect(withoutComment('echo \\# not a comment; biome x')).toBe(
      'echo \\# not a comment; biome x',
    );
    expect(withoutComment('if [ ${#biome_files[@]} -gt 0 ]; then')).toBe(
      'if [ ${#biome_files[@]} -gt 0 ]; then',
    );
    const ok = withHook(
      'agents-hooks/lint-check.sh',
      (t) => `${t}\ntrue # prettier compatibility note\n`,
    );
    expect(checkFormatterIdentity(ok)).toEqual([]);
  });

  it('hook arguments come from the descriptor, so another tool renders its own flags', () => {
    const lines = renderAgentHookLines({
      ...OXFMT,
      agentArgs: { afterEdit: '--write', lintCheck: '--check' },
    });
    expect(lines['agents-hooks/format-after-edit.sh']).toContain(
      '    bun run oxfmt --write "$file_path" 2>/dev/null || true',
    );
    expect(lines['agents-hooks/lint-check.sh'].join('\n')).toContain(
      'bun run oxfmt --check "${biome_files[@]}"',
    );
    expect(Object.values(lines).flat().join('\n')).not.toMatch(/oxfmt check/);
  });

  it('an agent hook that drops its config gate fails, naming the hook and the line', () => {
    const bad = withHook('agents-hooks/lint-check.sh', (t) =>
      t.replace('|| [ -f "biome.jsonc" ]', ''),
    );
    expect(checkFormatterIdentity(bad).join('\n')).toMatch(
      /agents-hooks\/lint-check\.sh no longer carries `if \[ -x "\.\/node_modules\/\.bin\/biome" \] && \{ \[ -f "biome\.json" \] \|\| \[ -f "biome\.jsonc" \]; \}; then`/,
    );
  });

  it('an agent hook that runs another formatter fails; the same word in a comment does not', () => {
    const bad = withHook(
      'agents-hooks/format-after-edit.sh',
      (t) => `${t}\nbunx prettier --write "$f"\n`,
    );
    expect(checkFormatterIdentity(bad).join('\n')).toMatch(/format-after-edit\.sh names prettier/);
    const commented = withHook(
      'agents-hooks/format-after-edit.sh',
      (t) => `${t}\n# prettier is not used\n`,
    );
    expect(checkFormatterIdentity(commented)).toEqual([]);
  });

  it('a deleted agent hook fails closed', () => {
    const bad = withHook('agents-hooks/lint-check.sh', () => null);
    expect(checkFormatterIdentity(bad).join('\n')).toMatch(
      /lint-check\.sh is missing from the commit/,
    );
  });

  it('switching the descriptor to another tool fails on the un-migrated hooks and presets', () => {
    const out = checkFormatterIdentity({ ...current, formatter: OXFMT }).join('\n');
    expect(out).toMatch(/no longer carries `bun run oxfmt check --write "\$file_path"/);
    expect(out).toMatch(/names biome outside a comment/);
    expect(out).toMatch(/biome\/base\.jsonc leaves the biome formatter on/);
    // Omission counts as ON (Biome's default); only an explicit false is off.
    expect(out).toMatch(/biome\/react\.jsonc leaves the biome formatter on/);
  });

  it('gating on a config devkit writes itself fails (the circular .oxfmtrc.json case)', () => {
    const bad = { ...current, formatter: { ...OXFMT, configProbes: ['.oxfmtrc.json'] } };
    expect(checkFormatterIdentity(bad).join('\n')).toMatch(
      /gates on \.oxfmtrc\.json, which devkit init writes/,
    );
  });

  it('a `./`-prefixed devkit-written config is still devkit-written', () => {
    const bad = { ...current, formatter: { ...OXFMT, configProbes: ['./.oxfmtrc.json'] } };
    expect(checkFormatterIdentity(bad).join('\n')).toMatch(
      /gates on \.\/\.oxfmtrc\.json, which devkit init writes/,
    );
  });

  it('the installed formatter package must be the descriptor one (scripts alone are not enough)', () => {
    const bad = { ...current, writtenDevDependency: undefined };
    expect(checkFormatterIdentity(bad).join('\n')).toMatch(/installs @biomejs\/biome@undefined/);
    const pkg = mkdtempSync(join(tmpdir(), 'fmt-identity-dep-'));
    writeFileSync(join(pkg, 'package.json'), '{"name":"c"}\n');
    patchPackageJson(pkg, 'v0', 'git+x', defaultSelection(), false, false, 'generic');
    expect(
      JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).devDependencies,
    ).toMatchObject({
      [CONSUMER_FORMATTER.package.name]: CONSUMER_FORMATTER.package.range,
    });
  });

  it('a script writer that drifts from the descriptor fails', () => {
    const bad = {
      ...current,
      writtenScripts: { ...current.writtenScripts, lint: 'prettier --check .' },
    };
    expect(checkFormatterIdentity(bad).join('\n')).toMatch(
      /package-json\.mts writes lint: "prettier --check \."/,
    );
  });

  it('a missing base preset or an unparseable preset fails closed', () => {
    const out = checkFormatterIdentity({
      ...current,
      presets: [{ path: 'biome/broken.jsonc', formatterEnabled: null }],
    }).join('\n');
    expect(out).toMatch(/biome\/base\.jsonc is missing/);
    expect(out).toMatch(/biome\/broken\.jsonc does not parse/);
  });
});

describe('the gate — when it judges and when it blocks', () => {
  it('a package.json missing from the commit BLOCKS — unknown identity is not a pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fmt-identity-nopkg-'));
    spawnSync('git', ['init', '-q'], { cwd: dir });
    expect(judgeFormatterIdentity(dir, { check: () => [] }).code).toBe(1);
  });

  it('an index restaged while the gate read it BLOCKS (hooks and presets are outside the ctime scan)', () => {
    let n = 0;
    const v = judgeFormatterIdentity(REPO, {
      split: [],
      touched: () => new Set<string>(),
      check: () => [],
      changedSince: () => [],
      indexTree: () => (n++ === 0 ? 'tree-a' : 'tree-b'),
    });
    expect(v).toMatchObject({ code: 1, findings: [expect.stringMatching(/index changed while/)] });
  });

  it('gate source changed while it was judged fails closed; untouched source passes', () => {
    const seams = { split: [], touched: () => new Set<string>(), check: () => [] };
    expect(
      judgeFormatterIdentity(REPO, { ...seams, changedSince: () => ['cli/x.mts'] }),
    ).toMatchObject({
      code: 1,
      findings: [expect.stringMatching(/changed while it was being judged/)],
    });
    expect(judgeFormatterIdentity(REPO, { ...seams, changedSince: () => [] }).code).toBe(0);
  });

  it('sourceChangedSince sees a rewrite (and a restore) after the cut-off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fmt-identity-ctime-'));
    mkdirSync(join(dir, 'cli'));
    mkdirSync(join(dir, 'gate-engine'));
    writeFileSync(join(dir, 'cli/a.mts'), '1');
    const cut = Date.now() + 5;
    const until = cut + 20;
    while (Date.now() < until);
    expect(sourceChangedSince(dir, cut)).toEqual([]);
    writeFileSync(join(dir, 'cli/a.mts'), '1');
    expect(sourceChangedSince(dir, cut)).toEqual(['cli/a.mts']);
  });

  it('stands down, saying so, when the gate source differs between index and worktree', () => {
    const v = judgeFormatterIdentity(REPO, { split: ['cli/x.mts'], check: () => ['boom'] });
    expect(v).toEqual({ code: 0, findings: [], inert: expect.stringMatching(/cannot judge/) });
  });

  it('a STAGED edit is the commit, not a split; unstaged and untracked gate source are', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fmt-identity-split-'));
    const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    mkdirSync(join(dir, 'cli'), { recursive: true });
    writeFileSync(join(dir, 'cli/a.mts'), '1\n');
    git('add', '-A');
    expect(sourceSplit(dir)).toEqual([]);
    writeFileSync(join(dir, 'cli/a.mts'), '2\n');
    expect(sourceSplit(dir)).toEqual(['cli/a.mts']);
    git('add', '-A');
    expect(sourceSplit(dir)).toEqual([]);
    writeFileSync(join(dir, 'cli/new.mts'), '');
    writeFileSync(join(dir, 'README.md'), '');
    expect(sourceSplit(dir)).toEqual(['cli/new.mts']);
    expect(sourceSplit(mkdtempSync(join(tmpdir(), 'fmt-identity-nogit-')))).toBeNull();
  });

  it('identity, findings and attribution all read the SAME tree id', () => {
    const seen: string[] = [];
    judgeFormatterIdentity(REPO, {
      split: [],
      changedSince: () => [],
      indexTree: () => TREE,
      check: (t) => (seen.push(`check:${t}`), ['boom']),
      touched: (t) => (seen.push(`touched:${t}`), new Set()),
    });
    expect(seen).toEqual([`check:${TREE}`, `touched:${TREE}`]);
  });

  it('the index-moved check covers the NOT-devkit path too (no early return escapes it)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fmt-identity-consumer-moved-'));
    spawnSync('git', ['init', '-q'], { cwd: dir });
    writeFileSync(join(dir, 'package.json'), '{"name":"consumer"}\n');
    spawnSync('git', ['add', '-A'], { cwd: dir });
    let n = 0;
    const real = spawnSync('git', ['write-tree'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    const v = judgeFormatterIdentity(dir, {
      indexTree: () => (n++ === 0 ? real : 'moved'),
      changedSince: () => [],
    });
    expect(v.code).toBe(1);
  });

  it('touchedIn: every path on an unborn branch, only the diff after a commit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fmt-identity-touched-'));
    const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    writeFileSync(join(dir, 'b.txt'), 'b\n');
    git('add', '-A');
    expect([...(touchedIn(dir, git('write-tree').stdout.trim()) ?? [])].sort()).toEqual([
      'a.txt',
      'b.txt',
    ]);
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x');
    writeFileSync(join(dir, 'b.txt'), 'changed\n');
    git('add', 'b.txt');
    expect([...(touchedIn(dir, git('write-tree').stdout.trim()) ?? [])]).toEqual(['b.txt']);
  });

  it('blocks only when a governed input is staged; otherwise it reports as pre-existing', () => {
    const judge = (touched: Set<string> | null) =>
      judgeFormatterIdentity(REPO, {
        split: [],
        touched: () => touched,
        check: () => ['boom'],
        changedSince: () => [],
      });
    expect(judge(new Set(['agents-hooks/lint-check.sh'])).code).toBe(1);
    expect(judge(new Set(['README.md']))).toEqual({ code: 0, findings: ['boom'], inert: null });
    expect(judge(null).code).toBe(1);
  });

  it('governed paths: the descriptor, script writer, lifecycle, presets, agent hooks and the gate', () => {
    for (const p of [
      'cli/lib/husky/format-fragment.mts',
      'cli/lib/install/package-json.mts',
      'cli/lib/install/oxc/lifecycle.mts',
      'biome/react.jsonc',
      'agents-hooks/format-after-edit.sh',
      'cli/lib/husky/format-identity/formatter-identity.mts',
      'cli/lib/husky/format-identity/jsonc.mts',
      'cli/lib/components.mts',
      'cli/commands/init.mts',
    ])
      expect(isFormatterIdentityPath(p), p).toBe(true);
    for (const p of ['README.md', 'biome.jsonc', 'agents-hooks/adhd-session-start.mjs'])
      expect(isFormatterIdentityPath(p), p).toBe(false);
  });

  it('identity comes from the INDEX: a staged consumer name is silent, an unstaged rename is not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fmt-identity-consumer-'));
    spawnSync('git', ['init', '-q'], { cwd: dir });
    writeFileSync(join(dir, 'package.json'), '{"name":"@norvalbv/devkit"}\n');
    spawnSync('git', ['add', '-A'], { cwd: dir });
    writeFileSync(join(dir, 'package.json'), '{"name":"consumer"}\n');
    const seams = { split: [], touched: () => null, check: () => ['boom'], changedSince: () => [] };
    expect(judgeFormatterIdentity(dir, seams).code).toBe(1);
    spawnSync('git', ['add', '-A'], { cwd: dir });
    expect(judgeFormatterIdentity(dir, seams)).toEqual({
      code: 0,
      findings: [],
      inert: null,
    });
  });
});

describe('parseJsonc', () => {
  it('accepts inline and block comments and trailing commas, leaving string contents alone', () => {
    expect(parseJsonc('{"formatter":{"enabled":false}, // keep off\n"linter":{}}')).toEqual({
      formatter: { enabled: false },
      linter: {},
    });
    expect(parseJsonc('{"a":"x,} // not a comment", /* c */ "b":[1,2,],}')).toEqual({
      a: 'x,} // not a comment',
      b: [1, 2],
    });
    expect(parseJsonc('{bad')).toBeNull();
    expect(parseJsonc('{"formatter":{"enabled":tr/* split */ue}}')).toBeNull();
    expect(parseJsonc('{"formatter":{"enabled":false}} /*')).toBeNull();
    expect(parseJsonc('{"a":1 // comment\r}')).toEqual({ a: 1 });
    expect(parseJsonc('\uFEFF{"formatter":{"enabled":false}}')).toEqual({
      formatter: { enabled: false },
    });
    expect(parseJsonc('{"a":[1, // c\r],}')).toEqual({ a: [1] });
  });
});
