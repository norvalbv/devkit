import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { selectedIds } from '../selection.mts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.DEVKIT_RUN_MODE;
  delete process.env.DEVKIT_REVIEW_GUARDS;
});

// A repo whose .devkit/config.json selects `guards` and, independently, anti-slop. Pass null with
// no antiSlop value for the missing-config path.
function repo(guards: string[] | null, antiSlop?: boolean): string {
  const d = mkdtempSync(join(tmpdir(), 'guard-selection-'));
  dirs.push(d);
  if (!guards && antiSlop === undefined) return d;
  mkdirSync(join(d, '.devkit'));
  const components = { guards: guards ?? undefined, antiSlop };
  writeFileSync(join(d, '.devkit', 'config.json'), JSON.stringify({ components }));
  return d;
}

describe('selectedIds', () => {
  // .devkit/config.json is external JSON: an inherited `components`/`guards`/`antiSlop` must
  // never change the gate set, at any layer.
  it('ignores inherited properties at every layer of the config', () => {
    const proto = Object.prototype;
    Object.defineProperty(proto, 'components', {
      value: { antiSlop: true, guards: ['size'] },
      configurable: true,
    });
    Object.defineProperty(proto, 'antiSlop', { value: true, configurable: true });
    Object.defineProperty(proto, 'guards', { value: ['size'], configurable: true });
    try {
      expect(selectedIds(repo(null))).toEqual(['size', 'fanout', 'dup', 'clone']);
      expect(selectedIds(repo(['clone']))).toEqual(['clone']);
      expect(selectedIds(repo([], false))).toEqual([]);
    } finally {
      delete proto.components;
      delete proto.antiSlop;
      delete proto.guards;
    }
  });

  it('intersects components.guards with the deterministic set in fixed order, dropping AI ids', () => {
    const d = repo(['clone', 'size', 'review']); // review is AI (fail-fast)
    expect(selectedIds(d)).toEqual(['size', 'clone']);
  });

  it('runs an explicitly-selected opt-in guard (coverage)', () => {
    expect(selectedIds(repo(['size', 'coverage']))).toEqual(['size', 'coverage']);
  });

  it('EXCLUDES opt-in coverage from the missing-config fallback (unadopted repo never wedged)', () => {
    expect(selectedIds(repo(null))).toEqual(['size', 'fanout', 'dup', 'clone']);
  });

  it('selects anti-slop only from its explicit component bit, never components.guards', () => {
    expect(selectedIds(repo([], true))).toEqual(['anti-slop']);
    expect(selectedIds(repo(['anti-slop'], false))).toEqual([]);
    expect(selectedIds(repo(['anti-slop']))).toEqual([]);
  });

  it('keeps anti-slop out of missing and unreadable config fallbacks', () => {
    expect(selectedIds(repo(null))).not.toContain('anti-slop');
    const d = repo([], true);
    writeFileSync(join(d, '.devkit', 'config.json'), '{ nope');
    expect(selectedIds(d)).toEqual(['size', 'fanout', 'dup', 'clone']);
  });

  it('selects comments from components.guards, but keeps it out of both fallbacks (opt-in)', () => {
    expect(selectedIds(repo(['size', 'comments']))).toEqual(['size', 'comments']);
    expect(selectedIds(repo(['review']))).toEqual([]);
    expect(selectedIds(repo(null))).not.toContain('comments');
    const d = repo(['comments']);
    writeFileSync(join(d, '.devkit', 'config.json'), '{ nope');
    expect(selectedIds(d)).not.toContain('comments');
  });

  it('review mode honours comments in the explicit allowlist, and only there', () => {
    const d = repo(['size', 'comments']);
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_GUARDS = 'comments,review';
    expect(selectedIds(d)).toEqual(['comments']);
    process.env.DEVKIT_REVIEW_GUARDS = 'size,review';
    expect(selectedIds(d)).toEqual(['size']);
  });

  it('dry-gates keeps the configured size gate: only review mode narrows to the allowlist', () => {
    const d = repo(['size', 'comments']);
    process.env.DEVKIT_RUN_MODE = 'dry-gates';
    process.env.DEVKIT_REVIEW_GUARDS = 'comments';
    expect(selectedIds(d)).toEqual(['size', 'comments']);
  });

  it('uses the explicit review allowlist instead of components.guards in review mode', () => {
    const d = repo(['size', 'fanout', 'dup', 'clone'], true);
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_GUARDS = ' clone, size ,review, anti-slop ';
    expect(selectedIds(d)).toEqual(['size', 'clone']);
    process.env.DEVKIT_REVIEW_GUARDS = '';
    expect(selectedIds(d)).toEqual([]);
    delete process.env.DEVKIT_REVIEW_GUARDS;
    expect(selectedIds(d)).toEqual([]);
  });
});
