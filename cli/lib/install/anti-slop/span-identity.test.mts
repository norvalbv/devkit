import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import antiSlop from '../../../commands/oxc/anti-slop.mts';
import { syncOxcCapability } from '../oxc/lifecycle.mts';
import {
  type AntiSlopBaseline,
  type BaselineEntry,
  baselineFromGroups,
  readBaseline,
  writeBaseline,
} from './baseline.mts';
import { ANTI_SLOP_IDENTITY, ANTI_SLOP_UPSTREAM } from './constants.mts';
import { rekeyWorkingBaseline } from './baseline-envelope.mts';
import { syncAntiSlopCapability } from './lifecycle.mts';
import { adoptActivatedAntiSlopFindings } from './managed-state.mts';
import { collectAntiSlopFindings, collectAntiSlopGroups } from './runner.mts';

const roots: string[] = [];
let out: string[] = [];
let err: string[] = [];

// Two baselined `no-unknown-parameters` findings on one signature line; oxfmt wraps it once a
// fourth parameter pushes it past the print width.
const ONE_LINE = [
  'export function emitCacheHit(judge: string, model?: unknown, durationMs?: unknown): void {',
  '  void [judge, model, durationMs];',
  '}',
  '',
].join('\n');
const WRAPPED = [
  'export function emitCacheHit(',
  '  judge: string,',
  '  model?: unknown,',
  '  durationMs?: unknown,',
  '  reason?: string,',
  '): void {',
  '  void [judge, model, durationMs, reason];',
  '}',
  '',
].join('\n');
const SOURCE_REL = 'src/gate-events.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commit(cwd: string, message: string): string {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=t', '-c', 'user.email=t@test.invalid', 'commit', '-qm', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

/** `prefix` puts the package below the repository root, as in a monorepo. */
function repository(source: string, prefix = ''): string {
  const root = mkdtempSync(join(tmpdir(), 'devkit-anti-slop-identity-'));
  roots.push(root);
  git(root, ['init', '-q']);
  const cwd = join(root, prefix);
  mkdirSync(join(cwd, 'src'), { recursive: true });
  syncAntiSlopCapability(cwd);
  syncOxcCapability(cwd, { antiSlop: true });
  writeFileSync(join(cwd, SOURCE_REL), source);
  return cwd;
}

