import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  isJsonObject,
  isJsonString,
  type JsonObject,
  type JsonValue,
} from '../../comment-firewall/types.mts';
import { resolveGuardConfig, type GuardConfig } from '../../config.mts';
import { matchScope } from '../../decisions/check-alignment.mts';
import { currentTarget, parseDecision } from '../../decisions/decision-format.mts';
import { BenchAbort, materializeFixture, parseCasesText } from '../../decisions/eval/bench.mts';
import { effectiveScope } from '../../decisions/recall/retrieval.mts';
import { completenessJudgeSetup } from '../completeness.mts';
import { AGENTS_DIR, casesPath } from './benchmark-config.mts';
import { type DecoySlot, type GoldSlot, SEVERITIES } from './matcher.mts';

export interface CompletenessCase {
  id: string;
  category: string;
  difficulty?: 'clear' | 'borderline' | 'adversarial';
  provenance?: 'authored' | 'mined' | 'adapted';
  note: string;
  variantOf?: string | null;
  variantKind?: 'invariance' | 'directional' | null;
  holdout?: boolean;
  message: string;
  repo: { base: Record<string, string>; staged: Record<string, string | null> };
  gold: GoldSlot[];
  decoys: DecoySlot[];
  expectedVerdict?: 'PASS' | 'FAIL';
}

function hasLoadableTarget(markdown: string, stagedFiles: string[]): boolean {
  const body = parseDecision(markdown).body;
  if (!currentTarget(body)) return false;
  const scopeGlobs = effectiveScope(body)
    .split(',')
    .map((glob) => glob.trim())
    .filter(Boolean);
  return scopeGlobs.length > 0 && matchScope(stagedFiles, scopeGlobs);
}

const DIFFICULTIES = ['clear', 'borderline', 'adversarial'] as const;
const PROVENANCE = ['authored', 'mined', 'adapted'] as const;
const VARIANT_KINDS = ['invariance', 'directional'] as const;
const VERDICTS = ['PASS', 'FAIL'] as const;
const DECOY_KINDS = ['recorded-decision', 'out-of-scope', 'working-as-intended'] as const;
const DECISION_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isOneOf(value: JsonValue | undefined, allowed: readonly string[]): value is string {
  return isJsonString(value) && allowed.includes(value);
}

function isRepoRelativePath(file: string): boolean {
  const normalized = path.posix.normalize(file);
  return (
    Boolean(file) &&
    !file.includes('\0') &&
    !file.includes('\\') &&
    !path.posix.isAbsolute(file) &&
    !path.win32.isAbsolute(file) &&
    normalized !== '.' &&
    normalized !== '..' &&
    !normalized.startsWith('../') &&
    normalized === file
  );
}

function isStringMap(value: JsonValue | undefined, allowNull: boolean): value is JsonObject {
  return (
    isJsonObject(value) &&
    Object.entries(value).every(
      ([key, entry]) =>
        isRepoRelativePath(key) && (isJsonString(entry) || (allowNull && entry === null)),
    )
  );
}

/** Free corpus lint — every defect here would otherwise surface mid-run after paid reviewer calls.
 * Exported so the unit tests run it over the committed corpus. */
