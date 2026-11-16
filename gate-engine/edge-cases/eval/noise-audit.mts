#!/usr/bin/env bun

/**
 * sc-1119 label-noise audit (the REQUIRED pre-step before interpreting any bench delta; the
 * kappa.mts pilot measured segmentation only and does NOT count). Blind, finding-level,
 * judgment-axes-only — findings are HANDED to the relabeler (no matching step, so segmentation
 * blindness cannot recur), with the committed labels hidden.
 *
 *   bun noise-audit.mts --sample     draw the stratified n=60 sample + FREEZE evidence bundles (no LLM)
 *   bun noise-audit.mts --run        relabel with opus + gemini (COSTS TOKENS; resume-safe)
 *   bun noise-audit.mts --report     AC1/κ/PABAK tables per axis/stratum + owner adjudication queue
 *   bun noise-audit.mts --epsilon    ε posteriors from raw/noise-audit-adjudication.jsonl → bench
 *
 * Pre-registered design (PREREGISTRATION.md; amendment vs the contract's "uniform 40–60" recorded
 * there): n=60 = ALL anchored liveBug receipts (7) + the 1 anchored-noise finding + 30 over the
 * remaining anchored-WS diff findings + 22 uniform over everything else (per-stratum reporting;
 * the gate reads the diff-decision stratum only). Seed 1119, Fisher-Yates.
 *
 * Two-axis information split (label-leak guard):
 * - VERDICT is relabeled truly blind: the finding's descriptive fields + the SAME anchor view the
 *   judge gets — no evidence bundle, no evidence.detail (detail QUOTES the fix/test and would
 *   hand the answer). This ε drives the recall-denominator perturbation. Documented gap: the
 *   blind view lacks repo/test state, so "duplicate-of-existing-test" noise can't be reproduced —
 *   AC1 understates reliability on noise-heavy strata (the gated stratum has ~1 noise finding).
 * - WASLIVEBUG+TIER is relabeled against a freshly-gathered MECHANICAL bundle (gatherEvidence,
 *   frozen at --sample time to raw/noise-audit-bundles.jsonl) and reported as evidence-grading
 *   reproducibility — never conflated with the blind verdict floor.
 *
 * Gate: Gwet's AC1 ≥ 0.667 on the diff-decision stratum, VERDICT axis, OPUS-vs-committed-gold
 * (gemini = cross-family reproducibility, reported alongside). Single-class NaN κ with high raw
 * agreement is a PASS, never a STOP. Reliability ≠ accuracy: ε comes from OWNER adjudication of
 * the disagreement+flag queue, denominator = the FULL audited stratum (agreements count as
 * correct) → Beta(wrong+1, right+1) per stratum.
 */

import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JUDGE_ISOLATION, JUDGE_READ_ONLY } from '../../judge/judge-isolation.mts';
import { execJudgeAsync } from '../../judge/run-judge.mts';
import { readCases } from './counts.mts';
import { gatherEvidence } from './label.mts';
import { anchorFilesOf, overlapCount } from './lib/match.mts';
import { EVIDENCE_TIERS } from './lib/schema.mts';
import { scrub } from './lib/scrub.mts';
import { cohenKappa, gwetAC1, mulberry32, pabak } from './lib/stats.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const rawDir = path.join(here, 'raw');
const samplePath = path.join(rawDir, 'noise-audit-sample.json');
const bundlesPath = path.join(rawDir, 'noise-audit-bundles.jsonl');
const relabelPath = (model) => path.join(rawDir, `noise-audit.${model}.jsonl`);
const queuePath = path.join(rawDir, 'noise-audit-queue.md');
const adjudicationPath = path.join(rawDir, 'noise-audit-adjudication.jsonl');
const epsilonPath = path.join(rawDir, 'noise-audit-epsilon.json');

export const SEED = 1119;
export const N_ANCHORED_WS = 30;
export const N_GLOBAL = 22;
export const AC1_GATE = 0.667;
const OPUS = 'opus';
// Default: the gemini CLI's own default model (`-m gemini-2.5-pro` hard-errors on this account);
// GEMINI_MODEL overrides when set. CLI v0.16.0 verified answering plainly from a NEUTRAL cwd —
// run from the repo it goes agentic (resumes workspace sessions, attempts tool calls).
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? null;
const GEMINI_CWD = path.join(os.tmpdir(), 'edge-cases-noise-audit-gemini');
const TIMEOUT = 240000;
/** Open evidence window: cases younger than 14 days at audit time — a re-derived bundle can
 * differ from what the original labeler saw (git history moved). Stats report with/without. */
