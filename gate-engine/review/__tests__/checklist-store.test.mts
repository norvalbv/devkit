/**
 * skills/_devkit/checklist-store.mjs — the checklist lifecycle shared by the six item-based reviewer
 * skills. Extracted from six byte-identical copies, so the risk it carries is a silent behaviour
 * change in code that ships into every consumer repo and had NO test coverage before.
 *
 * Tests live here rather than beside the module for the same two reasons as review-roots.test.mts:
 * `skills/**` is outside the vitest include globs, and everything under `skills/_devkit/` is
 * projected into consumer repos by `devkit sync-skills` — a test file there would ship as dead
 * weight a consumer's own runner might pick up.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createChecklistStore } from '../../../skills/_devkit/checklist-store.mjs';

let roots: string[] = [];
const mkRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'checklist-store-'));
  roots.push(root);
  return root;
};

let savedRunMode: string | undefined;
let savedKeep: string | undefined;
beforeEach(() => {
  savedRunMode = process.env.DEVKIT_RUN_MODE;
  delete process.env.DEVKIT_RUN_MODE;
  savedKeep = process.env.DEVKIT_CHECKLIST_KEEP;
  delete process.env.DEVKIT_CHECKLIST_KEEP;
});
afterEach(() => {
  if (savedRunMode === undefined) delete process.env.DEVKIT_RUN_MODE;
  else process.env.DEVKIT_RUN_MODE = savedRunMode;
  if (savedKeep === undefined) delete process.env.DEVKIT_CHECKLIST_KEEP;
  else process.env.DEVKIT_CHECKLIST_KEEP = savedKeep;
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

/** A store wired to capture output and record exits instead of killing the runner. */
function harness(overrides: Record<string, unknown> = {}) {
  const root = mkRoot();
  const path = join(root, '.claude', '.test-review.json');
  const lines: string[] = [];
  const exits: number[] = [];
  const store = createChecklistStore({
    path,
    label: 'Test Review',
    log: (...args: unknown[]) => lines.push(args.map(String).join(' ')),
    exit: (code: number) => {
      exits.push(code);
    },
    ...overrides,
  });
  return { store, path, lines, exits, out: () => lines.join('\n') };
}

const items = () => [
  { name: 'alpha', category: 'A', status: 'pending', issues: [] },
  { name: 'beta', category: 'B', status: 'pending', issues: [] },
];

describe('createChecklistStore — persistence', () => {
  it('save creates the parent directory and load round-trips', () => {
    const h = harness();
    expect(h.store.load()).toBeNull(); // absent → null, not a throw
    h.store.save({ generated: 'now', files: ['a.ts'], items: items() });
    expect(existsSync(h.path)).toBe(true);
    expect(h.store.load().items).toHaveLength(2);
  });

  it('writes pretty-printed JSON (the file is meant to be read by a human and an agent)', () => {
    const h = harness();
    h.store.save({ items: items() });
    expect(readFileSync(h.path, 'utf-8')).toContain('\n  ');
  });
});

// The path is resolved per call, not captured at construction. correctness rebinds its file from a
// `--lens` argument at DISPATCH — after module top-level — so a store that read the path once would
// pin every lensed run to the unlensed file: writing, reading and cleaning the wrong checklist while
// reporting success. An early version of this extraction did exactly that, and a lifecycle
// equivalence check missed it because it never passed a lens.
describe('createChecklistStore — path may be a thunk (correctness --lens)', () => {
  it('re-resolves the path on EVERY call rather than caching it', () => {
    const root = mkRoot();
    let active = join(root, '.claude', '.unlensed.json');
    const h = harness({ path: () => active });

    h.store.save({ items: items() });
    expect(existsSync(join(root, '.claude', '.unlensed.json'))).toBe(true);

    // rebind, exactly as dispatch does after parsing --lens
    active = join(root, '.claude', '.lensed.json');
    h.store.save({ items: items() });
    expect(existsSync(join(root, '.claude', '.lensed.json'))).toBe(true);

    // and every other operation follows the rebind, not the original
    h.store.checkItem('alpha', true);
    expect(JSON.parse(readFileSync(active, 'utf-8')).items[0].status).toBe('pass');
    h.store.checkItem('beta', true);
    h.store.finalize(); // passing finalize tidies the REBOUND path, not the original
    expect(existsSync(active)).toBe(false);
    expect(existsSync(join(root, '.claude', '.unlensed.json'))).toBe(true); // untouched
  });

  it('still accepts a plain string path (the five fixed-path reviewers)', () => {
    const h = harness();
    h.store.save({ items: items() });
    expect(existsSync(h.path)).toBe(true);
  });
});