/** The baseline a pre-span devkit wrote: every finding keyed on its whole physical line. */
function legacyBaseline(cwd: string): AntiSlopBaseline {
  const entries = new Map<string, BaselineEntry>();
  for (const finding of collectAntiSlopFindings(cwd, [])) {
    const lines = readFileSync(join(cwd, finding.file), 'utf8').split('\n');
    const context = (lines[finding.line - 1] ?? '').trim().replace(/\s+/gu, ' ');
    const entry = entries.get(finding.legacyFingerprint);
    if (entry) entry.count += 1;
    else {
      const { ruleId, file, diagnostic, legacyFingerprint: fingerprint } = finding;
      entries.set(fingerprint, { fingerprint, ruleId, file, diagnostic, context, count: 1 });
    }
  }
  return { schemaVersion: 1, upstreamCommit: ANTI_SLOP_UPSTREAM, entries: [...entries.values()] };
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
  for (const cwd of roots.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe('anti-slop span identity', () => {
  it('keeps baselined parameters baselined when oxfmt wraps their signature', () => {
    const cwd = repository(ONE_LINE);
    expect(antiSlop(['create'], cwd)).toBe(0);
    expect(readBaseline(cwd)?.entries.map((entry) => entry.context)).toEqual([
      'unknown',
      'unknown',
    ]);
    commit(cwd, 'base');

    writeFileSync(join(cwd, SOURCE_REL), WRAPPED);
    git(cwd, ['add', '-A']);
    expect(antiSlop(['check', '--staged'], cwd)).toBe(0);
    expect(out.join('\n')).toContain('anti-slop: PASS');
  });

  it('refuses a legacy working baseline with the rekey route, then rekey makes it pass', () => {
    const cwd = repository(ONE_LINE);
    writeBaseline(cwd, legacyBaseline(cwd));

    expect(antiSlop(['check'], cwd)).toBe(1);
    expect(err.join('\n')).toContain('run `devkit anti-slop rekey`, then stage it');
    expect(antiSlop(['prune'], cwd)).toBe(2);
    expect(antiSlop(['create', '--force'], cwd)).toBe(2);
    expect(antiSlop(['inspect'], cwd)).toBe(0);

    expect(antiSlop(['rekey'], cwd)).toBe(0);
    expect(readBaseline(cwd)?.identity).toBe(ANTI_SLOP_IDENTITY);
    const rekeyed = readFileSync(join(cwd, '.anti-slop-baseline.json'), 'utf8');
    expect(antiSlop(['rekey'], cwd)).toBe(0);
    expect(readFileSync(join(cwd, '.anti-slop-baseline.json'), 'utf8')).toBe(rekeyed);
    expect(antiSlop(['check'], cwd)).toBe(0);
  });

  it('accepts the migration commit against a legacy committed base, and still refuses growth', () => {
    const cwd = repository(ONE_LINE);
    writeBaseline(cwd, legacyBaseline(cwd));
    const base = commit(cwd, 'legacy base');

    expect(antiSlop(['rekey'], cwd)).toBe(0);
    git(cwd, ['add', '-A']);
    expect(antiSlop(['check', '--staged'], cwd)).toBe(0);
    expect(antiSlop(['check', '--base', base], cwd)).toBe(0);

    writeFileSync(join(cwd, 'src/extra.ts'), 'export const take = (input: unknown) => input;\n');
    writeBaseline(cwd, baselineFromGroups(collectAntiSlopGroups(cwd, [])));
    git(cwd, ['add', '-A']);
    expect(antiSlop(['check', '--base', base], cwd)).toBe(1);
    expect(err.join('\n')).toContain(
      `BASELINE-GROWTH anti-slop/no-unknown-parameters src/extra.ts`,
    );
  });

  it('re-keys from HEAD so a dirty working line cannot drop committed debt', () => {
    const cwd = repository(ONE_LINE);
    writeBaseline(cwd, legacyBaseline(cwd));
    commit(cwd, 'legacy base');
    writeFileSync(join(cwd, SOURCE_REL), WRAPPED);

    const legacy = readBaseline(cwd);
    if (!legacy) throw new Error('expected the committed legacy baseline');
    const next = rekeyWorkingBaseline(cwd, legacy);
    expect(next.entries.reduce((sum, entry) => sum + entry.count, 0)).toBe(2);
  });

  it('keys on the span text Oxlint reports for a BOM-prefixed CRLF file', () => {
    const cwd = repository(`\uFEFF// widen — later\r\n${ONE_LINE.replaceAll('\n', '\r\n')}`);

    expect(collectAntiSlopFindings(cwd, []).map((finding) => finding.context)).toEqual([
      'unknown',
      'unknown',
    ]);
  });

  it('re-keys from HEAD for a package below the repository root', () => {
    const cwd = repository(ONE_LINE, 'packages/app');
    writeBaseline(cwd, legacyBaseline(cwd));
    commit(cwd, 'legacy base');
    writeFileSync(join(cwd, SOURCE_REL), WRAPPED);

    const legacy = readBaseline(cwd);
    if (!legacy) throw new Error('expected the committed legacy baseline');
    expect(rekeyWorkingBaseline(cwd, legacy).entries).toHaveLength(2);
  });

  it('re-keys during upgrade before anything else, and only reports it on a dry run', () => {
    const cwd = repository(ONE_LINE);
    writeBaseline(cwd, legacyBaseline(cwd));
    const rekey = (legacy: AntiSlopBaseline) => rekeyWorkingBaseline(cwd, legacy);

    expect(adoptActivatedAntiSlopFindings(cwd, null, true, () => [], rekey)).toBe(true);
    expect(readBaseline(cwd)?.identity).toBeUndefined();
    expect(adoptActivatedAntiSlopFindings(cwd, null, false, () => [], rekey)).toBe(true);
    expect(readBaseline(cwd)?.identity).toBe(ANTI_SLOP_IDENTITY);
    expect(out.join('\n')).toContain('re-keyed 2 finding(s) to span identity');
  });
});