export const DRIFT_CUTOFF = '2026-06-29';

const readJsonl = (file) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

// ── stratified sample (deterministic Fisher-Yates under the pre-registered seed) ─────────────────
export const drawSample = (cases, seed = SEED) => {
  const rng = mulberry32(seed);
  const shuffle = (xs) => {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const receipts = [];
  const anchoredNoise = [];
  const anchoredWSPool = [];
  const globalPool = [];
  for (const c of cases) {
    if (c.degenerate) continue;
    const isDiffBearing = c.anchor.kind === 'diff' && c.findings.length > 0;
    const anchorFiles = isDiffBearing ? anchorFilesOf(c.anchor.nameStatus) : [];
    for (const f of c.findings) {
      const ref = `${c.id}#${f.idx}`;
      const anchored = isDiffBearing && overlapCount(f.files, anchorFiles) > 0;
      const item = { ref, caseId: c.id, idx: f.idx };
      if (anchored && String(f.wasLiveBug) === 'true')
        receipts.push({ ...item, stratum: 'receipts' });
      else if (anchored && f.verdict === 'noise')
        anchoredNoise.push({ ...item, stratum: 'anchored-noise' });
      else if (anchored) anchoredWSPool.push(item);
      else globalPool.push(item);
    }
  }
  const sample = [
    ...receipts,
    ...anchoredNoise,
    ...shuffle(anchoredWSPool)
      .slice(0, N_ANCHORED_WS)
      .map((i) => ({ ...i, stratum: 'anchored-ws' })),
    ...shuffle(globalPool)
      .slice(0, N_GLOBAL)
      .map((i) => ({ ...i, stratum: 'global' })),
  ];
  return {
    sample,
    poolSizes: {
      receipts: receipts.length,
      anchoredNoise: anchoredNoise.length,
      anchoredWS: anchoredWSPool.length,
      global: globalPool.length,
    },
  };
};

/** Diff-decision stratum = everything anchored (the slice the bench decision rides on). */
const isDecisionStratum = (s) => s !== 'global';

// ── relabel prompts (labels HIDDEN; descriptive fields only) ─────────────────────────────────────
const VERDICT_PROMPT = `You are blind-auditing ground-truth labels for an edge-case review benchmark. You get a code change (anchor) and candidate FINDINGS from a historical review of it. Judge each finding INDEPENDENTLY from the anchor alone. Reply ONLY a JSON object, no fences.

For each finding assign:
- "verdict": "worth-surfacing" — a legitimate concern a good reviewer should raise about this change (even if it might turn out to be already handled); OR "noise" — hallucinated, factually wrong about the code shown, or below-severity trivia.
- "flag": "well-formed" | "mis-segmented" (several distinct concerns crammed into one finding, or an incomplete fragment) | "wrong-files" (the files listed do not match what the claim is about) | "not-a-finding" (not an edge-case assertion at all).

Schema: {"labels":[{"ref":"<ref>","verdict":"worth-surfacing|noise","flag":"well-formed|mis-segmented|wrong-files|not-a-finding"}]}
Judge only from the material shown. Do not assume tests or code you cannot see.`;

const LIVEBUG_PROMPT = `You are blind-auditing evidence-grading for an edge-case review benchmark. You get candidate FINDINGS and a MECHANICALLY gathered evidence bundle from the session that produced them. The review prompt COMMANDED the agent to write tests and fix what it raised, so same-session compliance (a test written, a "fixed it" narration, a same-session commit) proves NOTHING by itself. Reply ONLY a JSON object, no fences.

For each finding assign:
- "wasLiveBug": "true" ONLY with independent behavioural evidence you can QUOTE from the bundle — a test run shown FAILING then passing after a fix (tier f2p-in-session), a DIFFERENT later session's commit addressing it (tier independent-fix; postCommits are the same session committing its own work and never qualify), or an explicit user turn validating it (tier user-confirmed). "false" only when the bundle shows the test or behaviour predates this session. Otherwise "unknown" — skepticism is symmetric.
- "tier": ${JSON.stringify(EVIDENCE_TIERS)} — a test that passed on its FIRST run is "test-added-green" with wasLiveBug "unknown".
- "detail": one line quoting the bundle line your call rests on ("" if tier is "none").

Schema: {"labels":[{"ref":"<ref>","wasLiveBug":"true|false|unknown","tier":"...","detail":"..."}]}
Do not invent evidence. Do not use knowledge outside the provided material.`;

// ── input builders ───────────────────────────────────────────────────────────────────────────────
const findingView = (f) =>
  `- ref ${f.ref}\n  claim: ${f.claim}\n  stated: ${f.text}\n  files: ${JSON.stringify(f.files)}\n  category: ${f.category} · severity: ${f.severity}`;

const anchorView = (c) => {
  const a = c.anchor;
  if (a.diffExcerpt) return `DIFF (as the labeler and judge see it):\n${a.diffExcerpt}`;
  return `SESSION SUMMARY (no diff recovered):\n${a.summary}${a.nameStatus ? `\nCHANGED FILES:\n${a.nameStatus}` : ''}`;
};

const bundleText = (bundle) => {
  const budgets = {
    turnTestRuns: 12000,
    turnFilesWritten: 2000,
    aftermathTestRuns: 8000,
    aftermathFilesWritten: 2000,
    userTurnsAfter: 6000,
    postCommits: 4000,
    laterCommits: 4000,
  };
  return Object.entries(bundle)
    .map(([k, v]) => {
      const body = JSON.stringify(v, null, 1);
      const cap = budgets[k] ?? 4000;
      return `-- ${k} --\n${body.length > cap ? `${body.slice(0, cap)}\n…[${k} truncated]` : body}`;
    })
    .join('\n');
};

// ── model runners ────────────────────────────────────────────────────────────────────────────────
const runOpus = (label, prompt, input) =>
  execJudgeAsync({
    label,
    args: ['-p', '--model', OPUS, ...JUDGE_READ_ONLY, ...JUDGE_ISOLATION, prompt],
    input,
    timeout: TIMEOUT,
    cwd: here,
  });

const runGemini = (label, prompt, input) =>
  new Promise((resolve) => {
    mkdirSync(GEMINI_CWD, { recursive: true });
    const child = execFile(
      'gemini',
      GEMINI_MODEL ? ['-m', GEMINI_MODEL, prompt] : [prompt],
      { cwd: GEMINI_CWD, encoding: 'utf8', timeout: TIMEOUT, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout?.trim()) {
          console.error(
            `⚠️  ${label}: gemini unavailable (${err?.code ?? err?.message ?? 'empty'}) — skipped`,
          );
          resolve(null);
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.write(input);
    child.stdin?.end();
  });

const FENCE_OPEN_RE = /^```(?:json)?\s*/i;
const FENCE_CLOSE_RE = /```\s*$/;
const parseLabels = (raw) => {
  const stripped = raw.trim().replace(FENCE_OPEN_RE, '').replace(FENCE_CLOSE_RE, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON');
  const obj = JSON.parse(stripped.slice(start, end + 1));
  if (!Array.isArray(obj.labels)) throw new Error('no labels');
  return obj.labels;
};

// ── agreement reporting ──────────────────────────────────────────────────────────────────────────
export const agreementTable = (pairs) => ({
  n: pairs.length,
  raw: pairs.length
    ? pairs.filter(([a, b]) => String(a) === String(b)).length / pairs.length
    : Number.NaN,
  ac1: gwetAC1(pairs),
  kappa: cohenKappa(pairs),
  pabak: pabak(pairs),
});

const fmt = (t) =>
  `n=${String(t.n).padStart(3)}  raw=${(t.raw * 100).toFixed(1)}%  AC1=${Number.isNaN(t.ac1) ? 'n/a' : t.ac1.toFixed(3)}  κ=${Number.isNaN(t.kappa) ? 'undef' : t.kappa.toFixed(3)}  PABAK=${Number.isNaN(t.pabak) ? 'n/a' : t.pabak.toFixed(3)}`;

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const cases = readCases();
  if (!cases.length) {
    console.error('noise-audit: no corpus');
    process.exit(2);
  }
  const byId = new Map(cases.map((c) => [c.id, c]));
  const findingOf = (item) => byId.get(item.caseId)?.findings.find((f) => f.idx === item.idx);

  if (has('--sample')) {
    const { sample, poolSizes } = drawSample(cases);
    const candidates = readJsonl(path.join(rawDir, 'candidates.jsonl'));
    const candById = new Map(candidates.map((c) => [c.id, c]));
    const bundles = [];
    for (const caseId of new Set(sample.map((s) => s.caseId))) {
      const cand = candById.get(caseId);
      if (!cand) {
        console.error(
          `noise-audit: no candidate bundle for ${caseId} (wasLiveBug axis will lack it)`,
        );
        continue;
      }
      bundles.push({ caseId, bundle: gatherEvidence(cand), frozenAt: new Date().toISOString() });
    }
    writeFileSync(samplePath, `${JSON.stringify({ seed: SEED, sample, poolSizes }, null, 2)}\n`);
    writeFileSync(bundlesPath, `${bundles.map((b) => scrub(JSON.stringify(b))).join('\n')}\n`);
    const strata = {};
    for (const s of sample) strata[s.stratum] = (strata[s.stratum] ?? 0) + 1;
    console.log(
      `noise-audit: sample n=${sample.length} (${JSON.stringify(strata)}), pools ${JSON.stringify(poolSizes)}, bundles frozen for ${bundles.length} cases`,
    );
    process.exit(0);
  }

  const { sample } = JSON.parse(readFileSync(samplePath, 'utf8'));

  if (has('--run')) {
    const bundles = new Map(readJsonl(bundlesPath).map((b) => [b.caseId, b.bundle]));
    const byCase = new Map();
    for (const item of sample) {
      byCase.set(item.caseId, [...(byCase.get(item.caseId) ?? []), item]);
    }
    // Default relabeler: opus via `claude -p` (subscription — owner cost directive 2026-07-13).
    // Gemini (cross-family) is OPT-IN via --with-gemini, on the CLI's DEFAULT model (never the
    // legacy gemini-2.5-pro); without it the family gap is a documented limitation.
    const models = argv.includes('--with-gemini') ? ['opus', 'gemini'] : ['opus'];
    for (const model of models) {
      const outPath = relabelPath(model);
      const done = new Set(readJsonl(outPath).map((r) => `${r.ref}·${r.axis}`));
      const run = model === 'opus' ? runOpus : runGemini;
      for (const [caseId, items] of byCase) {
        const row = byId.get(caseId);
        const findings = items
          .map((it) => ({ ...findingOf(it), ref: it.ref }))
          .filter((f) => f.claim);
        for (const axis of ['verdict', 'wasLiveBug']) {
          const todo = findings.filter((f) => !done.has(`${f.ref}·${axis}`));
          if (!todo.length) continue;
          if (axis === 'wasLiveBug' && !bundles.has(caseId)) continue;
          const input =
            axis === 'verdict'
              ? `=== ANCHOR ===\n${anchorView(row)}\n\n=== FINDINGS TO AUDIT ===\n${todo.map(findingView).join('\n')}`
              : `=== FINDINGS TO AUDIT ===\n${todo.map(findingView).join('\n')}\n\n=== EVIDENCE BUNDLE (mechanically gathered — the ONLY citable material) ===\n${bundleText(bundles.get(caseId))}`;
          const prompt = axis === 'verdict' ? VERDICT_PROMPT : LIVEBUG_PROMPT;
          const raw = await run(`noise-audit:${model}:${caseId}:${axis}`, prompt, scrub(input));
          if (raw === null) continue;
          try {
            const labels = parseLabels(raw);
            const lines = labels
              .filter((l) => todo.some((f) => f.ref === l.ref))
              .map((l) => JSON.stringify({ ...l, axis, model }));
            if (lines.length) appendFileSync(outPath, `${lines.join('\n')}\n`);
          } catch {
            console.error(
              `noise-audit: unparseable ${model} reply for ${caseId}:${axis} — rerun to retry`,
            );
          }
        }
      }
      console.log(`noise-audit: ${model} pass complete → ${outPath}`);
    }
    process.exit(0);
  }

  if (has('--report')) {
    const gold = new Map(
      sample.map((it) => {
        const f = findingOf(it);
        return [
          it.ref,
          {
            verdict: f?.verdict,
            wasLiveBug: String(f?.wasLiveBug),
            stratum: it.stratum,
            caseId: it.caseId,
          },
        ];
      }),
    );
    const driftCases = new Set(
      cases.filter((c) => Date.parse(c.date) > Date.parse(DRIFT_CUTOFF)).map((c) => c.id),
    );
    const queue = [];
    let gatePassed = null;
    for (const model of ['opus', 'gemini']) {
      const rel = readJsonl(relabelPath(model));
      if (!rel.length) {
        console.log(`\n── ${model}: no relabels yet`);
        continue;
      }
      console.log(`\n── ${model} vs committed gold`);
      for (const axis of ['verdict', 'wasLiveBug']) {
        const pairsAll = [];
        const pairsDecision = [];
        const pairsGlobal = [];
        const pairsNoDrift = [];
        for (const r of rel.filter((r) => r.axis === axis)) {
          const g = gold.get(r.ref);
          if (!g) continue;
          const pair = [
            axis === 'verdict' ? g.verdict : g.wasLiveBug,
            axis === 'verdict' ? r.verdict : r.wasLiveBug,
          ];
          pairsAll.push(pair);
          (isDecisionStratum(g.stratum) ? pairsDecision : pairsGlobal).push(pair);
          if (axis === 'wasLiveBug' && !driftCases.has(g.caseId)) pairsNoDrift.push(pair);
          if (String(pair[0]) !== String(pair[1]))
            queue.push({
              ref: r.ref,
              model,
              axis,
              gold: pair[0],
              relabel: pair[1],
              stratum: g.stratum,
            });
          if (axis === 'verdict' && r.flag && r.flag !== 'well-formed')
            queue.push({
              ref: r.ref,
              model,
              axis: 'flag',
              gold: 'well-formed',
              relabel: r.flag,
              stratum: g.stratum,
            });
        }
        console.log(`  ${axis.padEnd(10)} all      ${fmt(agreementTable(pairsAll))}`);
        console.log(`  ${axis.padEnd(10)} decision ${fmt(agreementTable(pairsDecision))}`);
        console.log(`  ${axis.padEnd(10)} global   ${fmt(agreementTable(pairsGlobal))}`);
        if (axis === 'wasLiveBug')
          console.log(
            `  ${axis.padEnd(10)} no-drift ${fmt(agreementTable(pairsNoDrift))} (evidence-window drift excluded)`,
          );
        if (model === 'opus' && axis === 'verdict') {
          const t = agreementTable(pairsDecision);
          // the GATE: AC1 on the decision stratum; single-class NaN with high raw agreement = PASS
          gatePassed = Number.isNaN(t.ac1) ? t.raw >= 0.9 : t.ac1 >= AC1_GATE;
        }
      }
    }
    const dedup = [...new Map(queue.map((q) => [`${q.ref}·${q.axis}·${q.model}`, q])).values()];
    writeFileSync(
      queuePath,
      [
        '# noise-audit owner adjudication queue',
        '',
        'For each line decide who is right and append to raw/noise-audit-adjudication.jsonl:',
        '{"ref":"<ref>","axis":"verdict|wasLiveBug|flag","correct":"gold|relabel|other","note":"..."}',
        '',
        ...dedup.map(
          (q) =>
            `- [ ] ${q.ref} · ${q.axis} (${q.stratum}, ${q.model}): gold=${q.gold} vs relabel=${q.relabel}`,
        ),
      ]
        .join('\n')
        .concat('\n'),
    );
    console.log(`\nqueue: ${dedup.length} disagreement/flag items → ${queuePath}`);
    console.log(
      gatePassed == null
        ? 'GATE: not evaluable yet (no opus verdict relabels)'
        : gatePassed
          ? `GATE: PASS (opus verdict AC1 ≥ ${AC1_GATE} on the decision stratum)`
          : `GATE: FAIL — STOP; owner inspects for information-gap artifacts before any re-audit pivot`,
    );
    process.exit(gatePassed === false ? 1 : 0);
  }

  if (has('--epsilon')) {
    const adjudications = readJsonl(adjudicationPath);
    if (!adjudications.length) {
      console.error(
        'noise-audit --epsilon: raw/noise-audit-adjudication.jsonl is empty — owner adjudication pending',
      );
      process.exit(2);
    }
    const strata = { diffDecision: { wrong: 0, total: 0 }, global: { wrong: 0, total: 0 } };
    const adjByRef = new Map(adjudications.map((a) => [`${a.ref}·${a.axis}`, a]));
    for (const it of sample) {
      const key = isDecisionStratum(it.stratum) ? 'diffDecision' : 'global';
      strata[key].total++;
      // adjudicated-wrong on the verdict axis or a flag adjudicated against gold = a label error;
      // agreements (never queued) and gold-upheld disagreements count correct
      const v = adjByRef.get(`${it.ref}·verdict`);
      const fl = adjByRef.get(`${it.ref}·flag`);
      if (v?.correct === 'relabel' || v?.correct === 'other' || fl?.correct === 'relabel')
        strata[key].wrong++;
    }
    const out = Object.fromEntries(
      Object.entries(strata).map(([k, s]) => [
        k,
        { alpha: s.wrong + 1, beta: s.total - s.wrong + 1, wrong: s.wrong, total: s.total },
      ]),
    );
    writeFileSync(epsilonPath, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`noise-audit: ε posteriors → ${epsilonPath} ${JSON.stringify(out)}`);
    process.exit(0);
  }

  console.error('noise-audit: pass --sample | --run | --report | --epsilon');
  process.exit(2);
}
