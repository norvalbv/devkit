/** The judge preflight's telemetry row carries the id of the ship attempt it opened, so a later
 *  reader can join what the preflight read to what that attempt's judges then did. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import {
  dirs,
  NOTHING_RE,
  reshipScript,
  scriptPath,
  seedReshipRepo,
  seedShipRepo,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

interface Row {
  type?: string;
  ship_id?: string;
  ship_mode?: string;
  branch?: string;
  roles?: { state: string }[];
}

/** Select the reviewer gate, point the sink at a temp file, and make codex unresolvable so the
 *  preflight reads no real account. */
function judged(dir: string, env: NodeJS.ProcessEnv) {
  mkdirSync(join(dir, '.devkit'), { recursive: true });
  writeFileSync(
    join(dir, '.devkit', 'config.json'),
    JSON.stringify({ components: { guards: ['review'] } }),
  );
  const sinkDir = mkdtempSync(join(tmpdir(), 'preflight-row-'));
  dirs.push(sinkDir);
  const sink = join(sinkDir, 'gate-events.jsonl');
  const rows = (): Row[] =>
    existsSync(sink)
      ? readFileSync(sink, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line): Row => JSON.parse(line))
      : [];
  return {
    env: { ...env, DEVKIT_GATE_EVENTS: sink, GUARD_CODEX_BIN: join(sinkDir, 'no-codex') },
    preflightRows: () => rows().filter((row) => row.type === 'judge_preflight'),
    rows,
  };
}

const ship = (dir: string, env: NodeJS.ProcessEnv, args: string[]) =>
  spawnSync('/bin/bash', [scriptPath, ...args], { cwd: dir, input: '', encoding: 'utf8', env });

describe('judge_preflight telemetry row', () => {
  it('a reviewer rehearsal records one row, stamped with its ship id and labelled a rehearsal', () => {
    const { dir, env } = seedShipRepo();
    writeFileSync(join(dir, 'note.txt'), 'x\n');
    const run = judged(dir, env);

    const r = ship(dir, run.env, [
      'feat/row-rehearsal',
      't',
      '--dry-gates',
      '--with-reviewers',
      '--',
      'note.txt',
    ]);

    expect(r.status, r.stderr).toBe(0);
    const [row, ...extra] = run.preflightRows();
    expect(extra).toEqual([]);
    expect(row.ship_id).toBeTruthy();
    expect(row).toMatchObject({ ship_mode: 'dry-gates', branch: 'feat/row-rehearsal' });
    expect(row.roles?.map((role) => role.state)).toEqual(['absent', 'absent', 'absent']);
  });

  it('a plain rehearsal runs no reviewer gate and records no row', () => {
    const { dir, env } = seedShipRepo();
    writeFileSync(join(dir, 'note.txt'), 'x\n');
    const run = judged(dir, env);

    const r = ship(dir, run.env, ['feat/row-plain', 't', '--dry-gates', '--', 'note.txt']);

    expect(r.status, r.stderr).toBe(0);
    expect(run.preflightRows()).toEqual([]);
  });

  it('a ship with nothing to commit stops before the preflight and records no row', () => {
    const { dir, env } = seedShipRepoLocalRemote();
    const run = judged(dir, env);

    const r = ship(dir, run.env, ['feat/row-empty', 't', '--', '.husky/.keep']);

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(NOTHING_RE);
    expect(r.stderr).not.toContain('guard-judge preflight');
    expect(run.preflightRows()).toEqual([]);
  });

  it('a re-push records its row under the same ship id as its attempt marker', () => {
    const { dir, env } = seedReshipRepo();
    writeFileSync(join(dir, 'note.txt'), 'again\n');
    const run = judged(dir, env);

    const r = spawnSync('/bin/bash', [reshipScript, 'pr-open', 'again', '--pr', '--', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...run.env, SHIP_DRY_RUN: '1' },
    });

    expect(r.status, r.stderr).toBe(0);
    const [row, ...extra] = run.preflightRows();
    expect(extra).toEqual([]);
    const attempt = run.rows().find((e) => e.type === 'ship_attempt');
    expect(attempt?.ship_id).toBeTruthy();
    expect(row.ship_id).toBe(attempt?.ship_id);
    expect(row).not.toHaveProperty('ship_mode');
  });
});
