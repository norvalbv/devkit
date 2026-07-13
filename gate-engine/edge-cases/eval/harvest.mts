#!/usr/bin/env bun

/**
 * Stage 1 of the edge-cases corpus pipeline (harvest → label → finalize): mechanically extract
 * every historical /edge-cases invocation from the local stores into raw/candidates.jsonl.
 * No LLM calls. Read-only on every store (agents.db is snapshotted first; Cursor is opened ro).
 *
 *   bun gate-engine/edge-cases/eval/harvest.mts                  # all sources
 *   bun gate-engine/edge-cases/eval/harvest.mts --source cc      # claude-code | frink-app | cursor | cc | fk | cu
 *
 * Re-running a source overwrites its raw/candidates-<source>.jsonl; the merged candidates.jsonl is
 * rebuilt from whichever per-source files exist. Dedup: a frink-app sub_chat and its Claude Code
 * transcript are the SAME session (sub_chats.session_id = transcript stem) — the transcript row
 * wins (full tool fidelity) and the frink-app row folds in as crossRefs + branch/pr enrichment.
 *
 * The 21 GB Cursor scan takes minutes; quitting Cursor speeds it up but is not required.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { harvestClaudeCode, harvestCursor, harvestFrinkApp } from './lib/sources.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const rawDir = path.join(here, 'raw');
mkdirSync(rawDir, { recursive: true });

const ALIASES = { cc: 'claude-code', fk: 'frink-app', cu: 'cursor' };
const argv = process.argv.slice(2);
const sourceArg = argv.includes('--source') ? argv[argv.indexOf('--source') + 1] : 'all';
const source = ALIASES[sourceArg] ?? sourceArg;
if (!['all', 'claude-code', 'frink-app', 'cursor'].includes(source)) {
  console.error(`harvest: unknown --source ${sourceArg}`);
  process.exit(2);
}

const EXTRACTORS = {
  'claude-code': harvestClaudeCode,
  'frink-app': () => harvestFrinkApp(rawDir),
  cursor: harvestCursor,
};

const perSourcePath = (name) => path.join(rawDir, `candidates-${name}.jsonl`);
const writeJsonl = (file, rows) =>
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
const readJsonl = (file) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

for (const [name, extract] of Object.entries(EXTRACTORS)) {
  if (source !== 'all' && source !== name) continue;
  const t0 = Date.now();
  const rows = extract();
  writeJsonl(perSourcePath(name), rows);
  console.log(
    `harvest: ${name} → ${rows.length} candidates (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );
}

// Merge + dedup across whatever per-source files exist.
const cc = readJsonl(perSourcePath('claude-code'));
const fk = readJsonl(perSourcePath('frink-app'));
const cu = readJsonl(perSourcePath('cursor'));

const ccBySession = new Map();
for (const c of cc) ccBySession.set(c.sessionId, [...(ccBySession.get(c.sessionId) ?? []), c]);

const unmatchedFk = [];
for (const f of fk) {
  const twins = ccBySession.get(f.sessionId);
  if (!twins) {
    unmatchedFk.push(f);
    continue;
  }
  for (const twin of twins) {
    twin.crossRefs.push(f.sourceRef);
    twin.branch ??= f.branch;
    twin.prNumber ??= f.prNumber;
  }
}

// Diff reconstruction: most transcripts hold rtk-compressed diffs (no literal hunks), but sessions
// print their commit shas ("[branch abc1234] …"). `git show` the PRE-invocation shas in the local
// repo to recover the real diff the run was anchored to. Post-invocation shas stay as evidence.
const REPO_PATHS = {
  frink: path.join(homedir(), 'Desktop/Personal and learning/frink'),
  devkit: path.join(homedir(), 'Desktop/Personal and learning/devkit'),
  qavis: path.join(homedir(), 'Desktop/Personal and learning/qavis'),
};
const git = (repoPath, args) => {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    }).trim();
  } catch {
    return ''; // unreachable sha / deleted branch — that reconstruction rung just doesn't apply
  }
};
const gitShow = (repoPath, sha) =>
  git(repoPath, ['show', '--no-color', '--format=commit %h %s', sha]);

/** The diff the run was anchored to, best rung first:
 *  1. session's own PRE-invocation commit shas (exact scope);
 *  2. the branch tip AS OF THE INVOCATION INSTANT, diffed against its merge-base with origin/main;
 *  3. date-window commits up to the invocation instant, filtered by session-file overlap;
 *  4. the branch's PR squash (whole PR incl. post-invocation fixes) — LAST resort, and always
 *     flagged postFixContaminated.
 *
 * SOLUTION-LEAKAGE RULE (methodology audit, cf. SWE-Bench+ 2410.06992): every time bound is the
 * invocation timestamp itself, never later — the /edge-cases prompt commands the agent to FIX what
 * it finds, so any window extending past the invocation sweeps the fix into the anchor and the
 * judge gets scored on a diff where the gold bug no longer exists. */
