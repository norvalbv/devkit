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
  it('includes the biome step + all guards when fully selected', () => {
    const block = buildGuardBlock(ALL);
    expect(block).toContain('# >>> devkit-guards >>>');
    expect(block).toContain('# <<< devkit-guards <<<');
    expect(block).toContain('# devkit:biome-format');
    for (const g of GUARD_IDS) expect(block).toContain(`bunx guard-${g}`);
  });

  it('omits the biome step when biome is deselected', () => {
    const block = buildGuardBlock({ biome: false, guards: [...GUARD_IDS] });
    expect(block).not.toContain('# devkit:biome-format');
    expect(block).not.toContain('biome format');
  });

  it('emits only the selected guards, in registry order', () => {
    const block = buildGuardBlock({ biome: true, guards: ['fanout', 'size'] });
    expect(block).toContain('bunx guard-size');
    expect(block).toContain('bunx guard-fanout');
    expect(block).not.toContain('bunx guard-dup');
    // registry order is size before fanout regardless of input order.
    expect(block.indexOf('guard-size')).toBeLessThan(block.indexOf('guard-fanout'));
  });

  it('always keeps the commented structure-lint placeholder', () => {
    expect(buildGuardBlock(ALL)).toMatch(/# bunx eslint src/);
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
  it('removes one guard fragment, leaving the others + markers intact', () => {
    const hook = buildFullHook(ALL);
    const { content, removed } = removeFragment(hook, 'guard-size');
    expect(removed).toBe(true);
    expect(content).not.toContain('bunx guard-size');
    expect(content).toContain('bunx guard-fanout');
    expect(content).toContain('# <<< devkit-guards <<<');
  });

  it('removes the biome-format step only', () => {
    const hook = buildFullHook(ALL);
    const { content, removed } = removeFragment(hook, 'biome-format');
    expect(removed).toBe(true);
    expect(content).not.toContain('biome format');
    expect(content).toContain('bunx guard-size');
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
    const next = replaceGuardBlock(once, buildGuardBlock({ biome: true, guards: ['size'] }));
    expect(next).toContain('bunx guard-size');
    expect(next).not.toContain('bunx guard-clone');
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

describe('guard fragments fail CLOSED on unexpected exit codes (#8)', () => {
  it('blocks on exit 1 AND any non-0/2 code; only 0/2 continue', () => {
    const block = buildGuardBlock({ guards: ['size'] });
    // exit 1 → accumulate; unexpected (not 0/2) → accumulate (named); 0/2 are the only clean
    // codes. The aggregated det-verdict then blocks once for every accumulated failure.
    expect(block).toMatch(/\[ "\$rc" -eq 1 \]/);
    expect(block).toMatch(/\[ "\$rc" -ne 0 \] && \[ "\$rc" -ne 2 \]/);
    expect(block).toContain(`DK_DET_FAILS="\${DK_DET_FAILS:-} guard-size"`);
    expect(block).toContain('deterministic gates failed');
  });
});

describe('hasFragment', () => {
  it('detects present + absent guard sentinels', () => {
    const hook = buildFullHook({ biome: true, guards: ['dup'] });
    expect(hasFragment(hook, 'guard-dup')).toBe(true);
    expect(hasFragment(hook, 'guard-clone')).toBe(false);
  });
});

// husky runs hooks under `sh -e`. A bare `bunx guard-X gate` whose fail-open exit (2) returns
// non-zero would ABORT the whole hook before the fragment's exit-code check — the fragment's
// "exit 2 = fail-open, continue" intent never runs (this regressed frink: every commit died at
// guard-dup's exit-2 opt-out). The fix is `rc=0; bunx … || rc=$?`. These run the assembled hook
// under a real `sh -e` with a stubbed `bunx`.
describe('guard fragments are set -e-safe (fail-open does not abort the hook)', () => {
  // Build a fresh hook (guards only — biome/git steps need a repo) into a temp $HOME so the hook's
  // own PATH_SETUP prepends OUR stub bunx (in $HOME/.bun/bin), then run it under `sh -e`.
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

  it('a guard fail-open (exit 2) lets the hook continue to exit 0', () => {
    expect(runHookWithStubBunx(2)).toBe(0);
  });

  it('a guard violation (exit 1) still blocks the commit (exit 1)', () => {
    expect(runHookWithStubBunx(1)).toBe(1);
  });

  it('an unexpected guard code (e.g. 127) fails closed (blocks)', () => {
    expect(runHookWithStubBunx(127)).toBe(1);
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
});
