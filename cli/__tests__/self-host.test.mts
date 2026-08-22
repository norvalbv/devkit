/**
 * Self-host mode: the bin→source rewrite, the fixed selection, and — the drift guarantees — TWO
 * PARITY checks on this repo's own committed state.
 *
 * 1. The committed `.husky/pre-commit` still equals what the current generator produces. If it
 *    fails, the hook drifted from the generator: regenerate it (`devkit init` in the repo, or
 *    `devkit doctor --fix`) and re-commit.
 * 2. Each agentTarget's skills/agents dir still equals what the sync writers project from `skills/`
 *    and `agents/`. If it fails, a source edit shipped without re-running the writer: run
 *    `node cli/index.mts sync-skills` / `sync-agents` and commit.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { projectionDrift } from '../lib/install/agent-assets/projection-parity.mts';
import { buildFullHook, extractGuardBlock, replaceGuardBlock } from '../lib/husky/husky-block.mts';
import { DK_NO_GIT_ENV_HELPER } from '../lib/husky/review-fragments.mts';
import {
  buildSelfHostBlock,
  buildSelfHostHook,
  isDevkitRepo,
  SELF_HOST_EXTRAS,
  SELF_HOST_STRUCTURE_CMD,
  selfHostSelection,
  sourceBinFor,
  toSelfHost,
} from '../lib/husky/self-host.mts';
import { testExecFileSync as execFileSync } from './_helpers.mts';

// The repo root (where package.json + .husky live) — resolved from THIS file, not cwd, so the parity
// check is robust to however vitest is launched.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const HOOK_SEL = {
  ...selfHostSelection(),
  structureCmd: SELF_HOST_STRUCTURE_CMD,
  extras: SELF_HOST_EXTRAS,
};

describe('self-host bin rewrite', () => {
  it('sourceBinFor maps a guard bin to its source .mts (derived from package.json bin)', () => {
    expect(sourceBinFor(ROOT, 'guard-review')).toBe('gate-engine/review/cli.mts');
    expect(sourceBinFor(ROOT, 'guard-comments')).toBe('gate-engine/comment-firewall/cli.mts');
    expect(sourceBinFor(ROOT, 'guard-deterministic')).toBe('gate-engine/deterministic/run.mts');
    expect(sourceBinFor(ROOT, 'guard-qavis-advisory')).toBe('gate-engine/qavis-advisory/cli.mts');
  });

  it('sourceBinFor throws on an unknown bin', () => {
    expect(() => sourceBinFor(ROOT, 'guard-nope')).toThrow(/no bin/);
  });

  it('toSelfHost rewrites source gates and the self-host formatter without changing consumers', () => {
    const input =
      'bunx guard-review --gate\nbunx biome format --write\nbunx guard-deterministic --hook x';
    const out = toSelfHost(input, ROOT);
    expect(out).toContain('node gate-engine/review/cli.mts --gate');
    expect(out).toContain('node gate-engine/deterministic/run.mts --hook x');
    expect(out).toContain('node_modules/.bin/oxfmt --threads 1 --write');
    expect(out).not.toContain('bunx biome format --write');
    expect(out).not.toContain('bunx guard-');
  });

  it('leaves the generic consumer hook on Biome until that repository proves parity', () => {
    const hook = buildFullHook({ biome: true, guards: [] });
    expect(hook).toContain('bunx biome format --write');
    expect(hook).not.toContain('node_modules/.bin/oxfmt');
  });
});

describe('selfHostSelection', () => {
  it('is the recommended guard set PLUS review', () => {
    const sel = selfHostSelection();
    for (const g of [
      'size',
      'fanout',
      'dup',
      'clone',
      'comments',
      'decisions',
      'qavis-advisory',
      'review',
    ])
      expect(sel.guards).toContain(g);
    expect(sel.husky).toBe(true);
    expect(sel).toMatchObject({ oxc: true, antiSlop: true });
  });

  // sc-1529. The fixed selection used to reset every opt-in on upgrade, so a dogfood repo running
  // `adhd: true` silently came back false — which deletes .devkit/vendored-skills/i-have-adhd
  // (syncAdhdSkill's reclaim branch) and prunes the two hooks that component owns, while the
  // config still claimed it was on. An opt-in the repo recorded must survive.
  it('carries the recorded components through — an opt-in survives an upgrade', () => {
    const sel = selfHostSelection({ adhd: true, fallow: true, searchCode: true });
    expect(sel.adhd).toBe(true);
    expect(sel.fallow).toBe(true);
    expect(sel.searchCode).toBe(true);
  });

  it('still lets a recorded OFF win over a default-on component', () => {
    expect(selfHostSelection({ lineGrowth: false }).lineGrowth).toBe(false);
    expect(selfHostSelection().lineGrowth).toBe(true);
    expect(selfHostSelection({ oxc: false, antiSlop: false })).toMatchObject({
      oxc: true,
      antiSlop: true,
    });
  });

  // The guards half of the fixed selection is deliberate and must NOT follow the recorded value:
  // a future RECOMMENDED_GUARD_IDS addition would otherwise open an interactive multiselect in the
  // dogfood repo, which is the whole reason the selection was pinned in the first place.
  it('keeps guards FIXED even when the config records a narrower set', () => {
    const sel = selfHostSelection({ guards: ['size'] });
    for (const g of [
      'size',
      'fanout',
      'dup',
      'clone',
      'comments',
      'decisions',
      'qavis-advisory',
      'review',
    ])
      expect(sel.guards).toContain(g);
  });

  it('an absent key falls through to the default instead of becoming undefined', () => {
    const sel = selfHostSelection({ adhd: undefined });
    expect(sel.adhd).toBe(false);
    expect(sel.skills).toBe(true);
  });
});

describe('buildSelfHostHook', () => {
  it('emits source gates + hard deterministic extras + the structure cmd; no bunx guard, no self-dep', () => {
    const hook = buildSelfHostHook(HOOK_SEL, '', ROOT);
    expect(hook).toContain('node gate-engine/deterministic/run.mts');
    expect(hook).toContain('node gate-engine/review/cli.mts --gate');
    expect(hook).toContain('node gate-engine/decisions/cli.mts detect --gate');
    expect(hook).toContain('--extra "lint=bun run lint"');
    expect(hook).toContain('--extra "anti-slop=node cli/index.mts anti-slop check --staged"');
    expect(hook).toContain('--extra "benchmarks=bun run benchmarks:check -- --mode staged"');
    expect(hook).toContain('--structure "bun run lint:structure"');
    expect(hook).toContain('node_modules/.bin/oxfmt --threads 1 --write');
    expect(hook).toContain('(cli|gate-engine)/');
    expect(hook).toContain('skills/.*\\.mjs');
    expect(hook).toContain('node_modules/.bin/oxfmt --threads 1 --write || exit 1');
    expect(hook).not.toContain('oxfmt --threads 1 --write 2>/dev/null || true');
    expect(hook).not.toContain("grep -E '\\.(tsx?|jsx?|css|json|jsonc|mjs|mts)$'");
    expect(hook).not.toContain('bunx biome format --write');
    expect(hook).not.toMatch(/bunx guard-/);
    expect(hook).not.toContain('@norvalbv/devkit');
  });

  it('formats and re-stages only files inside the proven self-host scope', () => {
    const root = mkdtempSync(join(tmpdir(), 'self-host-oxfmt-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
    mkdirSync(join(root, 'cli'), { recursive: true });
    mkdirSync(join(root, 'docs', 'benchmarks'), { recursive: true });
    writeFileSync(join(root, '.oxfmtrc.json'), '{}\n');
    writeFileSync(join(root, 'cli', 'sample.mts'), 'const value={answer:42}\n');
    writeFileSync(join(root, 'cli', 'partial.mts'), 'const partial={staged:true}\n');
    writeFileSync(join(root, 'docs', 'benchmarks', 'catalog.json'), '{"evidence":true}\n');
    execFileSync(
      'git',
      ['add', '.oxfmtrc.json', 'cli/sample.mts', 'cli/partial.mts', 'docs/benchmarks/catalog.json'],
      { cwd: root },
    );
    writeFileSync(join(root, 'cli', 'partial.mts'), 'const partial={working:true}\n');

    const fragment = buildSelfHostHook(HOOK_SEL, '', ROOT).match(
      /# devkit:biome-format[\s\S]*?# \/devkit:biome-format/,
    )?.[0];
    expect(fragment).toBeDefined();
    execFileSync('sh', ['-c', fragment ?? 'exit 1'], { cwd: root });

    const formatted = 'const value = { answer: 42 };\n';
    expect(readFileSync(join(root, 'cli', 'sample.mts'), 'utf8')).toBe(formatted);
    expect(execFileSync('git', ['show', ':cli/sample.mts'], { cwd: root, encoding: 'utf8' })).toBe(
      formatted,
    );
    const evidence = '{"evidence":true}\n';
    expect(readFileSync(join(root, 'docs', 'benchmarks', 'catalog.json'), 'utf8')).toBe(evidence);
    expect(
      execFileSync('git', ['show', ':docs/benchmarks/catalog.json'], {
        cwd: root,
        encoding: 'utf8',
      }),
    ).toBe(evidence);
    expect(readFileSync(join(root, 'cli', 'partial.mts'), 'utf8')).toBe(
      'const partial={working:true}\n',
    );
    expect(execFileSync('git', ['show', ':cli/partial.mts'], { cwd: root, encoding: 'utf8' })).toBe(
      'const partial={staged:true}\n',
    );
  });

  it('blocks the self-host hook when Oxfmt fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'self-host-oxfmt-failure-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    mkdirSync(join(root, 'cli'), { recursive: true });
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    const oxfmt = join(root, 'node_modules', '.bin', 'oxfmt');
    writeFileSync(oxfmt, '#!/bin/sh\nexit 7\n');
    chmodSync(oxfmt, 0o755);
    writeFileSync(join(root, 'cli', 'sample.mts'), 'const value={answer:42}\n');
    execFileSync('git', ['add', 'cli/sample.mts'], { cwd: root });

    const fragment = buildSelfHostHook(HOOK_SEL, '', ROOT).match(
      /# devkit:biome-format[\s\S]*?# \/devkit:biome-format/,
    )?.[0];
    expect(fragment).toBeDefined();
    expect(() => execFileSync('sh', ['-c', fragment ?? 'exit 1'], { cwd: root })).toThrow();
  });

  it('backs the lint extra with the native Oxlint policy only', () => {
    const pkg: { scripts?: Record<string, string> } = JSON.parse(
      readFileSync(join(ROOT, 'package.json'), 'utf8'),
    );
    expect(SELF_HOST_EXTRAS).toContainEqual({ label: 'lint', cmd: 'bun run lint' });
    expect(pkg.scripts?.lint).toBe('bun run lint:oxlint');
    expect(pkg.scripts?.['lint:oxlint']).toContain('--deny-warnings');
    expect(pkg.scripts?.['lint:biome']).toBeUndefined();
    expect(pkg.scripts?.['lint:regex']).toBeUndefined();
  });

  it('preserves the advisory fallow-audit gate INSIDE the block (never blocks, survives re-run)', () => {
    const hook = buildSelfHostHook(HOOK_SEL, '', ROOT);
    expect(hook).toContain(
      'command -v fallow >/dev/null 2>&1 && __dk_no_git_env fallow audit $FALLOW_BASE_ARGS || true',
    );
    // Inside the devkit-guards block: after the start marker, before the end marker — so
    // replaceGuardBlock preserves it on a re-run and the parity/doctor check covers it.
    expect(hook.indexOf('fallow audit')).toBeGreaterThan(hook.indexOf('>>> devkit-guards'));
    expect(hook.indexOf('fallow audit')).toBeLessThan(hook.indexOf('<<< devkit-guards'));
    expect(hook).toContain('__dk_review_baseline_gate fallow || true');
    expect(hook.indexOf('fallow audit')).toBeLessThan(
      hook.indexOf('# devkit:review-deterministic-finalizer'),
    );
    expect(hook.trimEnd().endsWith('exit 0')).toBe(true);
  });

  // DK-5: a --base ship cuts the gate worktree from a possibly non-main base, so the advisory fallow
  // audit must diff against THAT commit (DEVKIT_SHIP_BASE_SHA, exported by ship-branch.sh/reship.sh)
  // rather than fallow's own main-autodetect — else a stacked branch's own pre-existing findings
  // misreport as "new". No real fallow binary in this sandbox: stub it and assert on the args it sees.
  it('scopes the fallow audit to DEVKIT_SHIP_BASE_SHA when a ship exported it', () => {
    const hook = buildSelfHostHook(HOOK_SEL, '', ROOT);
    expect(hook).toContain(`[ -n "\${DEVKIT_SHIP_BASE_SHA:-}" ]`);
    expect(hook).toContain('FALLOW_BASE_ARGS="--base $DEVKIT_SHIP_BASE_SHA"');
    const fragment = extractGuardBlock(hook, '')?.match(
      /# devkit:fallow-advisory[\s\S]*?# \/devkit:fallow-advisory/,
    )?.[0];
    expect(fragment).toBeDefined();
    // A REAL stub on PATH, not a shell function: the gate runs through `env` (the git-env scrub),
    // which execs a binary and cannot see shell functions.
    const binDir = mkdtempSync(join(tmpdir(), 'fallow-stub-'));
    const stub = join(binDir, 'fallow');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell ${VAR:-default}, not a JS template
    writeFileSync(stub, '#!/bin/sh\necho "FALLOW_ARGS:$*"\necho "GIT_DIR:${GIT_DIR:-unset}"\n');
    chmodSync(stub, 0o755);
    const script = `${DK_NO_GIT_ENV_HELPER}\n${fragment}`;
    const run = (extra) =>
      execFileSync('sh', ['-c', script], {
        encoding: 'utf8',
        env: { PATH: `${binDir}:${process.env.PATH}`, ...extra },
      });

    expect(run({}).split('\n')[0]).toBe('FALLOW_ARGS:audit');
    expect(run({ DEVKIT_SHIP_BASE_SHA: 'deadbeef' }).split('\n')[0]).toBe(
      'FALLOW_ARGS:audit --base deadbeef',
    );
    // The scrub itself: git's linked-worktree hook env must not reach fallow's worktree machinery.
    expect(run({ GIT_DIR: '/repo/.git/worktrees/devkit-ship-x' })).toContain('GIT_DIR:unset');
  });

  it('is idempotent through replaceGuardBlock — re-applying the block keeps the fallow fragment intact', () => {
    const fresh = buildSelfHostHook(HOOK_SEL, '', ROOT);
    const block = buildSelfHostBlock(HOOK_SEL, '', ROOT);
    const reapplied = replaceGuardBlock(fresh, block, '');
    expect(reapplied).toBe(fresh); // no drift: the fallow fragment lives in the block, not a fragile tail
  });
});

describe('isDevkitRepo', () => {
  it('true for the devkit repo root', () => {
    expect(isDevkitRepo(ROOT)).toBe(true);
  });
});

describe('test timeout policy', () => {
  it('keeps one load-tolerant timeout in vitest.config.mjs instead of per-suite overrides', () => {
    const pending = [join(ROOT, 'cli'), join(ROOT, 'gate-engine'), join(ROOT, 'e2e', 'lib')];
    const overrides: string[] = [];
    const localTimeoutOverride = /\bsetConfig\s*\(\s*\{[^}]*\btestTimeout\s*:/;
    const compactOverride = ['vi.', 'set', 'Config({', 'test', 'Timeout: 30_000 })'].join('');
    const multilineOverride = [
      'vi.',
      'set',
      'Config ( {',
      '\n  retry: 1,\n  ',
      'test',
      'Timeout : 30_000\n})',
    ].join('');

    expect(localTimeoutOverride.test(compactOverride)).toBe(true);
    expect(localTimeoutOverride.test(multilineOverride)).toBe(true);

    while (pending.length > 0) {
      const dir = pending.pop();
      if (!dir || !existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          pending.push(path);
        } else if (
          entry.name.endsWith('.test.mts') &&
          localTimeoutOverride.test(readFileSync(path, 'utf8'))
        ) {
          overrides.push(path.slice(ROOT.length + 1));
        }
      }
    }

    expect(overrides).toEqual([]);
  });
});

// THE drift guarantee. A generator change that isn't regenerated into the committed hook, or a
// hand-edit of the hook, fails here — CI won't go green until the hook is regenerated.
describe('committed hook parity', () => {
  it('.husky/pre-commit guard block === the current generator output', () => {
    const hookPath = join(ROOT, '.husky', 'pre-commit');
    expect(existsSync(hookPath), '.husky/pre-commit must exist (self-host `devkit init`)').toBe(
      true,
    );
    const currentBlock = extractGuardBlock(readFileSync(hookPath, 'utf8'), '');
    const expectedBlock = buildSelfHostBlock(HOOK_SEL, '', ROOT);
    expect(currentBlock?.trim()).toBe(expectedBlock.trim());
  });
});

// THE second drift guarantee. `skills/` and `agents/` are the sources of truth; each agentTarget's
// dir is a pure projection of them (identical bytes for claude/cursor — only codex transforms).
// #405 edited two skill references and #395 edited every agent's frontmatter without re-running the
// writers, so the projections went on serving deleted ratchet scripts and a stale MCP tool profile,
// and nothing caught it. Missing, stale, and orphaned files all fail here.
describe('committed agent-asset projection parity', () => {
  // The source dir is carried explicitly rather than derived from `kind`: the two coincide for
  // skills/agents, but AgentAssetKind's third member `hooks` lives in `agents-hooks/`, so the
  // shortcut is already false for a third of the union.
  for (const [kind, srcDir] of [
    ['skills', 'skills'],
    ['agents', 'agents'],
  ] as const) {
    // Config read and comparison both happen INSIDE `it`. A throw in the describe body is a
    // file-level collection error, which would take the hook-parity guarantee above down with it —
    // a new guard must never be able to disable an existing one.
    it(`${kind}/ === what sync-${kind} projects into every agentTarget`, () => {
      // SAFETY: `.devkit/config.json` is devkit-owned and committed in THIS repo, and `components`
      // is the same object the sync writers read for their selection and target list. A missing or
      // reshaped field would already have broken the writers, and surfaces here as a throw inside
      // this test rather than a silent pass.
      const { components } = JSON.parse(
        readFileSync(join(ROOT, '.devkit', 'config.json'), 'utf8'),
      ) as { components: { agentTargets: string[]; guards: string[] } };

      const drift = projectionDrift({
        root: ROOT,
        kind,
        srcDir,
        targets: components.agentTargets,
        selection: components,
      });
      // The classes need different repairs: sync rewrites a stale file but can NEVER prune an
      // orphan (it only removes what the manifest records), so one blanket "re-run sync" would
      // send the next reader to a command that does nothing.
      expect(
        drift,
        `stale/missing → run \`node cli/index.mts sync-${kind}\` and commit; ` +
          'orphan → `git rm` it (sync never prunes unmanifested files)',
      ).toEqual([]);
    });
  }
});
