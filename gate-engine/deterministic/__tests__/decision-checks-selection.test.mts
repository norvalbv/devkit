/**
 * decision-checks is armed by the decisions guard, never by its own absence of config: it stays out
 * of every fallback, joins review only through DEVKIT_REVIEW_GUARDS, and owns its name and bypass.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configExtraGates } from '../command-gates.mts';
import { prefixCacheScope } from '../run.mts';
import { selectedIds } from '../selection.mts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.DEVKIT_RUN_MODE;
  delete process.env.DEVKIT_REVIEW_GUARDS;
  delete process.env.GUARD_DECISION_CHECKS_OK;
  vi.restoreAllMocks();
});

function repo(config?: string): string {
  const d = mkdtempSync(join(tmpdir(), 'decision-checks-'));
  dirs.push(d);
  if (config !== undefined) {
    mkdirSync(join(d, '.devkit'));
    writeFileSync(join(d, '.devkit', 'config.json'), config);
  }
  return d;
}
const guards = (...g: string[]) => repo(JSON.stringify({ components: { guards: g } }));

describe('decision-checks selection', () => {
  it('is selected only when components.guards includes decisions', () => {
    expect(selectedIds(guards('size', 'decisions'))).toEqual(['size', 'decision-checks']);
    expect(selectedIds(guards('size', 'review'))).toEqual(['size']);
  });

  it('stays out of the missing- and unreadable-config fallbacks', () => {
    expect(selectedIds(repo())).not.toContain('decision-checks');
    expect(selectedIds(repo('{ nope'))).not.toContain('decision-checks');
  });

  it('review mode arms it from DEVKIT_REVIEW_GUARDS=decisions alone', () => {
    const d = guards('size');
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_GUARDS = 'decisions';
    expect(selectedIds(d)).toEqual(['decision-checks']);
    process.env.DEVKIT_REVIEW_GUARDS = 'size,review';
    expect(selectedIds(d)).toEqual(['size']);
  });

  it('rejects decision-checks as an extraGates label', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo();
    writeFileSync(join(d, 'guard.config.json'), '{ "extraGates": { "decision-checks": "true" } }');
    expect(configExtraGates(d)).toEqual([{ label: 'extraGates' }]);
    expect(err.mock.calls.flat().join('\n')).toContain('extraGates.decision-checks:');
  });

  it('salts the prefix-cache scope under GUARD_DECISION_CHECKS_OK', () => {
    const plain = prefixCacheScope('s');
    process.env.GUARD_DECISION_CHECKS_OK = '1';
    expect(prefixCacheScope('s')).toBe('s:DECISION_CHECKS_OK-bypassed');
    expect(prefixCacheScope('s')).not.toBe(plain);
  });
});
