import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EVIDENCE_BEGIN, readEvidenceBlock } from '../lib/ship/evidence/block.mts';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import {
  dirs,
  GIT_ENV,
  reshipScript,
  scriptPath,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

const RUN = fileURLToPath(new URL('../lib/ship/evidence/run.mts', import.meta.url));
const VITEST = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url));
const COMMAND = [
  process.execPath,
  VITEST,
  'run',
  '--globals',
  '--reporter=json',
  '--outputFile.json={report}',
  '{files}',
];
const BLOCK = /<!-- devkit:evidence:begin -->[\s\S]*?<!-- devkit:evidence:end -->/;
const QAVIS = '<!-- qavis:start -->\nqa passed\n<!-- qavis:end -->';
const BROKEN = "export const value = () => 'broken';\n";
const FIXED = "export const value = () => 'fixed';\n";
const VALUE_TEST =
  "import { value } from './value.mjs';\nit('is fixed', () => expect(value()).toBe('fixed'));\n";

/** A recording gh: `pr view` serves the stored body plus the branch tips from the bare origin. */
const GH_STUB = `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const env = process.env;
const args = process.argv.slice(2);
appendFileSync(env.GH_LOG, args.join(' ') + '\\n');
const url = 'https://github.com/acme/app/pull/42';
const tip = (branch) => execFileSync('git', ['-C', env.GH_BARE, 'rev-parse', 'refs/heads/' + branch], { encoding: 'utf8' }).trim();
const json = args.includes('--json') ? args[args.indexOf('--json') + 1] : '';
if (args[1] === 'create') { writeFileSync(env.GH_STATE, args[args.indexOf('--body') + 1]); console.log(url); }
else if (args[1] === 'edit') writeFileSync(env.GH_STATE, readFileSync(0, 'utf8'));
else if (json === 'body,headRefOid,baseRefOid') process.stdout.write(JSON.stringify({
  body: existsSync(env.GH_STATE) ? readFileSync(env.GH_STATE, 'utf8') : '',
  headRefOid: env.GH_HEAD_OID || tip(env.GH_HEAD), baseRefOid: env.GH_BASE_OID || tip(env.GH_BASE) }));
else if (json.startsWith('number,state')) console.log(['42', 'OPEN', env.GH_HEAD, tip(env.GH_HEAD), 'acme/app', env.GH_BASE, url].join('\\t'));
else if (args[1] === 'view') console.log(url);
`;

function ghEnv(extra: Record<string, string>) {
  const bin = mkdtempSync(join(tmpdir(), 'evidence-gh-'));
  dirs.push(bin);
  writeFileSync(join(bin, 'gh'), GH_STUB);
  chmodSync(join(bin, 'gh'), 0o755);
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')),
  );
  return {
    log: join(bin, 'gh.log'),
    state: join(bin, 'gh.body'),
    env: {
      ...inherited,
      ...GIT_ENV,
      PATH: `${bin}:${process.env.PATH}`,
      GH_LOG: join(bin, 'gh.log'),
      GH_STATE: join(bin, 'gh.body'),
      ...extra,
    },
  };
}

