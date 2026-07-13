#!/usr/bin/env bun

/**
 * Stage 2 of the edge-cases corpus pipeline: propose per-finding labels for harvested candidates.
 * COSTS TOKENS (one sonnet call per case) — never auto-run; resume-safe (already-proposed ids skip).
 *
 *   bun gate-engine/edge-cases/eval/label.mts --limit 5        # pilot
 *   bun gate-engine/edge-cases/eval/label.mts                  # everything not yet proposed
 *   bun gate-engine/edge-cases/eval/label.mts --ids cc-…,fk-…  # specific cases
 *   bun gate-engine/edge-cases/eval/label.mts --audit          # print review queues, no LLM
 *
 * Ground-truth protocol (why this is structured this way): the /edge-cases prompt COMMANDS the
 * agent to write tests and TDD-fix whatever it raised, so "agent wrote a test/fix in the same
 * turn" is compliance, not proof a finding was real. Evidence is gathered MECHANICALLY first and
 * the model may only cite that bundle; wasLiveBug=true demands independent behavioural evidence
 * (a test observed FAILING before the fix, a fix in a different session/commit, or explicit user
 * confirmation). The verdict axis (worth-surfacing vs noise) is separate from the live-bug axis so
 * a correct-but-not-currently-broken edge case is not scored as judge noise. Every proposal starts
 * evidence.reviewed=false; finalize.mts refuses unreviewed wasLiveBug=true rows.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JUDGE_ISOLATION, JUDGE_READ_ONLY } from '../../judge/judge-isolation.mts';
import { execJudgeAsync } from '../../judge/run-judge.mts';
import { CATEGORIES, DEGENERATE_REASONS, EVIDENCE_TIERS, SEVERITIES } from './lib/schema.mts';
import { scrub } from './lib/scrub.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const rawDir = path.join(here, 'raw');
const candidatesPath = path.join(rawDir, 'candidates.jsonl');
const proposalsPath = path.join(rawDir, 'proposals.jsonl');

const MODEL = process.env.LABEL_MODEL ?? 'sonnet';
const CONCURRENCY = 4;

const REPO_PATHS = {
  frink: path.join(homedir(), 'Desktop/Personal and learning/frink'),
  devkit: path.join(homedir(), 'Desktop/Personal and learning/devkit'),
  qavis: path.join(homedir(), 'Desktop/Personal and learning/qavis'),
};

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const limit = Number(flag('--limit') ?? Number.POSITIVE_INFINITY);
const onlyIds = flag('--ids')?.split(',');
const audit = argv.includes('--audit');

const readJsonl = (file) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

const git = (repoPath, args) => {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    }).trim();
  } catch {
    return '';
  }
};

/** Mechanical evidence bundle — assembled BEFORE any model sees the case; the model may only cite this. */
const gatherEvidence = (c) => {
  const repoPath = REPO_PATHS[c.repo];
  const bundle = {
    turnTestRuns: c.turnActivity?.testRuns ?? [],
    turnFilesWritten: c.turnActivity?.filesWritten ?? [],
    aftermathTestRuns: c.aftermath?.testRuns ?? [],
    aftermathFilesWritten: c.aftermath?.filesWritten ?? [],
    userTurnsAfter: c.aftermath?.userTurns ?? [],
    postCommits: [],
    laterCommits: [],
  };
  if (repoPath) {
    for (const sha of (c.postCommits ?? []).slice(0, 10)) {
      const stat = git(repoPath, ['show', '--stat', '--format=%h %s', sha]);
      if (stat) bundle.postCommits.push(stat.slice(0, 1500));
    }
    if (c.editedFiles?.length) {
      const until = new Date(Date.parse(c.date) + 14 * 24 * 3600 * 1000).toISOString();
      const suffixes = c.editedFiles.map((f) => f.split('/').slice(-2).join('/'));
      // laterCommits feeds the "independent-fix" tier, so the SESSION'S OWN commits must never
      // land here — path overlap alone would let same-session compliance masquerade as an
      // independent later fix. Exclude every sha the session printed (pre + post).
      const ownShas = [...(c.preCommits ?? []), ...(c.postCommits ?? [])];
      const log = git(repoPath, [
        'log',
        '--all',
        '--no-merges',
        `--since=${c.date}`,
        `--until=${until}`,
        '--name-only',
        '--format=%x01%h %ad %s',
        '--date=short',
      ]);
      for (const block of log.split('\x01').filter(Boolean)) {
        const [head, ...files] = block.trim().split('\n');
        const sha = head.split(' ')[0];
        if (ownShas.some((own) => sha.startsWith(own) || own.startsWith(sha))) continue;
        if (suffixes.some((suf) => files.some((f) => f.includes(suf))))
          bundle.laterCommits.push(head);
      }
      bundle.laterCommits = bundle.laterCommits.slice(0, 20);
    }
  }
  return bundle;
};