const reconstructDiff = (r, repoPath) => {
  const invocationIso = new Date(Date.parse(r.date)).toISOString();
  const shown = (r.preCommits ?? []).map((sha) => gitShow(repoPath, sha)).filter(Boolean);
  if (shown.length) return { diff: shown.join('\n'), origin: 'reconstructed-from-commits' };

  if (r.branch && !['main', 'master'].includes(r.branch)) {
    for (const ref of [`origin/${r.branch}`, r.branch]) {
      if (!git(repoPath, ['rev-parse', '--verify', '--quiet', ref])) continue;
      const tip = git(repoPath, ['rev-list', '-1', `--until=${invocationIso}`, ref]);
      if (!tip) continue; // branch has no pre-invocation state — do not fall back to a later tip
      const base = git(repoPath, ['merge-base', 'origin/main', tip]);
      if (!base) continue;
      const diff = git(repoPath, ['diff', '--no-color', base, tip]);
      if (diff) return { diff, origin: 'reconstructed-from-branch' };
    }
  }

  // Date-window rung: merge-commit workflows keep the ORIGINAL session commits (true author
  // dates) in history. Commits up to the INVOCATION, filtered by session-file overlap (keeps
  // parallel same-day sessions out).
  if (r.editedFiles?.length) {
    const since = new Date(Date.parse(r.date) - 12 * 3600 * 1000).toISOString();
    const until = invocationIso;
    const shas = git(repoPath, [
      'log',
      '--all',
      '--no-merges',
      `--since=${since}`,
      `--until=${until}`,
      '--format=%H %s',
    ])
      .split('\n')
      .filter((l) => l && !l.includes('"sdkMessageUuid"')) // frink worktree checkpoint snapshots
      .map((l) => l.split(' ')[0]);
    const suffixes = r.editedFiles.map((f) => f.split('/').slice(-2).join('/'));
    const matching = shas.filter((sha) => {
      const files = git(repoPath, ['show', '--name-only', '--format=', sha]);
      return suffixes.some((suf) => files.includes(suf));
    });
    if (matching.length) {
      const diff = matching
        .slice(0, 10)
        .map((sha) => gitShow(repoPath, sha))
        .filter(Boolean)
        .join('\n');
      if (diff) return { diff, origin: 'reconstructed-from-date-window' };
    }
  }

  // Last resort: a squash merge contains the WHOLE PR including post-invocation fixes — it cannot
  // be time-bounded. Usable only as flagged, contaminated context (finalize demotes it out of the
  // diff-scoped denominator).
  const squash = r.prNumber
    ? git(repoPath, ['log', 'origin/main', `--grep=(#${r.prNumber})`, '-1', '--format=%H'])
    : (ghPrForBranch(repoPath, r.branch)?.mergeCommit?.oid ?? '');
  if (squash) {
    const diff = gitShow(repoPath, squash);
    if (diff) return { diff, origin: 'reconstructed-from-pr', postFixContaminated: true };
  }
  return null;
};

const ghPrForBranch = (repoPath, branch) => {
  try {
    const out = execFileSync(
      'gh',
      [
        'pr',
        'list',
        '--head',
        branch,
        '--state',
        'all',
        '--json',
        'number,mergeCommit',
        '--limit',
        '1',
      ],
      { encoding: 'utf8', cwd: repoPath, timeout: 15000 },
    );
    return JSON.parse(out)[0] ?? null;
  } catch {
    return null;
  }
};

const reconstructDiffs = (rows) => {
  let reconstructed = 0;
  for (const r of rows) {
    const repoPath = REPO_PATHS[r.repo];
    if (r.diffFull || !repoPath) continue;
    const result = reconstructDiff(r, repoPath);
    if (!result) continue;
    r.diffFull = result.diff.slice(0, 200 * 1024);
    r.diffOrigin = result.origin;
    r.postFixContaminated = result.postFixContaminated ?? false;
    reconstructed++;
  }
  return reconstructed;
};

// A Claude Code session continued after context compaction gets a NEW transcript file that
// re-embeds earlier messages with their ORIGINAL uuids — the same invocation would otherwise
// yield two rows. Dedup on the invocation-message uuid; the earlier row wins.
const byUuid = new Map();
const deduped = [];
for (const r of [...cc, ...unmatchedFk, ...cu].sort((a, b) => a.date.localeCompare(b.date))) {
  const uuid = r.sourceRef.includes('uuid=') ? r.sourceRef.split('uuid=')[1] : r.sourceRef;
  const twin = byUuid.get(uuid);
  if (twin) {
    twin.crossRefs.push(r.sourceRef);
    continue;
  }
  byUuid.set(uuid, r);
  deduped.push(r);
}

const merged = deduped;
const reconstructed = reconstructDiffs(merged);
const ids = new Set();
for (const m of merged) {
  if (ids.has(m.id)) {
    console.error(`harvest: duplicate id ${m.id} (${m.sourceRef})`);
    process.exit(1);
  }
  ids.add(m.id);
}
writeJsonl(path.join(rawDir, 'candidates.jsonl'), merged);

const byRepo = {};
const bySource = {};
for (const m of merged) {
  byRepo[m.repo] = (byRepo[m.repo] ?? 0) + 1;
  bySource[m.source] = (bySource[m.source] ?? 0) + 1;
}
console.log(
  `harvest: merged ${merged.length} candidates (${fk.length - unmatchedFk.length} frink-app folded into claude-code twins)`,
);
console.log(`  by source: ${JSON.stringify(bySource)}`);
console.log(`  by repo:   ${JSON.stringify(byRepo)}`);
console.log(
  `  with diff: ${merged.filter((m) => m.diffFull).length} / ${merged.length} (${reconstructed} reconstructed from session commits)`,
);