function write(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

const tipOf = (bare: string, branch: string) =>
  execFileSync('git', ['-C', bare, 'rev-parse', `refs/heads/${branch}`], {
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  }).trim();

/** A ship repo whose base already holds the broken source and, optionally, an evidence config. */
interface EvidenceEntry {
  command: string[];
  timeoutSeconds: number;
}

function shipRepo(evidence: EvidenceEntry | null, branch: string) {
  const seeded = seedShipRepoLocalRemote();
  write(seeded.dir, {
    'guard.config.json': JSON.stringify({
      sourceExtensions: ['mjs'],
      ...(evidence && { evidence }),
    }),
    'src/value.mjs': BROKEN,
  });
  seeded.git(['add', 'guard.config.json', 'src/value.mjs']);
  seeded.git(['commit', '-qm', 'seed'], { stdio: 'ignore' });
  seeded.git(['push', '-q', 'origin', 'work:work'], { stdio: 'ignore' });
  return { ...seeded, ...ghEnv({ GH_BARE: seeded.bare, GH_HEAD: branch, GH_BASE: 'work' }) };
}

const bash = (dir: string, env: NodeJS.ProcessEnv, argv: string[], input = 'b\n') =>
  spawnSync('/bin/bash', argv, { cwd: dir, env, input, encoding: 'utf8', timeout: 240_000 });

describe('devkit ship evidence block', () => {
  it('a ship and two re-ships keep one current evidence block in the PR body', () => {
    const repo = shipRepo({ command: COMMAND, timeoutSeconds: 120 }, 'feat/fix');
    write(repo.dir, { 'src/value.mjs': FIXED, 'src/value.test.mjs': VALUE_TEST });

    const shipped = bash(repo.dir, repo.env, [
      scriptPath,
      'feat/fix',
      'fix',
      'src/value.mjs',
      'src/value.test.mjs',
    ]);
    expect(shipped.status, shipped.stderr).toBe(0);
    const head = tipOf(repo.bare, 'feat/fix');
    const block = BLOCK.exec(readFileSync(repo.state, 'utf8'))?.[0] ?? '';
    expect(readEvidenceBlock(block, head)).toMatchObject({
      status: 'captured',
      headSha: head,
      baseSha: tipOf(repo.bare, 'work'),
      stale: false,
    });
    expect(block).toContain('"src/value.test.mjs"');
    expect(block).toMatch(/\| red \| PR base \+ PR test files `\w+` \| 1 \| 0 \| 1 \| 0 \|/);

    // An explicit body with no new commit swaps the caller text and carries the block unchanged.
    const reworded = bash(repo.dir, repo.env, [
      reshipScript,
      'feat/fix',
      'fix',
      '--pr',
      '--body',
      'reworded',
      '--no-qavis-publish',
      '--',
      'src/value.mjs',
    ]);
    expect(reworded.status, reworded.stderr).toBe(0);
    expect(reworded.stderr).not.toContain('evidence: running');
    expect(readFileSync(repo.state, 'utf8')).toBe(`reworded\n\n${block}\n`);

    // A new commit re-runs the evidence and replaces the block in place; other text stays.
    writeFileSync(repo.state, `reworded\n\n${block}\n\n${QAVIS}\n`);
    write(repo.dir, {
      'src/value.test.mjs': `${VALUE_TEST}it('stays fixed', () => expect(value()).toBe('fixed'));\n`,
    });
    const appended = bash(repo.dir, repo.env, [
      reshipScript,
      'feat/fix',
      'fix',
      '--pr',
      '--no-qavis-publish',
      '--',
      'src/value.test.mjs',
    ]);
    expect(appended.status, appended.stderr).toBe(0);
    const next = tipOf(repo.bare, 'feat/fix');
    const body = readFileSync(repo.state, 'utf8');
    expect(body.replace(BLOCK, 'BLOCK')).toBe(`reworded\n\nBLOCK\n\n${QAVIS}\n`);
    expect(readEvidenceBlock(body, next)).toMatchObject({ status: 'captured', stale: false });
  }, 600_000);

  it('makes no PR-body call at all when the repository has not configured evidence', () => {
    const repo = shipRepo(null, 'feat/plain');
    write(repo.dir, { 'src/value.mjs': FIXED, 'src/value.test.mjs': VALUE_TEST });

    const shipped = bash(repo.dir, repo.env, [
      scriptPath,
      'feat/plain',
      'fix',
      'src/value.mjs',
      'src/value.test.mjs',
    ]);

    expect(shipped.status, shipped.stderr).toBe(0);
    expect(readFileSync(repo.log, 'utf8')).not.toMatch(/--json body|pr edit/);
    expect(readFileSync(repo.state, 'utf8')).not.toContain(EVIDENCE_BEGIN);
  }, 240_000);

  it('drops a block pasted into the caller body before the PR is created', () => {
    const repo = shipRepo(null, 'feat/pasted');
    write(repo.dir, { 'src/value.mjs': FIXED });
    const forged = `${EVIDENCE_BEGIN}\nforged\n<!-- devkit:evidence:end -->`;

    const shipped = bash(
      repo.dir,
      repo.env,
      [scriptPath, 'feat/pasted', 'fix', 'src/value.mjs'],
      `mine\n${forged}\n`,
    );

    expect(shipped.status, shipped.stderr).toBe(0);
    expect(readFileSync(repo.state, 'utf8')).not.toContain(EVIDENCE_BEGIN);
    expect(readFileSync(repo.state, 'utf8')).toContain('mine');
  }, 240_000);

  it('bounds a hung test run: ship exits 0, the block says so, and no test process survives', () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'evidence-pid-')), 'pid');
    dirs.push(dirname(pidFile));
    const repo = shipRepo({ command: COMMAND, timeoutSeconds: 3 }, 'feat/slow');
    const slow = `import { writeFileSync } from 'node:fs';\nit('waits', async () => {\n  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n  await new Promise((done) => setTimeout(done, 120_000));\n}, 200_000);\n`;
    write(repo.dir, { 'src/value.mjs': FIXED, 'src/slow.test.mjs': slow });

    const started = Date.now();
    const shipped = bash(repo.dir, repo.env, [
      scriptPath,
      'feat/slow',
      'fix',
      'src/value.mjs',
      'src/slow.test.mjs',
    ]);

    expect(shipped.status, shipped.stderr).toBe(0);
    expect(Date.now() - started).toBeLessThan(110_000);
    const body = readFileSync(repo.state, 'utf8');
    expect(readEvidenceBlock(body, tipOf(repo.bare, 'feat/slow'))?.status).toBe('inconclusive');
    expect(body).toContain('did not finish within 3s');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 240_000);
});

