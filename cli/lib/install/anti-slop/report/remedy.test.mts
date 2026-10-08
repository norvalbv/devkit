/** sc-3469: a commit-time anti-slop FAIL names a per-rule hint and the acceptance route its install
 * mode supports (see the oxc-toolchain-migration note for why hints live in the CLI). */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import antiSlop from '../../../../commands/oxc/anti-slop.mts';
import {
  isOverlayOxcInstall,
  resolveOxlintEntryConfig,
  syncOxcCapability,
} from '../../oxc/lifecycle.mts';
import { baselineFromGroups, writeBaseline } from '../baseline.mts';
import { ANTI_SLOP_BASELINE_REL, ANTI_SLOP_UPSTREAM } from '../constants.mts';
import { syncAntiSlopCapability } from '../lifecycle.mts';
import { collectAntiSlopGroups } from '../runner.mts';
import { ACCEPT_VIA_OVERRIDE, antiSlopRemedyLines } from './remedy.mts';

const MOCKING = 'anti-slop/no-module-mocking';
const EMPTY_BASELINE = `${JSON.stringify(
  { schemaVersion: 1, upstreamCommit: ANTI_SLOP_UPSTREAM, entries: [] },
  null,
  2,
)}\n`;
const MOCKING_SOURCE = "import { vi } from 'vitest';\n\nvi.mock('node:fs');\n";

describe('antiSlopRemedyLines', () => {
  it('keys hints on the namespaced ruleId the diagnostics actually carry', () => {
    // FindingGroup.ruleId is `anti-slop/<rule>`; a table keyed on the bare name never matches.
    const text = antiSlopRemedyLines([MOCKING], false).join('\n');
    expect(text).toMatch(/deps/u);
  });

  it('prints each rule hint once however many findings share the rule', () => {
    const lines = antiSlopRemedyLines([MOCKING, MOCKING, MOCKING], false);
    const hints = lines.filter((line) => /deps/u.test(line));
    expect(hints).toHaveLength(1);
  });

  it('names a schema parse or an opted-in type guard for runtime typeof, never truthiness', () => {
    const typeofRule = 'anti-slop/no-runtime-typeof';
    const hints = antiSlopRemedyLines([typeofRule, typeofRule], false).filter((line) =>
      line.includes('no-runtime-typeof:'),
    );
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(/safeParse/u);
    expect(hints[0]).toMatch(/enable the rule's `allowInTypeGuards`/u);
    expect(hints[0]).toMatch(/`Boolean\(x\)`, `!!x`\) is not a replacement/u);
  });

  it('offers only the schema route for runtime typeof in overlay, where no rule option persists', () => {
    const text = antiSlopRemedyLines(['anti-slop/no-runtime-typeof'], true).join('\n');
    expect(text).toMatch(/safeParse/u);
    expect(text).toMatch(/is not a replacement/u);
    expect(text).not.toMatch(/allowInTypeGuards|Oxlint config/u);
  });

  it('still names the acceptance route when no rule has a hint', () => {
    const lines = antiSlopRemedyLines(['anti-slop/no-reflect-get', 'eslint/no-undef'], false);
    expect(lines.join('\n')).toContain(ACCEPT_VIA_OVERRIDE);
    expect(lines.join('\n')).not.toMatch(/deps/u);
  });

  it('names the path-scoped Oxlint override outside overlay', () => {
    expect(ACCEPT_VIA_OVERRIDE).toMatch(/override/u);
    expect(ACCEPT_VIA_OVERRIDE).toMatch(/Oxlint config/u);
    expect(antiSlopRemedyLines([MOCKING], false).join('\n')).toContain(ACCEPT_VIA_OVERRIDE);
  });

  it('never names the Oxlint config in overlay, where every sync rewrites it', () => {
    const text = antiSlopRemedyLines([MOCKING], true).join('\n');
    expect(text).not.toContain(ACCEPT_VIA_OVERRIDE);
    expect(text).not.toMatch(/Oxlint config/u);
    expect(text).toMatch(/create --force/u);
    // The per-rule hint is mode-independent.
    expect(text).toMatch(/deps/u);
  });
});

