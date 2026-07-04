import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashFragment, relPath } from '../clone-detector.mjs';

const HEX16 = /^[0-9a-f]{16}$/;
const LINES_RE = /--lines \d+\b/;
const RANGE_A_RE = /--range-a \d+-\d+\b/;
const RANGE_B_RE = /--range-b \d+-\d+\b/;

// hashFragment is the stable allowlist key for token clones — an approval must
// survive reformatting + cross-OS line endings, but change when the code changes.
describe('hashFragment', () => {
  it('is deterministic', () => {
    expect(hashFragment('const a = 1;')).toBe(hashFragment('const a = 1;'));
  });

  it('collapses whitespace runs — indentation/newlines must not change the key', () => {
    // Differs only in indentation + line breaks (whitespace runs), not tokens.
    expect(hashFragment('const a = 1;\n    return a;')).toBe(
      hashFragment('const a = 1; return a;'),
    );
  });

  it('is stable across CRLF vs LF (Windows vs Unix checkouts)', () => {
    expect(hashFragment('line1\r\nline2\r\n')).toBe(hashFragment('line1\nline2\n'));
  });

  it('distinct code yields a distinct key', () => {
    expect(hashFragment('const a = 1;')).not.toBe(hashFragment('const b = 2;'));
  });

  it('returns a 16-char hex slice', () => {
    expect(hashFragment('anything')).toMatch(HEX16);
  });

  it('treats empty and whitespace-only fragments equally', () => {
    expect(hashFragment('')).toBe(hashFragment('   \n\t  '));
  });
});

