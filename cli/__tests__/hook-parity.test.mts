/**
 * The extracted hook-parity comparison (cli/lib/husky/hook-parity.mts).
 *
 * `reason` strings are pinned VERBATIM against the ones review-drift served before the extraction:
 * `devkit review` surfaces them to a user mid-run, so a refactor that quietly reworded them is a
 * user-visible change, not an internal one.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  guardBlockMatches,
  HOOK_REL,
  isHookGeneratorPath,
  judgeHookParity,
  runHookParityGate,
  selfHostHookParity,
} from '../lib/husky/hook-parity.mts';
import {
  buildSelfHostBlock,
  buildSelfHostHook,
  SELF_HOST_EXTRAS,
  SELF_HOST_STRUCTURE_CMD,
  selfHostSelection,
} from '../lib/husky/self-host.mts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK_SEL = {
  ...selfHostSelection(),
  structureCmd: SELF_HOST_STRUCTURE_CMD,
  extras: SELF_HOST_EXTRAS,
};
const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A root the generator can build against: it only needs package.json's `bin` map (sourceBinFor). */
function seedRoot(hookContent?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'devkit-hook-parity-'));
  cleanup.push(root);
  copyFileSync(join(ROOT, 'package.json'), join(root, 'package.json'));
  if (hookContent !== undefined) {
    mkdirSync(join(root, '.husky'), { recursive: true });
    writeFileSync(join(root, HOOK_REL), hookContent);
  }
  return root;
}

describe('guardBlockMatches', () => {
  const expected = buildSelfHostBlock(HOOK_SEL, '', ROOT);
  const hook = buildSelfHostHook(HOOK_SEL, '', ROOT);

  it('matches a hook carrying exactly the generator block', () => {
    expect(guardBlockMatches(hook, expected)).toBe(true);
  });

  it('ignores surrounding whitespace on both sides', () => {
    expect(guardBlockMatches(hook, `\n\n${expected}\n  `)).toBe(true);
  });

  it('does not match once a byte inside the block changes', () => {
    expect(
      guardBlockMatches(hook.replace('Deterministic gates', 'Determinstic gates'), expected),
    ).toBe(false);
  });

  it('a hook with no markers is NOT a match (unmarked !== in-parity)', () => {
    expect(guardBlockMatches('#!/usr/bin/env sh\nexit 0\n', expected)).toBe(false);
  });

  it('a block written for a different pkgRel does not satisfy the root markers', () => {
    expect(guardBlockMatches(hook, expected, 'services/webapp')).toBe(false);
  });
});

describe('selfHostHookParity', () => {
  it('reports ok for this repo, whose committed hook IS the generator output', () => {
    const parity = selfHostHookParity(ROOT);
    expect(parity.status).toBe('ok');
    expect(parity.reason).toBeNull();
    expect(parity.hookRel).toBe('.husky/pre-commit');
    expect(parity.source).toBe('worktree');
  });

  it('reports stale — with review-drift’s verbatim reason — when the block drifted', () => {
    const drifted = buildSelfHostHook(HOOK_SEL, '', ROOT).replace(
      'Deterministic gates',
      'Determinstic gates',
    );
    const parity = selfHostHookParity(seedRoot(drifted));
    expect(parity.status).toBe('stale');
    expect(parity.reason).toBe('pre-commit gate block differs from the current generator');
    // The caller still gets both sides, so the failure can be diffed rather than merely reported.
    expect(parity.currentBlock).not.toBeNull();
    expect(parity.currentBlock).not.toBe(parity.expectedBlock);
  });

  it('reports unmarked when the hook exists but carries no guard block', () => {
    const parity = selfHostHookParity(seedRoot('#!/usr/bin/env sh\nexit 0\n'));
    expect(parity.status).toBe('unmarked');
    expect(parity.currentBlock).toBeNull();
    expect(parity.reason).toBe('pre-commit gate block differs from the current generator');
  });

  it('reports missing — never throws — when there is no hook at all', () => {
    const parity = selfHostHookParity(seedRoot());
    expect(parity.status).toBe('missing');
    expect(parity.reason).toBe('missing .husky/pre-commit');
    expect(parity.currentBlock).toBeNull();
    // No generator run on this branch: `devkit doctor` relies on the short-circuit so a fixture
    // repo that cannot supply devkit's package.json bin map still reaches its hook-wiring checks.
    expect(parity.expectedBlock).toBe('');
  });

  it('honours the caller’s recorded components rather than a bare default selection', () => {
    const root = seedRoot(buildSelfHostHook(HOOK_SEL, '', ROOT));
    expect(selfHostHookParity(root).status).toBe('ok');
    expect(selfHostHookParity(root, { components: { biome: false } }).status).toBe('stale');
  });
});

