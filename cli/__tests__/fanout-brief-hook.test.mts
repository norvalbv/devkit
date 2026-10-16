import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const HOOK = fileURLToPath(new URL('../../agents-hooks/fanout-brief.mjs', import.meta.url));
const FANOUT = fileURLToPath(
  new URL('../../gate-engine/ratchets/folder-fanout.mts', import.meta.url),
);
// Hermetic PATH: node and git only, so a globally installed guard-fanout never answers for the stub.
const PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;

const roots: string[] = [];
let sessions = 0;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, rel: string) {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), 'export {};\n');
}

// A committed repo whose `src/<dir>` folders hold `n` impl files, with the real guard-fanout on .bin.
function makeRepo(dirs: Record<string, number>, { governed = true, bin = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fanout-brief-'));
  roots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  if (governed) {
    const cfg = { scanRoots: ['src'], sourceExtensions: ['ts'], fanoutCap: 12 };
    writeFileSync(join(root, 'guard.config.json'), JSON.stringify(cfg));
  }
  for (const [dir, n] of Object.entries(dirs)) {
    for (let i = 0; i < n; i++) write(root, `src/${dir}/file-${i}.ts`);
  }
  git('add', '-A');
  git('commit', '-qm', 'init');
  if (bin) {
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    const shim = join(root, 'node_modules', '.bin', 'guard-fanout');
    writeFileSync(shim, `#!/bin/sh\nexec node '${FANOUT}' "$@"\n`, { mode: 0o755 });
  }
  return root;
}

function run(root: string, filePath: string, { tool = 'Write', session = `s${++sessions}` } = {}) {
  const input = { tool_name: tool, session_id: session, tool_input: { file_path: filePath } };
  return spawnSync('node', [HOOK], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH, CLAUDE_PROJECT_DIR: root },
    input: JSON.stringify(input),
  }).stdout.trim();
}

describe('fanout-brief', () => {
  it('warns before a new file pushes a full folder past the cap, naming its subfolders', () => {
    const root = makeRepo({ pile: 12, 'pile/advisory': 1 });
    const out = JSON.parse(run(root, 'src/pile/new.ts')).hookSpecificOutput;
    expect(out.hookEventName).toBe('PreToolUse');
    expect(out.additionalContext).toContain('will block your commit at guard-fanout');
    expect(out.additionalContext).toContain('src/pile: 12→13/12');
    expect(out.additionalContext).toContain('(existing: advisory)');
    // Advisory only: a permissionDecision would block the write or auto-approve every write.
    expect(out.permissionDecision).toBeUndefined();
  });

  // Catches an index-only count: files the session already wrote are untracked until staged.
  it('counts untracked files already sitting in the folder', () => {
    const root = makeRepo({ pile: 11 });
    write(root, 'src/pile/a.ts');
    expect(run(root, 'src/pile/b.ts')).toContain('src/pile: 11→13/12');
  });

  // Catches a sibling list read from git's quoted output: `"src/pile/\303\251.ts"` is in no folder.
  it('counts an untracked sibling whose name git would quote', () => {
    const root = makeRepo({ pile: 11 });
    write(root, 'src/pile/é.ts');
    expect(run(root, 'src/pile/b.ts')).toContain('src/pile: 11→13/12');
  });

  // Claude Code sends an absolute file_path; the fixtures above use the relative form.
  it('judges an absolute file_path inside the project', () => {
    const root = makeRepo({ pile: 12 });
    expect(run(root, join(root, 'src/pile/new.ts'))).toContain('src/pile: 12→13/12');
  });

  it('stays silent when the folder has room or the file already exists', () => {
    const root = makeRepo({ pile: 11, full: 12 });
    expect(run(root, 'src/pile/new.ts')).toBe('');
    expect(run(root, 'src/full/file-0.ts')).toBe('');
  });

  // Catches a hook that warns on folder count alone: tests never count toward fan-out.
  it('stays silent for a new test file in a full folder', () => {
    expect(run(makeRepo({ pile: 12 }), 'src/pile/new.test.ts')).toBe('');
  });

  it('stays silent for other tools and paths outside the project', () => {
    const root = makeRepo({ pile: 12 });
    expect(run(root, 'src/pile/new.ts', { tool: 'Edit' })).toBe('');
    expect(run(root, '../elsewhere/new.ts')).toBe('');
  });

  it('stays silent when guard-fanout is absent or the repo is ungoverned', () => {
    expect(run(makeRepo({ pile: 12 }, { bin: false }), 'src/pile/new.ts')).toBe('');
    expect(run(makeRepo({ pile: 12 }, { governed: false }), 'src/pile/new.ts')).toBe('');
  });

  it('warns once per folder per session', () => {
    const root = makeRepo({ pile: 12 });
    expect(run(root, 'src/pile/a.ts', { session: 'one' })).not.toBe('');
    expect(run(root, 'src/pile/b.ts', { session: 'one' })).toBe('');
    expect(run(root, 'src/pile/b.ts', { session: 'two' })).not.toBe('');
  });
});
