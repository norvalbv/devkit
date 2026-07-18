/**
 * Self-host mode: the bin→source rewrite, the fixed selection, and — the drift guarantee — a PARITY
 * check that the committed `.husky/pre-commit` still equals what the current generator produces.
 * If the parity test fails, the hook drifted from the generator: regenerate it (`devkit init` in the
 * repo, or `devkit doctor --fix`) and re-commit.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractGuardBlock, replaceGuardBlock } from '../lib/husky/husky-block.mts';
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
  it('emits source gates + hard deterministic extras + the structure cmd; no bunx guard, no self-dep', () => {
    const hook = buildSelfHostHook(HOOK_SEL, '', ROOT);
    expect(hook).toContain('node gate-engine/deterministic/run.mts');
    expect(hook).toContain('node gate-engine/review/cli.mts --gate');
    expect(hook).toContain('node gate-engine/decisions/cli.mts detect --gate');
    expect(hook).toContain('--extra "lint=bun run lint"');
    expect(hook).toContain('--extra "benchmarks=bun run benchmarks:check -- --mode staged"');
    expect(hook).toContain('--structure "bun run lint:structure"');
    expect(hook).not.toMatch(/bunx guard-/);
    expect(hook).not.toContain('@norvalbv/devkit');
  });

  it('preserves the advisory fallow-audit gate INSIDE the block (never blocks, survives re-run)', () => {
    const hook = buildSelfHostHook(HOOK_SEL, '', ROOT);
    expect(hook).toContain(
      'command -v fallow >/dev/null 2>&1 && fallow audit $FALLOW_BASE_ARGS || true',
    );
    // Inside the devkit-guards block: after the start marker, before the end marker — so
    // replaceGuardBlock preserves it on a re-run and the parity/doctor check covers it.
    expect(hook.indexOf('fallow audit')).toBeGreaterThan(hook.indexOf('>>> devkit-guards'));
    expect(hook.indexOf('fallow audit')).toBeLessThan(hook.indexOf('<<< devkit-guards'));
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
    const script = `fallow() { echo "FALLOW_ARGS:$*"; }\n${fragment}`;

    const unset = execFileSync('sh', ['-c', script], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    expect(unset.trim()).toBe('FALLOW_ARGS:audit');

    const based = execFileSync('sh', ['-c', script], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, DEVKIT_SHIP_BASE_SHA: 'deadbeef' },
    });
    expect(based.trim()).toBe('FALLOW_ARGS:audit --base deadbeef');
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