const PROMPT = `You are labeling ONE historical run of an "/edge-cases" review prompt to build benchmark ground truth. You get the anchor (diff or session context), the agent's RESPONSE, and a mechanically gathered EVIDENCE bundle. Reply with ONLY a JSON object, no fences, no prose.

Schema:
{
  "summary": "2-4 sentences: what the session had built when the prompt ran",
  "degenerate": boolean,            // true when the run had nothing to review (empty diff / docs-only / agent declined / no response)
  "degenerateReason": ${JSON.stringify(DEGENERATE_REASONS)} | null,
  "findings": [
    {
      "claim": "normalized one-line assertion of the edge case",
      "files": ["repo/relative/paths implicated"],
      "text": "the finding as the agent stated it (condensed ok, faithful)",
      "severity": ${JSON.stringify(SEVERITIES)},   // as the agent stated it; "unstated" if it didn't
      "category": ${JSON.stringify(CATEGORIES)},
      "verdict": "worth-surfacing" | "noise",
      "wasLiveBug": "true" | "false" | "unknown",
      "evidence": { "tier": ${JSON.stringify(EVIDENCE_TIERS)}, "detail": "...", "confidence": "high"|"medium"|"low" }
    }
  ]
}

Rules — read carefully, they are the point of this corpus:
1. Findings = the distinct edge cases/risks the RESPONSE surfaced. Test-writing narration is not a finding. A response that only says "nothing to test" has zero findings and degenerate=true.
2. verdict "noise" means the finding is hallucinated, factually wrong about the code, a duplicate of an already-existing test, or below-severity trivia. "Plausible but never confirmed" is NOT noise — that is verdict "worth-surfacing" with wasLiveBug "unknown".
3. wasLiveBug "true" ONLY with independent behavioural evidence you can QUOTE from the EVIDENCE bundle:
   - tier "f2p-in-session": a test run output in the bundle shows the relevant test FAILING and a later run PASSING after a fix. A test that passed on first run is NOT this — that is tier "test-added-green" and wasLiveBug "false" (the test pinned already-correct behaviour).
   - tier "independent-fix": an entry in laterCommits (a DIFFERENT, later session's commit) clearly addresses this finding. postCommits are the SAME session committing its own work — that is compliance, never independence.
   - tier "user-confirmed": a user turn in the bundle explicitly validates this specific finding.
   The /edge-cases prompt ORDERS the agent to write tests and fix things, so mere test-writing, same-turn "fixed it" narration, or a same-session commit of the fix is compliance, not proof.
4. evidence.detail MUST quote its source: the failing-test output line, the commit "sha subject", or the user's words. If the bundle has nothing for a finding, tier "none", wasLiveBug "unknown", and judge verdict on content quality alone.
5. tier "rejected": the user or agent explicitly dismissed the finding as wrong → verdict "noise", wasLiveBug "false".
6. Do not invent evidence. Do not use knowledge outside the provided material.`;

const buildInput = (c, bundle) => {
  const anchor = c.diffFull
    ? `DIFF (origin: ${c.diffOrigin}):\n${c.diffFull.slice(0, 20000)}`
    : c.statText
      ? `DIFF STAT (no hunks recovered):\n${c.statText}`
      : `SESSION CONTEXT BEFORE INVOCATION:\n${(c.aftermath?.precedingContext ?? '').slice(0, 8000) || '(none recovered)'}`;
  return [
    `CASE ${c.id} · repo ${c.repo} · ${c.date} · provider ${c.provider}`,
    `PROMPT VARIANT: ${c.promptVariant}`,
    `\n=== ANCHOR ===\n${anchor}`,
    `\n=== RESPONSE (the agent's edge-cases answer) ===\n${c.responseText.slice(0, 30000) || '(empty)'}`,
    `\n=== EVIDENCE BUNDLE (mechanically gathered — the ONLY citable material) ===\n${JSON.stringify(bundle, null, 1).slice(0, 15000)}`,
  ].join('\n');
};

