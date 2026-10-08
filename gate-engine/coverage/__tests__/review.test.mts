/** Coverage under `devkit review`: the target's artifact is copied privately with its provenance
 * re-bound, and an absent or stale artifact is NOT MEASURED (exit 2 + a verdict-line notice). */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { materializeReviewCoverage } from '../../../cli/lib/ship/coverage/review-coverage-copy.mts';
import { MANIFEST_NAME, snapshotSource } from '../provenance.mts';
import {
  cleanupRepos,
  gate,
  git,
  measure,
  repo,
  stage,
  trackRoot,
  write,
} from './_provenance-fixtures.mts';

const LOW = JSON.stringify({
  '/x/a.mts': { statementMap: { '0': { start: { line: 1 } } }, s: { '0': 0 }, f: {}, b: {} },
});

let temp = '';
let notices = '';
beforeEach(() => {
  vi.stubEnv('GUARD_COVERAGE_OK', '');
  vi.stubEnv('GUARD_NO_COVERAGE', '');
  temp = trackRoot(mkdtempSync(join(tmpdir(), 'coverage-review-temp-')));
  notices = join(temp, 'notices');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  cleanupRepos();
});

function reviewMode(noticesFile = notices): void {
  vi.stubEnv('DEVKIT_RUN_MODE', 'review');
  vi.stubEnv('DEVKIT_REVIEW_TEMP_ROOT', temp);
  vi.stubEnv('DEVKIT_REVIEW_NOTICES', noticesFile);
}

const noticeText = (): string => (existsSync(notices) ? readFileSync(notices, 'utf8') : '');

