import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import antiSlop from '../../../commands/oxc/anti-slop.mts';
import { syncOxcCapability } from '../oxc/lifecycle.mts';
import {
  ANTI_SLOP_BASELINE_REL,
  ANTI_SLOP_PRIOR_UPSTREAMS,
  ANTI_SLOP_UPSTREAM,
} from './constants.mts';
import { syncAntiSlopCapability } from './lifecycle.mts';
import { collectAntiSlopGroups } from './runner.mts';

const roots: string[] = [];

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 }).trim();

function baselineJson(upstreamCommit: string): string {
  return `${JSON.stringify({ schemaVersion: 1, upstreamCommit, entries: [] }, null, 2)}\n`;
}

function repository(source: string, upstreamCommit = ANTI_SLOP_UPSTREAM, overlay = false): string {
  const root = mkdtempSync(join(tmpdir(), 'devkit-anti-slop-pin-'));
  roots.push(root);
  git(root, ['init', '-q']);
  mkdirSync(join(root, 'src'), { recursive: true });
  if (overlay) {
    mkdirSync(join(root, '.devkit'), { recursive: true });
    writeFileSync(join(root, '.devkit', 'config.json'), `${JSON.stringify({ overlay: true })}\n`);
    writeFileSync(
      join(root, '.git', 'info', 'exclude'),
      `.devkit/\noxlint.devkit.json\n${ANTI_SLOP_BASELINE_REL}\n`,
    );
  }
  syncAntiSlopCapability(root);
  syncOxcCapability(root, overlay ? { antiSlop: true, overlay: true } : { antiSlop: true });
  writeFileSync(join(root, ANTI_SLOP_BASELINE_REL), baselineJson(upstreamCommit));
  writeFileSync(join(root, 'src', 'probe.ts'), source);
  git(root, ['add', '-A']);
  return root;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('vendored anti-slop at the current upstream pin', () => {
  it('leaves typeof existence probes alone and still reports a typeof type check', () => {
    const source = [
      "export const a = typeof globalThis.process === 'undefined';",
      "export const b = 'undefined' !== typeof globalThis.Bun;",
      "export const c = typeof globalThis.Deno == 'undefined';",
      "export const d = typeof globalThis.name === 'string';",
      '',
    ].join('\n');
    const findings = collectAntiSlopGroups(repository(source), []).filter(
      (group) => group.ruleId === 'anti-slop/no-runtime-typeof',
    );
    expect(findings.map((group) => [group.file, group.line])).toEqual([['src/probe.ts', 4]]);
  });

  it('passes the staged gate when the base commit holds a baseline from a prior pin', () => {
    const [prior] = ANTI_SLOP_PRIOR_UPSTREAMS;
    if (!prior) throw new Error('expected a prior upstream pin');
    const root = repository('export const clean = 1;\n', prior);
    git(root, ['-c', 'user.name=t', '-c', 'user.email=t@test.invalid', 'commit', '-qm', 'base']);
    writeFileSync(join(root, 'src', 'next.ts'), 'export const next = 2;\n');
    git(root, ['add', 'src/next.ts']);
    expect(antiSlop(['check', '--staged'], root)).toBe(0);
  });

  it('passes an overlay clone whose git-excluded baseline carries a prior pin, without rewriting it', () => {
    const [prior] = ANTI_SLOP_PRIOR_UPSTREAMS;
    if (!prior) throw new Error('expected a prior upstream pin');
    const root = repository('export const clean = 1;\n', prior, true);
    const before = readFileSync(join(root, ANTI_SLOP_BASELINE_REL), 'utf8');
    expect(antiSlop(['check', '--staged'], root)).toBe(0);
    expect(readFileSync(join(root, ANTI_SLOP_BASELINE_REL), 'utf8')).toBe(before);
  });
});