// relPath must collapse to forward-slash `src/...` keys regardless of the OS separator jscpd
// reports — else a Windows `\` path produces a key that never matches the `/`-style allowlist.
describe('relPath', () => {
  it('normalizes a backslash path and collapses to src/ (Windows index)', () => {
    expect(relPath('anything\\src\\renderer\\a.tsx')).toBe('src/renderer/a.tsx');
  });
  it('leaves a forward-slash src path collapsed the same way', () => {
    expect(relPath('/abs/proj/src/main/b.ts')).toBe('src/main/b.ts');
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const DETECTOR = resolve(here, '..', 'clone-detector.mjs');
// devkit package root (where node_modules/.bin/jscpd lives): __tests__ → co-occurrence → gate-engine → devkit.
const pkgRoot = resolve(here, '..', '..', '..');
const JSCPD_BIN = process.env.JSCPD_BIN || resolve(pkgRoot, 'node_modules/.bin/jscpd');
// The gate-contract cases all run jscpd; without the binary they'd fail-open to
// exit 2 and flip the assertions red (misleading). Skip cleanly if it's absent.
const HAS_JSCPD = existsSync(JSCPD_BIN);

// A clearly >50-token (jscpd default) verbatim block shared across two files.
const SHARED = `export function computeWidgetTotals(items) {
  let total = 0;
  let count = 0;
  for (const item of items) {
    if (item.active && item.value > 0) {
      total += item.value;
      count += 1;
    }
  }
  const average = count > 0 ? total / count : 0;
  return { total, count, average, label: 'widget-totals-summary-block' };
}
`;

// The gate's exit-code contract is what a pre-commit hook depends on:
//   1 = new clone → block · 0 = clean · 2 = could-not-run → fail-open.
describe.skipIf(!HAS_JSCPD)('clone-detector --gate exit-code contract', () => {
  let tmp;
  let cloneFile; // a real reported clone path, for the --changed scoping test
  let cloneHash; // the reported fragmentHash, for the allowlist-suppression test

  function run(args, env) {
    try {
      const stdout = execFileSync('node', [DETECTOR, ...args], {
        // JSCPD_BIN points at the package's jscpd so the engine, run from any cwd, finds it.
        env: { ...process.env, MATCHER_CHANGED_FILES: '', JSCPD_BIN, ...env },
        encoding: 'utf8',
      });
      return { status: 0, stdout };
    } catch (e) {
      return { status: e.status, stdout: `${e.stdout ?? ''}` };
    }
  }

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'clone-gate-'));
    writeFileSync(join(tmp, 'a.ts'), `${SHARED}\nexport const A_ONLY = 1;\n`);
    writeFileSync(join(tmp, 'b.ts'), `${SHARED}\nexport const B_ONLY = 2;\n`);
    // Discover the detector's reported path + fragmentHash for the scoping +
    // allowlist-suppression tests.
    const first = JSON.parse(run(['json', '--paths', tmp], {}).stdout)[0];
    cloneFile = first?.fileA;
    cloneHash = first?.fragmentHash;
  });

  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('exit 1 — a new cross-file clone blocks', () => {
    expect(run(['scan', '--gate', '--paths', tmp], {}).status).toBe(1);
  });

  it('exit 0 — no cross-file clone (clean)', () => {
    const clean = mkdtempSync(join(tmpdir(), 'clone-clean-'));
    writeFileSync(join(clean, 'solo.ts'), `${SHARED}\nexport const SOLO = 1;\n`);
    expect(run(['scan', '--gate', '--paths', clean], {}).status).toBe(0);
    rmSync(clean, { recursive: true, force: true });
  });

  it('exit 2 — jscpd unavailable fails open', () => {
    expect(run(['scan', '--gate', '--paths', tmp], { JSCPD_BIN: '/nonexistent' }).status).toBe(2);
  });

  it("resolves devkit's OWN bundled jscpd when the consumer has none (no JSCPD_BIN)", () => {
    // No JSCPD_BIN + no consumer jscpd: the detector must find devkit's own bundled jscpd via its
    // module-relative candidate paths, so a clone is still detected (exit 1) in a zero-jscpd-dep repo.
    const env = { ...process.env, MATCHER_CHANGED_FILES: '' };
    delete env.JSCPD_BIN;
    let status = 0;
    try {
      execFileSync('node', [DETECTOR, 'scan', '--gate', '--paths', tmp], { env, encoding: 'utf8' });
    } catch (e) {
      status = e.status;
    }
    expect(status).toBe(1);
  });

  it('--changed scopes to staged: in-scope blocks, out-of-scope clean', () => {
    expect(cloneFile).toBeTruthy();
    expect(
      run(['scan', '--changed', '--gate', '--paths', tmp], { MATCHER_CHANGED_FILES: cloneFile })
        .status,
    ).toBe(1);
    expect(
      run(['scan', '--changed', '--gate', '--paths', tmp], {
        MATCHER_CHANGED_FILES: 'src/totally/unrelated.ts',
      }).status,
    ).toBe(0);
  });

  it('exit 0 — a clone covered by a LIVE allowlist entry is suppressed', () => {
    const al = join(tmp, 'allowlist-live.json');
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(
      al,
      JSON.stringify({
        pairs: [],
        clones: [{ fragmentHash: cloneHash, date: today, decayDays: 3650 }],
      }),
    );
    expect(run(['scan', '--gate', '--paths', tmp], { CO_OCCURRENCE_ALLOWLIST: al }).status).toBe(0);
  });

  it('exit 1 — an EXPIRED allowlist entry re-surfaces the clone', () => {
    const al = join(tmp, 'allowlist-expired.json');
    writeFileSync(
      al,
      JSON.stringify({
        pairs: [],
        clones: [{ fragmentHash: cloneHash, date: '2000-01-01', decayDays: 1 }],
      }),
    );
    expect(run(['scan', '--gate', '--paths', tmp], { CO_OCCURRENCE_ALLOWLIST: al }).status).toBe(1);
  });

  // A corrupt allowlist must FAIL OPEN (exit 2), not silently empty the approved set →
  // re-surface every clone as novel → false-block (exit 1). Mirrors the matcher contract.
  it('exit 2 — a corrupt allowlist fails open (not a false-block)', () => {
    const al = join(tmp, 'allowlist-corrupt.json');
    writeFileSync(al, '{ "clones": [ <<<<<<< merge');
    expect(run(['scan', '--gate', '--paths', tmp], { CO_OCCURRENCE_ALLOWLIST: al }).status).toBe(2);
  });

  it('prints a pre-filled add-clone command (hash + lines + ranges) on block', () => {
    const { stdout } = run(['scan', '--gate', '--paths', tmp], {});
    // The agent pastes THIS, so the approved clone keeps its lines/ranges metadata. Assert
    // CONCRETE shapes (not bare flag names) so `--lines undefined` / `--range-a -` regress.
    expect(stdout).toContain(`add-clone "${cloneHash}"`);
    expect(stdout).toMatch(LINES_RE);
    expect(stdout).toMatch(RANGE_A_RE);
    expect(stdout).toMatch(RANGE_B_RE);
  });
});

