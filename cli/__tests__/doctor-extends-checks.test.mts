/**
 * Unit tests for the extends cluster this change lifted out of doctor.mts.
 *
 * These were never unit-tested — only reached indirectly through init-doctor's `devkit init`
 * subprocesses, which measured 47.5% statement coverage and left `repairExtends` entirely
 * unexecuted. That is the one function here that WRITES to a consumer's config, so it is the last
 * one that should be running on inference.
 *
 * Check and repair are tested against each other deliberately: a repair that writes a value the
 * check would still call drift is a `--fix` that never converges, and only pairing them catches it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkExtends,
  EXTENDS_REPAIRABLE,
  expectedExtends,
  repairExtends,
} from '../lib/doctor/extends-checks.mts';
import { rootRegistry } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

/** A repo holding one config file, returned with its absolute path. */
function withConfig(file: string, body: string): { root: string; path: string } {
  const root = mkTmp('doctor-extends-');
  const path = join(root, file);
  writeFileSync(path, body);
  return { root, path };
}

const PKG_BIOME = '@norvalbv/devkit/biome/base';

describe('expectedExtends — the pointer both check and repair agree on', () => {
  it('splits react vs base by stack in package mode', () => {
    expect(expectedExtends('react-app', false).biome).toBe('@norvalbv/devkit/biome/react');
    expect(expectedExtends('component-lib', false).biome).toBe('@norvalbv/devkit/biome/react');
    expect(expectedExtends('generic', false).biome).toBe(PKG_BIOME);
    expect(expectedExtends('generic', false).tsconfig).toBe('@norvalbv/devkit/tsconfig/base');
  });

  // Standalone vendors the configs into .devkit/ instead of resolving a package subpath — the whole
  // point of the mode is that there is no dependency to extend from.
  it('points at vendored relative paths in standalone mode', () => {
    expect(expectedExtends('electron', true).biome).toBe('./.devkit/biome/react.jsonc');
    expect(expectedExtends('node-service', true).tsconfig).toBe('./.devkit/tsconfig/node.json');
    expect(expectedExtends('next', true).tsconfig).toBe('./.devkit/tsconfig/next.json');
    expect(expectedExtends('generic', true).biome).toBe('./.devkit/biome/base.jsonc');
  });

  it('names a repairable file for each key it can produce', () => {
    expect(new Set(Object.values(EXTENDS_REPAIRABLE))).toEqual(new Set(['biome', 'tsconfig']));
  });
});

describe('checkExtends', () => {
  it('reports MISSING and stays fixable when the file is absent', () => {
    const root = mkTmp('doctor-extends-absent-');
    const r = checkExtends(root, 'biome.jsonc', PKG_BIOME);
    expect(r.status).toBe('MISSING');
    expect(r.fixable).toBe(true);
  });

  it('accepts the pointer as a bare string or inside an array', () => {
    const a = withConfig('biome.jsonc', JSON.stringify({ extends: PKG_BIOME }));
    expect(checkExtends(a.root, 'biome.jsonc', PKG_BIOME).status).toBe('OK');
    const b = withConfig('biome.jsonc', JSON.stringify({ extends: ['./local', PKG_BIOME] }));
    expect(checkExtends(b.root, 'biome.jsonc', PKG_BIOME).status).toBe('OK');
  });

  // The jsonc half: biome.jsonc legitimately carries // comments, so a strict JSON.parse would
  // report every commented config as invalid.
  it('tolerates // comments in a jsonc config', () => {
    const { root } = withConfig(
      'biome.jsonc',
      `{\n  // devkit-owned pointer\n  "extends": "${PKG_BIOME}"\n}\n`,
    );
    expect(checkExtends(root, 'biome.jsonc', PKG_BIOME).status).toBe('OK');
  });

  it('reports DRIFT naming the value it found', () => {
    const { root } = withConfig('biome.jsonc', JSON.stringify({ extends: './something-else' }));
    const r = checkExtends(root, 'biome.jsonc', PKG_BIOME);
    expect(r.status).toBe('DRIFT');
    expect(r.detail).toContain('./something-else');
    expect(r.remediation).toContain(PKG_BIOME);
  });

  it('reports invalid JSON as DRIFT rather than throwing', () => {
    const { root } = withConfig('biome.jsonc', '{ "extends": [oops }');
    const r = checkExtends(root, 'biome.jsonc', PKG_BIOME);
    expect(r.status).toBe('DRIFT');
    expect(r.detail).toContain('invalid JSON');
  });

  // configOverrides marks deliberate hand-ownership — but only AFTER syntax validation, so an
  // override can never launder a file that does not parse.
  it('honours configOverrides, but never ahead of a syntax error', () => {
    const ok = withConfig('biome.jsonc', JSON.stringify({ extends: './mine' }));
    expect(checkExtends(ok.root, 'biome.jsonc', PKG_BIOME, 'extends', true).status).toBe('OK');
    const bad = withConfig('biome.jsonc', '{ nope');
    expect(checkExtends(bad.root, 'biome.jsonc', PKG_BIOME, 'extends', true).status).toBe('DRIFT');
  });
});

describe('repairExtends — the only function here that writes to a consumer config', () => {
  it('swaps the devkit token and leaves comments and consumer keys intact', () => {
    const { root, path } = withConfig(
      'biome.jsonc',
      `{\n  // keep me\n  "extends": "@norvalbv/devkit/biome/react",\n  "linter": { "rules": {} }\n}\n`,
    );
    expect(repairExtends(path, PKG_BIOME)).toBe(true);
    const after = readFileSync(path, 'utf8');
    expect(after).toContain(PKG_BIOME);
    expect(after).toContain('// keep me');
    expect(after).toContain('"linter"');
    // The repair must satisfy the check, or --fix reports the same drift forever.
    expect(checkExtends(root, 'biome.jsonc', PKG_BIOME).status).toBe('OK');
  });

  it('repairs the devkit entry inside an array without disturbing its siblings', () => {
    const { path } = withConfig(
      'biome.jsonc',
      JSON.stringify({ extends: ['./local.json', '@norvalbv/devkit/biome/react'] }, null, 2),
    );
    expect(repairExtends(path, PKG_BIOME)).toBe(true);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.extends).toEqual(['./local.json', PKG_BIOME]);
  });

  // Every no-op path returns false so --fix never claims a repair it did not perform.
  it.each([
    ['the file is absent', null, PKG_BIOME],
    ['it already extends the expected pointer', JSON.stringify({ extends: PKG_BIOME }), PKG_BIOME],
    ['no devkit token is present', JSON.stringify({ extends: './only-mine' }), PKG_BIOME],
    ['extends is absent entirely', JSON.stringify({ linter: {} }), PKG_BIOME],
    ['the file does not parse', '{ broken', PKG_BIOME],
  ])('returns false when %s', (_why, body, expected) => {
    const root = mkTmp('doctor-extends-noop-');
    const path = join(root, 'biome.jsonc');
    if (body !== null) writeFileSync(path, body);
    expect(repairExtends(path, expected)).toBe(false);
  });

  it('does not rewrite a file it decided not to repair', () => {
    const { path } = withConfig('biome.jsonc', JSON.stringify({ extends: './only-mine' }));
    const before = readFileSync(path, 'utf8');
    expect(repairExtends(path, PKG_BIOME)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});
