import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  pinReviewRuntimeFile,
  reviewRuntimeFileFingerprint,
  reviewRuntimeFingerprint,
} from '../lib/ship/review/runtime-fingerprint.mts';
import { rootRegistry } from './_helpers.mts';

const FINGERPRINT_CLI = join(
  dirname(fileURLToPath(import.meta.url)),
  '../lib/ship/review/runtime-fingerprint.mts',
);
const { mkTmp, cleanup } = rootRegistry();

afterEach(cleanup);

function runFingerprint(...args: string[]) {
  return spawnSync(process.execPath, [FINGERPRINT_CLI, ...args], { encoding: 'utf8' });
}

describe('review runtime fingerprints', () => {
  it('tracks binary content and executable mode, but not unrelated permission bits', () => {
    const root = mkTmp('devkit-review-fingerprint-file-');
    const file = join(root, 'runtime.bin');
    const initial = Buffer.from([0, 1, 2, 0, 255]);
    writeFileSync(file, initial);
    chmodSync(file, 0o644);
    const regular = reviewRuntimeFingerprint(file);

    expect(regular).toBe(reviewRuntimeFileFingerprint(initial, 0o644));
    chmodSync(file, 0o600);
    expect(reviewRuntimeFingerprint(file)).toBe(regular);
    chmodSync(file, 0o755);
    expect(reviewRuntimeFingerprint(file)).not.toBe(regular);
    writeFileSync(file, Buffer.from([0, 1, 2, 0, 254]));
    expect(reviewRuntimeFingerprint(file)).not.toBe(regular);
  });

  it('uses deterministic relative-path order for directory trees', () => {
    const first = mkTmp('devkit-review-fingerprint-order-a-');
    const second = mkTmp('devkit-review-fingerprint-order-b-');
    mkdirSync(join(first, 'nested'));
    mkdirSync(join(second, 'nested'));
    writeFileSync(join(first, 'z.txt'), 'last\n');
    writeFileSync(join(first, 'nested/a.txt'), 'first\n');
    writeFileSync(join(second, 'nested/a.txt'), 'first\n');
    writeFileSync(join(second, 'z.txt'), 'last\n');

    expect(reviewRuntimeFingerprint(first)).toBe(reviewRuntimeFingerprint(second));
    writeFileSync(join(second, 'nested/a.txt'), 'changed\n');
    expect(reviewRuntimeFingerprint(first)).not.toBe(reviewRuntimeFingerprint(second));
  });

  it('dereferences file and directory symlinks', () => {
    const root = mkTmp('devkit-review-fingerprint-links-');
    const file = join(root, 'file.txt');
    const directory = join(root, 'directory');
    writeFileSync(file, 'runtime\n');
    mkdirSync(directory);
    writeFileSync(join(directory, 'nested.txt'), 'nested\n');
    symlinkSync(file, join(root, 'file-link'));
    symlinkSync(directory, join(root, 'directory-link'));

    expect(reviewRuntimeFingerprint(join(root, 'file-link'))).toBe(reviewRuntimeFingerprint(file));
    expect(reviewRuntimeFingerprint(join(root, 'directory-link'))).toBe(
      reviewRuntimeFingerprint(directory),
    );
  });

  it('rejects cyclic directory projections', () => {
    const root = mkTmp('devkit-review-fingerprint-cycle-');
    mkdirSync(join(root, 'nested'));
    symlinkSync(root, join(root, 'nested/back'));

    expect(() => reviewRuntimeFingerprint(root)).toThrow(/cyclic review runtime path/);
  });

  it.runIf(process.platform !== 'win32')('rejects unsupported filesystem entry types', () => {
    const root = mkTmp('devkit-review-fingerprint-fifo-');
    const fifo = join(root, 'runtime.fifo');
    const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    expect(created.status, created.stderr).toBe(0);

    expect(() => reviewRuntimeFingerprint(fifo)).toThrow(/unsupported review runtime path type/);
  });

  it('verifies fingerprints and true absence in one invocation', () => {
    const root = mkTmp('devkit-review-fingerprint-verify-');
    const file = join(root, 'runtime.txt');
    const absent = join(root, 'absent');
    writeFileSync(file, 'runtime\n');
    const expected = reviewRuntimeFingerprint(file);

    const unchanged = runFingerprint('--verify', expected, file, 'absent', absent);
    expect(unchanged.status, unchanged.stderr).toBe(0);

    writeFileSync(file, 'changed\n');
    const changed = runFingerprint('--verify', expected, file, 'absent', absent);
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain(file);
  });

  it('does not treat a dangling symlink as absent', () => {
    const root = mkTmp('devkit-review-fingerprint-dangling-');
    const link = join(root, 'runtime-link');
    symlinkSync(join(root, 'missing'), link);

    const result = runFingerprint('--verify', 'absent', link);

    expect(result.status).not.toBe(0);
  });

  it('runs verification when the CLI entrypoint is reached through a package symlink', () => {
    const root = mkTmp('devkit-review-fingerprint-cli-link-');
    const cliLink = join(root, 'runtime-fingerprint.mts');
    const file = join(root, 'runtime.txt');
    symlinkSync(FINGERPRINT_CLI, cliLink);
    writeFileSync(file, 'runtime\n');

    const result = spawnSync(process.execPath, [cliLink, '--verify', 'wrong', file], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(file);
  });

  it('keeps the descriptor-pinned file when the source is overwritten', () => {
    const root = mkTmp('devkit-review-runtime-pin-');
    const source = join(root, 'source.json');
    const pinned = join(root, 'pinned.json');
    writeFileSync(source, '{"version":"A"}\n');

    const fingerprint = pinReviewRuntimeFile(source, pinned);
    writeFileSync(source, '{"version":"B"}\n');

    expect(readFileSync(pinned, 'utf8')).toBe('{"version":"A"}\n');
    expect(reviewRuntimeFingerprint(pinned)).toBe(fingerprint);
    expect(reviewRuntimeFingerprint(source)).not.toBe(fingerprint);
  });
});
