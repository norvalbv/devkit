import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUARD_IDS } from '../lib/components.mjs';
import {
  buildFullHook,
  buildGuardBlock,
  buildOverlayHook,
  findPreambleEnd,
  hasFragment,
  removeFragment,
  removeGuardBlock,
  replaceGuardBlock,
} from '../lib/husky/husky-block.mjs';

const ALL = { biome: true, guards: [...GUARD_IDS] };

// A reviewer-gate hook in frink's shape: shebang + a PATH-setup for-loop + a gate that EARLY-EXITS
// `exit 0` (indented, reviews-pass) before a top-level `exit 1`. The bug: a block appended at EOF (or
// "before the first top-level exit") never runs on a reviews-pass commit.
const FRINK_HOOK = `#!/bin/bash

# Prepend user bin dirs so bun/bunx resolve under GUI git clients.
for dir in "$HOME/.bun/bin" "$HOME/.local/bin"; do
    [ -d "$dir" ] && case ":$PATH:" in *":$dir:"*) ;; *) PATH="$dir:$PATH" ;; esac
done
export PATH

echo "🎨 formatting..."
MISSING=()
if [ \${#MISSING[@]} -eq 0 ]; then
    echo "all reviews passed"
    exit 0
fi
echo "missing reviews"
exit 1
`;