describe('anti-slop check FAIL output (wiring)', () => {
  const roots: string[] = [];
  let out: string[] = [];
  let err: string[] = [];

  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      out.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      err.push(args.join(' '));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const git = (cwd: string, args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 }).trim();

  function repository(overlay: boolean): string {
    const root = mkdtempSync(join(tmpdir(), 'devkit-anti-slop-remedy-'));
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
    writeFileSync(join(root, ANTI_SLOP_BASELINE_REL), EMPTY_BASELINE);
    writeFileSync(join(root, 'src', 'a.test.ts'), MOCKING_SOURCE);
    git(root, ['add', '-A']);
    return root;
  }

  it('prints the rule hint and the override route after a new-finding FAIL', () => {
    const cwd = repository(false);
    expect(antiSlop(['check', '--staged'], cwd)).toBe(1);
    expect(out.join('\n')).toContain(MOCKING);
    const stderr = err.join('\n');
    expect(stderr).toMatch(/FAIL — [1-9]\d* new error finding\(s\)/u);
    expect(stderr).toMatch(/deps/u);
    expect(stderr).toContain(ACCEPT_VIA_OVERRIDE);
  });

  it('prints the typeof hint for a real no-runtime-typeof diagnostic', () => {
    const cwd = repository(false);
    writeFileSync(
      join(cwd, 'src', 'skip.ts'),
      "export const named = (x: string | number) => typeof x === 'string';\n",
    );
    git(cwd, ['add', '-A']);
    expect(antiSlop(['check', '--staged'], cwd)).toBe(1);
    expect(err.join('\n')).toMatch(/hint — no-runtime-typeof: .*safeParse/u);
  });

  it('prints the overlay route, not the Oxlint config, in an overlay install', () => {
    const cwd = repository(true);
    expect(antiSlop(['check', '--staged'], cwd)).toBe(1);
    const stderr = err.join('\n');
    expect(stderr).toMatch(/create --force/u);
    expect(stderr).not.toMatch(/Oxlint config/u);
  });

  it('keys overlay on the manifest stamp, not on the entry config still being on disk', () => {
    const cwd = repository(true);
    rmSync(join(cwd, 'oxlint.devkit.json'), { force: true });
    expect(resolveOxlintEntryConfig(cwd)).toBeNull();
    expect(isOverlayOxcInstall(cwd)).toBe(true);
    expect(isOverlayOxcInstall(repository(false))).toBe(false);
  });

  it('names the override route when the staged gate refuses baseline growth (create --force, then commit)', () => {
    // The exact path in the story: the author adopts the finding into the baseline, then the staged
    // gate refuses the growth. Its FAIL line is the one message they read; it must say what to do.
    const cwd = repository(false);
    writeFileSync(join(cwd, 'src', 'a.test.ts'), 'export const clean = 1;\n');
    git(cwd, ['add', '-A']);
    git(cwd, [
      '-c',
      'user.name=Devkit test',
      '-c',
      'user.email=devkit@test.invalid',
      'commit',
      '-qm',
      'empty baseline',
    ]);
    writeFileSync(join(cwd, 'src', 'a.test.ts'), MOCKING_SOURCE);
    writeBaseline(cwd, baselineFromGroups(collectAntiSlopGroups(cwd, ['src/a.test.ts'])));
    git(cwd, ['add', '-A']);

    expect(antiSlop(['check', '--staged'], cwd)).toBe(1);
    const stderr = err.join('\n');
    expect(stderr).toContain(`BASELINE-GROWTH ${MOCKING} src/a.test.ts`);
    expect(stderr).toContain(ACCEPT_VIA_OVERRIDE);
  });

  it('prints no remedy on a passing check', () => {
    const cwd = repository(false);
    writeFileSync(join(cwd, 'src', 'a.test.ts'), 'export const clean = 1;\n');
    git(cwd, ['add', '-A']);
    expect(antiSlop(['check', '--staged'], cwd)).toBe(0);
    expect(err.join('\n')).not.toContain(ACCEPT_VIA_OVERRIDE);
  });
});
