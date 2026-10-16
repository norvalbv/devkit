#!/usr/bin/env node
// Zero-LLM replay: which decision notes would a "this diff changes a name the note mentions" advisory
// print? Run from the repo root: `node docs/benchmarks/experiments/2026-10-16-note-mention-replay/replay.mjs`.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDecision } from '../../../../gate-engine/decisions/decisions.mts';
import { axisNotes } from '../../../../gate-engine/decisions/recall/note-relations.mts';

const HEAD = '53bda204';
const COMMITS = 200;
const INCIDENT = 'a7ca89a3';
const INCIDENT_NOTE = 'review-gate-in-chain#note:2026-08-04~3';
const BAR_LINES_PER_COMMIT = 0.5;

const DECL = /\b(?:function\*?|const|let|var|class|interface|type|enum|def|fn|func|struct)\s+([A-Za-z_$][\w$]*)/g;
const DECL_ALT = 'function\\*?|const|let|var|class|interface|type|enum|def|fn|func|struct';
const TOKEN = /[A-Za-z_$][\w$]*/g;
const COMMENT_LINE = /^-\s*(\/\/|\*|\/\*|#)/;
const SOURCE = /\.(m?[jt]s|py|sh)$/;
const NOT_SOURCE = /__tests__|\.test\./;
const EXCLUDE = [':!docs', ':!dist', ':!**/__tests__/**', ':!**/*.test.*', ':!.claude', ':!.cursor', ':!.agents', ':!.codex'];

/** Arms, as pre-registered: A removed lines; B adds hunk-header tokens; C filters B; D (post hoc) header declarations only. */
const ARMS = ['A', 'B', 'C', 'D'];

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
}

function tryGit(cwd, ...args) {
  try {
    return git(cwd, ...args);
  } catch {
    return '';
  }
}

function looksLikeIdentifier(name) {
  return name.length >= 6 && (/[a-z][A-Z]/.test(name) || name.includes('_'));
}

function wordIn(name, text) {
  return new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(text);
}

const notesByTree = new Map();

