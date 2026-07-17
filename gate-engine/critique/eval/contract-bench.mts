import { readFileSync } from 'node:fs';
import { parsePlanCritiqueResponse } from '../contract.mts';

export interface ContractRunOutcome {
  jsonContractValid: boolean;
  edgeCasesValid: boolean;
  noFlowId: boolean;
  repositoryUnchanged: boolean | null;
  providerArtifactsAbsent: boolean | null;
}

interface ContractCase {
  id: string;
  livePrompt?: string;
  expectedStatus?: string;
}

export function scoreContractResponse(
  raw: string,
  repositoryEffectsKnowable: boolean,
  effects: {
    repositoryUnchanged?: boolean | null;
    providerArtifactsAbsent?: boolean | null;
  },
): ContractRunOutcome {
  const contract = parsePlanCritiqueResponse(raw);
  const exactObject =
    contract.exactResponse && typeof contract.exactResponse === 'object'
      ? (contract.exactResponse as Record<string, unknown>)
      : null;
  return {
    jsonContractValid: contract.state === 'valid',
    edgeCasesValid: Boolean(
      contract.state === 'valid' &&
        exactObject &&
        Array.isArray((exactObject as { edgeCases?: unknown }).edgeCases),
    ),
    noFlowId: Boolean(
      contract.state === 'valid' &&
        exactObject &&
        !Object.hasOwn(exactObject, 'flowId') &&
        !Object.hasOwn(exactObject, 'EDGE_CASES_ID'),
    ),
    repositoryUnchanged: repositoryEffectsKnowable ? (effects.repositoryUnchanged ?? false) : null,
    providerArtifactsAbsent: repositoryEffectsKnowable
      ? (effects.providerArtifactsAbsent ?? false)
      : null,
  };
}

export function nullableMajority(values: Array<boolean | null>): boolean | null {
  const known = values.filter((value): value is boolean => value !== null);
  if (known.length === 0) return null;
  return known.filter(Boolean).length * 2 > known.length;
}

export function summarizeContract(
  rows: Array<{ contract: ContractRunOutcome | null }>,
): Record<string, { ok: number; total: number }> {
  const keys = [
    'jsonContractValid',
    'edgeCasesValid',
    'noFlowId',
    'repositoryUnchanged',
    'providerArtifactsAbsent',
  ] as const;
  return Object.fromEntries(
    keys.map((key) => [
      key,
      {
        ok: rows.filter((row) => row.contract?.[key] === true).length,
        total: rows.filter((row) => row.contract !== null && row.contract[key] !== null).length,
      },
    ]),
  );
}

export async function runPhaseContractBench(options: {
  casesPath: string;
  runs: number;
  critic: { model: string };
  run: (prompt: string) => Promise<string | null>;
  majority: (statuses: string[]) => string;
}): Promise<number> {
  const rows = readFileSync(options.casesPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ContractCase)
    .filter((row): row is ContractCase & { livePrompt: string; expectedStatus: string } =>
      Boolean(row.livePrompt && row.expectedStatus),
    );
  if (rows.length === 0) {
    console.error('critique-eval: no live phase-contract rows');
    return 2;
  }
  console.log(
    `critique phase-contract: budget ≈ ${rows.length * options.runs} critic call(s) · no matcher calls`,
  );
  let outages = 0;
  let passed = 0;
  for (const row of rows) {
    const statuses: string[] = [];
    for (let run = 0; run < options.runs; run++) {
      const raw = await options.run(row.livePrompt);
      if (!raw) {
        outages++;
        continue;
      }
      const contract = parsePlanCritiqueResponse(raw);
      statuses.push(contract.state === 'valid' ? (contract.value?.status ?? 'NULL') : 'INVALID');
    }
    const got = options.majority(statuses);
    const ok = got === row.expectedStatus;
    if (ok) passed++;
    console.log(
      `  ${row.id.padEnd(38)} ${ok ? 'OK' : 'FAIL'} status=${got} expected=${row.expectedStatus}`,
    );
  }
  console.log(
    `critique phase-contract: ${passed}/${rows.length} rows ok [model=${options.critic.model} K=${options.runs}]${outages ? ` · outages ${outages}` : ''}`,
  );
  if (outages > 0) return 2;
  return passed === rows.length ? 0 : 1;
}