/** A review-style private worktree of `root` at HEAD, carrying the same working-tree edit. */
function reviewWorktree(root: string, edit?: string): string {
  const wt = join(trackRoot(mkdtempSync(join(tmpdir(), 'coverage-review-wt-'))), 'wt');
  git(root, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
  if (edit !== undefined) write(wt, 'src/a.mts', edit);
  stage(wt);
  return wt;
}

describe('gate — review arms', () => {
  it('absent artifact → NOT MEASURED, exit 2, and a notice for the verdict line', () => {
    const { root } = repo();
    reviewMode();
    const { code, out } = gate(root);
    expect(code).toBe(2);
    expect(out).toContain('Coverage NOT MEASURED in this review');
    expect(out).toContain('`devkit ship` and commits still BLOCK');
    expect(out).not.toContain('FAILED');
    expect(noticeText()).toBe('coverage=not-measured reason=absent\n');
  });

  it('an artifact that measured no files → NOT MEASURED, exit 2, and an empty notice', () => {
    const { root } = repo('', { statements: 80 });
    write(root, 'coverage/coverage-final.json', '{}');
    reviewMode();
    const { code, out } = gate(root);
    expect(code).toBe(2);
    expect(out).toContain('measured no files');
    expect(out).not.toContain('FAILED');
    expect(out).not.toContain('passed');
    expect(noticeText()).toBe('coverage=not-measured reason=empty\n');
  });

  it('the same absent artifact outside review still fails closed', () => {
    const { root } = repo();
    const { code, out } = gate(root);
    expect(code).toBe(1);
    expect(out).toContain('Coverage gate FAILED');
    expect(noticeText()).toBe('');
  });

  it('stale artifact → NOT MEASURED before thresholds are judged (its numbers describe other code)', () => {
    const { root } = repo('', { statements: 90 });
    measure(root, undefined, LOW);
    write(root, 'src/a.mts', 'export const a = 3;\n');
    stage(root);
    reviewMode();
    const { code, out } = gate(root);
    expect(code).toBe(2);
    expect(out).toContain('the artifact predates 1 briefed file(s):');
    expect(out).toContain('src/a.mts');
    expect(out).not.toContain('below threshold');
    expect(noticeText()).toBe('coverage=not-measured reason=stale\n');
  });

  it('a FRESH below-threshold artifact still fails a review — measured numbers are a verdict', () => {
    const { root } = repo('', { statements: 90 });
    measure(root, undefined, LOW);
    stage(root);
    reviewMode();
    const { code, out } = gate(root);
    expect(code).toBe(1);
    expect(out).toContain('Coverage below threshold');
    expect(noticeText()).toBe('');
  });

  it('never writes a notices path outside the review temp root', () => {
    const { root } = repo();
    const outside = join(root, 'stray-notices');
    reviewMode(outside);
    expect(gate(root).code).toBe(2);
    expect(existsSync(outside)).toBe(false);
  });
});

describe('materializeReviewCoverage — private copy', () => {
  it('copies the artifact, re-binds provenance so the review reads it FRESH, and leaves the target alone', () => {
    const { root } = repo();
    write(root, 'src/a.mts', 'export const a = 2;\n');
    measure(root);
    const report = join(root, 'coverage/coverage-final.json');
    const before = statSync(report, { bigint: true });
    const wt = reviewWorktree(root, 'export const a = 2;\n');

    expect(materializeReviewCoverage(root, wt)).toBe('copied-rebound');
    expect(lstatSync(join(wt, 'coverage')).isSymbolicLink()).toBe(false);
    reviewMode();
    const { code, out } = gate(wt);
    expect(code).toBe(0);
    expect(out).toMatch(/✓ Coverage gate passed \(.*\) — artifact run run-\d+/);
    const after = statSync(report, { bigint: true });
    expect([after.ino, after.mtimeNs]).toEqual([before.ino, before.mtimeNs]);
  });

  it('an edit the artifact never saw reads STALE in the review worktree', () => {
    const { root } = repo();
    measure(root);
    const wt = reviewWorktree(root, 'export const a = 9;\n');
    materializeReviewCoverage(root, wt);
    reviewMode();
    expect(gate(wt).code).toBe(2);
    expect(noticeText()).toContain('reason=stale');
  });

  it('a manifest that does not bind the source artifact is copied as-is, so provenance stays unknown', () => {
    const { root } = repo();
    measure(root);
    const manifestPath = join(root, 'coverage', MANIFEST_NAME);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, artifactIdentity: '1:2:3' }));
    const wt = reviewWorktree(root);

    expect(materializeReviewCoverage(root, wt)).toBe('copied-unbound');
    reviewMode();
    const { code, out } = gate(wt);
    expect(code).toBe(0);
    expect(out).toContain('provenance unknown');
  });

  it('refuses a symlinked coverage/ — its numbers may belong to another checkout', () => {
    const { root } = repo();
    const elsewhere = trackRoot(mkdtempSync(join(tmpdir(), 'coverage-elsewhere-')));
    writeFileSync(join(elsewhere, 'coverage-final.json'), '{}');
    symlinkSync(elsewhere, join(root, 'coverage'));
    const wt = reviewWorktree(root);
    expect(materializeReviewCoverage(root, wt)).toBe('refused-symlink');
    expect(existsSync(join(wt, 'coverage'))).toBe(false);
  });

  it('keeps a coverage/ the snapshot already carries (a target that does not gitignore it)', () => {
    const { root } = repo();
    measure(root);
    const wt = reviewWorktree(root);
    mkdirSync(join(wt, 'coverage'));
    writeFileSync(join(wt, 'coverage/coverage-final.json'), '{"own":1}');
    expect(materializeReviewCoverage(root, wt)).toBe('destination-present');
    expect(readFileSync(join(wt, 'coverage/coverage-final.json'), 'utf8')).toBe('{"own":1}');
  });

  it('copies nothing when the target has no artifact, but carries the last-clear marker', () => {
    const { root } = repo();
    const wt = reviewWorktree(root);
    expect(materializeReviewCoverage(root, wt)).toBe('absent');
    expect(existsSync(join(wt, 'coverage'))).toBe(false);

    mkdirSync(join(root, 'coverage'));
    writeFileSync(join(root, 'coverage/.last-clear.json'), '{}');
    expect(materializeReviewCoverage(root, wt)).toBe('marker-only');
    expect(existsSync(join(wt, 'coverage/coverage-final.json'))).toBe(false);
  });
});

describe('review copy — scoped runs', () => {
  it('keeps the recorded args, so a scoped artifact is still NOT MEASURED after the copy', () => {
    const { root } = repo();
    measure(root, snapshotSource(root, ['src/a.test.mts']));
    const wt = reviewWorktree(root);
    expect(materializeReviewCoverage(root, wt)).toBe('copied-rebound');
    reviewMode();
    expect(gate(wt).code).toBe(2);
    expect(noticeText()).toBe('coverage=not-measured reason=scoped\n');
  });
});
