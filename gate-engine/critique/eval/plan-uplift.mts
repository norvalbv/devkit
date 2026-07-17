#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { wilson } from '../../decisions/eval/bench.mts';

export interface PlanAssessment {
  residualGoldFlawIds: string[];
  introducedDefectIds: string[];
  completeness: number;
  contractValid: boolean;
  tokens: number;
  latencyMs: number;
}

export interface PlanUpliftObservation {
  schemaVersion: 1;
  caseId: string;
  generatorModelFamily: string;
  criticModelFamily: string;
  critiquePasses: 1 | 2;
  revised: boolean;
  goldFlawIds: string[];
  initial: PlanAssessment;
  refined: PlanAssessment;
}

export interface PlanUpliftArmSummary {
  cases: number;
  outages: number;
  residualGoldFlaws: { initial: number; refined: number; delta: number };
  pairedResidual: { improved: number; worsened: number; tied: number };
  introducedDefects: { initial: number; refined: number; delta: number };
  falseRevisions: RateSummary;
  completeness: { initialMean: number; refinedMean: number; delta: number };
  contractValidity: { initial: RateSummary; refined: RateSummary };
  critiqueCycles: { total: number; mean: number };
  tokens: { initial: number; refined: number; delta: number };
  latencyMs: { initial: number; refined: number; delta: number };
  sameFamilyPairs: number;
}

export interface RateSummary {
  count: number;
  total: number;
  rate: number;
  wilson95: { lo: number; hi: number };
}

const average = (values: number[]): number =>
  values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

const rateSummary = (count: number, total: number): RateSummary => ({
  count,
  total,
  rate: total > 0 ? count / total : 0,
  wilson95: wilson(count, total),
});

function summarizeArm(rows: PlanUpliftObservation[]): PlanUpliftArmSummary {
  const usable = rows.filter(
    (row) => Number.isFinite(row.initial.completeness) && Number.isFinite(row.refined.completeness),
  );
  const initialResidual = usable.reduce(
    (sum, row) => sum + row.initial.residualGoldFlawIds.length,
    0,
  );
  const refinedResidual = usable.reduce(
    (sum, row) => sum + row.refined.residualGoldFlawIds.length,
    0,
  );
  const initialIntroduced = usable.reduce(
    (sum, row) => sum + row.initial.introducedDefectIds.length,
    0,
  );
  const refinedIntroduced = usable.reduce(
    (sum, row) => sum + row.refined.introducedDefectIds.length,
    0,
  );
  let improved = 0;
  let worsened = 0;
  let tied = 0;
  for (const row of usable) {
    const before = row.initial.residualGoldFlawIds.length;
    const after = row.refined.residualGoldFlawIds.length;
    if (after < before) improved++;
    else if (after > before) worsened++;
    else tied++;
  }
  const soundPlans = usable.filter((row) => row.goldFlawIds.length === 0);
  const falseRevisions = soundPlans.filter((row) => row.revised).length;
  const initialCompleteness = average(usable.map((row) => row.initial.completeness));
  const refinedCompleteness = average(usable.map((row) => row.refined.completeness));
  const initialTokens = usable.reduce((sum, row) => sum + row.initial.tokens, 0);
  const refinedTokens = usable.reduce((sum, row) => sum + row.refined.tokens, 0);
  const initialLatency = usable.reduce((sum, row) => sum + row.initial.latencyMs, 0);
  const refinedLatency = usable.reduce((sum, row) => sum + row.refined.latencyMs, 0);
  return {
    cases: usable.length,
    outages: rows.length - usable.length,
    residualGoldFlaws: {
      initial: initialResidual,
      refined: refinedResidual,
      delta: refinedResidual - initialResidual,
    },
    pairedResidual: { improved, worsened, tied },
    introducedDefects: {
      initial: initialIntroduced,
      refined: refinedIntroduced,
      delta: refinedIntroduced - initialIntroduced,
    },
    falseRevisions: rateSummary(falseRevisions, soundPlans.length),
    completeness: {
      initialMean: initialCompleteness,
      refinedMean: refinedCompleteness,
      delta: refinedCompleteness - initialCompleteness,
    },
    contractValidity: {
      initial: rateSummary(usable.filter((row) => row.initial.contractValid).length, usable.length),
      refined: rateSummary(usable.filter((row) => row.refined.contractValid).length, usable.length),
    },
    critiqueCycles: {
      total: usable.reduce((sum, row) => sum + row.critiquePasses, 0),
      mean: average(usable.map((row) => row.critiquePasses)),
    },
    tokens: {
      initial: initialTokens,
      refined: refinedTokens,
      delta: refinedTokens - initialTokens,
    },
    latencyMs: {
      initial: initialLatency,
      refined: refinedLatency,
      delta: refinedLatency - initialLatency,
    },
    sameFamilyPairs: usable.filter((row) => row.generatorModelFamily === row.criticModelFamily)
      .length,
  };
}

export function summarizePlanUplift(rows: PlanUpliftObservation[]): {
  all: PlanUpliftArmSummary;
  onePass: PlanUpliftArmSummary;
  twoPass: PlanUpliftArmSummary;
} {
  return {
    all: summarizeArm(rows),
    onePass: summarizeArm(rows.filter((row) => row.critiquePasses === 1)),
    twoPass: summarizeArm(rows.filter((row) => row.critiquePasses === 2)),
  };
}

function loadObservations(path: string): PlanUpliftObservation[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as PlanUpliftObservation);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node plan-uplift.mts <paired-observations.jsonl>');
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(summarizePlanUplift(loadObservations(path)), null, 2));
  }
}
