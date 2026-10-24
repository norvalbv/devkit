// prior-art workflow tier: the frozen family corpus and its zero-call lint. Every snapshot is a
// public repo pinned by commit SHA and tree OID; a family keeps a task's members in one partition.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { BenchAbort, parseCasesText } from '../../../decisions/eval/bench.mts';
import {
  PRIOR_ART_FRAMINGS,
  PRIOR_ART_VERDICTS,
  type PriorArtResponseV1,
  type PriorArtVerdict,
  validatePriorArtCoupling,
} from '../../response-contract.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const familiesPath = path.join(here, 'families.jsonl');

/** The one pattern every materialised consumer declares; refs/ sits beside consumer/. */
export const REFS_PATTERN = '../refs/*';

const hex40 = z.string().regex(/^[0-9a-f]{40}$/, 'must be a full 40-hex object id');
const snapshotSchema = z.strictObject({
  name: z.string().min(1),
  url: z.string().min(1),
  sha: hex40,
  tree: hex40,
});
/** `root` is `consumer` (the repo under validation) or the name of one of the member's refs. */
const spanSchema = z.strictObject({
  root: z.string().min(1),
  path: z.string().min(1),
  lines: z.tuple([z.number().int().positive(), z.number().int().positive()]),
});
const slotSchema = z.strictObject({
  id: z.string().min(1),
  desc: z.string().min(1),
  spans: z.array(spanSchema),
});
const memberSchema = z.strictObject({
  id: z.string().min(1),
  caseId: z.string().min(1),
  kind: z.enum(['natural', 'artificial']),
  provenance: z.string().min(1),
  /** null = a minimal consumer holding only guard.config.json. */
  consumer: snapshotSchema.nullable(),
  /** Empty = the declared pattern resolves nothing (the broken-tool layout). */
  refs: z.array(snapshotSchema),
  external: z.array(
    z.strictObject({
      leg: z.enum(['github', 'web', 'papers']),
      source: z.string().min(1),
      text: z.string().min(1),
      /** True when the excerpt alone could support the natural member's verdict. */
      gold: z.boolean().optional(),
    }),
  ),
  prompt: z.string().min(1),
  expectVerdict: z.array(z.enum(PRIOR_ART_VERDICTS)).min(1),
  expectFraming: z.array(z.enum(PRIOR_ART_FRAMINGS)),
  gold: z.array(slotSchema),
  decoys: z.array(slotSchema),
});

export type Snapshot = z.infer<typeof snapshotSchema>;
export type Span = z.infer<typeof spanSchema>;
export type Slot = z.infer<typeof slotSchema>;
export type Member = z.infer<typeof memberSchema>;

const NEXT_STEP = {
  SOLVED_ELSEWHERE: 'adopt_existing',
  DISSOLVE_FRAME: 'reframe',
  GENUINE_NEW_WORK: 'proceed_to_plan',
  INSUFFICIENT_EVIDENCE: 'gather_evidence',
} satisfies Record<PriorArtVerdict, NonNullable<PriorArtResponseV1['suggestedNextStep']>['kind']>;

/** The legs a member's layout makes honest: external legs are frozen reached, deep-research dark. */
export function layoutLegs(member: Member): PriorArtResponseV1['legs'] {
  const resolved = member.refs.length;
  return [
    {
      leg: 'local',
      status: resolved ? 'reached' : 'unavailable',
      detail: 'layout',
      declaredCheckouts: 1,
      resolvedCheckouts: resolved,
    },
    { leg: 'github', status: 'reached', detail: 'frozen' },
    { leg: 'web', status: 'reached', detail: 'frozen' },
    { leg: 'papers', status: 'reached', detail: 'frozen' },
    { leg: 'deep-research', status: 'unavailable', detail: 'frozen' },
  ];
}

/** Whether any contract-valid response can carry `verdict` here: the real coupling rules run over
 *  the most permissive response, so this lint never drifts from them. */
export function verdictReachable(member: Member, verdict: PriorArtVerdict): boolean {
  const response: PriorArtResponseV1 = {
    schemaVersion: 1,
    kind: 'prior_art',
    phase: 'problem',
    status: 'reviewed',
    problem: { statement: 'x', restatedFrame: 'x', assumedConstraints: [] },
    verdict,
    confidence: 'medium',
    legs: layoutLegs(member),
    frameChallenge: {
      framing: verdict === 'DISSOLVE_FRAME' ? 'DISSOLVES' : 'HOLDS',
      upstreamChoice: 'x',
      boundaryMustExist: 'unknown',
    },
    questions: (['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'] as const).map((id) => ({
      id,
      status: 'ANSWERED',
      finding: 'x',
    })),
    evidence: [{ kind: 'local', source: 'x', repoRoot: null, claim: 'x', quote: '' }],
    suggestedNextStep: { kind: NEXT_STEP[verdict], detail: 'x' },
    routing: null,
    summary: 'x',
    researchReferences: [],
  };
  try {
    validatePriorArtCoupling(response, (at, requirement) => {
      throw new Error(`${at}: ${requirement}`);
    });
    return true;
  } catch {
    return false;
  }
}

function lintMember(member: Member, at: string, errors: string[]): void {
  const roots = new Set([
    ...(member.consumer ? ['consumer'] : []),
    ...member.refs.map((r) => r.name),
  ]);
  for (const slot of [...member.gold, ...member.decoys])
    for (const span of slot.spans)
      if (!roots.has(span.root))
        errors.push(`${at}: slot ${slot.id} span root "${span.root}" absent`);
  for (const verdict of member.expectVerdict)
    if (!verdictReachable(member, verdict))
      errors.push(`${at}: expected ${verdict} is contract-unreachable for this layout`);
  if (member.kind === 'artificial') lintBrokenTool(member, at, errors);
}

/** A broken-tool twin must leave INSUFFICIENT_EVIDENCE as its only right answer. */
function lintBrokenTool(member: Member, at: string, errors: string[]): void {
  if (member.refs.length) errors.push(`${at}: an artificial broken-tool member resolves no refs`);
  if (member.expectVerdict.join() !== 'INSUFFICIENT_EVIDENCE')
    errors.push(`${at}: an artificial broken-tool member expects only INSUFFICIENT_EVIDENCE`);
  if (member.external.some((excerpt) => excerpt.gold))
    errors.push(`${at}: an artificial member carries gold-bearing external content`);
}

/** Corpus-level rules the schema cannot express: unique ids, reachability, family shape. */
export function lintFamilies(members: Member[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  members.forEach((member, index) => {
    const at = `member ${index + 1} (${member.id})`;
    if (seen.has(member.id)) errors.push(`${at}: duplicate id`);
    seen.add(member.id);
    lintMember(member, at, errors);
  });
  for (const caseId of new Set(members.map((member) => member.caseId)))
    if (!members.some((member) => member.caseId === caseId && member.kind === 'natural'))
      errors.push(`family ${caseId}: needs a natural member`);
  return errors;
}

export function loadFamilies(text = readFileSync(familiesPath, 'utf8')): Member[] {
  const parsed = z.array(memberSchema).safeParse(parseCasesText(text));
  if (!parsed.success)
    throw new BenchAbort(
      2,
      `prior-art workflow: families.jsonl is malformed — ${z.prettifyError(parsed.error)}`,
    );
  if (!parsed.data.length) throw new BenchAbort(2, 'prior-art workflow: families.jsonl is empty');
  const problems = lintFamilies(parsed.data);
  if (problems.length)
    throw new BenchAbort(2, `prior-art workflow: family lint failed —\n  ${problems.join('\n  ')}`);
  return parsed.data;
}
