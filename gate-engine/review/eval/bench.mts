#!/usr/bin/env node

/**
 * completeness-eval: accuracy benchmark for the automated completeness gate.
 *
 * The executable stays intentionally orchestration-only. Corpus/fixture construction, paid case
 * execution, scoring, identity, and baseline audit live in cohesive sibling modules so the shipped
 * size ratchet remains an architectural boundary rather than a raised threshold.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BenchAbort, cleanBenchEnv } from '../../decisions/eval/bench.mts';
import { resolveGuardConfig, type GuardConfig } from '../../config.mts';
import { judgeBinForModel } from '../../judge/codex/result.mts';
import type { SlotOutcome } from '../../judge/matcher-core.mts';
import { resolveEscalationModel } from '../reviewers.mts';
import {
  type AuditCheckpointValue,
  completenessAuditInputHash,
  completenessBaselineEligibility,
  matcherAudit,
  reusableAuditCheckpoint,
  runIndependentMatcherAudit,
  writeCompletenessBaseline,
} from './baseline-audit.mts';
import {
  AGENT_MD,
  AGENTS_DIR,
  auditLabelsPath,
  baselinePath,
  here,
  LEGACY_AUDIT_REVIEWER_MODEL,
  MATCH_CONCURRENCY,
  MATCH_MODEL,
  MATCH_RUNS,
  transcriptPath,
} from './benchmark-config.mts';
import {
  applyRetryEvidence,
  caseCheckpointIsReusable,
  type CaseCheckpointValue,
  type CaseResult,
  cleanupActiveFixture,
  type MatcherCheckpointValue,
  type ReviewerCheckpointValue,
  consistentReviewerModel,
  reusableCaseCheckpoint,
  reusableCaseCheckpointForRow,
  reusableMatcherCheckpoint,
  reusableReviewerCheckpoint,
  runCase,
} from './case-runner.mts';
import {
  acquireCompletenessProgressLock,
  installProgressLockTerminationHandlers,
  openCheckpointStore,
  resetCompletenessProgress,
} from './checkpoint.mts';
import {
  completenessAuditCheckpointIdentity,
  completenessCaseCheckpointIdentity,
  completenessCaseInputHash,
  completenessMatcherCheckpointIdentity,
  completenessMatcherInputHash,
  completenessReviewerCheckpointIdentity,
  gateHash,
  matcherHash,
  retryBaselineFingerprint,
  sha12,
} from './benchmark-identity.mts';
import {
  type CompletenessCase,
  completenessFixtureCapabilityFingerprint,
  lintCases,
  loadCases,
  materializeCompletenessFixture,
} from './cases.mts';
import { parseFindings, SEVERITIES } from './matcher.mts';
import {
  type BenchSummary,
  CEILING_FALSE_FLAG,
  compareCompleteness,
  FLOOR_GAP_RECALL,
  fmtCi,
  summarize,
  variantConsistency,
} from './scoring.mts';
import { completenessSlotKey } from './variant-consistency.mts';

export {
  type AuditCheckpointValue,
  type BenchSummary,
  type CaseCheckpointValue,
  type CaseResult,
  CEILING_FALSE_FLAG,
  type CompletenessCase,
  FLOOR_GAP_RECALL,
  type MatcherCheckpointValue,
  type ReviewerCheckpointValue,
  applyRetryEvidence,
  completenessAuditCheckpointIdentity,
  completenessAuditInputHash,
  completenessBaselineEligibility,
  completenessCaseCheckpointIdentity,
  completenessCaseInputHash,
  completenessFixtureCapabilityFingerprint,
  completenessMatcherCheckpointIdentity,
  completenessMatcherInputHash,
  completenessReviewerCheckpointIdentity,
  completenessSlotKey,
  compareCompleteness,
  consistentReviewerModel,
  lintCases,
  matcherAudit,
  materializeCompletenessFixture,
  reusableAuditCheckpoint,
  reusableCaseCheckpoint,
  reusableCaseCheckpointForRow,
  reusableMatcherCheckpoint,
  reusableReviewerCheckpoint,
  runCase,
  runIndependentMatcherAudit,
  summarize,
  variantConsistency,
  writeCompletenessBaseline,
};

function appendLedger(entry: object) {
  try {
    appendFileSync(path.join(here, 'runs.log'), `${JSON.stringify(entry)}\n`);
  } catch {
    // The ledger is telemetry; never let it break a run.
  }
}

function preflightJudge(role: 'reviewer' | 'matcher', model: string) {
  const bin = judgeBinForModel(model);
  try {
    execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 30000 });
  } catch {
    throw new BenchAbort(
      2,
      `completeness-eval: ${role} model ${model} requires \`${bin}\`, but that CLI is not available`,
    );
  }
}

function configuredReviewerModel(config: GuardConfig): string {
  return resolveEscalationModel(config);
}

/** Budget from remaining paid work, printed BEFORE any token is spent. */
function printEstimate(
  reviewerCalls: number,
  matcherSlots: number,
  matchRuns: number,
  remainingAuditSlots = 0,
) {
  const revLo = reviewerCalls * 60;
  const revHi = reviewerCalls * 360; // OBSERVED spread, not the cap (that would print ~5× the spend)
  const matcher = Math.round((matcherSlots * matchRuns * 15) / MATCH_CONCURRENCY);
  const audit = Math.round((remainingAuditSlots * 15) / MATCH_CONCURRENCY);
  console.log(
    `completeness-eval: budget ≈ ${Math.round((revLo + matcher + audit) / 60)}–${Math.round((revHi + matcher + audit) / 60)} min  ` +
      `(${reviewerCalls} remaining reviewer calls × 60–360s · ${matcherSlots} remaining slots × K=${matchRuns} matcher ÷ pool ${MATCH_CONCURRENCY}` +
      (remainingAuditSlots
        ? ` · ${remainingAuditSlots} remaining current slots × K=1 independent audit ÷ pool ${MATCH_CONCURRENCY}`
        : '') +
      ' · + one case re-run per baseline-discordant case)',
  );
}

