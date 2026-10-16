import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DETERMINISTIC } from '../../deterministic/registry.mts';
import type { CloneAllowlistEntry } from '../allowlist-io.mts';
import { RECONCILE_REFUSED_FLAGS } from '../clone-detector.mts';

const here = dirname(fileURLToPath(import.meta.url));
const DETECTOR = resolve(here, '..', 'clone-detector.mts');
const JSCPD_BIN =
  process.env.JSCPD_BIN || resolve(here, '..', '..', '..', 'node_modules/.bin/jscpd');
const HAS_JSCPD = existsSync(JSCPD_BIN);
const DEAD = 'deadbeefdeadbeef';

// A clearly >50-token verbatim block shared across two files, so the scan produces one live hash.
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

// Sibling suites stub these on process.env; an inherited fixture path would point the child at
// the wrong allowlist.
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, MATCHER_CHANGED_FILES: '', JSCPD_BIN, ...extra };
  for (const k of ['CO_OCCURRENCE_ALLOWLIST', 'GUARD_ALLOWLIST_PATH']) delete env[k];
  return env;
}

function makeConsumer(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'clone-reconcile-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'guard.config.json'), JSON.stringify({ scanRoots: ['src'] }));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, 'src', name), body);
  return dir;
}

function run(cwd: string, args: string[], extra?: Record<string, string>) {
  return spawnSync('node', [DETECTOR, ...args], { cwd, env: cleanEnv(extra), encoding: 'utf8' });
}

const PAIR = {
  symbolA: 'a',
  fileA: 'src/a.ts',
  symbolB: 'b',
  fileB: 'src/b.ts',
  date: '2026-01-01',
};
const deadEntry = {
  fragmentHash: DEAD,
  fileA: 'src/gone.ts',
  fileB: 'src/also-gone.ts',
  description: 'approved code that was later refactored away',
  date: '2026-01-01',
  decayDays: 3650,
};

describe.skipIf(!HAS_JSCPD)('guard-clone reconcile', () => {
  let consumer: string;
  let allowlist: string;
  let liveEntry: CloneAllowlistEntry;
  let original: string;

  beforeAll(() => {
    consumer = makeConsumer({
      'a.ts': `${SHARED}\nexport const A = 1;\n`,
      'b.ts': `${SHARED}\nexport const B = 2;\n`,
    });
    allowlist = join(consumer, '.co-occurrence-allowlist.json');
    const [clone] = JSON.parse(run(consumer, ['json']).stdout);
    liveEntry = {
      fragmentHash: clone.fragmentHash,
      description: 'intentional',
      date: '2026-01-01',
      decayDays: 3650,
    };
    original = `${JSON.stringify({ pairs: [PAIR], clones: [liveEntry, deadEntry] }, null, 2)}\n`;
  });
  afterAll(() => rmSync(consumer, { recursive: true, force: true }));
  beforeEach(() => writeFileSync(allowlist, original));

  it('dry run lists the dead entry and writes nothing', () => {
    const r = run(consumer, ['reconcile']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`drop  ${DEAD}`);
    expect(r.stdout).toContain(deadEntry.description);
    expect(r.stdout).toContain('keep 1, drop 1');
    expect(readFileSync(allowlist, 'utf8')).toBe(original);
  });

  it('--apply drops only the dead entry and leaves pairs and live entries identical', () => {
    expect(run(consumer, ['reconcile', '--apply']).status).toBe(0);
    const after = JSON.parse(readFileSync(allowlist, 'utf8'));
    expect(after).toEqual({ pairs: [PAIR], clones: [liveEntry] });
  });

  it('--apply with nothing dead does not rewrite the file', () => {
    const allLive = `${JSON.stringify({ pairs: [PAIR], clones: [liveEntry] }, null, 2)}\n`;
    writeFileSync(allowlist, allLive);
    const r = run(consumer, ['reconcile', '--apply']);
    expect(r.stdout).toContain('Nothing to reconcile');
    expect(readFileSync(allowlist, 'utf8')).toBe(allLive);
  });

  it('a jscpd that cannot run removes nothing and says why', () => {
    const r = run(consumer, ['reconcile', '--apply'], { JSCPD_BIN: '/nonexistent/jscpd' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('jscpd failed');
    expect(r.stderr).toContain('Nothing removed');
    expect(readFileSync(allowlist, 'utf8')).toBe(original);
  });

  it.each([['--paths', 'src'], ['--gate'], ['--min-tokens', '10']])(
    'refuses the scope-narrowing flag %s without writing',
    (...flags) => {
      const r = run(consumer, ['reconcile', '--apply', ...flags]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`${flags[0]} not allowed`);
      expect(readFileSync(allowlist, 'utf8')).toBe(original);
    },
  );

  it('a corrupt allowlist is refused after the scan, never rewritten', () => {
    writeFileSync(allowlist, '{ not json');
    const r = run(consumer, ['reconcile', '--apply']);
    expect(r.status).toBe(2);
    expect(readFileSync(allowlist, 'utf8')).toBe('{ not json');
  });

  it('an empty scan removes nothing and names remove-clone', () => {
    const empty = makeConsumer({
      'a.ts': 'export const A = 1;\n',
      'b.ts': 'export const B = 2;\n',
    });
    try {
      const path = join(empty, '.co-occurrence-allowlist.json');
      writeFileSync(path, original);
      const r = run(empty, ['reconcile', '--apply']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('scan returned no clones');
      expect(r.stderr).toContain('remove-clone');
      expect(readFileSync(path, 'utf8')).toBe(original);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

// Reconcile scans with config defaults only; if the gate ever passed its own scope knob, the two
// scans would differ and reconcile would delete approvals the gate still matches.
it('the commit gate passes no scope flag that reconcile cannot reproduce', () => {
  const gate = DETERMINISTIC.find((g) => g.id === 'clone');
  const scope = RECONCILE_REFUSED_FLAGS.filter((f) => f !== '--changed' && f !== '--gate');
  expect(gate?.args.filter((a) => scope.includes(a))).toEqual([]);
});
