import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AdvisoryDeps, qavisOnPath, type RouteResult, runQavisAdvisory } from '../check.mts';

const ENV_KEYS = ['GUARD_AI_STRICT', 'GUARD_QAVIS_OK', 'GUARD_NO_QAVIS_ADVISORY'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

const deps = (route: RouteResult, hasRecipe = true): AdvisoryDeps => ({
  hasRecipe: () => hasRecipe,
  route: () => route,
});
const advise = deps({ verdict: 'ADVISE' });
const silent = deps({ verdict: 'SILENT' });
const stderr = (): string =>
  (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map((c: unknown[]) => String(c[0]))
    .join('\n');

describe('runQavisAdvisory exit contract', () => {
  it('no recipe → 0, and never shells qavis (zero-weight for non-qavis repos)', () => {
    const route = vi.fn((): RouteResult => ({ verdict: 'ADVISE' }));
    expect(runQavisAdvisory('/r', { hasRecipe: () => false, route })).toBe(0);
    expect(route).not.toHaveBeenCalled();
    expect(stderr()).toBe(''); // a non-qavis repo hears nothing at all
  });

  it('SILENT → 0', () => {
    expect(runQavisAdvisory('/r', silent)).toBe(0);
  });

  it('ADVISE on a normal commit → 0 (advisory only, never blocks)', () => {
    expect(runQavisAdvisory('/r', advise)).toBe(0);
  });

  it('ADVISE under a strict ship → 3 (block until QA or override)', () => {
    process.env.GUARD_AI_STRICT = '1';
    expect(runQavisAdvisory('/r', advise)).toBe(3);
  });

  it('the emitted remediation runs forced vision and its receipt clears the next strict gate', () => {
    process.env.GUARD_AI_STRICT = '1';
    const repo = mkdtempSync(path.join(tmpdir(), 'qavis-advisory-contract-'));
    const binDir = mkdtempSync(path.join(tmpdir(), 'qavis-advisory-bin-'));
    const receipt = path.join(repo, 'pass-receipt');
    const qavis = path.join(binDir, 'qavis');
    writeFileSync(
      qavis,
      `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const expected = ['qa', '--staged', '--route', 'vision', '--repo', '.'];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(2);
writeFileSync(process.env.QAVIS_CONTRACT_RECEIPT, 'pass');
`,
    );
    chmodSync(qavis, 0o755);
    const route = (): RouteResult =>
      existsSync(receipt) ? { verdict: 'SILENT' } : { verdict: 'ADVISE' };

    expect(runQavisAdvisory(repo, { hasRecipe: () => true, route })).toBe(3);
    const command = stderr().match(/Run:\s+(qavis qa.*?)\s+\(a pass writes/)?.[1];
    expect(command).toBeDefined();
    const [executable, ...args] = command?.split(/\s+/) ?? [];
    execFileSync(executable as string, args, {
      cwd: repo,
      env: {
        ...process.env,
        PATH: [binDir, process.env.PATH].filter(Boolean).join(path.delimiter),
        QAVIS_CONTRACT_RECEIPT: receipt,
      },
    });

    expect(existsSync(receipt)).toBe(true);
    expect(runQavisAdvisory(repo, { hasRecipe: () => true, route })).toBe(0);
  });

  it('GUARD_QAVIS_OK short-circuits ADVISE under strict → 0, never shells qavis', () => {
    process.env.GUARD_AI_STRICT = '1';
    process.env.GUARD_QAVIS_OK = '1';
    const route = vi.fn((): RouteResult => ({ verdict: 'ADVISE' }));
    expect(runQavisAdvisory('/r', { hasRecipe: () => true, route })).toBe(0);
    expect(route).not.toHaveBeenCalled();
  });

  it('GUARD_NO_QAVIS_ADVISORY disables entirely → 0', () => {
    process.env.GUARD_AI_STRICT = '1';
    process.env.GUARD_NO_QAVIS_ADVISORY = '1';
    expect(runQavisAdvisory('/r', advise)).toBe(0);
  });
});

// A recipe repo EXPECTS qavis, so a skipped advisory is an anomaly worth a line — but never an
// exit code. Silence here is what let the gate sit dead and look identical to "nothing to QA".
describe('runQavisAdvisory reports a fail-open skip', () => {
  const missing = deps({ verdict: null, skip: 'qavis not on PATH' });

  it('qavis absent → 0 (fail-open) and says so on stderr', () => {
    expect(runQavisAdvisory('/r', missing)).toBe(0);
    expect(stderr()).toContain('qavis-advisory: skipped — qavis not on PATH.');
    expect(stderr()).toContain('GUARD_NO_QAVIS_ADVISORY=1');
  });

  it('qavis absent under a strict ship → STILL 0, and still warns', () => {
    process.env.GUARD_AI_STRICT = '1';
    expect(runQavisAdvisory('/r', missing)).toBe(0);
    expect(stderr()).toContain('qavis not on PATH');
  });

  it('route errored → 0, echoing the reason', () => {
    const r = deps({ verdict: null, skip: 'qavis route failed: boom' });
    expect(runQavisAdvisory('/r', r)).toBe(0);
    expect(stderr()).toContain('qavis route failed: boom');
  });

  it('unparseable verdict → 0, echoing what it printed', () => {
    const r = deps({ verdict: null, skip: 'qavis route printed no verdict ("MAYBE")' });
    expect(runQavisAdvisory('/r', r)).toBe(0);
    expect(stderr()).toContain('printed no verdict ("MAYBE")');
  });

  it.each([['SILENT'], ['ADVISE']] as const)('%s does not print a skip line', (verdict) => {
    runQavisAdvisory('/r', deps({ verdict }));
    expect(stderr()).not.toContain('skipped —');
  });
});

describe('qavisOnPath', () => {
  it('finds qavis in a PATH entry, and reports false when no entry has it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qavis-path-'));
    const empty = mkdtempSync(path.join(tmpdir(), 'qavis-empty-'));
    writeFileSync(path.join(dir, 'qavis'), '');

    expect(qavisOnPath({ PATH: [empty, dir].join(path.delimiter) })).toBe(true);
    expect(qavisOnPath({ PATH: empty })).toBe(false);
    expect(qavisOnPath({})).toBe(false);
  });
});
