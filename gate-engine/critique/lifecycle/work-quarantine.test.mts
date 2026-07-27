import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { temporaryRoot } from '../__tests__/evidence-store-fixture.mts';
import { sha256Bytes } from '../evidence-record.mts';
import {
  getPlanCritiqueWorkQuarantine,
  persistPlanCritiqueWorkQuarantine,
} from './work-quarantine.mts';

const identity = (overrides: Record<string, unknown> = {}) => ({
  provider: 'claude' as const,
  repositoryFingerprint: sha256Bytes(Buffer.from('repository', 'utf8')),
  workId: 'pcw1_example-work',
  ...overrides,
});

function quarantineFile(root: string): string {
  const directory = path.join(root, 'work-quarantines');
  const names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  expect(names).toHaveLength(1);
  return path.join(directory, names[0] as string);
}

describe('plan critique work quarantine', () => {
  it('publishes a deterministic private tombstone idempotently', () => {
    const root = temporaryRoot();
    const first = persistPlanCritiqueWorkQuarantine(identity(), { root });
    const file = quarantineFile(root);
    const before = lstatSync(file);

    expect(first).toEqual({
      state: 'created',
      quarantine: {
        schemaVersion: 1,
        kind: 'plan_critique_work_quarantine',
        provider: 'claude',
        repositoryFingerprint: identity().repositoryFingerprint,
        workId: 'pcw1_example-work',
        reason: 'hook_continuation',
      },
    });
    expect(before.mode & 0o777).toBe(0o600);
    expect(persistPlanCritiqueWorkQuarantine(identity(), { root }).state).toBe('existing');
    expect(lstatSync(file).ino).toBe(before.ino);
    expect(getPlanCritiqueWorkQuarantine(identity(), { root })).toEqual({
      status: 'quarantined',
      quarantine: first.quarantine,
    });
  });

  it('keeps provider, repository, and work identities independent', () => {
    const root = temporaryRoot();
    persistPlanCritiqueWorkQuarantine(identity(), { root });

    expect(
      getPlanCritiqueWorkQuarantine(identity({ provider: 'codex' as const }), { root }),
    ).toEqual({ status: 'clear' });
    expect(
      getPlanCritiqueWorkQuarantine(
        identity({ repositoryFingerprint: sha256Bytes(Buffer.from('other repository')) }),
        { root },
      ),
    ).toEqual({ status: 'clear' });
    expect(
      getPlanCritiqueWorkQuarantine(identity({ workId: 'pcw1_other-work' }), { root }),
    ).toEqual({ status: 'clear' });
  });

  it('does not create storage while reading a clear identity', () => {
    const root = temporaryRoot();
    expect(getPlanCritiqueWorkQuarantine(identity(), { root })).toEqual({ status: 'clear' });
    expect(() => readdirSync(root)).toThrow(/ENOENT/);
  });

  it.each([
    identity({ provider: 'unknown' }),
    identity({ repositoryFingerprint: 'not-a-fingerprint' }),
    identity({ workId: '' }),
    identity({ workId: 'controlled\nwork' }),
    identity({ workId: 'w'.repeat(4097) }),
  ])('rejects an invalid identity before publication', (invalid) => {
    const root = temporaryRoot();
    expect(() => persistPlanCritiqueWorkQuarantine(invalid as never, { root })).toThrow(
      /invalid plan critique work quarantine identity/,
    );
    expect(getPlanCritiqueWorkQuarantine(invalid as never, { root })).toEqual({
      status: 'unavailable',
      reason: 'malformed_quarantine',
    });
    expect(() => readdirSync(root)).toThrow(/ENOENT/);
  });

  it('fails closed for revoked proxy identities', () => {
    const root = temporaryRoot();
    const revocable = Proxy.revocable(identity(), {});
    revocable.revoke();

    expect(() => persistPlanCritiqueWorkQuarantine(revocable.proxy as never, { root })).toThrow(
      /invalid plan critique work quarantine identity/,
    );
    expect(getPlanCritiqueWorkQuarantine(revocable.proxy as never, { root })).toEqual({
      status: 'unavailable',
      reason: 'malformed_quarantine',
    });
    expect(() => readdirSync(root)).toThrow(/ENOENT/);
  });

  it.each([
    'invalid-json',
    'wrong-identity',
    'non-canonical',
    'oversized',
  ])('fails closed for %s persisted bytes', (corruption) => {
    const root = temporaryRoot();
    persistPlanCritiqueWorkQuarantine(identity(), { root });
    const file = quarantineFile(root);
    if (corruption === 'invalid-json') writeFileSync(file, '{');
    if (corruption === 'wrong-identity') {
      const record = JSON.parse(readFileSync(file, 'utf8'));
      record.workId = 'pcw1_other-work';
      writeFileSync(file, `${JSON.stringify(record)}\n`);
    }
    if (corruption === 'non-canonical') {
      const record = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    }
    if (corruption === 'oversized') writeFileSync(file, Buffer.alloc(16 * 1024 + 1));
    expect(getPlanCritiqueWorkQuarantine(identity(), { root })).toEqual({
      status: 'unavailable',
      reason: 'malformed_quarantine',
    });
  });

  it('fails closed for non-private persisted evidence', () => {
    const root = temporaryRoot();
    persistPlanCritiqueWorkQuarantine(identity(), { root });
    chmodSync(quarantineFile(root), 0o644);
    expect(getPlanCritiqueWorkQuarantine(identity(), { root })).toEqual({
      status: 'unavailable',
      reason: 'malformed_quarantine',
    });
  });

  it('publishes private directories and tombstones under a restrictive umask', () => {
    const root = temporaryRoot();
    const previousUmask = process.umask(0o200);
    try {
      expect(persistPlanCritiqueWorkQuarantine(identity(), { root }).state).toBe('created');
    } finally {
      process.umask(previousUmask);
    }
    const directory = path.join(root, 'work-quarantines');
    const files = readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => path.join(directory, name));
    expect(files).toHaveLength(1);
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(path.join(directory, '.pending')).mode & 0o777).toBe(0o700);
    expect(lstatSync(files[0] as string).mode & 0o777).toBe(0o600);
    expect(getPlanCritiqueWorkQuarantine(identity(), { root }).status).toBe('quarantined');
  });

  it('fails closed when the quarantine path is not a managed directory', () => {
    const root = temporaryRoot();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(root, 'work-quarantines'), 'not a directory');
    expect(getPlanCritiqueWorkQuarantine(identity(), { root })).toEqual({
      status: 'unavailable',
      reason: 'malformed_quarantine',
    });
  });
});