/** A two-commit history and a publish run against it, outside ship. */
function publishRun(
  baseFiles: Record<string, string>,
  headFiles: Record<string, string>,
  command = COMMAND,
) {
  const root = mkdtempSync(join(tmpdir(), 'evidence-run-'));
  dirs.push(root);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...GIT_ENV },
    }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  const commit = (files: Record<string, string>) => {
    write(root, files);
    git('add', '-A');
    git('commit', '-qm', 'c');
    return git('rev-parse', 'HEAD');
  };
  const config = JSON.stringify({ sourceExtensions: ['mjs'], evidence: { command } });
  const base = commit({ 'guard.config.json': config, 'src/value.mjs': BROKEN, ...baseFiles });
  const head = commit(headFiles);
  const gh = ghEnv({ GH_HEAD_OID: head, GH_BASE_OID: base });
  const publish = (headArg = head) =>
    spawnSync(
      process.execPath,
      [RUN, 'publish', '--cwd', root, '--repo', 'acme/app', '--pr', '42', '--head', headArg],
      {
        env: gh.env,
        encoding: 'utf8',
        timeout: 200_000,
      },
    );
  return { head, gh, publish };
}

describe('evidence outcomes', () => {
  it('reads a red test file that fails to load as inconclusive and names it', () => {
    const run = publishRun(
      {},
      {
        'src/extra.mjs': 'export const extra = 1;\n',
        'src/extra.test.mjs':
          "import { extra } from './extra.mjs';\nit('x', () => expect(extra).toBe(1));\n",
      },
    );
    const r = run.publish();
    expect(r.status, r.stderr).toBe(0);
    const body = readFileSync(run.gh.state, 'utf8');
    expect(readEvidenceBlock(body, run.head)?.status).toBe('inconclusive');
    expect(body).toMatch(/red file error, not counted: `"<checkout>\/src\/extra\.test\.mjs"`/);
  });

  it('abstains as platform-skipped when the selected tests skip on this host', () => {
    const skipped = "it.skipIf(true)('platform only', () => expect(1).toBe(2));\n";
    const run = publishRun({}, { 'src/value.mjs': FIXED, 'src/value.test.mjs': skipped });
    expect(run.publish().status).toBe(0);
    expect(readEvidenceBlock(readFileSync(run.gh.state, 'utf8'), run.head)).toMatchObject({
      status: 'not-run',
      reason: 'platform-skipped',
    });
  });

  it.each([
    ['docs-only', { 'README.md': 'docs\n' }],
    ['no-test-change', { 'src/value.mjs': FIXED }],
  ])('abstains as %s without running the test command', (reason, headFiles) => {
    const marker = join(mkdtempSync(join(tmpdir(), 'evidence-marker-')), 'ran');
    dirs.push(dirname(marker));
    const command = [
      process.execPath,
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`,
      '{report}',
      '{files}',
    ];
    const run = publishRun({ 'README.md': 'v1\n' }, headFiles, command);
    expect(run.publish().status).toBe(0);
    expect(readEvidenceBlock(readFileSync(run.gh.state, 'utf8'), run.head)).toMatchObject({
      status: 'not-run',
      reason,
    });
    expect(existsSync(marker)).toBe(false);
  });

  it('writes nothing once the PR head has moved past the evidence head', () => {
    const run = publishRun({}, { 'src/value.mjs': FIXED, 'src/value.test.mjs': VALUE_TEST });
    const r = run.publish('f'.repeat(40));
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('nothing was published');
    expect(readFileSync(run.gh.log, 'utf8')).not.toContain('pr edit');
  });
});
