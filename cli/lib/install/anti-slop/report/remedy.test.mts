/** sc-3469: a commit-time anti-slop FAIL names a per-rule hint and the acceptance route its install
 * mode supports (see the oxc-toolchain-migration note for why hints live in the CLI). */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GATE_REASON_ENV,
  readGateReason,
} from '../../../../../gate-engine/deterministic/reason.mts';
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
const ASSERTION = 'anti-slop/require-safety-comment-for-type-assertion';
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

  it('points a type assertion at schema parsing for I/O and at a SAFETY line otherwise', () => {
    const hints = antiSlopRemedyLines([ASSERTION, ASSERTION], false).filter((line) =>
      line.includes('hint —'),
    );
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(/zod `Schema\.safeParse\(JSON\.parse\(text\)\)`/u);
    expect(hints[0]).toMatch(/\/\/ SAFETY:/u);
  });

  it('never matches the bare rule name, and orders hints by first appearance', () => {
    const bare = antiSlopRemedyLines(['require-safety-comment-for-type-assertion'], false);
    expect(bare.some((line) => line.includes('hint —'))).toBe(false);
    const lines = antiSlopRemedyLines([ASSERTION, MOCKING], false);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('require-safety-comment-for-type-assertion:');
    expect(lines[1]).toContain('no-module-mocking:');
    expect(lines[2]).toContain(ACCEPT_VIA_OVERRIDE);
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
    vi.unstubAllEnvs();
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

  it('records the FAIL line, then the rule and location, for the aggregated verdict', () => {
    const cwd = repository(false);
    const reason = join(mkdtempSync(join(tmpdir(), 'devkit-anti-slop-reason-')), 'reason.txt');
    roots.push(join(reason, '..'));
    vi.stubEnv(GATE_REASON_ENV, reason);
    expect(antiSlop(['check', '--staged'], cwd)).toBe(1);
    const [summary, ...locations] = readGateReason(reason);
    expect(summary).toMatch(/^anti-slop: FAIL — 1 new error finding\(s\)/u);
    expect(locations).toEqual([
      expect.stringMatching(/^ERROR \S+ src\/a\.test\.ts:3:\d+ \(\+1\)$/u),
    ]);
    expect(locations[0]).toContain(MOCKING);
  });

  it('prints the schema-parse hint when the real rule blocks a cast on JSON.parse output', () => {
    // Guards the key: the hint only prints if the plugin's emitted ruleId matches the table entry.
    const cwd = repository(false);
    writeFileSync(join(cwd, 'src', 'a.test.ts'), 'export const clean = 1;\n');
    writeFileSync(
      join(cwd, 'src', 'read.ts'),
      "export const x = JSON.parse('{}') as { a: number };\n",
    );
    git(cwd, ['add', '-A']);

    expect(antiSlop(['check', '--staged'], cwd)).toBe(1);
    expect(out.join('\n')).toContain(ASSERTION);
    expect(err.join('\n')).toMatch(/hint — require-safety-comment-for-type-assertion: .*zod/u);
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
