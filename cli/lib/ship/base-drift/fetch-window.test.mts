import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TTL_MS, markerPathsFor, refreshWindow, windowState } from './fetch-window.mts';
import type { GitResult, GitRun } from './git-run.mts';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'bd-window-'));
});

function fakeGit(result: GitResult) {
  const calls: string[][] = [];
  const run: GitRun = (args) => {
    calls.push(args);
    return result;
  };
  // Object.assign infers the intersection, so the recorder needs no assertion to exist.
  return Object.assign(run, { calls });
}

const okGit = () => fakeGit({ status: 0, stdout: '', stderr: '' });
const failGit = () => fakeGit({ status: 128, stdout: '', stderr: 'could not read' });

describe('markerPathsFor', () => {
  it('gives sibling worktrees of ONE clone the same markers', () => {
    // Keyed on the common git dir, not the worktree path — that is what lets N agents share one
    // fetch instead of each paying the network.
    expect(markerPathsFor('/clone/.git', 'main', tmp)).toEqual(
      markerPathsFor('/clone/.git', 'main', tmp),
    );
  });

  it('gives different clones, and different bases, different markers', () => {
    expect(markerPathsFor('/clone-a/.git', 'main', tmp).attempt).not.toBe(
      markerPathsFor('/clone-b/.git', 'main', tmp).attempt,
    );
    expect(markerPathsFor('/clone/.git', 'main', tmp).attempt).not.toBe(
      markerPathsFor('/clone/.git', 'release', tmp).attempt,
    );
  });

  it('separates the rate limit from the freshness proof', () => {
    const { attempt, done } = markerPathsFor('/clone/.git', 'main', tmp);
    expect(attempt).not.toBe(done);
  });

  it('cannot be made to escape its namespace by a path-shaped base', () => {
    // The base arrives from argv or the environment, so it is hashed rather than interpolated.
    const { dir, attempt, done } = markerPathsFor('/clone/.git', '../../../../etc/passwd', tmp);
    for (const path of [attempt, done]) {
      expect(path.startsWith(`${dir}/`)).toBe(true);
      expect(path).not.toContain('..');
    }
  });
});

describe('windowState', () => {
  const markers = (name: string) => ({
    attempt: join(tmp, `${name}.attempt`),
    done: join(tmp, `${name}.done`),
  });

  it('reports no window when there is no marker', () => {
    expect(windowState(markers('absent'), 1_000, DEFAULT_TTL_MS)).toEqual({
      ageMs: null,
      done: false,
    });
  });

  it('treats a future-dated marker as NO window rather than an eternally young one', () => {
    const m = markers('future');
    writeFileSync(m.attempt, '');
    expect(windowState(m, 0, DEFAULT_TTL_MS).ageMs).toBeNull();
  });

  it('a future-dated marker cannot suppress a refresh', () => {
    const stamp = join(tmp, 'devkit-base-drift');
    const run = okGit();
    // now far behind the marker mtime: a clamp-to-zero would report cached and skip the fetch.
    refreshWindow(run, {
      commonDir: '/clone/.git',
      base: 'main',
      maxAgeMs: DEFAULT_TTL_MS,
      timeoutMs: 2_500,
      tmpDir: tmp,
      now: 1,
    });
    expect(run.calls).toHaveLength(1);
    expect(stamp).toBeTruthy();
  });

  it('reads a half-written window as NOT done', () => {
    const m = markers('inflight');
    writeFileSync(m.attempt, '');
    expect(windowState(m, 1_000, DEFAULT_TTL_MS).done).toBe(false);
  });
});

