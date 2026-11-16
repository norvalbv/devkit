import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordShown, SHOWN_RETAIN_MS, shownAnchors, shownStorePath } from '../shown.mts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-02T12:00:00Z');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'guard-comments-shown-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

const A = 'aaaaaaaaaaaa';
const B = 'bbbbbbbbbbbb';

const windowStart = Math.ceil(NOW / SHOWN_RETAIN_MS) * SHOWN_RETAIN_MS;

describe('shown paragraph store', () => {
  it('lives in the git common dir, outside the working tree', () => {
    const root = repo();
    expect(shownStorePath(root)).toBe(
      path.join(path.resolve(root, '.git'), 'devkit/comment-shown'),
    );
  });

  it('reads nothing before a record and both anchors after it', () => {
    const root = repo();
    expect(shownAnchors(root, [A, B], NOW)).toEqual(new Set());
    recordShown(root, [A, B], NOW);
    expect(shownAnchors(root, [A, B], NOW + DAY)).toEqual(new Set([A, B]));
  });

  it('keeps the first sighting time when two gates record the same anchor', () => {
    const root = repo();
    recordShown(root, [A], windowStart + DAY);
    recordShown(root, [A], windowStart + 20 * DAY);
    expect(shownAnchors(root, [A], windowStart + 31 * DAY)).toEqual(new Set());
  });

  it('keeps a sighting from the previous window until thirty days have passed', () => {
    const root = repo();
    recordShown(root, [A], windowStart - DAY);
    expect(shownAnchors(root, [A], windowStart + 28 * DAY)).toEqual(new Set([A]));
  });

  it('reads a sighting older than thirty days as never shown, with no write between', () => {
    const root = repo();
    recordShown(root, [A], windowStart - DAY);
    expect(shownAnchors(root, [A], windowStart + 30 * DAY)).toEqual(new Set());
  });

  it('throws when the store cannot be created, so the gate reports exit 4', () => {
    const root = repo();
    mkdirSync(path.join(root, '.git/devkit'), { recursive: true });
    writeFileSync(path.join(root, '.git/devkit/comment-shown'), 'not a directory');
    expect(() => recordShown(root, [A], NOW)).toThrow();
  });
});
