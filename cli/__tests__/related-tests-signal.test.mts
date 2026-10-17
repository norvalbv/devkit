import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { processAlive, testSpawnSync, waitForPath } from './_helpers.mts';

void (() => import('../lib/husky/gate-policy/related-tests.mts'));

const GATE = join(import.meta.dirname, '..', 'lib', 'husky', 'gate-policy', 'related-tests.mts');

// Mimics vitest: it traps the signal and exits, leaving its fork worker running.
const FAKE_VITEST = `#!${process.execPath}
if (process.env.FAKE_EXIT) {
  console.log('fake vitest ran');
  process.exit(Number(process.env.FAKE_EXIT));
}
const { spawn } = require('node:child_process');
const { renameSync, writeFileSync } = require('node:fs');
process.on('SIGTERM', () => process.exit(143));
process.on('SIGINT', () => process.exit(130));
const worker = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60e3)'], { stdio: 'ignore' });
writeFileSync(process.env.PIDS_FILE + '.tmp', \`\${process.pid} \${worker.pid}\`);
renameSync(process.env.PIDS_FILE + '.tmp', process.env.PIDS_FILE);
setTimeout(() => process.exit(0), 60e3);
`;

const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) if (processAlive(pid)) process.kill(pid, 'SIGKILL');
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

// A repo with one staged module and the fake vitest at node_modules/.bin/vitest.
function fixtureRepo(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'related-tests-signal-')));
  dirs.push(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'a.mts'), 'export const a = 1;\n');
  git(repo, 'add', 'a.mts');
  mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
  // CommonJS: the fixture has no package.json, so node reads the extensionless file as a script.
  writeFileSync(join(repo, 'node_modules', '.bin', 'vitest'), FAKE_VITEST);
  chmodSync(join(repo, 'node_modules', '.bin', 'vitest'), 0o755);
  return repo;
}

async function gone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const started = Date.now();
  while (processAlive(pid)) {
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

describe('related-tests gate signalled mid-run', () => {
  // SIGHUP and SIGQUIT come from the terminal, which no longer reaches vitest's detached group.
  it.each(['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'] as const)(
    'ends vitest and its worker on %s, and blocks',
    async (signal) => {
      const repo = fixtureRepo();
      const pidsFile = join(repo, 'pids');
      const child = spawn(process.execPath, [GATE], {
        cwd: repo,
        env: { ...process.env, PIDS_FILE: pidsFile },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      if (child.pid) pids.push(child.pid);
      await waitForPath(pidsFile, 30_000, child);
      const [main, worker] = readFileSync(pidsFile, 'utf8').split(' ').map(Number);
      pids.push(main, worker);
      const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
      child.kill(signal);
      expect(await exited).not.toBe(0);
      expect(await gone(main)).toBe(true);
      expect(await gone(worker)).toBe(true);
    },
  );
});

describe('related-tests gate run to completion in its own process group', () => {
  it.each([0, 1])('keeps vitest exit %i and its inherited output', (code) => {
    const repo = fixtureRepo();
    const r = testSpawnSync(process.execPath, [GATE], {
      cwd: repo,
      env: { ...process.env, FAKE_EXIT: String(code) },
      encoding: 'utf8',
    });
    expect(r.status).toBe(code);
    expect(r.stdout).toContain('related-tests: 1 staged path(s)\nfake vitest ran\n');
  });
});
