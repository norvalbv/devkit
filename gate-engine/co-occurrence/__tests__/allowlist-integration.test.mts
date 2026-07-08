import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The ticket's whole promise, end-to-end: the matcher gate blocks, prints a `guard-dup-allowlist
// add …` remedy, the user runs THAT EXACT command, and the gate stops blocking. A key mismatch
// between what the gate prints (symbolA/fileA) and how the CLI stores it (symFileKey) would let
// the printed remedy "succeed" yet never suppress the dup — the failure this test forecloses.

const here = dirname(fileURLToPath(import.meta.url));
const MATCHER = resolve(here, '..', 'matcher.mts');
const CLI = resolve(here, '..', 'allowlist-cli.mts');

let tmp: string;
let dbPath: string;
let n = 0;
const freshAllowlist = () => join(tmp, `al-${n++}.json`);
const emb = () => Buffer.from(new Float32Array([1, 0, 0, 0]).buffer);

// Split a shell command line into argv, honouring double-quoted tokens (the gate quotes
// symbols/paths). Enough for the gate's own output — no escaping/nesting to worry about.
function shellSplit(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom.
  while ((m = re.exec(line)) !== null) out.push(m[1] ?? m[2]);
  return out;
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'allowlist-integ-'));
  dbPath = join(tmp, 'index.db');
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE chunks (file_path TEXT, symbol_name TEXT, start_line INTEGER, end_line INTEGER, code_hash TEXT, embedding BLOB, code_embedding BLOB)',
  );
  const ins = db.prepare(
    'INSERT INTO chunks (file_path, symbol_name, start_line, end_line, code_hash, embedding, code_embedding) VALUES (?,?,?,?,?,?,?)',
  );
  // Two files, identical code_hash → an exact-tier cross-file dup the gate will surface.
  ins.run('src/fixtureA.ts', 'fixtureDupA', 1, 10, 'SAME_HASH', emb(), emb());
  ins.run('src/fixtureB.ts', 'fixtureDupB', 1, 10, 'SAME_HASH', emb(), emb());
  db.close();
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface Run {
  status: number;
  stdout: string;
}
function runGate(al: string): Run {
  try {
    const stdout = execFileSync('node', [MATCHER, 'scan', '--new', '--changed', '--gate'], {
      env: {
        ...process.env,
        SEARCH_CODE_DB: dbPath,
        MATCHER_CHANGED_FILES: 'src/fixtureA.ts',
        CO_OCCURRENCE_ALLOWLIST: al,
      },
      encoding: 'utf8',
    });
    return { status: 0, stdout };
  } catch (e) {
    const err = e as { status: number; stdout?: string };
    return { status: err.status, stdout: `${err.stdout ?? ''}` };
  }
}
function runCli(al: string, args: string[]): number {
  try {
    execFileSync('node', [CLI, ...args], {
      env: { ...process.env, CO_OCCURRENCE_ALLOWLIST: al },
      stdio: 'pipe',
    });
    return 0;
  } catch (e) {
    return (e as { status: number }).status;
  }
}

describe('gate → paste remedy → gate (full suppression loop)', () => {
  it('running the gate-printed guard-dup-allowlist command suppresses the block', () => {
    const al = freshAllowlist();

    // 1. Gate blocks and prints its remedy.
    const blocked = runGate(al);
    expect(blocked.status).toBe(1);
    const line = blocked.stdout.split('\n').find((l) => l.includes('guard-dup-allowlist add '));
    expect(line, 'gate must print a guard-dup-allowlist add remedy').toBeTruthy();

    // 2. Take that EXACT command, drop the bin name, fill the <why> placeholder, run it.
    const tokens = shellSplit((line as string).trim()).slice(1);
    const filled = tokens.map((t) => (t === '<why>' ? 'intentional cross-module mirror' : t));
    expect(runCli(al, filled)).toBe(0);

    // 3. Same gate run now passes — the pasted remedy actually did its job.
    expect(runGate(al).status).toBe(0);
  });

  it('removing the approval re-arms the gate (block returns)', () => {
    const al = freshAllowlist();
    runCli(al, [
      'add',
      'fixtureDupA',
      'src/fixtureA.ts',
      'fixtureDupB',
      'src/fixtureB.ts',
      '--description',
      'intentional',
    ]);
    expect(runGate(al).status).toBe(0); // suppressed
    expect(
      runCli(al, ['remove', 'fixtureDupA', 'src/fixtureA.ts', 'fixtureDupB', 'src/fixtureB.ts']),
    ).toBe(0);
    expect(runGate(al).status).toBe(1); // re-armed
  });
});