describe('isHookGeneratorPath', () => {
  const generatorInputs = [
    '.husky/pre-commit',
    'package.json',
    '.devkit/config.json',
    'cli/lib/components.mts',
    'cli/lib/husky/ai-guard-fragments.mts',
    'cli/lib/husky/self-host.mts',
  ];
  const bystanders = [
    'gate-engine/decisions/cli.mts',
    'docs/decisions/overlay-self-heal.md',
    'cli/commands/init.mts',
    'README.md',
  ];

  it.each(generatorInputs)('blames %s', (p) => expect(isHookGeneratorPath(p)).toBe(true));
  it.each(bystanders)('does not blame %s', (p) => expect(isHookGeneratorPath(p)).toBe(false));

  // THE durability guarantee. The predicate is hand-maintained, and a refactor that moves a
  // generator input out of cli/lib/husky/ would silently downgrade every real drift from a block
  // to an advisory — a missed catch nobody would notice, because the gate would still be "passing".
  // Walking the generator's own import graph makes that refactor fail HERE instead.
  it('covers every file the self-host generator can reach', () => {
    const seen = new Set<string>();
    const queue = ['cli/lib/husky/self-host.mts'];
    while (queue.length) {
      const rel = queue.pop();
      if (rel === undefined || seen.has(rel)) continue;
      seen.add(rel);
      const abs = join(ROOT, rel);
      if (!existsSync(abs)) continue;
      for (const [, spec] of readFileSync(abs, 'utf8').matchAll(/from\s+'(\.[^']+)'/g)) {
        queue.push(relative(ROOT, resolve(dirname(abs), spec)).replaceAll('\\', '/'));
      }
    }
    const uncovered = [...seen].filter((p) => !isHookGeneratorPath(p)).sort();
    expect(
      uncovered,
      'these files can change the generated hook but would NOT be blamed for the drift — ' +
        'add them to HOOK_GENERATOR_FILES (or a prefix) in cli/lib/husky/hook-parity.mts',
    ).toEqual([]);
  });
});

// The recorded selection is a generator INPUT, so it must be read from the same snapshot as the
// hook. Mixing an index hook with a worktree config lets a staged selection change read as parity.
describe('selfHostHookParity — staged source consistency', () => {
  it('builds the expected block from the STAGED config, not the worktree copy', () => {
    const root = mkdtempSync(join(tmpdir(), 'devkit-hook-parity-git-'));
    cleanup.push(root);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    copyFileSync(join(ROOT, 'package.json'), join(root, 'package.json'));
    mkdirSync(join(root, '.devkit'), { recursive: true });
    mkdirSync(join(root, '.husky'), { recursive: true });
    writeFileSync(join(root, '.devkit', 'config.json'), JSON.stringify({ components: {} }));
    writeFileSync(join(root, HOOK_REL), buildSelfHostHook(HOOK_SEL, '', ROOT));
    git('add', '-A');

    expect(selfHostHookParity(root, { source: 'staged' }).status).toBe('ok');

    // A worktree-only selection change must not move the staged verdict; staging it must.
    writeFileSync(
      join(root, '.devkit', 'config.json'),
      JSON.stringify({ components: { biome: false } }),
    );
    expect(selfHostHookParity(root, { source: 'staged' }).status).toBe('ok');
    expect(selfHostHookParity(root, { source: 'worktree' }).status).toBe('stale');
    git('add', '-A');
    expect(selfHostHookParity(root, { source: 'staged' }).status).toBe('stale');
  });
});

