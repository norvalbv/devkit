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
const HINT = 'if this code moved out of src/file.ts, that change is not staged; git add it';

const roots: string[] = [];
let out: string[] = [];
let err: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Baselined debt committed in src/file.ts, moved into src/other.ts with ONLY the destination staged. */
function destinationOnlyStaged(prefix = '', overlay = false): string {
  const root = mkdtempSync(join(tmpdir(), 'devkit-anti-slop-unstaged-source-'));
  roots.push(root);
  git(root, ['init', '-q']);
  const cwd = prefix ? join(root, prefix) : root;
  mkdirSync(join(cwd, 'src'), { recursive: true });
  if (overlay) {
    mkdirSync(join(cwd, '.devkit'), { recursive: true });
    writeFileSync(join(cwd, '.devkit', 'config.json'), `${JSON.stringify({ overlay: true })}\n`);
    writeFileSync(
      join(root, '.git', 'info', 'exclude'),
      `.devkit/\n${OVERLAY_ENTRY_REL}\n${ANTI_SLOP_BASELINE_REL}\n`,
    );
  }
  syncAntiSlopCapability(cwd);
  syncOxcCapability(cwd, { antiSlop: true, overlay });
  writeFileSync(join(cwd, 'src', 'file.ts'), `${CLEAN_SOURCE}${FINDING_SOURCE}`);
  writeFileSync(join(cwd, 'src', 'other.ts'), OTHER_SOURCE);
  expect(antiSlop(['create'], cwd)).toBe(0);
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.name=t', '-c', 'user.email=t@test.invalid', 'commit', '-qm', 'debt']);
  writeFileSync(join(cwd, 'src', 'file.ts'), CLEAN_SOURCE);
  writeFileSync(join(cwd, 'src', 'other.ts'), `${OTHER_SOURCE}${FINDING_SOURCE}`);
  git(cwd, ['add', 'src/other.ts']);
  out = [];
  err = [];
  return cwd;
}

function baselineBytes(cwd: string): string {
  return readFileSync(join(cwd, ANTI_SLOP_BASELINE_REL), 'utf8');
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

describe('adopt-relocations with the move source left unstaged', () => {
  it('names the unstaged source, then re-anchors once it is staged and stays quiet on re-run', () => {
    const cwd = destinationOnlyStaged();
    const before = baselineBytes(cwd);

    expect(antiSlop(['adopt-relocations'], cwd)).toBe(0);
    expect(out).toEqual([
      'anti-slop: adopted 0 relocated finding(s); baseline unchanged',
      `anti-slop: ${HINT} (or git add -p), then re-run \`devkit anti-slop adopt-relocations\``,
    ]);
    expect(baselineBytes(cwd)).toBe(before);

    git(cwd, ['add', 'src/file.ts']);
    out = [];
    expect(antiSlop(['adopt-relocations'], cwd)).toBe(0);
    expect(out.join('\n')).toContain(
      'anti-slop: re-anchored 1 relocated finding(s) from src/file.ts into src/other.ts',
    );
    expect(out.join('\n')).not.toContain('git add');

    out = [];
    expect(antiSlop(['adopt-relocations'], cwd)).toBe(0);
    expect(out).toEqual(['anti-slop: adopted 0 relocated finding(s); baseline unchanged']);
  });

  it('still names a source whose removal hunk is the part left unstaged', () => {
    const cwd = destinationOnlyStaged();
    writeFileSync(join(cwd, 'src', 'file.ts'), `${CLEAN_SOURCE}${FINDING_SOURCE}// unrelated\n`);
    git(cwd, ['add', 'src/file.ts']);
    writeFileSync(join(cwd, 'src', 'file.ts'), `${CLEAN_SOURCE}// unrelated\n`);

    expect(antiSlop(['adopt-relocations'], cwd)).toBe(0);
    expect(out.join('\n')).toContain(HINT);
  });

  it('adds the hint to the refused --base form, naming the same --base re-run', () => {
    const cwd = destinationOnlyStaged();

    expect(antiSlop(['adopt-relocations', '--base', 'HEAD'], cwd)).toBe(2);
    expect(err).toEqual([
      'anti-slop: no lint-evidenced relocations from HEAD to the index; baseline unchanged',
      `anti-slop: ${HINT} (or git add -p), then re-run \`devkit anti-slop adopt-relocations --base HEAD\``,
    ]);
  });

  it('names the source package-relative when the package sits below the repository root', () => {
    const cwd = destinationOnlyStaged('pkg');

    expect(antiSlop(['adopt-relocations'], cwd)).toBe(0);
    expect(out.join('\n')).toContain(HINT);
  });

  it('names the source in an overlay install, whose debt bound is the local, git-excluded baseline', () => {
    const cwd = destinationOnlyStaged('', true);

    expect(antiSlop(['adopt-relocations'], cwd)).toBe(0);
    expect(out.join('\n')).toContain(HINT);
    git(cwd, ['add', 'src/file.ts']);
    expect(antiSlop(['adopt-relocations'], cwd)).toBe(0);
    expect(out.join('\n')).toContain('re-anchored 1 relocated finding(s) from src/file.ts');
  });
});
