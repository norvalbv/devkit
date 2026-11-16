/** Shared fixture for the in-process `devkit anti-slop` command suites: real installs in tmp repos. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { syncOxcCapability } from '../../oxc/lifecycle.mts';
import { ANTI_SLOP_BASELINE_REL, ANTI_SLOP_UPSTREAM } from '../constants.mts';
import { syncAntiSlopCapability } from '../lifecycle.mts';

export const roots: string[] = [];
export const EMPTY_BASELINE = `${JSON.stringify(
  { schemaVersion: 1, upstreamCommit: ANTI_SLOP_UPSTREAM, entries: [] },
  null,
  2,
)}\n`;
export const CLEAN_SOURCE = 'export const value = "base";\n';
// `anti-slop/no-object-parameters` — the same shape the capability's own integration probe uses.
export const FINDING_SOURCE = 'export function widen(value: object) {\n  return value;\n}\n';
export const DICTIONARY_FINDING_SOURCE = 'export type Dict = Record<string, unknown>;\n';

/** Console output captured per test; cleared in place, never reassigned. */
export const out: string[] = [];
export const err: string[] = [];

/** Capture console output into `out`/`err` and remove every tmp repo in `roots` after each test. */
export function installAntiSlopCommandHarness(): void {
  beforeEach(() => {
    out.length = 0;
    err.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      out.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      err.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const cwd of roots.splice(0)) rmSync(cwd, { recursive: true, force: true });
  });
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

export function commit(cwd: string, message: string): void {
  git(cwd, ['add', '-A']);
  git(cwd, [
    '-c',
    'user.name=Devkit test',
    '-c',
    'user.email=devkit@test.invalid',
    'commit',
    '-qm',
    message,
  ]);
}

/** A repository with a REAL capability install; `prefix` puts the package below the repo root. */
export function installedRepository(prefix = ''): string {
  const root = mkdtempSync(join(tmpdir(), 'devkit-anti-slop-base-capability-'));
  roots.push(root);
  git(root, ['init', '-q']);
  const cwd = prefix ? join(root, prefix) : root;
  mkdirSync(join(cwd, 'src'), { recursive: true });
  syncAntiSlopCapability(cwd);
  syncOxcCapability(cwd, { antiSlop: true });
  writeFileSync(join(cwd, ANTI_SLOP_BASELINE_REL), EMPTY_BASELINE);
  writeFileSync(join(cwd, 'src', 'file.ts'), CLEAN_SOURCE);
  return cwd;
}

/** An overlay install: capability and per-clone baseline git-excluded, so no base tree carries them. */
export function overlayRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devkit-anti-slop-overlay-'));
  roots.push(root);
  git(root, ['init', '-q']);
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, '.devkit'), { recursive: true });
  writeFileSync(join(root, '.devkit', 'config.json'), `${JSON.stringify({ overlay: true })}\n`);
  writeFileSync(
    join(root, '.git', 'info', 'exclude'),
    `.devkit/\noxlint.devkit.json\n${ANTI_SLOP_BASELINE_REL}\n`,
  );
  syncAntiSlopCapability(root);
  syncOxcCapability(root, { antiSlop: true, overlay: true });
  return root;
}
