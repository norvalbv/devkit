/**
 * The `extends`-pointer half of `devkit doctor`: what biome.jsonc / tsconfig.json SHOULD extend for
 * a given stack and install mode, whether they do, and the one in-place repair `--fix` performs.
 *
 * Split out of doctor.mts, which is at its line budget — the same reason self-host-doctor.mts lives
 * beside it. Check and repair travel together because they must agree on the expected pointer: a
 * repair that writes a value the check would still call drift is a `--fix` that never converges.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CheckResult, check } from './check-result.mts';

/** A jsonc/json config carrying an `extends` base pointer; the index signature lets checkExtends
 * read an arbitrary `key` (defaults to "extends") out of the parsed object. */
export interface ConfigWithExtends {
  extends?: string | string[];
  [key: string]: unknown;
}

/** The devkit-owned `extends` pointer for each emitted config, by install mode. */
export interface ExpectedExtends {
  biome: string;
  tsconfig: string;
}

// Strip // line comments so a jsonc config parses as JSON.
const JSONC_LINE_COMMENT_RE = /^\s*\/\/.*$/gm;
function jsoncText(path: string): string {
  return readFileSync(path, 'utf8').replace(JSONC_LINE_COMMENT_RE, '');
}

// Tolerant read for repair only; drift checks parse strictly and report syntax errors.
function readJsonc(path: string): ConfigWithExtends | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(jsoncText(path)) as ConfigWithExtends;
  } catch {
    return null;
  }
}

// Expected extends are shared by check and repair. Package Biome presets mirror templates by stack;
// standalone uses separately vendored .devkit paths, so keep its stack list aligned with standalone.
const PKG_REACT_BIOME = new Set(['react-app', 'component-lib']);

export function expectedExtends(stack: string, standalone: boolean): ExpectedExtends {
  return {
    biome: standalone
      ? `./.devkit/biome/${['electron', 'react-app', 'next', 'component-lib'].includes(stack) ? 'react' : 'base'}.jsonc`
      : `@norvalbv/devkit/biome/${PKG_REACT_BIOME.has(stack) ? 'react' : 'base'}`,
    tsconfig: standalone
      ? `./.devkit/tsconfig/${stack === 'next' ? 'next' : stack === 'node-service' ? 'node' : 'base'}.json`
      : '@norvalbv/devkit/tsconfig/base',
  };
}

export function checkExtends(
  cwd: string,
  file: string,
  expected: string,
  key = 'extends',
  overridden = false,
): CheckResult {
  const path = join(cwd, file);
  if (!existsSync(path)) {
    return check(file, 'MISSING', 'absent', 'run `devkit init`', true);
  }
  let parsed: ConfigWithExtends;
  try {
    parsed = JSON.parse(jsoncText(path)) as ConfigWithExtends;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return check(file, 'DRIFT', `invalid JSON: ${msg}`, 'fix the JSON syntax, then re-run');
  }
  // configOverrides marks deliberate hand-ownership, but only after syntax validation.
  if (overridden) {
    return check(file, 'OK', 'intentional override (configOverrides)');
  }
  const ext = parsed[key];
  const list = Array.isArray(ext) ? ext : [ext];
  if (!list.includes(expected)) {
    return check(
      file,
      'DRIFT',
      `${key} is ${JSON.stringify(ext)}`,
      `should extend "${expected}" (if intentional, add "${file}" to .devkit/config.json configOverrides)`,
    );
  }
  return check(file, 'OK', `extends ${expected}`);
}

// Configs whose drifted `extends` pointer --fix can repair IN PLACE (kind → expectedExtends key).
// The top-level config is the CONSUMER's (it carries paths, libs, plugins, overrides); only the
// pointer it extends is devkit-owned. guard.config.json is excluded: --fix never edits it DIRECTLY.
// It is recreated when MISSING by plain create-if-absent init, and one key — `indexPath` — can be
// rewritten by the init re-run a drifted search-index check triggers, because that is the same
// setIndexPath step that wrote the key originally. The rule is "no bespoke doctor-side edits of a
// consumer config", not "this file is never written".
export const EXTENDS_REPAIRABLE: Record<string, 'biome' | 'tsconfig'> = {
  'biome.jsonc': 'biome',
  'tsconfig.json': 'tsconfig',
};

// Replace only the devkit extends token, preserving comments and consumer deltas.
export function repairExtends(path: string, expected: string): boolean {
  if (!existsSync(path)) return false;
  const ext = readJsonc(path)?.extends;
  const list = Array.isArray(ext) ? ext : ext == null ? [] : [ext];
  if (list.includes(expected)) return false;
  const old = list.find((v) => typeof v === 'string' && v.includes('devkit'));
  if (!old) return false;
  const raw = readFileSync(path, 'utf8');
  const next = raw.replace(JSON.stringify(old), JSON.stringify(expected));
  if (next === raw) return false;
  writeFileSync(path, next);
  return true;
}
