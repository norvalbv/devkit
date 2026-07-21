import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadEntries,
  replaceEntries,
  saveEntries,
  verdictStoreGeneration,
} from '../../gate-engine/judge/verdict-store.mts';
import {
  prepareReviewCacheSession,
  promoteReviewCacheStore,
  REVIEW_CACHE_STORE_NAMES,
} from '../lib/ship/review/cache/session.mts';
import { rootRegistry } from './_helpers.mts';

const SESSION_CLI = join(
  dirname(fileURLToPath(import.meta.url)),
  '../lib/ship/review/cache/session.mts',
);
const { mkTmp, cleanup } = rootRegistry();

afterEach(cleanup);

function roots(label: string): { persistent: string; privateRoot: string } {
  return {
    persistent: realpathSync(mkTmp(`devkit-review-cache-session-${label}-persistent-`)),
    privateRoot: realpathSync(mkTmp(`devkit-review-cache-session-${label}-private-`)),
  };
}

function store(root: string, name = REVIEW_CACHE_STORE_NAMES[0]): string {
  return join(root, name);
}

describe('review cache session', () => {
  it('hydrates only the fixed review stores and reports their captured generations', () => {
    const fx = roots('prepare');
    const seeded = {
      'review-cache.json': { review: { at: '2026-07-21T00:00:00.000Z' } },
      'decisions-verdict-cache.json': { decision: { at: '2026-07-21T00:00:01.000Z' } },
    };
    for (const [name, entries] of Object.entries(seeded)) {
      expect(saveEntries(store(fx.persistent, name), entries)).toBe(true);
    }
    writeFileSync(join(fx.persistent, 'not-a-review-store.json'), '{"secret":true}\n');

    const checkpoints = prepareReviewCacheSession(fx.persistent, fx.privateRoot);

    expect(checkpoints.map(({ name }) => name)).toEqual(REVIEW_CACHE_STORE_NAMES);
    for (const checkpoint of checkpoints) {
      expect(checkpoint.generation).toBe(
        verdictStoreGeneration(store(fx.persistent, checkpoint.name)),
      );
      expect(loadEntries(store(fx.privateRoot, checkpoint.name))).toEqual(
        loadEntries(store(fx.persistent, checkpoint.name)),
      );
    }
    expect(existsSync(join(fx.privateRoot, 'not-a-review-store.json'))).toBe(false);
  });

  it('CAS-promotes private checkpoints while preserving same-generation concurrent additions', () => {
    const fx = roots('merge');
    const persistentStore = store(fx.persistent);
    const privateStore = store(fx.privateRoot);
    expect(saveEntries(persistentStore, { prior: { at: '1' } })).toBe(true);
    const [checkpoint] = prepareReviewCacheSession(fx.persistent, fx.privateRoot);
    expect(checkpoint?.generation).not.toBeNull();
    expect(saveEntries(privateStore, { reviewed: { at: '3' } })).toBe(true);
    expect(saveEntries(persistentStore, { concurrent: { at: '2' } })).toBe(true);

    expect(
      promoteReviewCacheStore(
        fx.persistent,
        fx.privateRoot,
        'review-cache.json',
        checkpoint?.generation ?? null,
      ),
    ).toBe('saved');
    expect(loadEntries(persistentStore)).toEqual({
      prior: { at: '1' },
      concurrent: { at: '2' },
      reviewed: { at: '3' },
    });
  });

  it('refuses promotion after the persistent generation is replaced', () => {
    const fx = roots('rotation');
    const persistentStore = store(fx.persistent);
    const privateStore = store(fx.privateRoot);
    expect(saveEntries(persistentStore, { prior: { at: '1' } })).toBe(true);
    const [checkpoint] = prepareReviewCacheSession(fx.persistent, fx.privateRoot);
    expect(saveEntries(privateStore, { stale: { at: '3' } })).toBe(true);
    expect(replaceEntries(persistentStore, { authoritative: { at: '2' } })).toBe(true);

    expect(
      promoteReviewCacheStore(
        fx.persistent,
        fx.privateRoot,
        'review-cache.json',
        checkpoint?.generation ?? null,
      ),
    ).toBe('generation-changed');
    expect(loadEntries(persistentStore)).toEqual({ authoritative: { at: '2' } });
  });

  it('promotes an initially absent store using a null generation checkpoint', () => {
    const fx = roots('absent');
    const [checkpoint] = prepareReviewCacheSession(fx.persistent, fx.privateRoot);
    expect(checkpoint).toEqual({ name: 'review-cache.json', generation: null });
    expect(saveEntries(store(fx.privateRoot), { first: { at: '1' } })).toBe(true);

    expect(
      promoteReviewCacheStore(
        fx.persistent,
        fx.privateRoot,
        'review-cache.json',
        checkpoint.generation,
      ),
    ).toBe('saved');
    expect(loadEntries(store(fx.persistent))).toEqual({ first: { at: '1' } });
  });

  it('rejects overlapping, linked, and unapproved cache roots or store names', () => {
    const fx = roots('unsafe');
    const nested = join(fx.persistent, 'private');
    mkdirSync(nested);
    expect(() => prepareReviewCacheSession(fx.persistent, nested)).toThrow(/separate/);
    expect(() => prepareReviewCacheSession(fx.persistent, fx.persistent)).toThrow(/separate/);

    const linked = join(mkTmp('devkit-review-cache-session-link-parent-'), 'linked');
    symlinkSync(fx.privateRoot, linked, 'dir');
    expect(() => prepareReviewCacheSession(fx.persistent, linked)).toThrow(/physical directory/);
    expect(() =>
      promoteReviewCacheStore(fx.persistent, fx.privateRoot, 'arbitrary.json', null),
    ).toThrow(/unsupported review cache store/);
  });

  it('uses a fixed NUL protocol and exit 2 for a stale CLI promotion', () => {
    const fx = roots('cli');
    const prepared = spawnSync(
      process.execPath,
      [SESSION_CLI, 'prepare', fx.persistent, fx.privateRoot],
      { encoding: null },
    );
    expect(prepared.status, prepared.stderr.toString()).toBe(0);
    expect(prepared.stdout.toString().split('\0')).toEqual([
      'devkit-review-cache-session-v1',
      '3',
      'review-cache.json',
      '',
      'decisions-verdict-cache.json',
      '',
      'prefix-cache.json',
      '',
      '',
    ]);

    expect(replaceEntries(store(fx.persistent), { replaced: { at: '1' } })).toBe(true);
    const promoted = spawnSync(
      process.execPath,
      [SESSION_CLI, 'promote', fx.persistent, fx.privateRoot, 'review-cache.json', randomUUID()],
      { encoding: null },
    );
    expect(promoted.status).toBe(2);
    expect(promoted.stdout.toString().split('\0')).toEqual([
      'devkit-review-cache-promotion-v1',
      'review-cache.json',
      'generation-changed',
      '',
    ]);
  });
});