export function lintCases(rows: readonly unknown[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const variants: Array<{ at: string; id: string; base: string }> = [];
  for (const [index, raw] of rows.entries()) {
    // SAFETY: parsed JSONL rows and test fixtures are inspected through JSON guards before access.
    const value = raw as JsonValue;
    if (!isJsonObject(value)) {
      errors.push(`row ${index + 1}: must be a JSON object`);
      continue;
    }
    const id = isJsonString(value.id) && value.id.trim() ? value.id : '';
    const at = `row ${id || index + 1}`;
    if (!id) errors.push(`${at}: missing or non-string id`);
    else if (ids.has(id)) errors.push(`${at}: duplicate id`);
    else ids.add(id);
    for (const field of ['category', 'note', 'message'] as const)
      if (!isJsonString(value[field]) || !value[field].trim())
        errors.push(`${at}: missing or non-string ${field}`);
    if (value.difficulty !== undefined && !isOneOf(value.difficulty, DIFFICULTIES))
      errors.push(`${at}: bad difficulty`);
    if (value.provenance !== undefined && !isOneOf(value.provenance, PROVENANCE))
      errors.push(`${at}: bad provenance`);
    if (value.holdout !== undefined && value.holdout !== true && value.holdout !== false)
      errors.push(`${at}: holdout must be boolean`);
    if (value.expectedVerdict !== undefined && !isOneOf(value.expectedVerdict, VERDICTS))
      errors.push(`${at}: bad expectedVerdict`);

    const variantOf =
      isJsonString(value.variantOf) && value.variantOf.trim() ? value.variantOf : '';
    const variantKind = isOneOf(value.variantKind, VARIANT_KINDS) ? value.variantKind : '';
    if (
      value.variantOf !== undefined &&
      value.variantOf !== null &&
      (!isJsonString(value.variantOf) || !value.variantOf.trim())
    )
      errors.push(`${at}: variantOf must be a non-empty string or null`);
    if (
      value.variantKind !== undefined &&
      value.variantKind !== null &&
      !isOneOf(value.variantKind, VARIANT_KINDS)
    )
      errors.push(`${at}: bad variantKind`);
    if (variantOf && !variantKind) errors.push(`${at}: variantOf requires an explicit variantKind`);
    if (!variantOf && variantKind) errors.push(`${at}: variantKind requires variantOf`);
    if (id && variantOf) variants.push({ at, id, base: variantOf });

    const repo = isJsonObject(value.repo) ? value.repo : undefined;
    const base = repo && isStringMap(repo.base, false) ? repo.base : undefined;
    const staged = repo && isStringMap(repo.staged, true) ? repo.staged : undefined;
    if (!base || !staged) errors.push(`${at}: repo.base/staged must be string maps`);
    else if (
      !Object.entries(staged).some(([file, content]) =>
        content === null ? isJsonString(base[file]) : base[file] !== content,
      )
    )
      errors.push(`${at}: nothing staged`);

    const gold = Array.isArray(value.gold) ? value.gold : [];
    const decoys = Array.isArray(value.decoys) ? value.decoys : [];
    if (!Array.isArray(value.gold) || !Array.isArray(value.decoys))
      errors.push(`${at}: gold/decoys must be arrays`);
    const slotIds = new Set<string>();
    const validateSlotId = (slot: JsonValue): string => {
      if (!isJsonObject(slot) || !isJsonString(slot.id) || !slot.id.trim()) {
        errors.push(`${at}: slot must have an id`);
        return '';
      }
      if (slotIds.has(slot.id)) errors.push(`${at}: duplicate slot id ${slot.id}`);
      slotIds.add(slot.id);
      if (!isJsonString(slot.desc) || !slot.desc.trim())
        errors.push(`${at}: slot ${slot.id} must have a description`);
      return slot.id;
    };
    for (const rawGold of gold) {
      // SAFETY: Array.isArray above narrows a JsonValue collection; each element is guarded below.
      const goldValue = rawGold as JsonValue;
      const goldId = validateSlotId(goldValue);
      if (!isJsonObject(goldValue)) continue;
      if (!isOneOf(goldValue.severity, SEVERITIES))
        errors.push(`${at}: gold ${goldId || '(no id)'} bad severity`);
      if (
        goldValue.paths !== undefined &&
        (!Array.isArray(goldValue.paths) ||
          goldValue.paths.some((entry) => !isJsonString(entry) || !entry.trim()))
      )
        errors.push(`${at}: gold ${goldId || '(no id)'} paths must be non-empty strings`);
    }
    for (const rawDecoy of decoys) {
      // SAFETY: Array.isArray above narrows a JsonValue collection; each element is guarded below.
      const decoyValue = rawDecoy as JsonValue;
      const decoyId = validateSlotId(decoyValue);
      if (!isJsonObject(decoyValue)) continue;
      if (!isOneOf(decoyValue.kind, DECOY_KINDS))
        errors.push(`${at}: decoy ${decoyId || '(no id)'} bad kind`);
      const targetSlug =
        isJsonString(decoyValue.targetSlug) && decoyValue.targetSlug ? decoyValue.targetSlug : '';
      if (decoyValue.kind === 'recorded-decision') {
        const file = `docs/decisions/${targetSlug}.md`;
        if (!targetSlug)
          errors.push(`${at}: decoy ${decoyId || '(no id)'} recorded-decision needs targetSlug`);
        else if (!DECISION_SLUG.test(targetSlug))
          errors.push(`${at}: decoy ${decoyId} has invalid targetSlug ${targetSlug}`);
        else if (!base || !isJsonString(base[file]))
          errors.push(`${at}: decoy ${decoyId} — ${file} not in repo.base`);
        else if (!hasLoadableTarget(base[file], Object.keys(staged ?? {})))
          errors.push(
            `${at}: decoy ${decoyId} — ${file} has no parseable Target Scope applicable to staged files`,
          );
      } else if (decoyValue.targetSlug !== undefined) {
        errors.push(`${at}: decoy ${decoyId || '(no id)'} targetSlug requires recorded-decision`);
      }
    }
  }
  for (const variant of variants) {
    if (variant.id === variant.base)
      errors.push(`${variant.at}: variantOf cannot reference itself`);
    else if (!ids.has(variant.base))
      errors.push(`${variant.at}: variantOf base ${variant.base} does not exist`);
  }
  return errors;
}

export function loadCases(): CompletenessCase[] {
  let rows: CompletenessCase[];
  try {
    rows = parseCasesText(readFileSync(casesPath, 'utf8'));
  } catch (e) {
    throw new BenchAbort(2, `completeness-eval: cannot read ${path.basename(casesPath)} — ${e}`);
  }
  if (!rows.length) throw new BenchAbort(2, 'completeness-eval: corpus is empty');
  const errors = lintCases(rows);
  if (errors.length)
    throw new BenchAbort(2, `completeness-eval: corpus lint failed —\n  ${errors.join('\n  ')}`);
  return rows;
}

// ─── Fixture wrapper ──────────────────────────────────────────────────────────────

export function materializeCompletenessFixture(
  row: CompletenessCase,
  agentsDirAbs = AGENTS_DIR,
  writeMessage: (file: string, data: string) => void = writeFileSync,
  consumerConfig: GuardConfig = resolveGuardConfig(process.cwd()),
) {
  const { cwd: consumerRoot, ...configFile } = consumerConfig;
  const base = {
    ...row.repo.base,
    'guard.config.json': `${JSON.stringify(
      {
        ...configFile,
        decisionsDir: 'docs/decisions',
        review: { ...consumerConfig.review, agentsDir: agentsDirAbs },
      },
      null,
      2,
    )}\n`,
  };
  const fx = materializeFixture({ repo: { base, staged: row.repo.staged } });
  const msgFile = path.join(fx.repo, '.git', 'COMMIT_EDITMSG');
  try {
    writeMessage(msgFile, row.message.endsWith('\n') ? row.message : `${row.message}\n`);
    return { ...fx, consumerRoot, msgFile };
  } catch (error) {
    fx.cleanup();
    throw error;
  }
}

/** Resolve the same secret-safe capability identity the gate will use inside a real fixture. */
export function completenessFixtureCapabilityFingerprint(
  row: CompletenessCase,
  agentsDirAbs = AGENTS_DIR,
  consumerConfig: GuardConfig = resolveGuardConfig(process.cwd()),
): string {
  const fx = materializeCompletenessFixture(row, agentsDirAbs, writeFileSync, consumerConfig);
  try {
    return completenessJudgeSetup(resolveGuardConfig(fx.repo), fx.repo, {
      mcpProjectRoots: [fx.consumerRoot],
    }).capabilityFingerprint;
  } finally {
    fx.cleanup();
  }
}