// The approve-command dump is capped (APPROVE_CAP) so a big clone batch doesn't flood the
// commit/ship log — but every clone must still appear as a ROW. The cap trims only the
// copy-paste helper, never the finding. Two things regress silently if this breaks:
//   1. off-by-one: `>= CAP` instead of `> CAP` prints a bogus "+0 more" exactly at the cap.
//   2. row truncation: if a future "optimization" caps rows too, clones vanish from the report.
describe.skipIf(!HAS_JSCPD)('clone-detector --gate approve-command cap', () => {
  const APPROVE_CAP = 6; // must match clone-detector.mjs

  // n distinct >50-token blocks, each duplicated across its own a<i>/b<i> pair → n novel
  // cross-file clones. Blocks differ by token (compute_i, seen_i, *i, label-i) so a<i>
  // matches ONLY b<i> — the shared lines between pairs (`for (...)`, `const average`) are
  // single lines, far under jscpd's min-tokens, so no cross-pair or same-file inflation.
  function writeNClones(dir, n) {
    for (let i = 1; i <= n; i++) {
      const block = `export function compute_${i}(items) {
  let total = 0; let count = 0; let seen_${i} = 0;
  for (const item of items) {
    if (item.active_${i} && item.value > 0) { total += item.value * ${i}; count += 1; seen_${i} += 1; }
  }
  const average = count > 0 ? total / count : 0;
  return { total, count, average, seen_${i}, label: 'block-number-${i}-summary' };
}`;
      writeFileSync(join(dir, `a${i}.ts`), `${block}\nexport const A_${i} = 1;\n`);
      writeFileSync(join(dir, `b${i}.ts`), `${block}\nexport const B_${i} = 2;\n`);
    }
  }

  function runGate(n) {
    const dir = mkdtempSync(join(tmpdir(), 'clone-cap-'));
    writeNClones(dir, n);
    try {
      execFileSync('node', [DETECTOR, 'scan', '--gate', '--paths', dir], {
        env: { ...process.env, MATCHER_CHANGED_FILES: '', JSCPD_BIN },
        encoding: 'utf8',
      });
      return { status: 0, stdout: '' };
    } catch (e) {
      return { status: e.status, stdout: `${e.stdout ?? ''}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const cmdCount = (s) => (s.match(/add-clone/g) || []).length;
  const rowCount = (s) => (s.match(/^\s+\d+L\s+[0-9a-f]{16}/gm) || []).length;

  it(`at the cap (${APPROVE_CAP}): prints all ${APPROVE_CAP} commands and NO "+N more" line`, () => {
    const { status, stdout } = runGate(APPROVE_CAP);
    expect(status).toBe(1); // still blocks
    expect(cmdCount(stdout)).toBe(APPROVE_CAP);
    expect(stdout).not.toMatch(/\+\d+ more/); // `> CAP`, not `>= CAP`
    expect(rowCount(stdout)).toBe(APPROVE_CAP); // every finding listed
  });

  it(`over the cap (${APPROVE_CAP + 1}): commands capped + "+1 more", but ALL rows listed`, () => {
    const { status, stdout } = runGate(APPROVE_CAP + 1);
    expect(status).toBe(1);
    expect(cmdCount(stdout)).toBe(APPROVE_CAP); // helper truncated to the cap
    expect(stdout).toContain('(+1 more'); // overflow count is exact
    expect(rowCount(stdout)).toBe(APPROVE_CAP + 1); // finding is NEVER truncated
  });
});

// From-temp-cwd: prove the engine scans the CONSUMER cwd (W-3), not the package dir. We run
// the detector with cwd = a throwaway repo that has its OWN src/ + guard.config.json; default
// --paths must resolve to THAT repo's scanRoots and surface its clone. If the engine reached
// for __dirname it'd scan the package and miss this entirely.
describe.skipIf(!HAS_JSCPD)('clone-detector from a temp consumer cwd (W-3)', () => {
  let consumer;
  beforeAll(() => {
    consumer = mkdtempSync(join(tmpdir(), 'clone-consumer-'));
    mkdirSync(join(consumer, 'src'), { recursive: true });
    // guard.config.json points scanRoots at the consumer's own src/ (relative to its cwd).
    writeFileSync(join(consumer, 'guard.config.json'), JSON.stringify({ scanRoots: ['src'] }));
    writeFileSync(join(consumer, 'src', 'a.ts'), `${SHARED}\nexport const A_ONLY = 1;\n`);
    writeFileSync(join(consumer, 'src', 'b.ts'), `${SHARED}\nexport const B_ONLY = 2;\n`);
  });
  afterAll(() => rmSync(consumer, { recursive: true, force: true }));

  it('default --paths (config.scanRoots) scans the consumer repo, not the package → exit 1', () => {
    let status = 0;
    try {
      execFileSync('node', [DETECTOR, 'scan', '--gate'], {
        cwd: consumer,
        env: { ...process.env, MATCHER_CHANGED_FILES: '', JSCPD_BIN },
        encoding: 'utf8',
      });
    } catch (e) {
      status = e.status;
    }
    expect(status).toBe(1); // found the consumer's own cross-file clone via its scanRoots
  });

  it('relPath/keys reference the consumer cwd, so a clone there is reported under src/', () => {
    const out = execFileSync('node', [DETECTOR, 'json'], {
      cwd: consumer,
      env: { ...process.env, JSCPD_BIN },
      encoding: 'utf8',
    });
    const clones = JSON.parse(out);
    expect(clones.length).toBeGreaterThan(0);
    // Stripped against the CONSUMER cwd → repo-relative src/ key, no absolute temp prefix.
    expect(clones[0].fileA.startsWith('src/')).toBe(true);
  });
});
