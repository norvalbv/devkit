#!/usr/bin/env node

/**
 * Synthetic precision-guard generator (sc-1119). The corpus has only 4 true diff-shaped guard
 * rows — a hallucination gate at n=4 is statistically vacuous (rule of three), and degenerate
 * anchors need zero labeling spend to grow (methodology checklist item 16). This mines PURE-PROSE
 * docs-only commits from the pinned repo histories and renders them through the same excerpt
 * pipeline the corpus uses, giving the bench ~26 extra rows on which ANY judge finding is a
 * hallucination by construction.
 *
 *   node gate-engine/edge-cases/eval/guards-generate.mts        # → eval/guards-synthetic.jsonl
 *
 * Output is GITIGNORED (rows carry frink diff excerpts — same privacy posture as cases.jsonl);
 * this generator + the pinned shas + the purity rules below ARE committed, so the file is
 * regenerable byte-for-byte in the corpus-bearing checkout.
 *
 * Pre-registered purity rules (PREREGISTRATION.md):
 * - every changed path must be prose (*.md/*.mdx, docs/, LICENSE-class root files) — config,
 *   build, lockfile and CI paths are EXCLUDED because a judge can raise a legitimate finding
 *   there, which would score a good config as hallucinating;
 * - any diff containing a fenced code block (``` ) is rejected — prose is not finding-free when a
 *   markdown code example carries a real bug;
 * - deterministic: repos walked at PINNED shas, commits taken in git-log order, capped per repo.
 *
 * Scope (also pre-registered): these rows bound PROSE-hallucination. Over-flagging on real but
 * correct code is a different failure mode this slice does not measure.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { excerptDiff } from './lib/excerpt.mts';
import { sha8 } from './lib/schema.mts';
import { scrub } from './lib/scrub.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(here, 'guards-synthetic.jsonl');

/** Pinned generation frontier: commits reachable from these shas only (reproducibility). */
export const PINNED = {
  devkit: '86bb201f3205071fc3f9d41be2460ef6d977fb16',
  frink: '1394feb018d8a5edd99ebf274c88d0941dde50da',
};
const REPO_PATHS = {
  devkit: path.join(homedir(), 'Desktop/Personal and learning/devkit'),
  frink: path.join(homedir(), 'Desktop/Personal and learning/frink'),
};
const PER_REPO_CAP = 13; // ≈26 total across the two repos

const MD_RE = /\.mdx?$/i;
const DOCS_DIR_RE = /^docs\//;
const LICENSE_CLASS_RE = /^(LICENSE|NOTICE|CONTRIBUTING|CODE_OF_CONDUCT)(\.[a-z]+)?$/i;
const FENCED_CHANGE_RE = /^[+-].*```/m;

/** Pure-prose path: markdown anywhere, anything under docs/, or LICENSE-class root files. */
export const isPureDocsPath = (p) =>
  MD_RE.test(p) || DOCS_DIR_RE.test(p) || LICENSE_CLASS_RE.test(p);

/** Reject prose diffs whose content embeds fenced code/command/config examples. */
export const hasFencedBlock = (diff) => FENCED_CHANGE_RE.test(diff);

const git = (repoPath, args) =>
  execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });

const mineRepo = (repo) => {
  const repoPath = REPO_PATHS[repo];
  const tip = PINNED[repo];
  const log = git(repoPath, ['log', tip, '--no-merges', '--name-only', '--format=%x01%H']);
  const rows = [];
  for (const block of log.split('\x01').filter(Boolean)) {
    if (rows.length >= PER_REPO_CAP) break;
    const [sha, ...rest] = block.trim().split('\n');
    const files = rest.map((l) => l.trim()).filter(Boolean);
    if (!files.length || !files.every(isPureDocsPath)) continue;
    let diff = '';
    try {
      diff = git(repoPath, ['show', '--format=', sha]);
    } catch {
      continue;
    }
    if (!diff.trim() || hasFencedBlock(diff)) continue;
    const nameStatus = git(repoPath, ['show', '--format=', '--name-status', sha]).trim();
    const { excerpt } = excerptDiff(diff);
    rows.push({
      id: `sg-${repo}-${sha8(sha)}`,
      repo,
      sourceSha: sha,
      synthetic: true,
      anchor: {
        kind: 'diff',
        nameStatus,
        diffExcerpt: excerpt,
        summary: 'Documentation-only change.',
      },
      degenerate: true,
      degenerateReason: 'docs-only',
      findings: [],
    });
  }
  return rows;
};

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const rows = Object.keys(PINNED).flatMap((repo) => mineRepo(repo));
  // scrub is the committed-output gate for the corpus; these rows are gitignored but flow into
  // judge prompts, so the same defense-in-depth applies
  const lines = rows.map((r) => scrub(JSON.stringify(r)));
  writeFileSync(outPath, lines.length ? `${lines.join('\n')}\n` : '');
  console.log(`guards: ${rows.length} synthetic docs-only guard rows → ${outPath}`);
  for (const r of rows) console.log(`  ${r.id}  ${r.anchor.nameStatus.split('\n')[0]}`);
  if (rows.length < 15)
    console.log(
      'guards: N < 15 — pre-registered minimum not met; the guard gate runs DESCRIPTIVE-only',
    );
}
