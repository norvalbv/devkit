import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import antiSlop from '../../../commands/oxc/anti-slop.mts';
import { OVERLAY_ENTRY_REL, syncOxcCapability } from '../oxc/lifecycle.mts';
import { ANTI_SLOP_BASELINE_REL } from './constants.mts';
import { syncAntiSlopCapability } from './lifecycle.mts';

const CLEAN_SOURCE = 'export const value = "base";\n';
const OTHER_SOURCE = 'export const other = "other";\n';
// `anti-slop/no-object-parameters` — the shape the capability's own integration probe uses.
const FINDING_SOURCE = 'export function widen(value: object) {\n  return value;\n}\n';
const MISSING_ENTRY = `overlay entry ${OVERLAY_ENTRY_REL} is missing — run \`devkit doctor --fix\``;
const STAGE_ADVICE = `stage ${ANTI_SLOP_BASELINE_REL}`;

const roots: string[] = [];
let out: string[] = [];
let err: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commit(cwd: string): void {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=t', '-c', 'user.email=t@test.invalid', 'commit', '-qm', 'debt']);
}

/** An overlay clone with committed, baselined debt in src/file.ts, staged to move into src/other.ts. */
function overlayWithStagedMove(): string {
  const root = mkdtempSync(join(tmpdir(), 'devkit-anti-slop-overlay-entry-'));
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
  writeFileSync(join(root, 'src', 'other.ts'), OTHER_SOURCE);
  expect(antiSlop(['create'], root)).toBe(0);
  commit(root);
  writeFileSync(join(root, 'src', 'file.ts'), CLEAN_SOURCE);
  writeFileSync(join(root, 'src', 'other.ts'), `${OTHER_SOURCE}${FINDING_SOURCE}`);
  git(root, ['add', '-A']);
  out = [];
  err = [];
  return root;
}

function baselineBytes(root: string): string {
  return readFileSync(join(root, ANTI_SLOP_BASELINE_REL), 'utf8');
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

describe('overlay install whose root entry config is missing', () => {
  it('names the missing entry on every lint path instead of "not installed" or a missing baseline', () => {
    const root = overlayWithStagedMove();
    rmSync(join(root, OVERLAY_ENTRY_REL));
    const before = baselineBytes(root);

    expect(() => antiSlop(['adopt-relocations'], root)).toThrow(MISSING_ENTRY);
    expect(() => antiSlop(['check', '--staged'], root)).toThrow(MISSING_ENTRY);
    expect(() => antiSlop(['check'], root)).toThrow(MISSING_ENTRY);
    expect(antiSlop(['adopt-relocations', '--base', 'HEAD'], root)).toBe(2);
    expect(err.join('\n')).toContain('--base is unavailable in an overlay install');
    expect(err.join('\n')).not.toContain('is missing; run `devkit anti-slop create`');
    expect(baselineBytes(root)).toBe(before);
  });

  it('keeps overlay wording for adopt-renames, which re-keys the baseline without linting', () => {
    const root = overlayWithStagedMove();
    rmSync(join(root, OVERLAY_ENTRY_REL));

    expect(antiSlop(['adopt-renames'], root)).toBe(0);
    expect(out.join('\n')).not.toContain(STAGE_ADVICE);
  });

  it('passes check --staged when nothing relevant is staged, since only lint paths refuse', () => {
    const root = overlayWithStagedMove();
    git(root, ['reset', '-q']);
    rmSync(join(root, OVERLAY_ENTRY_REL));

    expect(antiSlop(['check', '--staged'], root)).toBe(0);
  });

  it('re-anchors relocated debt with the entry present, without non-overlay staging advice', () => {
    const root = overlayWithStagedMove();

    expect(antiSlop(['adopt-relocations'], root)).toBe(0);
    expect(out.join('\n')).toContain('re-anchored 1 relocated finding(s)');
    expect(out.join('\n')).not.toContain(STAGE_ADVICE);
    expect(antiSlop(['check', '--staged'], root)).toBe(0);
  });
});
