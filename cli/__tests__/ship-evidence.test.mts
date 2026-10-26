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
import { z } from 'zod';
import { EVIDENCE_BEGIN, readEvidenceBlock, VERDICT_SLOT } from '../lib/ship/evidence/block.mts';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import {
  dirs,
  GIT_ENV,
  reshipScript,
  scriptPath,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

// Never called: declares the spawned module to vitest's graph, so `vitest related` selects this file.
void (() => import('../lib/ship/evidence/run.mts'));

const RUN = fileURLToPath(new URL('../lib/ship/evidence/run.mts', import.meta.url));
const SHIP_DIR = fileURLToPath(new URL('../lib/ship', import.meta.url));
const NOTES_BEGIN = '<!-- devkit:evidence:notes:begin -->';
const NOTES_END = '<!-- devkit:evidence:notes:end -->';
/** An evidence block holding only a notes section, as a repo with no evidence config gets. */
const notesBlock = (bullet: string) =>
  `${EVIDENCE_BEGIN}\n${NOTES_BEGIN}\n${bullet}\n${NOTES_END}\n<!-- devkit:evidence:end -->`;
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
/** A pre-commit hook standing in for a PASS reviewer that raised the advisory in $NOTE. */
const NOTE_HOOK = `[ -z "$NOTE" ] || printf '{"type":"advisory_result","ship_id":"%s","gate":"review:correctness-reviewer","status":"finding","detail":"%s"}\\n' "$DEVKIT_SHIP_ID" "$NOTE" >> "$DEVKIT_GATE_EVENTS"`;
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
if (args[1] === 'create') {
  writeFileSync(env.GH_STATE, args[args.indexOf('--body') + 1]);
  writeFileSync(env.GH_STATE + '.title', args[args.indexOf('--title') + 1]);
  console.log(url);
}
else if (args[1] === 'edit') writeFileSync(env.GH_STATE, readFileSync(0, 'utf8'));
else if (json.startsWith('title,body') && env.GH_VIEW_FAIL && !existsSync(env.GH_VIEW_FAIL)) {
  if (env.GH_VIEW_FAIL_ONCE) writeFileSync(env.GH_VIEW_FAIL, '');
  process.exit(1);
}
else if (json === 'title,body,headRefOid,baseRefOid') process.stdout.write(JSON.stringify({
  title: existsSync(env.GH_STATE + '.title') ? readFileSync(env.GH_STATE + '.title', 'utf8') : 'fix: value',
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
    Object.entries(process.env).filter(([key]) => !/^(GUARD_|FRINK_|HUSKY$)/.test(key)),
  );
  return {
    log: join(bin, 'gh.log'),
    state: join(bin, 'gh.body'),
    sink: join(bin, 'gate-events.jsonl'),
    env: {
      ...inherited,
      ...GIT_ENV,
      PATH: `${bin}:${process.env.PATH}`,
      GH_LOG: join(bin, 'gh.log'),
      GH_STATE: join(bin, 'gh.body'),
      DEVKIT_GATE_EVENTS: join(bin, 'gate-events.jsonl'),
      ...extra,
    },
  };
}

const sinkRow = z.looseObject({ type: z.string() });

/** The sink's rows of one type, in write order. */
function rowsOf(sink: string, type: string) {
  if (!existsSync(sink)) return [];
  return readFileSync(sink, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => sinkRow.parse(JSON.parse(line)))
    .filter((row) => row.type === type);
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

function shipRepo(evidence: EvidenceEntry | null, branch: string, hookBody?: string) {
  const seeded = seedShipRepoLocalRemote(hookBody ? { hookBody } : {});
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
    expect(block).toMatch(/\(setup \d+s, red \d+s, green \d+s, cleanup \d+s\)/);
    expect(block).toContain('| red | PR test files on the PR base | 1 | 0 | 1 | 0 |');
    // One small source file with proof captured at this head, gated by this ship with no bypass.
    expect(block).toContain(
      `**Merge verdict:** 🟢 auto-merge-eligible · advisory, at \`${head.slice(0, 12)}\` ${VERDICT_SLOT}\n- **captured-proof**\n`,
    );
    expect(readEvidenceBlock(block, head)?.mergeVerdict).toEqual({
      verdict: 'auto-merge-eligible',
      reasons: [{ code: 'captured-proof' }],
    });
    // The capture scrubs the ship env from its tests; the row still names this ship and repo.
    const [attempt] = rowsOf(repo.sink, 'ship_attempt');
    const [row, ...extra] = rowsOf(repo.sink, 'ship_evidence');
    expect(extra).toEqual([]);
    expect(row).toMatchObject({
      ship_id: attempt?.ship_id,
      repo: attempt?.repo,
      branch: 'feat/fix',
      pr_number: 42,
      head,
      status: 'captured',
      reason: null,
      test_files: 1,
      publish: 'written',
      verdict: 'auto-merge-eligible',
      failed: false,
    });
    expect(row?.duration_s).toEqual(expect.any(Number));

    // An explicit body with no new commit swaps the caller text and carries the block unchanged.
    const reworded = bash(repo.dir, repo.env, [
      reshipScript,
      'feat/fix',
      'fix',
      '--pr',
      '--body',
      'reworded',
      '--',
      'src/value.mjs',
    ]);
    expect(reworded.status, reworded.stderr).toBe(0);
    expect(reworded.stderr).not.toContain('evidence: running');
    expect(readFileSync(repo.state, 'utf8')).toBe(`reworded\n\n${block}\n`);
    // No new commit, so no evidence step and no second row.
    expect(rowsOf(repo.sink, 'ship_evidence')).toHaveLength(1);

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
      '--',
      'src/value.test.mjs',
    ]);
    expect(appended.status, appended.stderr).toBe(0);
    const next = tipOf(repo.bare, 'feat/fix');
    const body = readFileSync(repo.state, 'utf8');
    expect(body.replace(BLOCK, 'BLOCK')).toBe(`reworded\n\nBLOCK\n\n${QAVIS}\n`);
    expect(readEvidenceBlock(body, next)).toMatchObject({ status: 'captured', stale: false });
    // Recomputed for the new head: each commit's gate record is read by sha, so two clean ships
    // read as one clean commit does.
    expect(body).toContain(`· advisory, at \`${next.slice(0, 12)}\``);
    expect(body).not.toContain(head.slice(0, 12));
    expect(readEvidenceBlock(body, next)?.mergeVerdict).toEqual({
      verdict: 'auto-merge-eligible',
      reasons: [{ code: 'captured-proof' }],
    });
    const rows = rowsOf(repo.sink, 'ship_evidence');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ head: next, status: 'captured', publish: 'written' });
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
    expect(rowsOf(repo.sink, 'ship_attempt')).not.toEqual([]);
    expect(rowsOf(repo.sink, 'ship_evidence')).toEqual([]);
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

  it('carries reviewer advisories into a Reviewer notes section that each re-ship adds to', () => {
    const repo = shipRepo(null, 'feat/notes', NOTE_HOOK);
    const sink = join(mkdtempSync(join(tmpdir(), 'notes-sink-')), 'gate-events.jsonl');
    dirs.push(dirname(sink));
    const ship = (argv: string[], note: string) =>
      bash(repo.dir, { ...repo.env, DEVKIT_GATE_EVENTS: sink, NOTE: note }, argv, 'mine\n');
    const note = (head: string, text: string) =>
      `- **correctness-reviewer** at \`${head.slice(0, 12)}\`: ${text}`;
    const reship = (text: string) => [reshipScript, 'feat/notes', 'fix', '--pr', '--', text];

    write(repo.dir, { 'src/value.mjs': FIXED });
    const shipped = ship([scriptPath, 'feat/notes', 'fix', 'src/value.mjs'], 'value.mjs:1 — first');
    expect(shipped.status, shipped.stderr).toBe(0);
    const first = note(tipOf(repo.bare, 'feat/notes'), 'value.mjs:1 — first');
    expect(readFileSync(repo.state, 'utf8')).toMatch(
      /^mine\n\n<!-- devkit:evidence:begin -->\n<!-- devkit:evidence:notes:begin -->/,
    );
    expect(readFileSync(repo.state, 'utf8')).toContain('<summary>💬 <b>Reviewer notes</b>');
    expect(readFileSync(repo.state, 'utf8')).toContain(`${first}\n`);

    // An append re-ship judged only its delta: its note joins the first, which stays.
    write(repo.dir, { 'src/value.mjs': `${FIXED}// two\n` });
    const second = ship(reship('src/value.mjs'), 'value.mjs:2 — second');
    expect(second.status, second.stderr).toBe(0);
    const body = readFileSync(repo.state, 'utf8');
    expect(body).toContain(first);
    expect(body).toContain(note(tipOf(repo.bare, 'feat/notes'), 'value.mjs:2 — second'));
    expect(body.match(/<!-- devkit:evidence:notes:begin -->/g)).toHaveLength(1);

    // A re-ship whose reviewers raised nothing touches the body not at all.
    write(repo.dir, { 'src/value.mjs': `${FIXED}// three\n` });
    const quiet = ship(reship('src/value.mjs'), '');
    expect(quiet.status, quiet.stderr).toBe(0);
    expect(readFileSync(repo.state, 'utf8')).toBe(body);

    // An explicit body swaps only the caller text: the notes carry over, a pasted block is dropped.
    const notes = BLOCK.exec(body)?.[0] ?? '';
    const forged = notesBlock(`- **r** at \`${'f'.repeat(12)}\`: forged`);
    write(repo.dir, { 'src/value.mjs': `${FIXED}// four\n` });
    const reworded = ship(
      [
        reshipScript,
        'feat/notes',
        'fix',
        '--pr',
        '--body',
        `reworded\n\n${forged}`,
        '--',
        'src/value.mjs',
      ],
      '',
    );
    expect(reworded.status, reworded.stderr).toBe(0);
    expect(readFileSync(repo.state, 'utf8')).toBe(`reworded\n\n${notes}\n`);
  }, 600_000);

  it('a history rewrite replaces the earlier notes through publish_reviewer_notes', () => {
    const head = 'c'.repeat(40);
    const sink = join(mkdtempSync(join(tmpdir(), 'notes-sink-')), 'gate-events.jsonl');
    dirs.push(dirname(sink));
    const rows = [
      { type: 'ship_attempt', ship_id: 'rewrite' },
      { type: 'advisory_result', ship_id: 'rewrite', gate: 'review:r', detail: 'new.ts:1 — kept' },
    ];
    writeFileSync(sink, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    const gh = ghEnv({ GH_HEAD_OID: head, GH_BASE_OID: 'd'.repeat(40) });
    writeFileSync(
      gh.state,
      `prose\n\n${notesBlock(`- **r** at \`${'a'.repeat(12)}\`: old.ts:1 — stale`)}\n`,
    );
    const call = `. "$SCRIPT_DIR/publish-evidence.sh"; publish_reviewer_notes 42 acme/app ${head} "$PWD" replace`;
    const r = spawnSync('/bin/bash', ['-c', call], {
      env: { ...gh.env, SCRIPT_DIR: SHIP_DIR, DEVKIT_GATE_EVENTS: sink, DEVKIT_SHIP_ID: 'rewrite' },
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    const body = readFileSync(gh.state, 'utf8');
    expect(body).toContain(`- **r** at \`${head.slice(0, 12)}\`: new.ts:1 — kept`);
    expect(body).not.toContain('stale');
    expect(body.startsWith('prose\n\n')).toBe(true);
  }, 60_000);

  it('writes no notes when the checkout sets review.prNotes to false', () => {
    const root = mkdtempSync(join(tmpdir(), 'notes-off-'));
    dirs.push(root);
    writeFileSync(join(root, 'guard.config.json'), '{ "review": { "prNotes": false } }\n');
    const sink = join(root, 'gate-events.jsonl');
    const rows = [
      { type: 'ship_attempt', ship_id: 'off' },
      { type: 'advisory_result', ship_id: 'off', gate: 'review:r', detail: 'a.ts:1 — noted' },
    ];
    writeFileSync(sink, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    const gh = ghEnv({ GH_HEAD_OID: 'c'.repeat(40), GH_BASE_OID: 'd'.repeat(40) });
    writeFileSync(gh.state, 'prose\n');
    const call = `. "$SCRIPT_DIR/publish-evidence.sh"; publish_reviewer_notes 42 acme/app ${'c'.repeat(40)} "${root}"`;
    const r = spawnSync('/bin/bash', ['-c', call], {
      env: { ...gh.env, SCRIPT_DIR: SHIP_DIR, DEVKIT_GATE_EVENTS: sink, DEVKIT_SHIP_ID: 'off' },
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(gh.state, 'utf8')).toBe('prose\n');
  }, 60_000);

  it('leaves the PR body alone when it cannot be read, and the same command re-run then writes it', () => {
    const repo = shipRepo(null, 'feat/keep');
    write(repo.dir, { 'src/value.mjs': FIXED });
    const shipped = bash(repo.dir, repo.env, [scriptPath, 'feat/keep', 'fix', 'src/value.mjs']);
    expect(shipped.status, shipped.stderr).toBe(0);
    const block = `${EVIDENCE_BEGIN}\nkept\n<!-- devkit:evidence:end -->`;
    writeFileSync(repo.state, `old\n\n${block}\n`);
    const before = tipOf(repo.bare, 'feat/keep');
    write(repo.dir, { 'src/value.mjs': `${FIXED}// again\n` });
    const argv = [reshipScript, 'feat/keep', 'fix', '--pr', '--body', 'new', '--', 'src/value.mjs'];

    const never = join(dirname(repo.log), 'never');
    const refused = bash(repo.dir, { ...repo.env, GH_VIEW_FAIL: never }, argv);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('PR body was not updated');
    expect(refused.stderr).toContain('re-run the same devkit ship command');
    expect(tipOf(repo.bare, 'feat/keep')).not.toBe(before);
    expect(readFileSync(repo.state, 'utf8')).toBe(`old\n\n${block}\n`);
    expect(readFileSync(repo.log, 'utf8')).not.toContain('pr edit');

    const retried = bash(repo.dir, repo.env, argv);
    expect(retried.status, retried.stderr).toBe(0);
    expect(readFileSync(repo.state, 'utf8')).toBe(`new\n\n${block}\n`);
  }, 240_000);

  it("a refused body update still publishes the pushed commit's evidence, and the re-run carries it", () => {
    const repo = shipRepo({ command: COMMAND, timeoutSeconds: 120 }, 'feat/fresh');
    write(repo.dir, { 'src/value.mjs': FIXED });
    const shipped = bash(repo.dir, repo.env, [scriptPath, 'feat/fresh', 'fix', 'src/value.mjs']);
    expect(shipped.status, shipped.stderr).toBe(0);
    write(repo.dir, { 'src/value.mjs': `${FIXED}// again\n` });
    const argv = [
      reshipScript,
      'feat/fresh',
      'fix',
      '--pr',
      '--body',
      'new',
      '--',
      'src/value.mjs',
    ];
    const once = { GH_VIEW_FAIL: join(dirname(repo.log), 'view-failed'), GH_VIEW_FAIL_ONCE: '1' };

    const refused = bash(repo.dir, { ...repo.env, ...once }, argv);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('PR body was not updated');
    const head = tipOf(repo.bare, 'feat/fresh');
    expect(readEvidenceBlock(readFileSync(repo.state, 'utf8'), head)).toMatchObject({
      stale: false,
    });

    const retried = bash(repo.dir, repo.env, argv);
    expect(retried.status, retried.stderr).toBe(0);
    const body = readFileSync(repo.state, 'utf8');
    expect(body.replace(BLOCK, 'BLOCK')).toBe('new\n\nBLOCK\n');
    expect(readEvidenceBlock(body, head)).toMatchObject({ stale: false });
  }, 240_000);

  it('bounds a hung test run: ship exits 0, the block says so, and no test process survives', () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'evidence-pid-')), 'pid');
    dirs.push(dirname(pidFile));
    const repo = shipRepo({ command: COMMAND, timeoutSeconds: 10 }, 'feat/slow');
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
    expect(body).toMatch(/did not finish within 10s \(setup \d+s[^)]* unfinished\)/);
    expect(body).toContain('**Merge verdict:** 🟡 human-review · advisory');
    expect(body).toContain('\n- **no-captured-proof:** inconclusive\n');
    const [row, ...extra] = rowsOf(repo.sink, 'ship_evidence');
    expect(extra).toEqual([]);
    expect(row).toMatchObject({ status: 'inconclusive', test_files: 1, failed: false });
    expect(row?.detail).toMatch(/did not finish within 10s/);
    expect(row?.duration_s).toBeGreaterThanOrEqual(10);
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
  const publish = (headArg = head, extra: Record<string, string> = {}) =>
    spawnSync(
      process.execPath,
      [RUN, 'publish', '--cwd', root, '--repo', 'acme/app', '--pr', '42', '--head', headArg],
      {
        env: { ...gh.env, ...extra },
        encoding: 'utf8',
        timeout: 200_000,
      },
    );
  return { root, head, gh, publish };
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
    expect(body).toContain(
      "<details><summary>Did not load on red (1 file): red's counts leave out the tests inside</summary>\n\n- `<checkout>/src/extra.test.mjs`",
    );
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

  it('records an abstention under a ship id, and nothing for a run outside a ship', () => {
    const run = publishRun({}, { 'src/value.mjs': FIXED });
    expect(run.publish().status).toBe(0);
    expect(rowsOf(run.gh.sink, 'ship_evidence')).toEqual([]);

    writeFileSync(run.gh.state, '');
    const started = String(Math.floor(Date.now() / 1000) - 30);
    const r = spawnSync(
      process.execPath,
      [
        RUN,
        'publish',
        '--cwd',
        run.root,
        '--repo',
        'acme/app',
        '--pr',
        '42',
        '--head',
        run.head,
      ].concat(['--started', started]),
      { env: { ...run.gh.env, DEVKIT_SHIP_ID: 'ship-1' }, encoding: 'utf8', timeout: 200_000 },
    );
    expect(r.status, r.stderr).toBe(0);
    // A run that finds this head's block current (a --failed fallback after a lost read-back, or a
    // retry) reports the recorded outcome, so the captured rate counts what the PR body holds.
    expect(run.publish(run.head, { DEVKIT_SHIP_ID: 'ship-1' }).status).toBe(0);
    const rows = rowsOf(run.gh.sink, 'ship_evidence');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      status: 'not-run',
      reason: 'no-test-change',
      verdict: rows[0]?.verdict,
      test_files: null,
      publish: 'unchanged',
    });
    expect(rows[0]).toMatchObject({
      ship_id: 'ship-1',
      status: 'not-run',
      reason: 'no-test-change',
      test_files: 0,
      publish: 'written',
    });
    expect(rows[0]?.duration_s).toBeGreaterThanOrEqual(30);
  });

  it('writes one row across a publish run that fails and its --failed fallback', () => {
    const run = publishRun({}, { 'src/value.mjs': FIXED });
    const once = { GH_VIEW_FAIL: join(run.root, '.git', 'view-failed'), GH_VIEW_FAIL_ONCE: '1' };
    const script = `SCRIPT_DIR=${JSON.stringify(SHIP_DIR)}; . "$SCRIPT_DIR/publish-evidence.sh"; publish_evidence_block "$@"`;
    const r = spawnSync('/bin/bash', ['-c', script, 'x', run.root, '42', 'acme/app', run.head], {
      env: { ...run.gh.env, ...once, DEVKIT_SHIP_ID: 'ship-2' },
      encoding: 'utf8',
      timeout: 200_000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('evidence step stopped with exit 1');
    const rows = rowsOf(run.gh.sink, 'ship_evidence');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ship_id: 'ship-2',
      status: 'inconclusive',
      detail: 'the evidence step stopped with exit 1',
      test_files: null,
      publish: 'written',
      failed: true,
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

  it('names a bypass exported for the ship, and reads the record as unknown outside one', () => {
    const run = publishRun({}, { 'src/value.mjs': FIXED });
    const sink = join(mkdtempSync(join(tmpdir(), 'evidence-sink-')), 'gate-events.jsonl');
    dirs.push(dirname(sink));
    const ts = new Date().toISOString();
    writeFileSync(
      sink,
      `${JSON.stringify({ type: 'ship_gated', head: run.head, bypasses: [], ts })}\n`,
    );
    const shipped = { DEVKIT_GATE_EVENTS: sink };
    const verdictOf = () =>
      readEvidenceBlock(readFileSync(run.gh.state, 'utf8'), run.head)?.mergeVerdict?.reasons;

    expect(run.publish(run.head, { ...shipped, GUARD_COVERAGE_OK: '1' }).status).toBe(0);
    expect(readFileSync(run.gh.state, 'utf8')).toContain(
      '\n- **gate-bypassed:** GUARD_COVERAGE_OK\n- **no-captured-proof:** not-run: no-test-change\n',
    );

    writeFileSync(run.gh.state, '');
    expect(run.publish(run.head, shipped).status).toBe(0);
    expect(verdictOf()).toEqual([{ code: 'no-captured-proof', detail: 'not-run: no-test-change' }]);

    writeFileSync(run.gh.state, '');
    expect(run.publish().status).toBe(0);
    expect(verdictOf()?.[0]).toEqual({
      code: 'bypass-unknown',
      detail: `no passing devkit ship gate record for ${run.head.slice(0, 12)}`,
    });
  });

  it('still writes the block when the verdict cannot be computed, and says why', () => {
    const run = publishRun({}, { 'src/value.mjs': FIXED });
    const r = run.publish(run.head, { GH_BASE_OID: 'f'.repeat(40) });
    expect(r.status, r.stderr).toBe(0);
    const body = readFileSync(run.gh.state, 'utf8');
    expect(body).toMatch(/\*\*Merge verdict:\*\* unavailable \(Command failed: git /);
    expect(readEvidenceBlock(body, run.head)).toMatchObject({ status: 'inconclusive' });
    expect(readEvidenceBlock(body, run.head)?.mergeVerdict).toBeUndefined();
  });

  it('writes the evidence with no verdict line when the policy sets mergeVerdict.enabled to false', () => {
    const config = JSON.stringify({
      sourceExtensions: ['mjs'],
      evidence: { command: COMMAND },
      mergeVerdict: { enabled: false },
    });
    const run = publishRun(
      { 'guard.config.json': config },
      { 'src/value.mjs': FIXED, 'src/value.test.mjs': VALUE_TEST },
    );
    const r = run.publish();
    expect(r.status, r.stderr).toBe(0);
    const body = readFileSync(run.gh.state, 'utf8');
    expect(body).not.toContain('Merge verdict');
    expect(body).toContain(`## Automated evidence\n${VERDICT_SLOT}\n`);
    expect(readEvidenceBlock(body, run.head)).toMatchObject({ status: 'captured' });
    expect(readEvidenceBlock(body, run.head)?.mergeVerdict).toBeUndefined();
  });

  it('writes nothing once the PR head has moved past the evidence head', () => {
    const run = publishRun({}, { 'src/value.mjs': FIXED, 'src/value.test.mjs': VALUE_TEST });
    const r = run.publish('f'.repeat(40));
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('nothing was published');
    expect(readFileSync(run.gh.log, 'utf8')).not.toContain('pr edit');
  });
});