describe('buildGuardBlock', () => {
  it('includes the biome step, the deterministic orchestrator, and the AI guards when fully selected', () => {
    const block = buildGuardBlock(ALL);
    expect(block).toContain('# >>> devkit-guards >>>');
    expect(block).toContain('# <<< devkit-guards <<<');
    expect(block).toContain('# devkit:biome-format');
    // Deterministic guards (size/fanout/dup/clone) run through the ONE orchestrator, not per-guard.
    expect(block).toContain('bunx guard-deterministic --hook');
    expect(block).not.toContain('bunx guard-size');
    expect(block).not.toContain('bunx guard-fanout');
    // AI guards keep their own fail-fast fragments.
    expect(block).toContain('bunx guard-decisions');
    expect(block).toContain('bunx guard-review');
  });

  it('omits the biome step when biome is deselected', () => {
    const block = buildGuardBlock({ biome: false, guards: [...GUARD_IDS] });
    expect(block).not.toContain('# devkit:biome-format');
    expect(block).not.toContain('biome format');
  });

  it('emits ONE deterministic line for any selected deterministic guard, gated `|| exit 1`', () => {
    const block = buildGuardBlock({ biome: true, guards: ['fanout', 'size'] });
    const lines = block.split('\n').filter((l) => l.includes('guard-deterministic'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\|\| exit 1$/);
    // no AI guards selected → no AI fragment
    expect(block).not.toContain('bunx guard-decisions');
  });

  it('emits NO deterministic line when only AI guards are selected', () => {
    const block = buildGuardBlock({ biome: false, guards: ['decisions'] });
    expect(block).not.toContain('guard-deterministic');
    expect(block).toContain('bunx guard-decisions');
  });

  it('joins the structure command to the deterministic line via --structure when set', () => {
    const off = buildGuardBlock({ guards: ['size'] });
    expect(off).not.toContain('--structure');
    const on = buildGuardBlock({ guards: ['size'], structureCmd: 'guard-structure gate' });
    expect(on).toContain('--structure "guard-structure gate"');
    const electron = buildGuardBlock({ guards: ['size'], structureCmd: 'bunx eslint src' });
    expect(electron).toContain('--structure "bunx eslint src"');
  });

  it('emits the deterministic line for structure even with NO deterministic guard selected', () => {
    const block = buildGuardBlock({ guards: ['decisions'], structureCmd: 'guard-structure gate' });
    expect(block).toContain('bunx guard-deterministic --hook');
    expect(block).toContain('--structure "guard-structure gate"');
  });

  it('monorepo package block captures the hook path ABSOLUTE before cd (guard-prefix stays live)', () => {
    const block = buildGuardBlock({ guards: ['size'] }, 'pkg/a');
    // $0 is git-root-relative; after `cd pkg/a` it no longer resolves — the wrapper must pin it.
    const iHookPath = block.indexOf('DK_HOOK_PATH=');
    expect(iHookPath).toBeGreaterThan(-1);
    expect(iHookPath).toBeLessThan(block.indexOf('( cd "pkg/a"'));
    expect(block).toContain(`--hook "\${DK_HOOK_PATH:-$0}"`);
  });
});

describe('buildFullHook', () => {
  it('wraps the block in a shebang preamble + trailing exit 0', () => {
    const hook = buildFullHook(ALL);
    expect(hook.startsWith('#!/bin/sh')).toBe(true);
    expect(hook.trimEnd().endsWith('exit 0')).toBe(true);
    expect(hook).toContain('# >>> devkit-guards >>>');
  });
});

describe('removeFragment', () => {
  it('removes one AI guard fragment, leaving the others + markers intact', () => {
    const hook = buildFullHook(ALL);
    const { content, removed } = removeFragment(hook, 'guard-decisions');
    expect(removed).toBe(true);
    expect(content).not.toContain('bunx guard-decisions');
    expect(content).toContain('bunx guard-review');
    expect(content).toContain('bunx guard-deterministic');
    expect(content).toContain('# <<< devkit-guards <<<');
  });

  it('removes the deterministic fragment only', () => {
    const hook = buildFullHook(ALL);
    const { content, removed } = removeFragment(hook, 'deterministic');
    expect(removed).toBe(true);
    expect(content).not.toContain('bunx guard-deterministic');
    expect(content).toContain('bunx guard-decisions');
  });

  it('removes the biome-format step only', () => {
    const hook = buildFullHook(ALL);
    const { content, removed } = removeFragment(hook, 'biome-format');
    expect(removed).toBe(true);
    expect(content).not.toContain('biome format');
    expect(content).toContain('bunx guard-deterministic');
  });

  it('is a no-op (removed:false) when the fragment is absent', () => {
    const hook = buildFullHook({ biome: false, guards: ['fanout'] });
    expect(removeFragment(hook, 'guard-clone').removed).toBe(false);
  });
});

describe('removeGuardBlock', () => {
  it('strips the whole block but preserves consumer lines outside it', () => {
    const consumer = '#!/bin/sh\necho mine\n';
    const hook = `${consumer}\n${buildGuardBlock(ALL)}\n\nexit 0\n`;
    const { content, removed } = removeGuardBlock(hook);
    expect(removed).toBe(true);
    expect(content).toContain('echo mine');
    expect(content).toContain('exit 0');
    expect(content).not.toContain('devkit-guards');
  });
});

describe('findPreambleEnd', () => {
  const at = (hook) => hook.slice(findPreambleEnd(hook), findPreambleEnd(hook) + 40);
  it('stops after shebang + comment + the PATH for-loop, before the first command', () => {
    // The for-loop line itself contains `$HOME/.bun` (a preamble shape) but must be tracked as a loop
    // so its body + `done` + `export PATH` are all consumed — then the `echo` is the boundary.
    expect(at(FRINK_HOOK)).toMatch(/echo "🎨 formatting/);
  });
  it('shebang-only → just after the shebang line', () => {
    expect(findPreambleEnd('#!/bin/sh\necho hi\n')).toBe('#!/bin/sh'.length + 1);
  });
  it('whole-file-is-preamble → EOF', () => {
    const p = '#!/bin/sh\n# only comments\nexport PATH\n';
    expect(findPreambleEnd(p)).toBe(p.length);
  });
  it('no shebang, first line a command → very top (0)', () => {
    expect(findPreambleEnd('run_thing\necho x\n')).toBe(0);
  });
});

describe('replaceGuardBlock — relocate after the preamble (reachability)', () => {
  it('on a reviewer-gate hook that early-exits, the block lands AFTER the PATH preamble and BEFORE the gate', () => {
    const out = replaceGuardBlock(FRINK_HOOK, buildGuardBlock(ALL));
    const iBlock = out.indexOf('# >>> devkit-guards >>>');
    expect(iBlock).toBeGreaterThan(out.indexOf('export PATH')); // PATH set up first
    expect(iBlock).toBeLessThan(out.indexOf('echo "🎨 formatting')); // before consumer logic
    expect(iBlock).toBeLessThan(out.indexOf('MISSING=')); // before the gate
    // The reviews-pass `exit 0` is INDENTED (inside the `if`) — the block must precede it so it runs
    // even when reviews pass (the bug was the block sitting after this early exit).
    expect(iBlock).toBeLessThan(out.indexOf('exit 0'));
    expect((out.match(/# >>> devkit-guards/g) || []).length).toBe(1);
  });
  it('does NOT inject a duplicate PATH setup when the hook already has one', () => {
    const out = replaceGuardBlock(FRINK_HOOK, buildGuardBlock(ALL));
    expect((out.match(/export PATH/g) || []).length).toBe(1);
  });
  it('injects PATH_SETUP before the block when the hook has none', () => {
    const out = replaceGuardBlock('#!/bin/sh\nrun_thing\n', buildGuardBlock(ALL));
    expect(out).toMatch(/export PATH/);
    expect(out.indexOf('>>> devkit-guards')).toBeGreaterThan(out.indexOf('export PATH'));
    expect(out.indexOf('>>> devkit-guards')).toBeLessThan(out.indexOf('run_thing'));
  });
  it('is idempotent — re-running yields identical bytes', () => {
    const once = replaceGuardBlock(FRINK_HOOK, buildGuardBlock(ALL));
    expect(replaceGuardBlock(once, buildGuardBlock(ALL))).toBe(once);
  });
  it('swaps content on re-run (markers present) without duplicating', () => {
    const once = replaceGuardBlock(FRINK_HOOK, buildGuardBlock(ALL));
    const next = replaceGuardBlock(once, buildGuardBlock({ biome: true, guards: ['decisions'] }));
    expect(next).toContain('bunx guard-decisions');
    expect(next).not.toContain('guard-deterministic'); // only an AI guard now → no det line
    expect((next.match(/# >>> devkit-guards/g) || []).length).toBe(1);
  });
  it('monorepo: scoped markers, still reachable before consumer logic', () => {
    const out = replaceGuardBlock(
      FRINK_HOOK,
      buildGuardBlock({ guards: ['size'] }, 'pkg/a'),
      'pkg/a',
    );
    expect(out).toContain('# >>> devkit-guards: pkg/a >>>');
    expect(out.indexOf('devkit-guards: pkg/a')).toBeLessThan(out.indexOf('echo "🎨 formatting'));
  });
});

// The deterministic set fails CLOSED at the orchestrator: the single `guard-deterministic` line is
// `|| exit 1`-guarded, so its exit 1 (one or more real failures, aggregated inside the bin) blocks
// the commit. The per-gate trichotomy/aggregation itself is proven in
// gate-engine/deterministic/__tests__/run.test.mjs.
describe('deterministic orchestrator line is fail-closed', () => {
  it('the guard-deterministic line propagates a real failure via `|| exit 1`', () => {
    const block = buildGuardBlock({ guards: ['size'] });
    const line = block.split('\n').find((l) => l.includes('guard-deterministic'));
    expect(line).toMatch(/\|\| exit 1$/);
  });
});

describe('hasFragment', () => {
  it('detects the deterministic + AI sentinels', () => {
    const det = buildFullHook({ biome: true, guards: ['dup'] });
    expect(hasFragment(det, 'deterministic')).toBe(true);
    expect(hasFragment(det, 'guard-decisions')).toBe(false);
    const ai = buildFullHook({ biome: false, guards: ['decisions'] });
    expect(hasFragment(ai, 'guard-decisions')).toBe(true);
    expect(hasFragment(ai, 'deterministic')).toBe(false);
  });
});

// husky runs hooks under `sh -e`. The AI fragments capture their code with `rc=0; bunx … || rc=$?`
// so a fail-open code (2) never aborts the hook before the fragment's own check; the deterministic
// line guards itself with `|| exit 1`. Run the assembled hook under a real `sh -e` with a stubbed
// `bunx` to prove neither aborts prematurely.
describe('assembled hook is set -e-safe', () => {
  const runHookWithStubBunx = (stubExit) => {
    const home = mkdtempSync(join(tmpdir(), 'dk-husky-'));
    const bin = join(home, '.bun', 'bin');
    mkdirSync(bin, { recursive: true });
    const bunx = join(bin, 'bunx');
    writeFileSync(bunx, `#!/bin/sh\nexit ${stubExit}\n`);
    chmodSync(bunx, 0o755);
    const hookPath = join(home, 'pre-commit');
    writeFileSync(hookPath, buildFullHook({ biome: false, guards: [...GUARD_IDS] }));
    try {
      execFileSync('sh', ['-e', hookPath], {
        env: { ...process.env, HOME: home, PATH: '/usr/bin:/bin' },
        stdio: 'pipe',
      });
      return 0;
    } catch (e) {
      return e.status;
    }
  };

  it('every gate clean (exit 0) → the hook runs to completion (exit 0)', () => {
    expect(runHookWithStubBunx(0)).toBe(0);
  });

  it('a gate returning non-zero blocks the commit (exit 1), never aborts silently mid-hook', () => {
    // guard-deterministic exit 1 → `|| exit 1`; and were it to reach an AI gate, that too exits 1.
    expect(runHookWithStubBunx(1)).toBe(1);
  });
});

describe('buildOverlayHook — gates-only guard for the global init.sh shim', () => {
  const hook = buildOverlayHook({ guards: [...GUARD_IDS] }, '.husky/pre-commit');
  const guardIdx = hook.indexOf('DEVKIT_VIA_HUSKY_INIT');
  const chainIdx = hook.indexOf('exec sh');

  it('emits the gates-only env guard (gates passed via the shim → exit 0, husky runs the committed hook)', () => {
    expect(guardIdx).toBeGreaterThan(-1);
    expect(hook).toContain('&& exit 0');
  });

  it('places the guard BEFORE the chain exec (the chain runs only when the env is unset)', () => {
    expect(chainIdx).toBeGreaterThan(guardIdx);
  });

  it('still chains to the repo hook for the normal (non-shim) path', () => {
    expect(hook).toContain('exec sh ".husky/pre-commit" "$@"');
  });

  it('runs the deterministic orchestrator command -v-guarded (global bin)', () => {
    expect(hook).toContain('command -v guard-deterministic');
  });

  it('does NOT forward structure to the orchestrator (overlay is deliberately structure-free)', () => {
    // The overlay is non-invasive and sets up no structure config, so buildOverlayHook calls
    // standaloneDeterministicLines() with no command — passing structureCmd must not leak a
    // --structure arg in. Lock the intentional omission so it is not re-added by accident.
    const withStruct = buildOverlayHook(
      { guards: [...GUARD_IDS], structureCmd: 'guard-structure gate' },
      '.husky/pre-commit',
    );
    expect(withStruct).not.toContain('--structure');
  });
});