/** Live notes in the decision log as of `rev`: not targeted by an Amends, not a Scope or Check line. */
export function liveNotes(rev, cwd = process.cwd()) {
  const tree = git(cwd, 'rev-parse', `${rev}:docs/decisions`).trim();
  if (notesByTree.has(tree)) return notesByTree.get(tree);
  const out = [];
  for (const file of git(cwd, 'ls-tree', '--name-only', tree).trim().split('\n')) {
    if (!file.endsWith('.md') || file === 'INDEX.md') continue;
    const notes = axisNotes(parseDecision(git(cwd, 'show', `${tree}:${file}`)).body);
    const amended = new Set(notes.map((n) => n.amends?.replace(/^.*#/, '')).filter(Boolean));
    for (const n of notes) {
      if (amended.has(n.id) || /^\*\*(Scope|Check):\*\*/.test(n.text)) continue;
      out.push({ slug: file.slice(0, -3), id: n.id, text: n.text });
    }
  }
  notesByTree.set(tree, out);
  return out;
}

function headerNames(header, arm) {
  if (arm === 'A') return [];
  if (arm === 'D') return [...header.matchAll(DECL)].map((m) => m[1]);
  return header.match(TOKEN) ?? [];
}

/** Names one diff line contributes: its hunk header's (arms B to D) or a removed line's tokens. */
function lineNames(line, arm) {
  if (line.startsWith('@@')) return headerNames(line.replace(/^@@[^@]*@@/, ''), arm);
  if (!line.startsWith('-') || line.startsWith('---')) return [];
  if (arm === 'C' && COMMENT_LINE.test(line)) return [];
  return line.match(TOKEN) ?? [];
}

/** Names the diff changes, per arm. Every arm keeps only names the parent file declares. */
function changedNames(diff, arm, declared) {
  const names = new Set(diff.split('\n').flatMap((line) => lineNames(line, arm)));
  return [...names].filter((n) => looksLikeIdentifier(n) && declared.has(n));
}

/** Files at `rev` declaring `name`. POSIX classes only: BSD regex (Apple git) has no `\s` or `\b`. */
export function declaringFiles(name, rev, cwd = process.cwd()) {
  const edge = '[^[:alnum:]_$]';
  const pattern = `(^|${edge})(${DECL_ALT})[[:space:]]+${name.replace(/\$/g, '[$]')}(${edge}|$)`;
  try {
    return execFileSync('git', ['grep', '-l', '-E', pattern, rev, '--', ...EXCLUDE], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch (error) {
    if (error.status === 1) return []; // git grep exits 1 for no match; anything else is a failure
    throw error;
  }
}

/** Arm C's collision filter: the name has one declaring file, or the note names the hunk's file. */
function uniqueOrNamed(name, rev, file, note, cwd) {
  if (declaringFiles(name, rev, cwd).length <= 1) return true;
  return note.text.includes(path.basename(file).replace(/\.\w+$/, ''));
}

function hitsFor(diff, arm, parentSource, rev, file, notes, cwd) {
  const declared = new Set([...parentSource.matchAll(DECL)].map((m) => m[1]));
  const hits = [];
  for (const name of changedNames(diff, arm, declared))
    for (const note of notes)
      if (wordIn(name, note.text) && (arm !== 'C' || uniqueOrNamed(name, rev, file, note, cwd)))
        hits.push({ file, name, note: `${note.slug}#${note.id}` });
  return hits;
}

export function replayCommit(sha, arm, cwd = process.cwd()) {
  const files = git(cwd, 'diff-tree', '--no-commit-id', '--name-only', '-r', sha)
    .trim()
    .split('\n')
    .filter((f) => SOURCE.test(f) && !NOT_SOURCE.test(f) && !f.startsWith('dist/'));
  if (!files.length) return null;
  const notes = liveNotes(`${sha}^`, cwd);
  const hits = new Map();
  for (const file of files) {
    const diff = tryGit(cwd, 'show', '--format=', '-U0', ...(arm === 'C' ? ['-w'] : []), sha, '--', file);
    const parent = tryGit(cwd, 'show', `${sha}^:${file}`);
    for (const h of hitsFor(diff, arm, parent, `${sha}^`, file, notes, cwd)) if (!hits.has(h.note)) hits.set(h.note, h);
  }
  return [...hits.values()];
}

/** The same >100KB change made in place: only the hunk header names withStagedFiles. */
function inPlaceIncident(arm) {
  const file = 'gate-engine/review/runtime.mts';
  const before = git(process.cwd(), 'show', `${INCIDENT}^:${file}`);
  const after = before.replace('falling back to script-side resolution`', 'writing a temp file`');
  if (after === before) throw new Error('in-place fixture: the >100KB fallback message was not found');
  const dir = mkdtempSync(path.join(tmpdir(), 'note-mention-'));
  try {
    writeFileSync(path.join(dir, 'a.mts'), before);
    writeFileSync(path.join(dir, 'b.mts'), after);
    let diff = '';
    try {
      execFileSync('git', ['diff', '--no-index', '-U0', 'a.mts', 'b.mts'], { cwd: dir, encoding: 'utf8' });
    } catch (e) {
      diff = e.stdout; // --no-index exits 1 when the files differ
    }
    const notes = liveNotes(`${INCIDENT}^`);
    return hitsFor(diff, arm, before, `${INCIDENT}^`, file, notes).some((h) => h.note === INCIDENT_NOTE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Counts over one arm's replays; a null replay is a commit that changed no source file. */
export function tally(replays) {
  const counted = replays.filter((hits) => hits !== null);
  const lines = counted.reduce((n, hits) => n + hits.length, 0);
  return {
    commits: counted.length,
    fired: counted.filter((hits) => hits.length > 0).length,
    lines,
    perCommit: counted.length ? Number((lines / counted.length).toFixed(2)) : null,
    distinctPairs: new Set(counted.flat().map((h) => `${h.note} ${h.name}`)).size,
  };
}

/** An empty replay never passes: `null <= bar` is true in JavaScript. */
export function passesBar(counts, incident) {
  return incident.moved && incident.inPlace && counts.perCommit !== null && counts.perCommit <= BAR_LINES_PER_COMMIT;
}

function runArm(arm, shas) {
  const counts = tally(shas.map((sha) => replayCommit(sha, arm)));
  const incidentSha = git(process.cwd(), 'rev-parse', INCIDENT).trim();
  const moved = (replayCommit(incidentSha, arm) ?? []).some((h) => h.note === INCIDENT_NOTE);
  const incident = { moved, inPlace: inPlaceIncident(arm) };
  return { arm, ...counts, incident, passes: passesBar(counts, incident) };
}

function main() {
  const shas = git(process.cwd(), 'log', HEAD, '--no-merges', '-n', String(COMMITS), '--format=%H').trim().split('\n');
  const arms = (process.argv[2] ? process.argv[2].split(',') : ARMS).map((arm) => runArm(arm, shas));
  const summary = { head: HEAD, commits: COMMITS, bar: BAR_LINES_PER_COMMIT, arms };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