/** Coverage matrix (zero judge calls). Cells a category cannot populate are n/a, not debt:
 * clean-complete rows have gold:[] by construction, so their severity cells are structural. */
function printCoverage(rows: CompletenessCase[]) {
  console.log(`── completeness (${rows.length} rows) ──`);
  const cells: Record<string, number> = {};
  const tag: {
    provenance: Record<string, number>;
    holdout: number;
    variants: number;
    decoyKinds: Record<string, number>;
  } = {
    provenance: {},
    holdout: 0,
    variants: 0,
    decoyKinds: {},
  };
  for (const r of rows) {
    const sevs = r.gold.length
      ? [...new Set(r.gold.map((g) => g.severity))]
      : ['(no gold — control)'];
    for (const sev of sevs) {
      const key = `${r.category.padEnd(26)} ${sev.padEnd(22)} ${r.difficulty ?? 'unset'}`;
      cells[key] = (cells[key] ?? 0) + 1;
    }
    const p = r.provenance ?? 'authored';
    tag.provenance[p] = (tag.provenance[p] ?? 0) + 1;
    if (r.holdout) tag.holdout += 1;
    if (r.variantOf) tag.variants += 1;
    for (const d of r.decoys) tag.decoyKinds[d.kind] = (tag.decoyKinds[d.kind] ?? 0) + 1;
  }
  console.log(`  ${'category'.padEnd(26)} ${'gold severity'.padEnd(22)} difficulty  rows`);
  for (const key of Object.keys(cells).sort()) console.log(`  ${key}  ${cells[key]}`);
  console.log(
    `  provenance: ${Object.entries(tag.provenance)
      .map(([k, v]) => `${k}=${v}`)
      .join(
        ' ',
      )} · holdout=${tag.holdout} · variant rows=${tag.variants} · decoys: ${Object.entries(
      tag.decoyKinds,
    )
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`,
  );
  const unset = rows.filter((r) => !r.difficulty).length;
  if (unset) console.log(`  COVERAGE DEBT: ${unset} row(s) missing a difficulty tag`);
}