const FENCE_OPEN_RE = /^```(?:json)?\s*/i;
const FENCE_CLOSE_RE = /```\s*$/;

const parseProposal = (raw) => {
  const stripped = raw.trim().replace(FENCE_OPEN_RE, '').replace(FENCE_CLOSE_RE, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in reply');
  return JSON.parse(stripped.slice(start, end + 1));
};

// ── audit mode: review queues, no LLM ────────────────────────────────────────────────────────────
if (audit) {
  const proposals = readJsonl(proposalsPath);
  const queues = { liveBug: [], noise: [], lowConfidence: [], degenerate: [] };
  for (const p of proposals) {
    if (p.degenerate) queues.degenerate.push(p.id);
    for (const f of p.findings ?? []) {
      const tag = `${p.id}#${f.idx ?? '?'} [${f.evidence?.tier}] ${f.claim}`;
      if (String(f.wasLiveBug) === 'true')
        queues.liveBug.push(`${tag}\n    ↳ ${f.evidence?.detail}`);
      if (f.verdict === 'noise') queues.noise.push(`${tag}\n    ↳ ${f.evidence?.detail}`);
      if (f.evidence?.confidence === 'low') queues.lowConfidence.push(tag);
    }
  }
  const total = proposals.reduce((n, p) => n + (p.findings?.length ?? 0), 0);
  console.log(`proposals: ${proposals.length} cases, ${total} findings\n`);
  for (const [name, q] of Object.entries(queues)) {
    console.log(`── ${name} (${q.length}) ${'─'.repeat(Math.max(0, 60 - name.length))}`);
    for (const line of q) console.log(`  ${line}`);
    console.log();
  }
  process.exit(0);
}

// ── labeling run ─────────────────────────────────────────────────────────────────────────────────
const candidates = readJsonl(candidatesPath);
const done = new Set(readJsonl(proposalsPath).map((p) => p.id));
const todo = candidates
  .filter((c) => !done.has(c.id))
  .filter((c) => !onlyIds || onlyIds.includes(c.id))
  .slice(0, limit);
console.log(`label: ${todo.length} to propose (${done.size} already done, model ${MODEL})`);

const labelOne = async (c) => {
  const bundle = gatherEvidence(c);
  // defense in depth: modeled secrets/paths never reach the judge at all — redaction is
  // semantics-neutral for labeling, and finalize's scrub stays the committed-output gate
  const input = scrub(buildInput(c, bundle));
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await execJudgeAsync({
      label: `edge-cases-label:${c.id}`,
      args: ['-p', '--model', MODEL, ...JUDGE_READ_ONLY, ...JUDGE_ISOLATION, PROMPT],
      input,
      timeout: 240000,
      cwd: here,
    });
    if (raw === null) return null;
    try {
      const proposal = parseProposal(raw);
      const findings = (proposal.findings ?? []).map((f, idx) => ({
        idx: idx + 1,
        ...f,
        evidence: { ...(f.evidence ?? {}), reviewed: false },
      }));
      // whitelist the judge's contribution — a reply must never overwrite harvested provenance
      // (repo/source/diffFull/…), or a transcript-influenced answer could e.g. forge an
      // allowlisted repo and publish a non-allowlisted excerpt downstream
      return {
        ...c,
        summary: proposal.summary,
        degenerate: proposal.degenerate,
        degenerateReason: proposal.degenerateReason ?? null,
        findings,
        labelModel: MODEL,
      };
    } catch {
      // malformed JSON — one retry, then give up on this case
    }
  }
  console.error(`label: ${c.id} — unparseable reply twice, skipped`);
  return null;
};

let failed = 0;
for (let i = 0; i < todo.length; i += CONCURRENCY) {
  const batch = todo.slice(i, i + CONCURRENCY);
  const results = await Promise.all(batch.map(labelOne));
  for (const r of results) {
    if (!r) {
      failed++;
      continue;
    }
    appendFileSync(proposalsPath, `${JSON.stringify(r)}\n`);
  }
  console.log(`label: ${Math.min(i + CONCURRENCY, todo.length)}/${todo.length} processed`);
}
console.log(`label: done (${failed} failed — rerun to retry those)`);