function seedGitRoot() {
  const root = mkdtempSync(join(tmpdir(), 'devkit-hook-parity-judge-'));
  cleanup.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  copyFileSync(join(ROOT, 'package.json'), join(root, 'package.json'));
  mkdirSync(join(root, '.devkit'), { recursive: true });
  mkdirSync(join(root, '.husky'), { recursive: true });
  writeFileSync(join(root, '.devkit', 'config.json'), JSON.stringify({ components: {} }));
  writeFileSync(join(root, HOOK_REL), buildSelfHostHook(HOOK_SEL, '', ROOT));
  git('add', '-A');
  git('commit', '-qm', 'seed');
  return { root, git };
}

describe('judgeHookParity — attribution edge cases', () => {
  // stagedSet excludes deletions, so blaming from it would let `git rm .devkit/config.json` land a
  // stale hook as "pre-existing drift".
  it('blames a staged DELETION of a generator input', () => {
    const { root, git } = seedGitRoot();
    // Commit a consistent pair: the hook generated for biome:false, and the config recording it.
    const noBiome = {
      ...selfHostSelection({ biome: false }),
      structureCmd: SELF_HOST_STRUCTURE_CMD,
      extras: SELF_HOST_EXTRAS,
    };
    writeFileSync(
      join(root, '.devkit', 'config.json'),
      JSON.stringify({ components: { biome: false } }),
    );
    writeFileSync(join(root, HOOK_REL), buildSelfHostHook(noBiome, '', ROOT));
    git('add', '-A');
    git('commit', '-qm', 'biome off');
    expect(judgeHookParity(root).parity?.status).toBe('ok');

    // Deleting the config reverts the selection to the default, so the committed hook is now stale
    // — and the deletion is what caused it.
    git('rm', '-q', '.devkit/config.json');
    const verdict = judgeHookParity(root);
    expect(verdict.parity?.status).toBe('stale');
    expect(verdict.blamed).toContain('.devkit/config.json');
    expect(verdict.code).toBe(1);
  });

  // The expected block is generated from the WORKTREE while the hook comes from the index, so a
  // generator input that differs between them compares two different trees.
  it('stands down rather than judging when a generator input is only partly staged', () => {
    const { root, git } = seedGitRoot();
    writeFileSync(
      join(root, '.devkit', 'config.json'),
      JSON.stringify({ components: { biome: false } }),
    );
    git('add', '-A');
    // Now diverge index from worktree on the same generator input.
    writeFileSync(join(root, '.devkit', 'config.json'), JSON.stringify({ components: {} }));
    const verdict = judgeHookParity(root);
    expect(verdict.code).toBe(0);
    expect(verdict.inert).toContain('.devkit/config.json');
  });
});

// The exit CODE is the entire contract with the deterministic orchestrator: `--extra` runs with
// failOpen2:false, so every non-zero blocks the commit. judgeHookParity is asserted above; these
// pin what the hook actually propagates, plus the remedy text a blocked developer has to act on.
describe('runHookParityGate — printed verdict and exit code', () => {
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
    delete process.env.GUARD_HOOK_PARITY_OK;
  });

  it('exits 0 and says so when the committed hook is in parity', () => {
    expect(runHookParityGate(ROOT)).toBe(0);
    expect(out.join('\n')).toContain('Hook parity passed');
  });

  it('exits 0 and announces a bypass without judging anything', () => {
    process.env.GUARD_HOOK_PARITY_OK = '1';
    expect(runHookParityGate(ROOT)).toBe(0);
    expect(out.join('\n')).toContain('BYPASSED');
    // The bypass must be the canonical GUARD_ spelling on its own line — a remedy nobody can
    // copy-paste is the dead end config.mts documents.
    expect(out.join('\n')).toContain('GUARD_HOOK_PARITY_OK=1');
    expect(out.join('\n')).not.toContain('Hook parity passed');
  });

  it('exits 0 and stays silent in a repo devkit does not own', () => {
    const root = seedRoot(buildSelfHostHook(HOOK_SEL, '', ROOT));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'not-devkit' }));
    expect(runHookParityGate(root)).toBe(0);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });

  it('exits 2 when the hook is absent — the commit would run no gates at all', () => {
    const root = seedRoot();
    expect(runHookParityGate(root)).toBe(2);
    expect(err.join('\n')).toContain('would run no gates at all');
  });

  it('never throws out of the gate — an unreadable root degrades to 0', () => {
    expect(runHookParityGate(join(ROOT, 'no', 'such', 'directory'))).toBe(0);
    expect(err).toEqual([]);
  });
});

