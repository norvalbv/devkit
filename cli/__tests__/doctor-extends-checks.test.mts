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

const PKG_TSCONFIG = '@norvalbv/devkit/tsconfig/base';

describe('expectedExtends — the pointer both check and repair agree on', () => {
  it('uses the one package tsconfig base for every stack in package mode', () => {
    expect(expectedExtends('react-app', false).tsconfig).toBe(PKG_TSCONFIG);
    expect(expectedExtends('generic', false)).toEqual({ tsconfig: PKG_TSCONFIG });
  });

  // Standalone vendors the configs into .devkit/ instead of resolving a package subpath — the whole
  // point of the mode is that there is no dependency to extend from.
  it('points at vendored relative paths in standalone mode', () => {
    expect(expectedExtends('node-service', true).tsconfig).toBe('./.devkit/tsconfig/node.json');
    expect(expectedExtends('next', true).tsconfig).toBe('./.devkit/tsconfig/next.json');
    expect(expectedExtends('generic', true).tsconfig).toBe('./.devkit/tsconfig/base.json');
  });

  it('names a repairable file for each key it can produce', () => {
    expect(new Set(Object.values(EXTENDS_REPAIRABLE))).toEqual(new Set(['tsconfig']));
  });
});

describe('checkExtends', () => {
  it('reports MISSING and stays fixable when the file is absent', () => {
    const root = mkTmp('doctor-extends-absent-');
    const r = checkExtends(root, 'tsconfig.json', PKG_TSCONFIG);
    expect(r.status).toBe('MISSING');
    expect(r.fixable).toBe(true);
  });

  it('accepts the pointer as a bare string or inside an array', () => {
    const a = withConfig('tsconfig.json', JSON.stringify({ extends: PKG_TSCONFIG }));
    expect(checkExtends(a.root, 'tsconfig.json', PKG_TSCONFIG).status).toBe('OK');
    const b = withConfig('tsconfig.json', JSON.stringify({ extends: ['./local', PKG_TSCONFIG] }));
    expect(checkExtends(b.root, 'tsconfig.json', PKG_TSCONFIG).status).toBe('OK');
  });

  // The jsonc half: tsconfig.json legitimately carries // comments, so a strict JSON.parse would
  // report every commented config as invalid.
  it('tolerates // comments in a jsonc config', () => {
    const { root } = withConfig(
      'tsconfig.json',
      `{\n  // devkit-owned pointer\n  "extends": "${PKG_TSCONFIG}"\n}\n`,
    );
    expect(checkExtends(root, 'tsconfig.json', PKG_TSCONFIG).status).toBe('OK');
  });

  it('reports DRIFT naming the value it found', () => {
    const { root } = withConfig('tsconfig.json', JSON.stringify({ extends: './something-else' }));
    const r = checkExtends(root, 'tsconfig.json', PKG_TSCONFIG);
    expect(r.status).toBe('DRIFT');
    expect(r.detail).toContain('./something-else');
    expect(r.remediation).toContain(PKG_TSCONFIG);
  });

  it('reports invalid JSON as DRIFT rather than throwing', () => {
    const { root } = withConfig('tsconfig.json', '{ "extends": [oops }');
    const r = checkExtends(root, 'tsconfig.json', PKG_TSCONFIG);
    expect(r.status).toBe('DRIFT');
    expect(r.detail).toContain('invalid JSON');
  });

  // configOverrides marks deliberate hand-ownership — but only AFTER syntax validation, so an
  // override can never launder a file that does not parse.
  it('honours configOverrides, but never ahead of a syntax error', () => {
    const ok = withConfig('tsconfig.json', JSON.stringify({ extends: './mine' }));
    expect(checkExtends(ok.root, 'tsconfig.json', PKG_TSCONFIG, 'extends', true).status).toBe('OK');
    const bad = withConfig('tsconfig.json', '{ nope');
    expect(checkExtends(bad.root, 'tsconfig.json', PKG_TSCONFIG, 'extends', true).status).toBe(
      'DRIFT',
    );
  });
});

describe('repairExtends — the only function here that writes to a consumer config', () => {
  it('swaps the devkit token and leaves comments and consumer keys intact', () => {
    const { root, path } = withConfig(
      'tsconfig.json',
      `{\n  // keep me\n  "extends": "@norvalbv/devkit/tsconfig/node",\n  "linter": { "rules": {} }\n}\n`,
    );
    expect(repairExtends(path, PKG_TSCONFIG)).toBe(true);
    const after = readFileSync(path, 'utf8');
    expect(after).toContain(PKG_TSCONFIG);
    expect(after).toContain('// keep me');
    expect(after).toContain('"linter"');
    // The repair must satisfy the check, or --fix reports the same drift forever.
    expect(checkExtends(root, 'tsconfig.json', PKG_TSCONFIG).status).toBe('OK');
  });

  it('repairs the devkit entry inside an array without disturbing its siblings', () => {
    const { path } = withConfig(
      'tsconfig.json',
      JSON.stringify({ extends: ['./local.json', '@norvalbv/devkit/tsconfig/node'] }, null, 2),
    );
    expect(repairExtends(path, PKG_TSCONFIG)).toBe(true);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.extends).toEqual(['./local.json', PKG_TSCONFIG]);
  });

  // Every no-op path returns false so --fix never claims a repair it did not perform.
  it.each([
    ['the file is absent', null, PKG_TSCONFIG],
    [
      'it already extends the expected pointer',
      JSON.stringify({ extends: PKG_TSCONFIG }),
      PKG_TSCONFIG,
    ],
    ['no devkit token is present', JSON.stringify({ extends: './only-mine' }), PKG_TSCONFIG],
    ['extends is absent entirely', JSON.stringify({ linter: {} }), PKG_TSCONFIG],
    ['the file does not parse', '{ broken', PKG_TSCONFIG],
  ])('returns false when %s', (_why, body, expected) => {
    const root = mkTmp('doctor-extends-noop-');
    const path = join(root, 'tsconfig.json');
    if (body !== null) writeFileSync(path, body);
    expect(repairExtends(path, expected)).toBe(false);
  });

  it('does not rewrite a file it decided not to repair', () => {
    const { path } = withConfig('tsconfig.json', JSON.stringify({ extends: './only-mine' }));
    const before = readFileSync(path, 'utf8');
    expect(repairExtends(path, PKG_TSCONFIG)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});