describe('createChecklistStore — missing checklist is a hard stop, never a silent pass', () => {
  it.each([
    [
      'status',
      (s: ReturnType<typeof harness>['store']) => s.status(),
      '❌ No checklist. Run: generate',
    ],
    ['finalize', (s: ReturnType<typeof harness>['store']) => s.finalize(), '❌ No checklist'],
    [
      'checkItem',
      (s: ReturnType<typeof harness>['store']) => s.checkItem('alpha', true),
      '❌ No checklist',
    ],
  ])('%s exits 1 with its own message', (_label, run, message) => {
    const h = harness();
    run(h.store);
    expect(h.exits).toEqual([1]);
    expect(h.lines[0]).toBe(message);
  });
});

describe('createChecklistStore — checkItem', () => {
  it('marks pass and persists', () => {
    const h = harness();
    h.store.save({ items: items() });
    h.store.checkItem('alpha', true);
    expect(h.store.load().items[0].status).toBe('pass');
    expect(h.out()).toContain('✓ alpha: pass');
  });

  it('marks fail and appends the reason', () => {
    const h = harness();
    h.store.save({ items: items() });
    h.store.checkItem('alpha', false, 'boom');
    const item = h.store.load().items[0];
    expect(item.status).toBe('fail');
    expect(item.issues).toEqual(['boom']);
    expect(h.out()).toContain('✓ alpha: fail (boom)');
  });

  // The one non-obvious rule in the original: a later pass wipes the failure trail, so a recovered
  it('appends one issue per --fail call, capped at 3 by default', () => {
    const h = harness();
    h.store.save({ items: items() });
    h.store.checkItem('alpha', false, 'first src/a.ts:1');
    h.store.checkItem('alpha', false, 'second src/b.ts:2');
    h.store.checkItem('alpha', false, 'third src/c.ts:3');
    h.store.checkItem('alpha', false, 'fourth src/d.ts:4');
    const item = h.store.load().items.find((i: { name: string }) => i.name === 'alpha');
    expect(item.issues).toEqual(['first src/a.ts:1', 'second src/b.ts:2', 'third src/c.ts:3']);
    expect(h.out()).toContain('issue cap reached (3)');
  });

  it('GUARD_REVIEW_MAX_ISSUES_PER_LENS raises the cap (clamped to 1..10)', () => {
    const saved = process.env.GUARD_REVIEW_MAX_ISSUES_PER_LENS;
    process.env.GUARD_REVIEW_MAX_ISSUES_PER_LENS = '5';
    try {
      const h = harness();
      h.store.save({ items: items() });
      for (let i = 0; i < 6; i++) h.store.checkItem('alpha', false, `issue-${i}`);
      const item = h.store.load().items.find((i: { name: string }) => i.name === 'alpha');
      expect(item.issues).toHaveLength(5);
    } finally {
      if (saved === undefined) delete process.env.GUARD_REVIEW_MAX_ISSUES_PER_LENS;
      else process.env.GUARD_REVIEW_MAX_ISSUES_PER_LENS = saved;
    }
  });

  // item cannot keep failing `finalize` on stale issues from an earlier attempt.
  it('a recovery pass CLEARS the stale issue trail', () => {
    const h = harness();
    h.store.save({ items: items() });
    h.store.checkItem('alpha', false, 'boom');
    h.store.checkItem('alpha', true);
    expect(h.store.load().items[0].issues).toEqual([]);
  });

  it('an unknown item exits 1 and lists what IS available', () => {
    const h = harness();
    h.store.save({ items: items() });
    h.store.checkItem('nope', true);
    expect(h.exits).toEqual([1]);
    expect(h.out()).toContain('❌ Item not found: nope');
    expect(h.out()).toContain('alpha, beta');
  });

  it('a fail with no reason records the status without pushing an empty issue', () => {
    const h = harness();
    h.store.save({ items: items() });
    h.store.checkItem('alpha', false);
    expect(h.store.load().items[0].issues).toEqual([]);
  });
});