describe('judgeHookParity — isolation and degraded inputs', () => {
  // Frink runs many panes at once, and devkit itself is developed across ~20 linked worktrees that
  // share one object database. A gate that read the shared .git instead of its own worktree index
  // would blame this commit for whatever another pane happened to have staged.
  it('sees only its OWN worktree’s index, never a sibling worktree’s', () => {
    const { root, git } = seedGitRoot();
    const sibling = join(root, '..', `${basename(root)}-sibling`);
    cleanup.push(sibling);
    git('worktree', 'add', '-q', '--detach', sibling);
    // Stage a REAL generator-input change in the SIBLING only. Its hook is HEAD's, built for the
    // default selection, so recording biome:false there is genuine drift the sibling caused.
    writeFileSync(
      join(sibling, '.devkit', 'config.json'),
      JSON.stringify({ components: { biome: false } }),
    );
    execFileSync('git', ['add', '-A'], { cwd: sibling, encoding: 'utf8' });

    const theirs = judgeHookParity(sibling);
    expect(theirs.parity?.status).toBe('stale');
    expect(theirs.blamed).toContain('.devkit/config.json');

    // The original worktree staged nothing and must be entirely unaffected.
    const mine = judgeHookParity(root);
    expect(mine.parity?.status).toBe('ok');
    expect(mine.blamed).toEqual([]);
    expect(mine.code).toBe(0);
    git('worktree', 'remove', '--force', sibling);
  });

  // A review-mode replay judges a past commit and stages nothing. An empty set is NOT the same as
  // git being unavailable: there is a real answer, and it is "this change caused nothing".
  it('reports drift as advisory — never blocking — when the change stages nothing', () => {
    const { root, git } = seedGitRoot();
    writeFileSync(
      join(root, HOOK_REL),
      buildSelfHostHook(HOOK_SEL, '', ROOT).replace('Deterministic gates', 'Determinstic gates'),
    );
    git('add', '-A');
    git('commit', '-qm', 'drifted hook');
    const verdict = judgeHookParity(root, new Set());
    expect(verdict.parity?.status).toBe('stale');
    expect(verdict.code).toBe(0);
    expect(verdict.blamed).toEqual([]);
    expect(verdict.inert).toBeNull();
  });

  it('falls back to the default selection when the staged config is not valid JSON', () => {
    const { root, git } = seedGitRoot();
    writeFileSync(join(root, '.devkit', 'config.json'), '{ this is not json');
    git('add', '-A');
    // A malformed devkit-owned file must not become an exception that blocks every commit.
    const verdict = judgeHookParity(root);
    expect(verdict.parity?.status).toBe('ok');
    expect(verdict.code).toBe(0);
  });
});

// The hook spawns this as `node cli/lib/husky/hook-parity.mts --gate`, so the process exit code —
// not the returned number — is what blocks a commit. This also exercises the run-as-main guard and
// its catch-all, which an in-process call never reaches.
describe('hook-parity --gate as the hook actually spawns it', () => {
  const GATE = join(ROOT, 'cli', 'lib', 'husky', 'hook-parity.mts');
  const spawnGate = (cwd: string, env: Record<string, string> = {}) =>
    spawnSync('node', [GATE, '--gate'], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });

  it('exits 0 in this repo, whose hook is in parity', () => {
    const result = spawnGate(ROOT);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Hook parity passed');
  });

  it('exits 1 when a staged generator input drifted the hook', () => {
    const { root, git } = seedGitRoot();
    writeFileSync(
      join(root, '.devkit', 'config.json'),
      JSON.stringify({ components: { biome: false } }),
    );
    git('add', '-A');
    const result = spawnGate(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Hook parity broken');
  });

  it('exits 0 in a directory that is not a devkit repo', () => {
    const root = mkdtempSync(join(tmpdir(), 'devkit-hook-parity-foreign-'));
    cleanup.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'someone-elses-repo' }));
    const result = spawnGate(root);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
