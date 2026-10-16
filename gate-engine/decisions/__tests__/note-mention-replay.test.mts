import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  declaringFiles,
  liveNotes,
  passesBar,
  replayCommit,
  tally,
} from '../../../docs/benchmarks/experiments/2026-10-16-note-mention-replay/replay.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ENV_SOURCE = (message: string) =>
  `export function withStagedFiles(files) {\n  if (files.length > 100) {\n    console.error('${message}');\n    return null;\n  }\n  return files;\n}\n`;

const record = (notes: string[]) =>
  `---\nslug: demo-axis\ncreated: 2026-01-01\n---\n\n# demo-axis\n\n## Target · 2026-01-01 — demo\n\n` +
  `**Context:** c\n**Ruling:** r\n**Scope:** src/**\n${notes.map((n) => `- ${n}`).join('\n')}\n`;

function commitAll(dir: string, files: Record<string, string>): string {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body);
  }
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'step');
  return git('rev-parse', 'HEAD').trim();
}

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'note-mention-replay-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  commitAll(dir, files);
  return dir;
}

const NOTE = '2026-01-02 — withStagedFiles: a list over 100 falls back loudly.';

/** A log naming withStagedFiles, then a commit that edits only the fallback branch's body. */
function inPlaceHistory(notes = [NOTE], extra: Record<string, string> = {}) {
  const dir = repo({
    'docs/decisions/demo-axis.md': record(notes),
    'src/env.mts': ENV_SOURCE('falls back loudly'),
    ...extra,
  });
  return { dir, sha: commitAll(dir, { 'src/env.mts': ENV_SOURCE('writes a temp file') }) };
}

// The collision filter once used `\s`/`\b` in git grep -E, which BSD regex (Apple git) never matches.
it('counts every file that declares a name, so a collision is seen on BSD-regex git too', () => {
  const dir = repo({
    'a.mts': 'export function gateHash(x) {}\n',
    'b.mts': 'const gateHash = 1;\n',
    'c.mts': 'use(gateHashes);\n',
  });
  expect(declaringFiles('gateHash', 'HEAD', dir).sort()).toEqual(['HEAD:a.mts', 'HEAD:b.mts']);
});

it('reads no declaration as an empty list, but a git failure as an error', () => {
  const dir = repo({ 'a.mts': 'call(gateHash);\n' });
  expect(declaringFiles('gateHash', 'HEAD', dir)).toEqual([]);
  expect(() => declaringFiles('gateHash', 'no-such-rev', dir)).toThrow();
});

// The record's central claim: removed lines alone are blind to a body edit; the hunk header is not.
it('misses an in-place body edit on removed lines alone, and catches it through the hunk header', () => {
  const { dir, sha } = inPlaceHistory();
  expect(replayCommit(sha, 'A', dir)).toEqual([]);
  for (const arm of ['B', 'C', 'D'])
    expect(replayCommit(sha, arm, dir).map((h: { note: string }) => h.note)).toEqual([
      'demo-axis#note:2026-01-02',
    ]);
});

it('matches against the log as of the parent, so a note added by the same commit never counts', () => {
  const dir = repo({
    'docs/decisions/demo-axis.md': record([]),
    'src/env.mts': ENV_SOURCE('falls back loudly'),
  });
  const sha = commitAll(dir, {
    'docs/decisions/demo-axis.md': record([NOTE]),
    'src/env.mts': ENV_SOURCE('writes a temp file'),
  });
  expect(replayCommit(sha, 'B', dir)).toEqual([]);
});

it('drops notes a declared Amends supersedes, and Scope or Check notes', () => {
  const dir = repo({
    'docs/decisions/demo-axis.md': record([
      NOTE,
      '2026-01-03 — **Amends:** note:2026-01-02 — withStagedFiles now writes a temp file.',
      '2026-01-04 — **Check:** `node check.mjs withStagedFiles`',
    ]),
  });
  expect(liveNotes('HEAD', dir).map((n: { id: string }) => n.id)).toEqual(['note:2026-01-03']);
});

it('drops a hit in arm C when another file declares the same name and the note names neither', () => {
  const { dir, sha } = inPlaceHistory([NOTE], {
    'src/other.mts': 'export const withStagedFiles = 1;\n',
  });
  expect(replayCommit(sha, 'B', dir)).toHaveLength(1);
  expect(replayCommit(sha, 'C', dir)).toEqual([]);
});

const hit = (note: string, name: string) => ({ file: 'src/env.mts', note, name });

it('tallies only commits that changed source, and counts each note-and-name pair once', () => {
  const counts = tally([
    null,
    [],
    [hit('a#note:1', 'withStagedFiles')],
    [hit('a#note:1', 'withStagedFiles'), hit('b#note:2', 'readDiagnosis')],
  ]);
  expect(counts).toEqual({ commits: 3, fired: 2, lines: 3, perCommit: 1, distinctPairs: 2 });
});

// `null <= 0.5` is true in JavaScript, so an empty replay would otherwise read as a pass.
it('never passes a replay with no source-changing commit, even when both incident variants hit', () => {
  const both = { moved: true, inPlace: true };
  expect(tally([null, null]).perCommit).toBeNull();
  expect(passesBar(tally([null, null]), both)).toBe(false);
  expect(passesBar(tally([[], []]), both)).toBe(true);
  expect(passesBar(tally([[], []]), { moved: true, inPlace: false })).toBe(false);
});
