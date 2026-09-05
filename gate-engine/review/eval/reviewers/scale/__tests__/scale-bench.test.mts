import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Hang detector for CLI startup under parallel suite load.
const CLI_TIMEOUT_MS = 30_000;

it.each(['../../../../escape', "' OR 1=1--", 'g'.repeat(64), 'a'.repeat(63), 'A'.repeat(64)])(
  'rejects malformed diff identifier %s before any storage or query work',
  (diff) => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../scale-bench.mts', import.meta.url)), '--diff', diff],
      { encoding: 'utf8', timeout: CLI_TIMEOUT_MS },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('diff must be a 64-character lowercase SHA-256');
  },
  CLI_TIMEOUT_MS,
);

it.each(['--out', '--research-root'])(
  'rejects %s outside private research before opening telemetry or materializing a diff',
  (flag) => {
    const root = mkdtempSync(join(tmpdir(), 'scale-output-boundary-'));
    const output = join(root, 'output');
    try {
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('../scale-bench.mts', import.meta.url)), flag, output],
        { encoding: 'utf8', timeout: CLI_TIMEOUT_MS },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'raw replay output requires a directory under ~/.devkit/research',
      );
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  CLI_TIMEOUT_MS,
);

it(
  'rejects cleanup of a custom research root before touching unrelated directories',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'scale-clean-research-'));
    const keep = join(root, 'notes', 'keep.txt');
    mkdirSync(join(root, 'notes'));
    writeFileSync(keep, 'unrelated research notes');
    try {
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('../scale-bench.mts', import.meta.url)),
          '--clean',
          '--research-root',
          root,
        ],
        { encoding: 'utf8', timeout: CLI_TIMEOUT_MS },
      );
      expect(existsSync(keep)).toBe(true);
      expect(readFileSync(keep, 'utf8')).toBe('unrelated research notes');
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('--clean cannot be combined with --research-root');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  CLI_TIMEOUT_MS,
);

function childScale(root: string, context: string, mode: string) {
  const script = `import os from 'node:os';
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    os.homedir = () => process.argv[1];
    const { runScaleBench } = await import(process.argv[2]);
    try {
      await runScaleBench(async ({ outputDirectory, contextDirectory }) => {
        console.log('entered');
        if (process.argv[3] === 'hold')
          await new Promise(resolve => process.stdin.once('data', resolve));
        if (process.argv[3] === 'exit') process.exit(7);
        if (process.argv[3] === 'throw') throw new Error('run failed');
        writeFileSync(join(outputDirectory, 'published.json'), JSON.stringify({ contextDirectory }));
      });
    } catch (error) { console.error(error.message); process.exitCode = 1; }
    process.stdin.pause();`;
  const child = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    script,
    root,
    new URL('../scale-bench.mts', import.meta.url).href,
    mode,
    '--diff',
    'a'.repeat(64),
    '--repo',
    root,
    '--branch',
    'same-branch',
    '--research-root',
    join(root, '.devkit', 'research', context),
  ]);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const completed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  const entered = () =>
    new Promise<void>((resolve, reject) => {
      if (stdout.includes('entered')) {
        resolve();
        return;
      }
      child.stdout.once('data', () => resolve());
      child.once('error', reject);
      child.once('close', () => reject(new Error(`owner exited before entry: ${stderr}`)));
    });
  return { child, completed, entered };
}

it(
  'owns the default output bank across awaits even when concurrent runs use different context roots',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'scale-output-owner-')));
    const output = join(root, '.devkit', 'research', '2026-08-22-ship-attempts', 'probe');
    const owner = childScale(root, 'context-a', 'hold');
    try {
      await owner.entered();
      const competing = await childScale(root, 'context-b', 'complete').completed;
      expect(competing.code).toBe(1);
      expect(competing.stderr).toContain('Could not acquire scale output bank lock');
      expect(competing.stdout).not.toContain('entered');
      expect(existsSync(join(output, 'published.json'))).toBe(false);
      owner.child.stdin.end('publish');
      expect((await owner.completed).code).toBe(0);
      expect(
        JSON.parse(readFileSync(join(output, 'published.json'), 'utf8')).contextDirectory,
      ).toContain('context-a');
      expect(existsSync(join(output, '.scale-run.lock'))).toBe(false);
      const resumed = await childScale(root, 'context-b', 'complete').completed;
      expect(resumed.code).toBe(0);
      expect(resumed.stdout).toContain('entered');
      expect(
        JSON.parse(readFileSync(join(output, 'published.json'), 'utf8')).contextDirectory,
      ).toContain('context-b');
    } finally {
      owner.child.kill('SIGKILL');
      await owner.completed;
      rmSync(root, { recursive: true, force: true });
    }
  },
  CLI_TIMEOUT_MS,
);

it.each(['exit', 'throw', 'SIGTERM'])(
  'allows a new output-bank owner after %s',
  async (mode) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'scale-output-release-')));
    const output = join(root, '.devkit', 'research', '2026-08-22-ship-attempts', 'probe');
    const owner = childScale(root, 'context-a', mode === 'SIGTERM' ? 'hold' : mode);
    try {
      if (mode === 'SIGTERM') {
        await owner.entered();
        owner.child.kill('SIGTERM');
      }
      const result = await owner.completed;
      expect(result.code).toBe(mode === 'exit' ? 7 : mode === 'SIGTERM' ? null : 1);
      expect(result.signal).toBe(mode === 'SIGTERM' ? 'SIGTERM' : null);
      expect(existsSync(join(output, '.scale-run.lock'))).toBe(mode === 'SIGTERM');
      const resumed = await childScale(root, 'context-b', 'complete').completed;
      expect(resumed.code).toBe(0);
      expect(resumed.stdout).toContain('entered');
      expect(existsSync(join(output, '.scale-run.lock'))).toBe(false);
      expect(
        JSON.parse(readFileSync(join(output, 'published.json'), 'utf8')).contextDirectory,
      ).toContain('context-b');
    } finally {
      owner.child.kill('SIGKILL');
      await owner.completed;
      rmSync(root, { recursive: true, force: true });
    }
  },
  CLI_TIMEOUT_MS,
);