async function main(argv: string[]) {
  const args = new Set(argv);
  const writeBaseline = args.has('--baseline');
  const failOnRegression = args.has('--fail');
  const devOnly = args.has('--dev');
  const fresh = args.has('--fresh');
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx !== -1 ? argv[onlyIdx + 1] : null;

  // Capture the consumer's effective file/env configuration before benchmark hygiene strips
  // GUARD_*/FRINK_* from the synthetic repositories and judge processes.
  const consumerConfig = resolveGuardConfig(process.cwd());
  const stripped = cleanBenchEnv();
  // cleanBenchEnv covers GUARD_*/FRINK_* + the six repo-corruption GIT vars; these two reshape
  // fixture `git init/commit` through global config and must go too.
  for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'])
    if (process.env[k] !== undefined) {
      delete process.env[k];
      stripped.push(k);
    }
  process.env.DECISIONS_NO_EMBED = '1'; // belt-and-braces: fixtures ship no INDEX.md anyway
  if (stripped.length)
    console.log(`completeness-eval: stripped env for a clean run: ${stripped.join(', ')}`);

  let rows = loadCases();

  if (args.has('coverage')) {
    printCoverage(rows);
    process.exit(0);
  }
  if (args.has('matcher-audit')) {
    if (!existsSync(auditLabelsPath))
      throw new BenchAbort(
        2,
        `completeness-eval: no ${path.basename(auditLabelsPath)} — label a held sample first`,
      );
    const res = matcherAudit(
      readFileSync(auditLabelsPath, 'utf8'),
      (caseId) => {
        const f = transcriptPath(caseId);
        return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
      },
      LEGACY_AUDIT_REVIEWER_MODEL,
    );
    console.log(
      `matcher-audit: agreement ${fmtCi(res.agree, res.n)} · Cohen's κ ${res.kappa.toFixed(3)}`,
    );
    if (res.missing.length)
      console.log(
        `  ${res.missing.length} labelled slot(s) missing a transcript (stale labels or no run yet): [${res.missing.join(', ')}]`,
      );
    console.log(
      res.kappa >= 0.7
        ? '  κ ≥ 0.7 — matcher trusted'
        : '  κ < 0.7 — MATCHER NOT TRUSTED: fix matcher.mts before reading headline metrics',
    );
    process.exit(0);
  }

  if (devOnly && (writeBaseline || failOnRegression))
    throw new BenchAbort(
      2,
      'completeness-eval: --dev excludes holdout rows — not valid with --baseline/--fail',
    );
  if (only && (writeBaseline || failOnRegression))
    throw new BenchAbort(
      2,
      'completeness-eval: --only is an iteration subset — not valid with --baseline/--fail',
    );
  if (devOnly) rows = rows.filter((r) => !r.holdout);
  if (only) rows = rows.filter((r) => r.id.startsWith(only));
  if (!rows.length) throw new BenchAbort(2, 'completeness-eval: no rows after filtering');

  const releaseProgressLock = acquireCompletenessProgressLock();
  installProgressLockTerminationHandlers(releaseProgressLock, cleanupActiveFixture);

  if (consumerConfig.noLlm)
    throw new BenchAbort(2, 'completeness-eval: noLlm is enabled — the gate cannot be measured');
  const expectedReviewerModel = configuredReviewerModel(consumerConfig);
  preflightJudge('reviewer', expectedReviewerModel);
  preflightJudge('matcher', MATCH_MODEL);
  if (!existsSync(AGENT_MD))
    throw new BenchAbort(2, `completeness-eval: ${AGENT_MD} missing — nothing to measure`);
  if (fresh) {
    resetCompletenessProgress();
    console.log('completeness-eval: cleared durable progress (--fresh)');
  }

  const expectedMcpCapabilityFingerprint = completenessFixtureCapabilityFingerprint(
    rows[0],
    AGENTS_DIR,
    consumerConfig,
  );
  const gh = gateHash(expectedMcpCapabilityFingerprint);
  const mh = matcherHash();
  const corpusHash = sha12(JSON.stringify(rows));
  const baseline: { completeness?: BenchSummary } = existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, 'utf8'))
    : {};
  const retryAgainst =
    baseline.completeness?.reviewerModel === expectedReviewerModel &&
    baseline.completeness.mcpCapabilityFingerprint === expectedMcpCapabilityFingerprint &&
    baseline.completeness.matchModel === MATCH_MODEL &&
    baseline.completeness.matchRuns === MATCH_RUNS &&
    baseline.completeness.gateHash === gh &&
    baseline.completeness.matcherHash === mh &&
    baseline.completeness.corpusHash === corpusHash
      ? baseline.completeness
      : null;

  const caseCheckpoint = openCheckpointStore<CaseCheckpointValue>({
    kind: 'case',
    identity: completenessCaseCheckpointIdentity({
      reviewerModel: expectedReviewerModel,
      mcpCapabilityFingerprint: expectedMcpCapabilityFingerprint,
      retryBaselineHash: retryBaselineFingerprint(retryAgainst),
      noLlm: consumerConfig.noLlm,
    }),
    decode: (value) => reusableCaseCheckpoint(value, expectedReviewerModel),
    accept: (value) => caseCheckpointIsReusable(value, expectedReviewerModel),
  });
  const reviewerCheckpoint = openCheckpointStore<ReviewerCheckpointValue>({
    kind: 'reviewer',
    identity: completenessReviewerCheckpointIdentity(
      expectedReviewerModel,
      expectedMcpCapabilityFingerprint,
      consumerConfig.noLlm,
    ),
    decode: (value) =>
      reusableReviewerCheckpoint(value, expectedReviewerModel, expectedMcpCapabilityFingerprint),
  });
  const matcherCheckpoint = openCheckpointStore<MatcherCheckpointValue>({
    kind: 'matcher',
    identity: completenessMatcherCheckpointIdentity(),
    decode: reusableMatcherCheckpoint,
    accept: (value) => !value.outcome.outage,
  });
  const auditCheckpoint = openCheckpointStore<AuditCheckpointValue>({
    kind: 'audit',
    identity: completenessAuditCheckpointIdentity(
      expectedReviewerModel,
      expectedMcpCapabilityFingerprint,
    ),
    decode: reusableAuditCheckpoint,
    accept: (value) => !value.outcome.outage,
  });
  const savedById = new Map<string, CaseCheckpointValue>();
  for (const row of rows) {
    const saved = caseCheckpoint.take(
      row.id,
      completenessCaseInputHash(row, expectedMcpCapabilityFingerprint),
    );
    if (reusableCaseCheckpointForRow(saved, row, expectedReviewerModel))
      savedById.set(row.id, saved);
  }
  const needsRetry = (row: CompletenessCase, result: CaseResult): boolean => {
    const prior = retryAgainst?.rows?.[row.id];
    if (!prior || result.outage || !result.score) return false;
    const caseOk = result.score.slots.every((slot) => slot.outage || slot.ok);
    return caseOk !== prior.ok;
  };
  type ReviewerPhase = 'primary' | 'retry';
  const reviewerPhaseKey = (row: CompletenessCase, phase: ReviewerPhase) => `${row.id}::${phase}`;
  const savedReviewer = (row: CompletenessCase, phase: ReviewerPhase) =>
    reviewerCheckpoint.take(
      reviewerPhaseKey(row, phase),
      completenessCaseInputHash(row, expectedMcpCapabilityFingerprint),
    );
  const runCheckpointedCase = (
    row: CompletenessCase,
    phase: ReviewerPhase,
    saveTranscript = true,
  ) => {
    const inputHash = completenessCaseInputHash(row, expectedMcpCapabilityFingerprint);
    const key = reviewerPhaseKey(row, phase);
    return runCase(row, {
      saveTranscript,
      reviewerResume: reviewerCheckpoint.take(key, inputHash),
      onReviewerComplete: (value) => reviewerCheckpoint.record(key, inputHash, value),
      matcherCheckpoint,
      expectedCapabilityFingerprint: expectedMcpCapabilityFingerprint,
      consumerConfig,
    });
  };
  const expectedSlots = (row: CompletenessCase) => [
    ...row.gold.map((slot) => ({ id: slot.id, kind: 'gold' as const })),
    ...row.decoys.map((slot) => ({ id: slot.id, kind: 'decoy' as const })),
  ];
  const outcomeMatches = (
    outcome: SlotOutcome | undefined,
    expected: { id: string; kind: 'gold' | 'decoy' },
    findingCount: number,
  ) =>
    outcome?.slotId === expected.id &&
    outcome.kind === expected.kind &&
    !outcome.outage &&
    Number.isInteger(outcome.match) &&
    outcome.match >= 0 &&
    outcome.match <= findingCount;
  const matcherWorkRemaining = (
    row: CompletenessCase,
    reviewer: ReviewerCheckpointValue | undefined,
  ) => {
    const slots = expectedSlots(row);
    if (!reviewer) return slots.length;
    const findings = parseFindings(reviewer.raw).findings;
    if (!findings.length) return 0;
    const inputHash = completenessMatcherInputHash(row, findings);
    return slots.filter((slot) => {
      const saved = matcherCheckpoint.take(completenessSlotKey(row.id, slot.id), inputHash);
      return !outcomeMatches(saved?.outcome, slot, findings.length);
    }).length;
  };
  let remainingReviewerCalls = 0;
  let remainingMatcherSlots = 0;
  const savedMatcherSlotKeys = new Set<string>();
  for (const row of rows) {
    const saved = savedById.get(row.id);
    if (!saved) {
      const reviewer = savedReviewer(row, 'primary');
      if (!reviewer) remainingReviewerCalls += 1;
      remainingMatcherSlots += matcherWorkRemaining(row, reviewer);
    } else if (!saved.retryComplete && needsRetry(row, saved.result)) {
      const reviewer = savedReviewer(row, 'retry');
      if (!reviewer) remainingReviewerCalls += 1;
      remainingMatcherSlots += matcherWorkRemaining(row, reviewer);
    }
    for (const phase of ['primary', 'retry'] as const) {
      const reviewer = savedReviewer(row, phase);
      if (!reviewer) continue;
      const findings = parseFindings(reviewer.raw).findings;
      const inputHash = completenessMatcherInputHash(row, findings);
      for (const slot of expectedSlots(row)) {
        const matcherSaved = matcherCheckpoint.take(
          completenessSlotKey(row.id, slot.id),
          inputHash,
        );
        if (outcomeMatches(matcherSaved?.outcome, slot, findings.length))
          savedMatcherSlotKeys.add(JSON.stringify([row.id, slot.id, inputHash]));
      }
    }
  }
  let remainingAuditSlots = 0;
  let savedAuditSlots = 0;
  if (writeBaseline) {
    for (const row of rows) {
      const saved = savedById.get(row.id);
      const total = row.gold.length + row.decoys.length;
      if (!saved?.result.findings) {
        remainingAuditSlots += total;
        continue;
      }
      const inputHash = completenessAuditInputHash(row, saved.result);
      remainingAuditSlots += expectedSlots(row).filter((slot) => {
        const key = completenessSlotKey(row.id, slot.id);
        const savedAudit = auditCheckpoint.take(key, inputHash);
        const prefixed = { ...slot, id: key };
        const matches = outcomeMatches(
          savedAudit?.outcome,
          prefixed,
          saved.result.findings!.length,
        );
        if (matches) savedAuditSlots += 1;
        return !matches;
      }).length;
    }
  }
  const savedReviewerCount = rows.reduce(
    (count, row) =>
      count +
      Number(Boolean(savedReviewer(row, 'primary'))) +
      Number(Boolean(savedReviewer(row, 'retry'))),
    0,
  );
  if (savedById.size || savedReviewerCount || savedMatcherSlotKeys.size || savedAuditSlots)
    console.log(
      `completeness-eval: durable progress — ${savedById.size}/${rows.length} complete case(s), ${savedReviewerCount} reviewer response(s), ${savedMatcherSlotKeys.size} matcher slot(s), ${savedAuditSlots} audit slot(s)`,
    );
  printEstimate(remainingReviewerCalls, remainingMatcherSlots, MATCH_RUNS, remainingAuditSlots);

  const results: CaseResult[] = [];
  const observedReviewerRuns: CaseResult[] = [];
  let retryCaseOutages = 0;
  let retrySlotOutages = 0;
  for (const row of rows) {
    const inputHash = completenessCaseInputHash(row, expectedMcpCapabilityFingerprint);
    const saved = savedById.get(row.id);
    const res = saved?.result ?? (await runCheckpointedCase(row, 'primary'));
    observedReviewerRuns.push(res);
    // Alignment convention: a case whose outcome disagrees with the baseline re-runs ONCE.
    // 1-of-2 disagreement = instability (never a counted flip); 2-of-2 = a real flip.
    const retryRequired = needsRetry(row, res);
    if (
      !saved &&
      caseCheckpointIsReusable(
        { result: res, retryComplete: !retryRequired },
        expectedReviewerModel,
      )
    )
      caseCheckpoint.record(row.id, inputHash, { result: res, retryComplete: !retryRequired });
    if (retryRequired && !saved?.retryComplete) {
      // Persist the paid primary before the retry. A kill during the retry resumes from this phase
      // boundary instead of paying for the primary reviewer and matcher a second time.
      if (caseCheckpointIsReusable({ result: res, retryComplete: false }, expectedReviewerModel))
        caseCheckpoint.record(row.id, inputHash, { result: res, retryComplete: false });
      console.log(`  ${row.id.padEnd(34)} …disagrees with baseline — retrying once`);
      const res2 = await runCheckpointedCase(row, 'retry', false);
      observedReviewerRuns.push(res2);
      const retryEvidence = applyRetryEvidence(res, res2);
      retryCaseOutages += retryEvidence.caseOutages;
      retrySlotOutages += retryEvidence.slotOutages;
      if (
        retryEvidence.caseOutages === 0 &&
        retryEvidence.slotOutages === 0 &&
        res2.reviewerModel === expectedReviewerModel &&
        caseCheckpointIsReusable({ result: res, retryComplete: true }, expectedReviewerModel)
      )
        caseCheckpoint.record(row.id, inputHash, { result: res, retryComplete: true });
    }
    results.push(res);
    if (res.outage) console.log(`  ${row.id.padEnd(34)} OUTAGE (reviewer dark — row excluded)`);
    else if (res.score) {
      const sc = res.score;
      const hits = sc.slots.filter((x) => x.kind === 'gold' && x.ok).length;
      const goldN = sc.slots.filter((x) => x.kind === 'gold').length;
      const flagged = sc.slots.filter((x) => x.kind === 'decoy' && !x.ok).length;
      const decoyN = sc.slots.filter((x) => x.kind === 'decoy').length;
      const ok = hits === goldN && flagged === 0;
      console.log(
        `  ${row.id.padEnd(34)} ${ok ? 'OK  ' : 'FAIL'}  gold ${hits}/${goldN} · decoys flagged ${flagged}/${decoyN} · spurious ${sc.spurious.length}` +
          (res.warnings.length ? `  (${res.warnings.join('; ')})` : '') +
          (saved ? '  (checkpoint)' : ''),
      );
    }
  }
  if (results.length && results.every((r) => r.outage))
    throw new BenchAbort(2, 'completeness-eval: every case was an outage');

  const reviewerModel = consistentReviewerModel(observedReviewerRuns);
  if (reviewerModel !== expectedReviewerModel)
    throw new BenchAbort(
      2,
      `completeness-eval: reviewer preflight selected ${expectedReviewerModel}, but judge argv used ${reviewerModel}`,
    );
  const s = summarize(rows, results, { reviewerModel });
  s.mcpCapabilityFingerprint = expectedMcpCapabilityFingerprint;
  s.caseOutages += retryCaseOutages;
  s.slotOutages += retrySlotOutages;
  s.outages = s.caseOutages + s.slotOutages;
  s.gateHash = gh;
  s.matcherHash = mh;
  s.corpusHash = corpusHash;
  const floorsPass = s.gapRecall >= FLOOR_GAP_RECALL && s.falseFlagRate <= CEILING_FALSE_FLAG;
  if (writeBaseline && s.outages === 0 && floorsPass) {
    const audit = await runIndependentMatcherAudit(rows, results, {
      model: reviewerModel,
      checkpoint: auditCheckpoint,
    });
    s.matcherAudit = {
      model: audit.model,
      n: audit.n,
      agree: audit.agree,
      kappa: audit.kappa,
      missing: audit.missing.length,
    };
  }

  console.log(
    `\ncompleteness: ${results.length} case(s)  [matcher=${s.matchModel} K=${s.matchRuns} · reviewer=${s.reviewerModel} K=1]`,
  );
  console.log(
    `  headline: gap recall ${fmtCi(s.gold.hit, s.gold.total)}  (floor ${FLOOR_GAP_RECALL})`,
  );
  console.log(
    `  headline: false-flag rate ${fmtCi(s.decoys.flagged, s.decoys.total)}  (ceiling ${CEILING_FALSE_FLAG})`,
  );
  console.log(
    `    recorded decisions re-litigated: ${fmtCi(s.decoys.recorded.flagged, s.decoys.recorded.total)}`,
  );
  console.log(
    `  finding precision (informational): ${fmtCi(s.findings.matched, s.findings.total)} · spurious/case ${(s.findings.spurious / Math.max(1, s.cases - s.caseOutages)).toFixed(1)}`,
  );
  if (s.severity.total) {
    console.log(
      `  severity calibration (warn tier): exact ${fmtCi(s.severity.exact, s.severity.total)}`,
    );
    for (const want of SEVERITIES)
      if (s.severity.confusion[want])
        console.log(
          `    want ${want.padEnd(10)} → ${Object.entries(s.severity.confusion[want])
            .map(([g, n]) => `${g}=${n}`)
            .join(' ')}`,
        );
  }
  if (s.verdicts.total)
    console.log(`  verdict line (informational): ${fmtCi(s.verdicts.correct, s.verdicts.total)}`);
  if (s.outages)
    console.log(
      `  outages: ${s.caseOutages} case(s) + ${s.slotOutages} slot(s) — score is suspect, rerun before trusting`,
    );
  if (s.matcherAudit)
    console.log(
      `  matcher audit: agreement ${fmtCi(s.matcherAudit.agree, s.matcherAudit.n)} · Cohen's κ ${s.matcherAudit.kappa.toFixed(3)}` +
        (s.matcherAudit.missing ? ` · missing ${s.matcherAudit.missing}` : ''),
    );
  const vc = variantConsistency(rows, s);
  if (vc)
    console.log(
      `  variant consistency: ${vc.consistent}/${vc.total} groups${vc.broken.length ? ` — broken: [${vc.broken.join(', ')}]` : ''}`,
    );

  const { regressed, lines } = compareCompleteness(s, baseline.completeness);
  if (existsSync(baselinePath)) for (const l of lines) console.log(l);

  appendLedger({
    ts: new Date().toISOString(),
    args: [...args],
    reviewerModel: s.reviewerModel,
    mcpCapabilityFingerprint: s.mcpCapabilityFingerprint,
    matchModel: s.matchModel,
    matchRuns: s.matchRuns,
    gateHash: gh,
    matcherHash: mh,
    corpusHash: s.corpusHash,
    cases: s.cases,
    gapRecall: Number(s.gapRecall.toFixed(3)),
    falseFlagRate: Number(s.falseFlagRate.toFixed(3)),
    outages: s.outages,
    matcherAudit: s.matcherAudit,
    regressed,
  });

  if (writeBaseline) {
    writeCompletenessBaseline(baselinePath, baseline, s);
    console.log(`\nwrote baseline → ${path.relative(process.cwd(), baselinePath)}`);
  }
  if (failOnRegression && regressed) {
    console.error(
      '\nFAIL: floor breach or statistically significant one-directional case flips vs baseline.',
    );
    process.exit(1);
  }
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((e) => {
    if (e instanceof BenchAbort) {
      console.error(e.message);
      process.exit(e.code);
    }
    throw e;
  });
}
