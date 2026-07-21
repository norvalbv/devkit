import { spawn } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listPrivateFiles,
  managedPath,
  publishImmutable,
  readPrivateFile,
  readPrivateFileBounded,
} from '../immutable-file.mts';

const scratchRoots: string[] = [];
const temporaryRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'immutable-file-'));
  scratchRoots.push(root);
  return root;
};

afterEach(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('immutable private files', () => {
  it('creates private managed directories without accepting unsafe segments', () => {
    const anchor = temporaryRoot();

    const directory = managedPath(anchor, ['records', 'v1'], true);

    expect(directory).toBe(path.join(realpathSync(anchor), 'records', 'v1'));
    expect(lstatSync(path.join(anchor, 'records')).mode & 0o777).toBe(0o700);
    expect(lstatSync(directory as string).mode & 0o777).toBe(0o700);
    expect(managedPath(anchor, ['missing'], false)).toBeNull();
    for (const segment of ['', '.', '..', 'nested/escape']) {
      expect(() => managedPath(anchor, [segment], true)).toThrow(/unsafe managed segment/);
    }
  });

  it('does not chmod a pre-existing protected directory before descent', () => {
    const anchor = temporaryRoot();
    const existing = path.join(anchor, 'records');
    mkdirSync(existing, { mode: 0o755 });
    chmodSync(existing, 0o755);

    // Repairing this path with chmod created a lstat/chmod gap: a replacement symlink could
    // redirect both chmod and the next mkdir. Existing directories are now read-only inputs;
    // a private leaf is created beneath protected (not group/other-writable) ancestry.
    expect(managedPath(anchor, ['records', 'v1'], true)).toBe(
      path.join(realpathSync(anchor), 'records', 'v1'),
    );
    expect(lstatSync(existing).mode & 0o777).toBe(0o755);
    expect(lstatSync(path.join(existing, 'v1')).mode & 0o777).toBe(0o700);
  });

  it('rejects writable ancestry and a non-private managed leaf', () => {
    const anchor = temporaryRoot();
    const writable = path.join(anchor, 'writable');
    const visible = path.join(anchor, 'visible');
    mkdirSync(writable, { mode: 0o777 });
    chmodSync(writable, 0o777);
    mkdirSync(visible, { mode: 0o755 });
    chmodSync(visible, 0o755);

    expect(() => managedPath(anchor, ['writable', 'v1'], true)).toThrow(/writable by another/);
    expect(() => managedPath(anchor, ['visible'], true)).toThrow(/not private/);
  });

  it('rejects symlinked managed directories without writing outside the anchor', () => {
    const anchor = temporaryRoot();
    const outside = temporaryRoot();
    symlinkSync(outside, path.join(anchor, 'linked'), 'dir');

    expect(() => managedPath(anchor, ['linked', 'nested'], true)).toThrow(/symlink/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('detects a directory replaced after validation before a later operation', () => {
    const anchor = temporaryRoot();
    const outside = temporaryRoot();
    const records = managedPath(anchor, ['records'], true) as string;
    const parked = path.join(anchor, 'parked-records');
    renameSync(records, parked);
    symlinkSync(outside, records, 'dir');

    expect(() => managedPath(anchor, ['records', 'nested'], true)).toThrow(/symlink|changed/);
    expect(() => publishImmutable(records, 'record', Buffer.from('do not escape'))).toThrow(
      /symlink|changed/,
    );
    expect(readdirSync(outside)).toEqual([]);
  });

  it('publishes private files idempotently without replacing their inode', () => {
    const anchor = temporaryRoot();
    const directory = managedPath(anchor, ['records'], true) as string;
    const content = Buffer.from('same immutable bytes');

    expect(readPrivateFile(directory, 'record')).toBeNull();
    expect(publishImmutable(directory, 'record', content)).toBe('created');
    const before = lstatSync(path.join(directory, 'record'));

    expect(readPrivateFile(directory, 'record')).toEqual(content);
    expect(before.mode & 0o777).toBe(0o600);
    expect(publishImmutable(directory, 'record', content)).toBe('existing');
    expect(lstatSync(path.join(directory, 'record')).ino).toBe(before.ino);
  });

  it('bounds private reads before consuming oversized files', () => {
    const anchor = temporaryRoot();
    const directory = managedPath(anchor, ['records'], true) as string;
    const exact = Buffer.from('four');
    publishImmutable(directory, 'exact', exact);
    publishImmutable(directory, 'empty', Buffer.alloc(0));

    expect(readPrivateFileBounded(directory, 'exact', exact.length)).toEqual(exact);
    expect(readPrivateFileBounded(directory, 'empty', 0)).toEqual(Buffer.alloc(0));
    expect(readPrivateFileBounded(directory, 'missing', exact.length)).toBeNull();
    expect(() => readPrivateFileBounded(directory, 'exact', exact.length - 1)).toThrow(
      /exceeds 3 bytes/,
    );

    const oversized = path.join(directory, 'oversized');
    writeFileSync(oversized, '', { mode: 0o600 });
    truncateSync(oversized, 64 * 1024 * 1024);
    expect(() => readPrivateFileBounded(directory, 'oversized', 8)).toThrow(/exceeds 8 bytes/);

    const visible = path.join(directory, 'visible');
    writeFileSync(visible, 'visible', { mode: 0o600 });
    chmodSync(visible, 0o644);
    expect(() => readPrivateFileBounded(directory, 'visible', 8)).toThrow(/not private/);

    symlinkSync(path.join(directory, 'exact'), path.join(directory, 'linked'));
    mkdirSync(path.join(directory, 'nested'));
    expect(() => readPrivateFileBounded(directory, 'linked', 8)).toThrow(/symlink/);
    expect(() => readPrivateFileBounded(directory, 'nested', 8)).toThrow(/not a file/);
    for (const invalid of [-1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => readPrivateFileBounded(directory, 'exact', invalid)).toThrow(
        /invalid maximum read size/,
      );
    }
  });

  it('publishes mode 0600 files under a restrictive process umask', () => {
    const anchor = temporaryRoot();
    const directory = managedPath(anchor, ['records'], true) as string;
    managedPath(directory, ['.pending'], true);
    const previousUmask = process.umask(0o200);
    try {
      expect(publishImmutable(directory, 'record', Buffer.from('private'))).toBe('created');
      expect(lstatSync(path.join(directory, 'record')).mode & 0o777).toBe(0o600);
      expect(publishImmutable(directory, 'record', Buffer.from('private'))).toBe('existing');
    } finally {
      process.umask(previousUmask);
    }
  });

  it('rejects conflicts and non-private existing destinations without replacing bytes', () => {
    const anchor = temporaryRoot();
    const directory = managedPath(anchor, ['records'], true) as string;
    const destination = path.join(directory, 'record');
    publishImmutable(directory, 'record', Buffer.from('first'));

    expect(() => publishImmutable(directory, 'record', Buffer.from('second'))).toThrow(
      /immutable conflict/,
    );
    expect(readFileSync(destination, 'utf8')).toBe('first');

    chmodSync(destination, 0o644);
    expect(() => publishImmutable(directory, 'record', Buffer.from('first'))).toThrow(
      /not private/,
    );
  });

  it('rejects symlink destinations and never writes through them', () => {
    const anchor = temporaryRoot();
    const outside = path.join(temporaryRoot(), 'outside');
    const directory = managedPath(anchor, ['records'], true) as string;
    writeFileSync(outside, 'do not replace');
    symlinkSync(outside, path.join(directory, 'record'));

    expect(() => readPrivateFile(directory, 'record')).toThrow(/symlink/);
    expect(() => publishImmutable(directory, 'record', Buffer.from('replacement'))).toThrow(
      /symlink/,
    );
    expect(readFileSync(outside, 'utf8')).toBe('do not replace');
  });

  it('lists only regular private files in deterministic order', () => {
    const anchor = temporaryRoot();
    const directory = managedPath(anchor, ['records'], true) as string;
    publishImmutable(directory, 'z-record', Buffer.from('z'));
    publishImmutable(directory, 'a-record', Buffer.from('a'));
    mkdirSync(path.join(directory, 'nested'));
    symlinkSync(path.join(directory, 'a-record'), path.join(directory, 'record-link'));

    expect(listPrivateFiles(directory)).toEqual(['a-record', 'z-record']);
  });

  it('keeps orphaned or concurrent pending files out of record listings', () => {
    const anchor = temporaryRoot();
    const directory = managedPath(anchor, ['records'], true) as string;
    const pending = managedPath(directory, ['.pending'], true) as string;
    const orphan = path.join(pending, '.record.123.orphan.tmp');
    writeFileSync(orphan, 'unfinished', { mode: 0o600 });

    expect(listPrivateFiles(directory)).toEqual([]);
    expect(publishImmutable(directory, 'record', Buffer.from('complete'))).toBe('created');
    expect(listPrivateFiles(directory)).toEqual(['record']);
    expect(readdirSync(pending)).toEqual([path.basename(orphan)]);
  });

  it('resolves concurrent hard-link publication with one creator and no temporary files', async () => {
    const root = temporaryRoot();
    const directory = managedPath(root, ['records'], true) as string;
    const gate = path.join(root, 'start');
    const publisher = path.join(root, 'publisher.mts');
    const moduleUrl = pathToFileURL(
      path.join(import.meta.dirname, '..', 'immutable-file.mts'),
    ).href;
    writeFileSync(
      publisher,
      `import { existsSync } from 'node:fs';\n` +
        `import { publishImmutable } from ${JSON.stringify(moduleUrl)};\n` +
        `const [directory, gate] = process.argv.slice(2);\n` +
        `process.stdout.write('ready\\n');\n` +
        `while (!existsSync(gate)) await new Promise((resolve) => setTimeout(resolve, 2));\n` +
        `process.stdout.write(publishImmutable(directory, 'record', Buffer.from('same')));\n`,
    );

    const children = Array.from({ length: 6 }, () => {
      const child = spawn(process.execPath, [publisher, directory, gate], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      const ready = new Promise<void>((resolve, reject) => {
        child.stdout.on('data', () => {
          if (stdout.startsWith('ready\n')) resolve();
        });
        child.once('error', reject);
        child.once('close', (code) => {
          if (!stdout.startsWith('ready\n'))
            reject(new Error(`publisher exited ${code} before ready: ${stderr}`));
        });
      });
      const completed = new Promise<{ code: number | null; stderr: string; stdout: string }>(
        (resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code) => resolve({ code, stderr, stdout }));
        },
      );
      return { completed, ready };
    });

    await Promise.all(children.map(({ ready }) => ready));
    writeFileSync(gate, 'go');
    const results = await Promise.all(children.map(({ completed }) => completed));
    const states = results.map(({ stdout }) => stdout.trim().split('\n').at(-1));

    expect(results.map(({ code }) => code)).toEqual(Array(6).fill(0));
    expect(states.filter((state) => state === 'created')).toHaveLength(1);
    expect(states.filter((state) => state === 'existing')).toHaveLength(5);
    expect(readPrivateFile(directory, 'record')).toEqual(Buffer.from('same'));
    expect(listPrivateFiles(directory)).toEqual(['record']);
    expect(readdirSync(path.join(directory, '.pending'))).toEqual([]);
  });
});
