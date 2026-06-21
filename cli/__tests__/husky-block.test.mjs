import { describe, expect, it } from 'vitest';
import { GUARD_IDS } from '../lib/components.mjs';
import {
  buildFullHook,
  buildGuardBlock,
  hasFragment,
  removeFragment,
  removeGuardBlock,
  replaceGuardBlock,
} from '../lib/husky/husky-block.mjs';

const ALL = { biome: true, guards: [...GUARD_IDS] };

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

describe('replaceGuardBlock', () => {
  it('swaps the block in place, keeping surrounding lines', () => {
    const hook = `head\n${buildGuardBlock(ALL)}\ntail\n`;
    const next = replaceGuardBlock(hook, buildGuardBlock({ biome: true, guards: ['size'] }));
    expect(next.startsWith('head\n')).toBe(true);
    expect(next.trimEnd().endsWith('tail')).toBe(true);
    expect(next).toContain('bunx guard-size');
    expect(next).not.toContain('bunx guard-clone');
  });

  it('appends the block when none exists', () => {
    const next = replaceGuardBlock('#!/bin/sh\necho x\n', buildGuardBlock(ALL));
    expect(next).toContain('echo x');
    expect(next).toContain('# >>> devkit-guards >>>');
  });
});

describe('hasFragment', () => {
  it('detects present + absent guard sentinels', () => {
    const hook = buildFullHook({ biome: true, guards: ['dup'] });
    expect(hasFragment(hook, 'guard-dup')).toBe(true);
    expect(hasFragment(hook, 'guard-clone')).toBe(false);
  });
});