describe('refreshWindow', () => {
  const opts = (extra: Partial<Parameters<typeof refreshWindow>[1]> = {}) => ({
    commonDir: '/clone/.git',
    base: 'main',
    maxAgeMs: DEFAULT_TTL_MS,
    timeoutMs: 2_500,
    tmpDir: tmp,
    now: 1_000_000,
    ...extra,
  });

  it('fetches when there is no window, and reports fresh', () => {
    const run = okGit();
    expect(refreshWindow(run, opts())).toEqual({ freshness: 'fresh', ageMs: 0 });
    expect(run.calls).toHaveLength(1);
  });

  it('uses --no-tags, --no-write-fetch-head and ONE forced refspec', () => {
    const run = okGit();
    refreshWindow(run, opts());
    expect(run.calls).toHaveLength(1);
    const args = run.calls.flat();
    expect(args).toContain('--no-tags');
    // Without this a hook fetch clobbers a concurrent ship's FETCH_HEAD (ship-branch.sh:298-303).
    expect(args).toContain('--no-write-fetch-head');
    expect(args.at(-1)).toBe('+refs/heads/main:refs/remotes/origin/main');
  });

  it('rides an open window without touching the network', () => {
    const first = okGit();
    refreshWindow(first, opts());
    const second = okGit();
    const outcome = refreshWindow(second, opts({ now: 1_000_000 + 30_000 }));
    expect(outcome.freshness).toBe('cached');
    expect(outcome.ageMs).toBe(30_000);
    expect(second.calls).toHaveLength(0);
  });

  it('re-fetches once the window has expired', () => {
    refreshWindow(okGit(), opts());
    const later = okGit();
    expect(refreshWindow(later, opts({ now: 1_000_000 + DEFAULT_TTL_MS + 1 })).freshness).toBe(
      'fresh',
    );
    expect(later.calls).toHaveLength(1);
  });

  it('maxAgeMs 0 always fetches', () => {
    refreshWindow(okGit(), opts());
    const forced = okGit();
    expect(refreshWindow(forced, opts({ maxAgeMs: 0 })).freshness).toBe('fresh');
    expect(forced.calls).toHaveLength(1);
  });

  it('reports unknown — never fresh — when the fetch fails', () => {
    expect(refreshWindow(failGit(), opts()).freshness).toBe('unknown');
  });

  it('stamps the window BEFORE fetching, so a hung remote costs one window not one stall per call', () => {
    const failing = failGit();
    refreshWindow(failing, opts());
    // The marker exists despite the failure, so the next call inside the window does not re-attempt.
    const next = failGit();
    expect(next.calls).toHaveLength(0);
    expect(readdirSync(join(tmp, 'devkit-base-drift'))).toHaveLength(1);
  });

  it('a FAILED refresh does not license the rest of its window to report cached', () => {
    // The rate limit and the freshness claim are separate: the window still suppresses re-attempts,
    // but the refs it would be read from were never updated, so nothing may call them current.
    refreshWindow(failGit(), opts());
    const next = failGit();
    const outcome = refreshWindow(next, opts({ now: 1_000_000 + 1_000 }));
    expect(outcome.freshness).toBe('unknown');
    expect(next.calls).toHaveLength(0);
  });

  it("a second agent's failed attempt does not destroy the first agent's proof", () => {
    refreshWindow(okGit(), opts());
    const { attempt, done } = markerPathsFor('/clone/.git', 'main', tmp);
    expect(existsSync(done)).toBe(true);

    const laterFailure = failGit();
    expect(
      refreshWindow(laterFailure, opts({ maxAgeMs: 0, now: 1_000_000 + 1_000 })).freshness,
    ).toBe('unknown');
    // Both files survive independently; a single-file scheme would have lost the completion.
    expect(existsSync(done)).toBe(true);
    expect(existsSync(attempt)).toBe(true);

    // And the window stays conservative rather than re-certifying from the superseded completion.
    expect(refreshWindow(okGit(), opts({ now: 1_000_000 + 2_000 })).freshness).toBe('unknown');
  });

  it("a stale completion beside a fresh attempt does not license 'cached'", () => {
    // The attempt window can expire while the previous `done` is still inside the TTL. A reader
    // seeing that pair would otherwise trust refs that a now-in-flight fetch is about to replace.
    refreshWindow(okGit(), opts());
    // A's attempt expires; A starts a NEW fetch (stamping a fresh attempt) that has not returned.
    const later = 1_000_000 + DEFAULT_TTL_MS - 1_000;
    const inFlight: GitRun = () => {
      const b = refreshWindow(okGit(), opts({ now: later + 10 }));
      expect(b.freshness).toBe('unknown');
      return { status: 0, stdout: '', stderr: '' };
    };
    refreshWindow(inFlight, opts({ maxAgeMs: 0, now: later }));
  });

  it('a completion cannot certify a DIFFERENT attempt, even one stamped in the same tick', () => {
    // The attempt id must be unique per attempt, not derived from a clock two attempts can share.
    const { attempt, done } = markerPathsFor('/clone/.git', 'main', tmp);
    refreshWindow(okGit(), opts());
    const firstId = readFileSync(done, 'utf8').trim();
    expect(firstId).not.toBe('');
    // A second forced attempt at the SAME instant: its id must differ, so the old completion cannot
    // vouch for it and a reader inside the window sees unknown rather than cached.
    refreshWindow(failGit(), opts({ maxAgeMs: 0 }));
    expect(readFileSync(attempt, 'utf8').trim()).not.toBe(firstId);
    expect(refreshWindow(okGit(), opts()).freshness).toBe('unknown');
  });

  it('a concurrent reader during an IN-FLIGHT fetch reports unknown, never cached', () => {
    const inFlight: GitRun = (args) => {
      expect(args[0]).toBe('fetch');
      const b = refreshWindow(okGit(), opts({ now: 1_000_000 + 200 }));
      expect(b.freshness).toBe('unknown');
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(refreshWindow(inFlight, opts()).freshness).toBe('fresh');
    // Once A completes, the same window IS trustworthy.
    expect(refreshWindow(okGit(), opts({ now: 1_000_000 + 300 })).freshness).toBe('cached');
  });
});
