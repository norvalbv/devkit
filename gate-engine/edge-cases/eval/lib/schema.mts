/**
 * Case schema for the edge-cases eval corpus: enums, validator, prompt-variant classifier and the
 * repo excerpt allowlist. Shared by finalize.mts (writes cases.jsonl) and cases.test.mts (the
 * permanent gate) so the contract can't drift from its enforcement.
 *
 * MUST stay importable under plain node (vitest runs the gate) — no bun:sqlite here or transitively.
 */

import { createHash } from 'node:crypto';

/** The stable substring present in every historical /edge-cases invocation, old and new. */
export const ANCHOR_PHRASE = 'what edge cases can you think of';

/** Repos whose code excerpts may be committed here (benord-labs/personal only). */
export const EXCERPT_ALLOWLIST = ['frink', 'devkit', 'qavis'];

/** Employer code — rows from these repos are dropped entirely at harvest (cross-org sign-off needed). */
export const EXCLUDED_REPOS = ['owners-web'];

export const SOURCES = ['claude-code', 'frink-app', 'cursor'];
export const ANCHOR_KINDS = ['diff', 'session-summary'];
export const SEVERITIES = ['high', 'medium', 'low', 'unstated'];
export const CATEGORIES = [
  'race',
  'boundary',
  'provider',
  'os',
  'integration',
  'input-shape',
  'wrong-return',
  'other',
];
export const VERDICTS = ['worth-surfacing', 'noise'];
export const WAS_LIVE_BUG = ['true', 'false', 'unknown'];
/** Ranked by INDEPENDENCE from the raising agent (the /edge-cases prompt commands test+fix, so
 * same-session compliance is weak evidence — see README). */
export const EVIDENCE_TIERS = [
  'f2p-in-session',
  'independent-fix',
  'user-confirmed',
  'test-added-green',
  'rejected',
  'none',
];
export const CONFIDENCES = ['high', 'medium', 'low'];
export const DEGENERATE_REASONS = ['empty-diff', 'docs-only', 'agent-declined', 'no-response'];

export const sha8 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 8);

/** Classify the invocation text into a prompt lineage. promptSha still recorded for grouping. */
export const classifyPromptVariant = (text) => {
  const t = (text ?? '').toLowerCase().replace(/\s+/g, ' ');
  if (t.includes("given everything we've discussed") && t.includes('golden standard'))
    return 'frink-cmd-v1';
  // earlier revision of the frink command — same body, no golden-standard coverage line
  if (
    t.includes("given everything we've discussed") &&
    t.includes('carried out in the same branch')
  )
    return 'frink-cmd-v0';
  if (t.includes('based on our diff, debugging, and chat history')) return 'legacy-diff-debug-chat';
  return `custom-${sha8(t)}`;
};

const isOneOf = (value, list) => list.includes(value);
const ID_RE = /^(cc|fk|cu)-[\w-]+-\d{8}-[0-9a-f]{8}$/;
const SHA8_RE = /^[0-9a-f]{8}$/;

/** Validate a finalized case row. Returns an array of error strings (empty = valid). */
export const validateCase = (c) => {
  const errors = [];
  const err = (m) => errors.push(`${c?.id ?? '<no-id>'}: ${m}`);

  if (!ID_RE.test(c?.id ?? '')) err('bad id format');
  if (!isOneOf(c?.source, SOURCES)) err(`bad source ${c?.source}`);
  if (typeof c?.sourceRef !== 'string' || !c.sourceRef) err('missing sourceRef');
  if (!Array.isArray(c?.crossRefs)) err('crossRefs must be an array');
  if (typeof c?.repo !== 'string' || !c.repo) err('missing repo');
  if (EXCLUDED_REPOS.some((r) => c?.repo === r || c?.repo === `other:${r}`))
    err(`excluded repo ${c.repo}`);
  if (Number.isNaN(Date.parse(c?.date ?? ''))) err('bad date');
  if (typeof c?.promptVariant !== 'string' || !c.promptVariant) err('missing promptVariant');
  if (!SHA8_RE.test(c?.promptSha ?? '')) err('bad promptSha');

  const a = c?.anchor;
  if (!a || !isOneOf(a.kind, ANCHOR_KINDS)) err(`bad anchor.kind ${a?.kind}`);
  if (typeof a?.summary !== 'string' || !a.summary) err('anchor.summary required');
  if (a?.kind === 'diff' && (typeof a?.nameStatus !== 'string' || !a.nameStatus.trim()))
    err('diff anchor requires a non-empty nameStatus');
  const allowlisted = EXCERPT_ALLOWLIST.includes(c?.repo);
  if (a?.diffExcerpt && !allowlisted)
    err(`diffExcerpt present but repo ${c?.repo} not in excerpt allowlist`);

  if (!Array.isArray(c?.findings)) err('findings must be an array');
  for (const f of c?.findings ?? []) {
    const fid = `finding ${f?.idx}`;
    if (!Number.isInteger(f?.idx)) err(`${fid}: bad idx`);
    if (typeof f?.claim !== 'string' || !f.claim) err(`${fid}: missing claim`);
    if (!Array.isArray(f?.files)) err(`${fid}: files must be an array`);
    if (typeof f?.text !== 'string' || !f.text) err(`${fid}: missing text`);
    if (!isOneOf(f?.severity, SEVERITIES)) err(`${fid}: bad severity ${f?.severity}`);
    if (!isOneOf(f?.category, CATEGORIES)) err(`${fid}: bad category ${f?.category}`);
    if (!isOneOf(f?.verdict, VERDICTS)) err(`${fid}: bad verdict ${f?.verdict}`);
    if (!isOneOf(String(f?.wasLiveBug), WAS_LIVE_BUG))
      err(`${fid}: bad wasLiveBug ${f?.wasLiveBug}`);
    if (!isOneOf(f?.evidence?.tier, EVIDENCE_TIERS))
      err(`${fid}: bad evidence.tier ${f?.evidence?.tier}`);
    if (typeof f?.evidence?.detail !== 'string' || !f.evidence.detail)
      err(`${fid}: missing evidence.detail`);
    if (!isOneOf(f?.evidence?.confidence, CONFIDENCES)) err(`${fid}: bad confidence`);
    if (typeof f?.evidence?.reviewed !== 'boolean')
      err(`${fid}: evidence.reviewed must be boolean`);
    // A live-bug claim needs independent behavioural evidence — compliance tiers don't qualify.
    if (
      String(f?.wasLiveBug) === 'true' &&
      ['test-added-green', 'rejected', 'none'].includes(f?.evidence?.tier)
    )
      err(
        `${fid}: wasLiveBug=true requires f2p-in-session/independent-fix/user-confirmed evidence`,
      );
  }

  if (typeof c?.degenerate !== 'boolean') err('degenerate must be boolean');
  if (c?.degenerate && !isOneOf(c?.degenerateReason, DEGENERATE_REASONS))
    err('bad degenerateReason');
  if (c?.degenerate && (c?.findings ?? []).length > 0) err('degenerate rows must have no findings');
  return errors;
};