describe('createChecklistStore — finalize is the gate', () => {
  it('PASSES only when every item is resolved and issue-free', () => {
    const h = harness();
    h.store.save({ items: items() });
    h.store.checkItem('alpha', true);
    h.store.checkItem('beta', true);
    h.store.finalize();
    expect(h.exits).toEqual([]);
    expect(h.out()).toContain('✅ Test Review: All checks passed');
  });

  // sc-1438 follow-up: finalize is the mandatory terminal step in EVERY session, so a passing one
  // tidies the scratch artifact itself — the agent never decides when cleanup applies. The env
  // guards keep it exactly where it must survive (gate runs, review mode).
  it('a passing finalize removes the artifact automatically (interactive tidy)', () => {
    const h = harness();
    h.store.save({ items: items() });
    h.store.checkItem('alpha', true);
    h.store.checkItem('beta', true);
    h.store.finalize();
    expect(h.exits).toEqual([]);
    expect(existsSync(h.path)).toBe(false);
  });

  it('a passing finalize KEEPS the artifact under DEVKIT_CHECKLIST_KEEP=1 (gate runs)', () => {
    const h = harness();
    h.store.save({ items: items() });
    h.store.checkItem('alpha', true);
    h.store.checkItem('beta', true);
    process.env.DEVKIT_CHECKLIST_KEEP = '1';
    h.store.finalize();
    expect(h.exits).toEqual([]);
    expect(existsSync(h.path)).toBe(true);
  });

  it('a FAILING finalize leaves the artifact (both modes need the evidence)', () => {
    const h = harness();
    h.store.save({ items: items() });
    h.store.checkItem('alpha', false, 'boom');
    h.store.checkItem('beta', true);
    h.store.finalize();
    expect(h.exits).toEqual([1]);
    expect(existsSync(h.path)).toBe(true);
  });

  it('BLOCKS on a pending item, naming it', () => {
    const h = harness();
    h.store.save({ items: items() });
    h.store.checkItem('alpha', true);
    h.store.finalize();
    expect(h.exits).toEqual([1]);
    expect(h.out()).toContain('❌ Incomplete: 1 items pending');
    expect(h.out()).toContain('beta');
  });

  it('BLOCKS on a failed item, listing every issue', () => {
    const h = harness();
    h.store.save({ items: items() });
    h.store.checkItem('alpha', false, 'boom');
    h.store.checkItem('beta', true);
    h.store.finalize();
    expect(h.exits).toEqual([1]);
    expect(h.out()).toContain('❌ Failed: 1 issues');
    expect(h.out()).toContain('- boom');
  });

  // Pending is reported BEFORE failures: an unfinished review is a different problem from a failing
  // one, and reporting the failure first would tell the agent to fix code when it should finish work.
  it('reports pending before failures when both exist', () => {
    const h = harness();
    h.store.save({ items: items() });
    h.store.checkItem('alpha', false, 'boom');
    h.store.finalize();
    expect(h.out()).toContain('❌ Incomplete');
    expect(h.out()).not.toContain('❌ Failed');
  });
});

describe('createChecklistStore — status', () => {
  it('counts resolved over total and surfaces failures with their item name', () => {
    const h = harness();
    h.store.save({ items: items() });
    h.store.checkItem('alpha', false, 'boom');
    h.store.status();
    expect(h.out()).toContain('📋 Test Review: 1/2 | Failed: 1');
    expect(h.out()).toContain('- [alpha] boom');
  });

  it('omits the Issues block when nothing failed', () => {
    const h = harness();
    h.store.save({ items: items() });
    h.store.status();
    expect(h.out()).toContain('📋 Test Review: 0/2 | Failed: 0');
    expect(h.out()).not.toContain('Issues:');
  });
});

// sc-1438 follow-up: there is no public cleanup command any more — tidy is internal to finalize.
// These pin the tidy behaviors not already covered by the finalize describe above.
describe('createChecklistStore — finalize tidy specifics', () => {
  const passAll = (h: ReturnType<typeof harness>) => {
    h.store.save({ items: items() });
    h.store.checkItem('alpha', true);
    h.store.checkItem('beta', true);
  };

  // The review worktree is discarded wholesale and the checklist is the evidence a reader may still
  // want — so review mode must NOT delete it, even on a passing finalize.
  it('a passing finalize KEEPS the checklist under DEVKIT_RUN_MODE=review', () => {
    const h = harness();
    passAll(h);
    process.env.DEVKIT_RUN_MODE = 'review';
    h.store.finalize();
    expect(h.exits).toEqual([]);
    expect(existsSync(h.path)).toBe(true);
  });

  // Regression guard for the one string that is NOT derivable from the display label: api-security
  // says "Removed API security checklist", which label.toLowerCase() would mangle to "api security".
  it('cleanupLabel overrides the lowercased default in the tidy line', () => {
    const h = harness({ label: 'API Security', cleanupLabel: 'API security' });
    passAll(h);
    h.store.finalize();
    expect(h.out()).toContain('🗑️  Removed API security checklist');
  });

  it('defaults cleanupLabel to the lowercased label when not given', () => {
    const h = harness({ label: 'Backend Performance' });
    passAll(h);
    h.store.finalize();
    expect(h.out()).toContain('🗑️  Removed backend performance checklist');
  });
});
