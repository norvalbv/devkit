/** Resolve a replay request (diff sha or ship id) to its archived diff, base commit and the
 * original run's result row, from the machine telemetry sink. Bench-only; read-only. */
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { archivedDiffPath, readArchivedDiffEvidence } from '../labels.mts';

const DIFF_SHA = /^[0-9a-f]{64}$/;
const DIFF_PREFIX = /^[0-9a-f]{12,64}$/; // the sha12 every replay line prints

const sinkRowSchema = z.object({
  type: z.string(),
  reviewer: z.string().optional(),
  diff_sha256: z.string().optional(),
  base_sha: z.string().nullable().optional(),
  ship_id: z.string().optional(),
  ts: z.string().optional(),
  status: z.string().optional(),
  model: z.string().optional(),
  item_tally: z.record(z.string(), z.number()).optional(),
  prompt_identity: z.string().optional(),
});
type SinkRow = z.infer<typeof sinkRowSchema>;

export interface ReplayInput {
  diffSha: string;
  diffText: string;
  base: string;
  ts: string;
  shipId?: string;
  promptIdentity?: string;
  original?: { status?: string; model?: string; itemTally?: Record<string, number> };
}

export function defaultSinkPath(): string {
  return path.join(os.homedir(), '.devkit', 'telemetry', 'gate-events.jsonl');
}

/** Every review_scope row for `reviewer` matching `ref`, plus that reviewer's review_result rows. */
async function scanSink(sink: string, ref: string, reviewer: string) {
  const scopes: SinkRow[] = [];
  const results: SinkRow[] = [];
  if (!existsSync(sink)) return { scopes, results };
  const quotedReviewer = `"reviewer":"${reviewer}"`;
  for await (const line of createInterface({
    input: createReadStream(sink),
    crlfDelay: Infinity,
  })) {
    if (!line.includes(quotedReviewer)) continue;
    const isScope = line.includes('"review_scope"') && line.includes(ref);
    if (!isScope && !line.includes('"review_result"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a torn append is not a replay source
    }
    const decoded = sinkRowSchema.safeParse(parsed);
    if (!decoded.success) continue;
    const row = decoded.data;
    if (row.reviewer !== reviewer) continue;
    const diffMatch = DIFF_PREFIX.test(ref) && row.diff_sha256?.startsWith(ref);
    if (row.type === 'review_scope' && (diffMatch || row.ship_id === ref)) scopes.push(row);
    else if (row.type === 'review_result') results.push(row);
  }
  return { scopes, results };
}

function verifyCommit(repo: string, base: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error(
      `replay: base ${base} is not a commit in ${repo} — fetch it, or pass --base <sha> / --repo <path>`,
    );
  }
}

/** Throws a remedy-bearing Error for every input the replay cannot honour; never guesses a base. */
export async function resolveReplayInput(o: {
  ref: string;
  reviewer: string;
  repo: string;
  base?: string;
  sink?: string;
}): Promise<ReplayInput> {
  const { scopes, results } = await scanSink(o.sink ?? defaultSinkPath(), o.ref, o.reviewer);
  const archived = scopes.filter(
    (row) =>
      row.diff_sha256 &&
      DIFF_SHA.test(row.diff_sha256) &&
      existsSync(archivedDiffPath(row.diff_sha256)),
  );
  const row = archived.at(-1);
  if (!row && !DIFF_SHA.test(o.ref))
    throw new Error(
      `replay: no archived ${o.reviewer} diff matches ${o.ref} — only FAIL diffs are archived`,
    );
  const diffSha = row?.diff_sha256 ?? o.ref;
  const evidence = readArchivedDiffEvidence(diffSha);
  if (evidence.text === null)
    throw new Error(
      evidence.error === 'missing-diff'
        ? `replay: no archived diff ${diffSha.slice(0, 12)} — only FAIL diffs are archived; a PASS diff has no replay source`
        : `replay: archived diff ${diffSha.slice(0, 12)} is ${evidence.error}`,
    );
  const recordedBase = o.base ?? row?.base_sha ?? undefined;
  if (!recordedBase)
    throw new Error(
      `replay: no base commit recorded for diff ${diffSha.slice(0, 12)} — pass --base <sha>`,
    );
  const base = verifyCommit(o.repo, recordedBase);
  const original = row
    ? results.find((r) => r.ship_id === row.ship_id && (r.ts ?? '') >= (row.ts ?? ''))
    : undefined;
  return {
    diffSha,
    diffText: evidence.text,
    base,
    ts: row?.ts ?? new Date().toISOString(),
    shipId: row?.ship_id,
    promptIdentity: row?.prompt_identity,
    original: original && {
      status: original.status,
      model: original.model,
      itemTally: original.item_tally,
    },
  };
}
