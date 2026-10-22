import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import antiSlop from '../../../commands/oxc/anti-slop.mts';
import { OVERLAY_ENTRY_REL, syncOxcCapability } from '../oxc/lifecycle.mts';
import { readBaseline } from './baseline.mts';
import { ANTI_SLOP_BASELINE_REL } from './constants.mts';
import { syncAntiSlopCapability } from './lifecycle.mts';

const CLEAN_SOURCE = 'export const value = "base";\n';
// `anti-slop/no-object-parameters` — the shape the capability's own integration probe uses.
const FINDING_SOURCE = 'export function widen(value: object) {\n  return value;\n}\n';

const roots: string[] = [];
let out: string[] = [];
let err: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commit(cwd: string, message: string): void {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=t', '-c', 'user.email=t@test.invalid', 'commit', '-qm', message]);
}

/** An overlay clone whose baselined debt in src/file.ts was renamed to src/renamed.ts and committed. */
function overlayWithCommittedRename() {
  const root = mkdtempSync(join(tmpdir(), 'devkit-anti-slop-committed-rename-'));
  roots.push(root);
  git(root, ['init', '-q']);
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, '.devkit'), { recursive: true });
  writeFileSync(join(root, '.devkit', 'config.json'), `${JSON.stringify({ overlay: true })}\n`);
  writeFileSync(
    join(root, '.git', 'info', 'exclude'),
    `.devkit/\n${OVERLAY_ENTRY_REL}\n${ANTI_SLOP_BASELINE_REL}\n`,
  );
  syncAntiSlopCapability(root);
  syncOxcCapability(root, { antiSlop: true, overlay: true });
  writeFileSync(join(root, 'src', 'file.ts'), `${CLEAN_SOURCE}${FINDING_SOURCE}`);
  expect(antiSlop(['create'], root)).toBe(0);
  commit(root, 'debt');
  const debt = debtAt(root, 'src/file.ts');
  expect(debt).toBeGreaterThan(0);
  git(root, ['mv', 'src/file.ts', 'src/renamed.ts']);
  commit(root, 'rename');
  out = [];
  err = [];
  return { root, base: git(root, ['rev-parse', 'HEAD~1']), debt };
}

function debtAt(root: string, file: string): number {
  return (readBaseline(root)?.entries ?? [])
    .filter((entry) => entry.file === file)
    .reduce((sum, entry) => sum + entry.count, 0);
}

function baselineBytes(root: string): string {
  return readFileSync(join(root, ANTI_SLOP_BASELINE_REL), 'utf8');
}

/** The ship worktree's shape: HEAD at the base, the committed rename in the index. */
function asShipWorktree(root: string): void {
  git(root, ['reset', '-q', '--soft', 'HEAD~1']);
}

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('overlay re-key of a rename that is already committed', () => {
  it('names a working remedy at ship, and adopt-renames --base re-keys without adding debt', () => {
    const { root, base, debt } = overlayWithCommittedRename();
    expect(antiSlop(['adopt-renames'], root)).toBe(0);
    expect(debtAt(root, 'src/renamed.ts')).toBe(0);

    expect(antiSlop(['check', 'src/renamed.ts'], root)).toBe(1);
    expect(err.join('\n')).toContain(
      'src/file.ts no longer exists; if it was renamed to this file, run `devkit anti-slop adopt-renames`',
    );

    asShipWorktree(root);
    expect(antiSlop(['check', '--staged'], root)).toBe(1);
    expect(err.join('\n')).toContain('BASELINE-RENAME');
    expect(err.join('\n')).toContain(`\`devkit anti-slop adopt-renames --base ${base}\``);
    commit(root, 'rename');

    expect(antiSlop(['adopt-renames', '--base', base], root)).toBe(0);
    expect(debtAt(root, 'src/file.ts')).toBe(0);
    expect(debtAt(root, 'src/renamed.ts')).toBe(debt);
    expect(antiSlop(['check', 'src/renamed.ts'], root)).toBe(0);
    // A re-run is a no-op, not a collision with the debt it just re-keyed.
    expect(antiSlop(['adopt-renames', '--base', base], root)).toBe(0);
    expect(debtAt(root, 'src/renamed.ts')).toBe(debt);

    asShipWorktree(root);
    expect(antiSlop(['check', '--staged'], root)).toBe(0);
  });

  it('refuses to merge renamed debt into debt already baselined at the new path', () => {
    const { root, base, debt } = overlayWithCommittedRename();
    expect(antiSlop(['create', '--force', 'src/renamed.ts'], root)).toBe(0);
    const before = baselineBytes(root);

    expect(antiSlop(['adopt-renames', '--base', base], root)).toBe(2);
    expect(err.join('\n')).toContain('run `devkit anti-slop prune`');
    expect(baselineBytes(root)).toBe(before);

    expect(antiSlop(['prune'], root)).toBe(0);
    expect(debtAt(root, 'src/file.ts')).toBe(0);
    expect(debtAt(root, 'src/renamed.ts')).toBe(debt);
    expect(antiSlop(['check', 'src/renamed.ts'], root)).toBe(0);
  });

  it('still refuses --base for check and adopt-relocations', () => {
    const { root, base } = overlayWithCommittedRename();
    expect(antiSlop(['check', '--base', base], root)).toBe(2);
    expect(antiSlop(['adopt-relocations', '--base', base], root)).toBe(2);
    expect(err.join('\n')).toContain('--base is unavailable in an overlay install');
  });
});
