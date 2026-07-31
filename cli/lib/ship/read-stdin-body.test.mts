import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const shipScript = fileURLToPath(new URL('./ship-branch.sh', import.meta.url));
const reshipScript = fileURLToPath(new URL('./reship.sh', import.meta.url));
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  });
}

function seedShipRepo(): { dir: string; script: string; args: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'ship-stdin-'));
  roots.push(dir);
  git(dir, ['init', '-q', '-b', 'work']);
  git(dir, ['config', 'user.email', 'a@b.c']);
  git(dir, ['config', 'user.name', 'a']);
  writeFileSync(join(dir, 'note.txt'), 'base\n');
  git(dir, ['add', 'note.txt']);
  git(dir, ['commit', '-q', '-m', 'base']);
  git(dir, ['remote', 'add', 'origin', 'git@github.com:acme/app.git']);
  writeFileSync(join(dir, 'note.txt'), 'changed\n');
  return {
    dir,
    script: shipScript,
    args: ['feat/idle-stdin', 'test', '--', 'note.txt'],
  };
}

function seedReshipRepo(): { dir: string; script: string; args: string[] } {
  const remoteRoot = mkdtempSync(join(tmpdir(), 'reship-stdin-remote-'));
  roots.push(remoteRoot);
  const bare = join(remoteRoot, 'github.com', 'acme', 'app.git');
  execFileSync('mkdir', ['-p', join(remoteRoot, 'github.com', 'acme')]);
  git(remoteRoot, ['init', '-q', '--bare', bare]);

  const seeded = seedShipRepo();
  git(seeded.dir, ['remote', 'set-url', 'origin', bare]);
  git(seeded.dir, ['push', '-q', 'origin', 'work:pr-open']);
  writeFileSync(join(seeded.dir, 'note.txt'), 'reship delta\n');
  return {
    dir: seeded.dir,
    script: reshipScript,
    args: ['pr-open', 'test', '--', 'note.txt'],
  };
}

function runWithIdleStdin({
  dir,
  script,
  args,
}: {
  dir: string;
  script: string;
  args: string[];
}): Promise<{ status: number | null; stderr: string; watchdogFired: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', [script, ...args], {
      cwd: dir,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        ...GIT_ENV,
        SHIP_DRY_RUN: '1',
        SHIP_STDIN_TIMEOUT_SECONDS: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let watchdogFired = false;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      if (process.platform === 'win32' || child.pid === undefined) child.kill('SIGTERM');
      else process.kill(-child.pid, 'SIGTERM');
      child.stdin.destroy();
    }, 2_500);
    child.once('close', (status) => {
      clearTimeout(watchdog);
      child.stdin.destroy();
      resolve({ status, stderr, watchdogFired });
    });
  });
}

describe('ship stdin body timeout (sc-1340)', () => {
  for (const [mode, seed] of [
    ['new ship', seedShipRepo],
    ['re-ship', seedReshipRepo],
  ] as const) {
    it(`${mode} fails loud instead of waiting forever on an open, idle stdin pipe`, async () => {
      const result = await runWithIdleStdin(seed());
      expect(result.watchdogFired, result.stderr).toBe(false);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('stdin stayed open without completing a PR body');
      expect(result.stderr).toContain('redirect stdin from /dev/null');
    });
  }
});
