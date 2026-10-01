import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// sc-2317: `finalize --retrieval` is the gate's only signal that semantic retrieval ran, so a
// malformed spelling is refused rather than recorded as (or mistaken for) `ok`.

const SCRIPT = fileURLToPath(
  new URL('../../skills/commit-guard/scripts/checklist.mjs', import.meta.url),
);
const GATE_ENV = { ...process.env, DEVKIT_RUN_MODE: 'commit', DEVKIT_CHECKLIST_KEEP: '1' };
// Never inherit the caller's keep flag: this suite itself runs inside the commit gate.
const { DEVKIT_CHECKLIST_KEEP: _gateKeep, ...ambientEnv } = process.env;
const INTERACTIVE_ENV = { ...ambientEnv, DEVKIT_RUN_MODE: 'commit' };

/** The commit-guard checklist artifact as this script reads and writes it. */
interface CommitGuardState {
  files: Array<{ path: string; status: string; issues: string[] }>;
  retrieval?: { status: string; cause?: string };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repoWith(state: CommitGuardState) {
  const repo = mkdtempSync(join(tmpdir(), 'commit-guard-retrieval-'));
  dirs.push(repo);
  mkdirSync(join(repo, '.claude'), { recursive: true });
  const stateFile = join(repo, '.claude', '.pre-commit-review.json');
  writeFileSync(stateFile, JSON.stringify(state));
  return { repo, stateFile };
}

const resolved: CommitGuardState = { files: [{ path: 'src/a.ts', status: 'pass', issues: [] }] };

const finalize = (repo: string, args: string[], env = GATE_ENV) =>
  spawnSync('node', [SCRIPT, 'finalize', ...args], { cwd: repo, encoding: 'utf8', env });

const stored = (stateFile: string): CommitGuardState => JSON.parse(readFileSync(stateFile, 'utf8'));

describe('commit-guard finalize --retrieval (sc-2317)', () => {
  it('records ok on a passing checklist', () => {
    const { repo, stateFile } = repoWith(resolved);
    const r = finalize(repo, ['--retrieval', 'ok']);
    expect(r.status, r.stdout).toBe(0);
    expect(stored(stateFile).retrieval).toEqual({ status: 'ok' });
  });

  it('records unavailable with its cause, trimmed', () => {
    const { repo, stateFile } = repoWith(resolved);
    const r = finalize(repo, ['--retrieval', 'unavailable', '--cause', '  embeddings 503  ']);
    expect(r.status, r.stdout).toBe(0);
    expect(stored(stateFile).retrieval).toEqual({ status: 'unavailable', cause: 'embeddings 503' });
    expect(r.stdout).toContain('Semantic retrieval unavailable: embeddings 503');
  });

  it('accepts --cause before --retrieval (flag order is not significant)', () => {
    const { repo, stateFile } = repoWith(resolved);
    const r = finalize(repo, ['--cause', 'index missing', '--retrieval', 'unavailable']);
    expect(r.status, r.stdout).toBe(0);
    expect(stored(stateFile).retrieval).toEqual({ status: 'unavailable', cause: 'index missing' });
  });

  it.each([
    ['unavailable without --cause', ['--retrieval', 'unavailable']],
    ['unavailable with a blank cause', ['--retrieval', 'unavailable', '--cause', '   ']],
    ['--cause swallowing the next flag', ['--retrieval', 'unavailable', '--cause', '--verbose']],
    ['--cause as the last token', ['--retrieval', 'unavailable', '--cause']],
    ['--retrieval with no value', ['--retrieval']],
    ['a typo’d status', ['--retrieval', 'okay']],
    ['a wrong-case status', ['--retrieval', 'OK']],
    [
      'contradictory repeated --retrieval (ok first)',
      ['--retrieval', 'ok', '--retrieval', 'unavailable', '--cause', 'embeddings-down'],
    ],
    [
      'contradictory repeated --retrieval (unavailable first)',
      ['--retrieval', 'unavailable', '--cause', 'x', '--retrieval', 'ok'],
    ],
    ['a repeated --cause', ['--retrieval', 'unavailable', '--cause', 'a', '--cause', 'b']],
    ['ok with an outage cause', ['--retrieval', 'ok', '--cause', 'remote embeddings unreachable']],
    ['a cause with no status', ['--cause', 'backend failed']],
    ['an unknown flag', ['--retrieval', 'ok', '--verbose']],
    ['a stray positional', ['--retrieval', 'ok', 'extra']],
  ])('refuses %s and writes nothing', (_, args) => {
    const { repo, stateFile } = repoWith(resolved);
    const r = finalize(repo, args);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Usage: finalize');
    expect(stored(stateFile)).toEqual(resolved);
  });

  it('an incomplete checklist still refuses and records no retrieval status', () => {
    const pending: CommitGuardState = {
      files: [{ path: 'src/a.ts', status: 'pending', issues: [] }],
    };
    const { repo, stateFile } = repoWith(pending);
    expect(finalize(repo, ['--retrieval', 'ok']).status).toBe(1);
    expect(stored(stateFile).retrieval).toBeUndefined();
  });

  it('a failed checklist still refuses and records no retrieval status', () => {
    const failed: CommitGuardState = {
      files: [{ path: 'src/a.ts', status: 'fail', issues: ['dup'] }],
    };
    const { repo, stateFile } = repoWith(failed);
    expect(finalize(repo, ['--retrieval', 'unavailable', '--cause', 'x']).status).toBe(1);
    expect(stored(stateFile).retrieval).toBeUndefined();
  });

  it('plain finalize stays valid (interactive use) and leaves the status absent for the gate', () => {
    const { repo, stateFile } = repoWith(resolved);
    expect(finalize(repo, []).status).toBe(0);
    expect(stored(stateFile).retrieval).toBeUndefined();
  });

  it('the latest recorded status wins across repeated finalize calls', () => {
    const { repo, stateFile } = repoWith(resolved);
    finalize(repo, ['--retrieval', 'unavailable', '--cause', 'first try failed']);
    expect(finalize(repo, ['--retrieval', 'ok']).status).toBe(0);
    expect(stored(stateFile).retrieval).toEqual({ status: 'ok' });
  });

  it('outside the gate env a recorded finalize still tidies the artifact', () => {
    const { repo, stateFile } = repoWith(resolved);
    const r = finalize(repo, ['--retrieval', 'ok'], INTERACTIVE_ENV);
    expect(r.status, r.stdout).toBe(0);
    expect(existsSync(stateFile)).toBe(false);
  });

  it('keeps a cause containing shell metacharacters as literal data', () => {
    const { repo, stateFile } = repoWith(resolved);
    const cause = '$(touch INJECTED) `id` ; rm -rf x';
    expect(finalize(repo, ['--retrieval', 'unavailable', '--cause', cause]).status).toBe(0);
    expect(stored(stateFile).retrieval?.cause).toBe(cause);
    expect(existsSync(join(repo, 'INJECTED'))).toBe(false);
  });
});
