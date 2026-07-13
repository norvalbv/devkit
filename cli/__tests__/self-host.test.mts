/**
 * Self-host mode: the bin→source rewrite, the fixed selection, and — the drift guarantee — a PARITY
 * check that the committed `.husky/pre-commit` still equals what the current generator produces.
 * If the parity test fails, the hook drifted from the generator: regenerate it (`devkit init` in the
 * repo, or `devkit doctor --fix`) and re-commit.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractGuardBlock } from '../lib/husky/husky-block.mts';
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
    expect(sourceBinFor(ROOT, 'guard-deterministic')).toBe('gate-engine/deterministic/run.mts');
    expect(sourceBinFor(ROOT, 'guard-qavis-advisory')).toBe('gate-engine/qavis-advisory/cli.mts');
  });

  it('sourceBinFor throws on an unknown bin', () => {
    expect(() => sourceBinFor(ROOT, 'guard-nope')).toThrow(/no bin/);
  });

  it('toSelfHost rewrites `bunx guard-*` to `node <source>` and leaves `bunx biome` alone', () => {
    const input =
      'bunx guard-review --gate\nbunx biome format --write\nbunx guard-deterministic --hook x';
    const out = toSelfHost(input, ROOT);
    expect(out).toContain('node gate-engine/review/cli.mts --gate');
    expect(out).toContain('node gate-engine/deterministic/run.mts --hook x');
    expect(out).toContain('bunx biome format --write'); // real devDep — untouched
    expect(out).not.toContain('bunx guard-');
  });
});

describe('selfHostSelection', () => {
  it('is the recommended guard set PLUS review', () => {
    const sel = selfHostSelection();
    for (const g of ['size', 'fanout', 'dup', 'clone', 'decisions', 'qavis-advisory', 'review'])
      expect(sel.guards).toContain(g);
    expect(sel.husky).toBe(true);
  });
});

describe('buildSelfHostHook', () => {
  it('emits source gates + the hard-lint extra + the structure cmd; no bunx guard, no self-dep', () => {
    const hook = buildSelfHostHook(HOOK_SEL, '', ROOT);
    expect(hook).toContain('node gate-engine/deterministic/run.mts');
    expect(hook).toContain('node gate-engine/review/cli.mts --gate');
    expect(hook).toContain('node gate-engine/decisions/cli.mts detect --gate');
    expect(hook).toContain('--extra "lint=bun run lint"');
    expect(hook).toContain('--structure "bun run lint:structure"');
    expect(hook).not.toMatch(/bunx guard-/);
    expect(hook).not.toContain('@norvalbv/devkit');
  });

  it('preserves the hand hook advisory fallow-audit tail (outside the block, never blocks)', () => {
    const hook = buildSelfHostHook(HOOK_SEL, '', ROOT);
    expect(hook).toContain('command -v fallow >/dev/null 2>&1 && fallow audit || true');
    // After the guard block, before the terminal exit 0.
    expect(hook.indexOf('fallow audit')).toBeGreaterThan(hook.indexOf('<<< devkit-guards'));
    expect(hook.trimEnd().endsWith('exit 0')).toBe(true);
  });
});

describe('isDevkitRepo', () => {
  it('true for the devkit repo root', () => {
    expect(isDevkitRepo(ROOT)).toBe(true);
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
