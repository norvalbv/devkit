import {
  ASSESSMENTS,
  CHANGE_TYPES,
  EVIDENCE_MODES,
  FRESHNESS_STATES,
  LIFECYCLES,
  METRIC_DIRECTIONS,
  METRIC_UNITS,
} from './types.mts';

const ABSOLUTE_PATH_RE =
  /(?:^|[\s=:])(?:\/(?:Users|home|root|var|tmp|private|opt|srv|etc)(?:\/|$)|[A-Za-z]:[\\/]|\\\\[^\\\s]+\\)/;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const UNPUBLISHED_REF_RE = /refs\/(?:heads|stash|remotes)\//;
const PRIVATE_KEY_RE = /BEGIN (?:(?:[A-Z0-9]+ )*PRIVATE|OPENSSH|RSA) KEY/;
const FORBIDDEN_FIELD_RE =
  /^(?:absolutePath|branch|branchName|email|gitRef|messages|privateSourceText|prompt|rawPrompt|sourceText|transcript)$/i;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
export const BARE_SHA256_RE = /^[a-f0-9]{64}$/;
export const EVENT_ID_RE = /^evt-[a-z0-9][a-z0-9._-]*$/;
const COMPARISON_VERDICTS = [...ASSESSMENTS, 'not-comparable', 'coverage-only'] as const;
const PROVENANCE_TIERS = [
  'accepted',
  'committed-summary',
  'reported',
  'local-aggregate',
  'external',
] as const;

function looksPrivate(value: string): string | null {
  if (ABSOLUTE_PATH_RE.test(value)) return 'absolute path';
  if (EMAIL_RE.test(value)) return 'email address';
  if (UNPUBLISHED_REF_RE.test(value)) return 'unpublished git ref';
  if (PRIVATE_KEY_RE.test(value)) return 'private key';
  return null;
}

export function privacyErrors(value: unknown, location: string, errors: string[]): void {
  if (typeof value === 'string') {
    const reason = looksPrivate(value);
    if (reason) errors.push(`${location}: contains ${reason}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      privacyErrors(child, `${location}[${index}]`, errors);
    });
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_FIELD_RE.test(key)) errors.push(`${location}.${key}: forbidden private field`);
      privacyErrors(child, `${location}.${key}`, errors);
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function oneOf(values: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && values.includes(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function metricErrors(value: unknown, location: string): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return [`${location}: metric must be an object`];
  if (typeof value.id !== 'string' || !value.id) errors.push(`${location}: missing metric id`);
  if (typeof value.label !== 'string' || !value.label)
    errors.push(`${location}: missing metric label`);
  if (!finite(value.value)) errors.push(`${location}: metric value must be finite`);
  if (!oneOf(METRIC_DIRECTIONS, value.direction))
    errors.push(`${location}: invalid metric direction`);
  if (!oneOf(METRIC_UNITS, value.unit)) errors.push(`${location}: invalid metric unit`);
  if (value.unit === 'ratio' && finite(value.value) && (value.value < 0 || value.value > 1))
    errors.push(`${location}: ratio value must be between zero and one`);
  if (typeof value.inferenceUnit !== 'string' || !value.inferenceUnit)
    errors.push(`${location}: missing inference unit`);
  if (value.numerator !== undefined && (!finite(value.numerator) || value.numerator < 0))
    errors.push(`${location}: numerator must be non-negative and finite`);
  if (value.denominator !== undefined && (!finite(value.denominator) || value.denominator < 0))
    errors.push(`${location}: denominator must be non-negative`);
  const hasNumerator = value.numerator !== undefined;
  const hasDenominator = value.denominator !== undefined;
  if (value.unit === 'ratio' && hasNumerator !== hasDenominator)
    errors.push(`${location}: ratio numerator and denominator must be provided together`);
  if (value.unit === 'ratio' && finite(value.denominator) && value.denominator <= 0)
    errors.push(`${location}: ratio denominator must be positive`);
  if (
    value.unit === 'ratio' &&
    finite(value.numerator) &&
    finite(value.denominator) &&
    value.numerator > value.denominator
  )
    errors.push(`${location}: ratio numerator cannot exceed denominator`);
  if (
    value.unit === 'ratio' &&
    finite(value.value) &&
    finite(value.numerator) &&
    finite(value.denominator) &&
    value.denominator > 0 &&
    Math.abs(value.value - value.numerator / value.denominator) > Number.EPSILON * 8
  ) {
    errors.push(`${location}: ratio value does not match numerator divided by denominator`);
  }
  for (const threshold of ['floor', 'ceiling', 'mde', 'noiseFloor'] as const) {
    if (value[threshold] !== undefined && !finite(value[threshold]))
      errors.push(`${location}: ${threshold} must be finite`);
  }
  if (value.assessment !== undefined && !oneOf(ASSESSMENTS, value.assessment))
    errors.push(`${location}: invalid metric assessment`);
  if (value.interval !== undefined) {
    if (!isRecord(value.interval)) errors.push(`${location}: interval must be an object`);
    else if (
      typeof value.interval.method !== 'string' ||
      !finite(value.interval.lower) ||
      !finite(value.interval.upper) ||
      (value.interval.lower as number) > (value.interval.upper as number)
    ) {
      errors.push(`${location}: invalid interval`);
    }
  }
  return errors;
}

function comparisonErrors(value: unknown, location: string): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return [`${location}: comparison must be an object`];
  if (typeof value.predecessorEventId !== 'string' || !value.predecessorEventId)
    errors.push(`${location}: missing predecessor event id`);
  if (typeof value.method !== 'string' || !value.method)
    errors.push(`${location}: missing comparison method`);
  if (!oneOf(COMPARISON_VERDICTS, value.verdict))
    errors.push(`${location}: invalid comparison verdict`);
  for (const count of ['sharedRows', 'positiveDiscordant', 'negativeDiscordant'] as const) {
    if (
      value[count] !== undefined &&
      (!Number.isInteger(value[count]) || (value[count] as number) < 0)
    ) {
      errors.push(`${location}: ${count} must be a non-negative integer`);
    }
  }
  if (value.pValue !== undefined && (!finite(value.pValue) || value.pValue < 0 || value.pValue > 1))
    errors.push(`${location}: pValue must be between zero and one`);
  return errors;
}

function hashErrors(value: unknown, location: string): string[] {
  if (!isRecord(value)) return [`${location}: hashes must be an object`];
  return ['implementation', 'corpus', 'scorer', 'runner'].flatMap((key) =>
    typeof value[key] === 'string' && SHA256_RE.test(value[key])
      ? []
      : [`${location}.${key}: invalid SHA-256`],
  );
}

export function checkpointErrors(value: unknown, location: string): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return [`${location}: checkpoint must be an object`];
  if (value.schemaVersion !== 1) errors.push(`${location}: unsupported schemaVersion`);
  for (const key of ['suiteId', 'capturedAt', 'sourceCommit', 'adapter'] as const) {
    if (typeof value[key] !== 'string' || !value[key]) errors.push(`${location}: missing ${key}`);
  }
  if (typeof value.capturedAt === 'string' && Number.isNaN(Date.parse(value.capturedAt)))
    errors.push(`${location}: invalid capturedAt`);
  if (typeof value.sourceCommit === 'string' && !COMMIT_RE.test(value.sourceCommit))
    errors.push(`${location}: invalid sourceCommit`);
  errors.push(...hashErrors(value.hashes, `${location}.hashes`));
  if (!Array.isArray(value.metrics)) errors.push(`${location}: metrics must be an array`);
  else
    value.metrics.forEach((metric, index) => {
      errors.push(...metricErrors(metric, `${location}.metrics[${index}]`));
    });
  if (!Array.isArray(value.comparisons)) errors.push(`${location}: comparisons must be an array`);
  else
    value.comparisons.forEach((comparison, index) => {
      errors.push(...comparisonErrors(comparison, `${location}.comparisons[${index}]`));
    });
  if (!isRecord(value.rows)) errors.push(`${location}: rows must be an object`);
  if (
    !isRecord(value.acceptance) ||
    value.acceptance.accepted !== true ||
    typeof value.acceptance.reason !== 'string'
  ) {
    errors.push(`${location}: checkpoint acceptance must be accepted with a reason`);
  }
  return errors;
}

export function eventErrors(value: unknown, location: string): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return [`${location}: event must be an object`];
  if (value.schemaVersion !== 1) errors.push(`${location}: unsupported schemaVersion`);
  if (typeof value.id !== 'string' || !EVENT_ID_RE.test(value.id))
    errors.push(`${location}: invalid event id`);
  for (const key of ['recordedAt', 'suiteId', 'note'] as const) {
    if (typeof value[key] !== 'string' || !value[key]) errors.push(`${location}: missing ${key}`);
  }
  if (typeof value.recordedAt === 'string' && Number.isNaN(Date.parse(value.recordedAt)))
    errors.push(`${location}: invalid recordedAt`);
  if (!Array.isArray(value.subjectIds) || value.subjectIds.some((id) => typeof id !== 'string'))
    errors.push(`${location}: subjectIds must be a string array`);
  if (!oneOf(LIFECYCLES, value.lifecycle)) errors.push(`${location}: invalid lifecycle`);
  if (!oneOf(EVIDENCE_MODES, value.evidence)) errors.push(`${location}: invalid evidence mode`);
  if (!oneOf(FRESHNESS_STATES, value.freshness)) errors.push(`${location}: invalid freshness`);
  if (!oneOf(CHANGE_TYPES, value.changeType)) errors.push(`${location}: invalid change type`);
  if (!oneOf(ASSESSMENTS, value.assessment)) errors.push(`${location}: invalid assessment`);
  if (value.evidence === 'accepted' && value.hashes === undefined)
    errors.push(`${location}: accepted event requires hashes`);
  if (value.evidence === 'accepted' && value.checkpoint === undefined)
    errors.push(`${location}: accepted event requires a checkpoint`);
  if (value.hashes !== undefined) errors.push(...hashErrors(value.hashes, `${location}.hashes`));
  if (!Array.isArray(value.metrics)) errors.push(`${location}: metrics must be an array`);
  else
    value.metrics.forEach((metric, index) => {
      errors.push(...metricErrors(metric, `${location}.metrics[${index}]`));
    });
  if (!Array.isArray(value.comparisons)) errors.push(`${location}: comparisons must be an array`);
  else
    value.comparisons.forEach((comparison, index) => {
      errors.push(...comparisonErrors(comparison, `${location}.comparisons[${index}]`));
    });
  if (
    !isRecord(value.provenance) ||
    typeof value.provenance.source !== 'string' ||
    !oneOf(PROVENANCE_TIERS, value.provenance.tier)
  )
    errors.push(`${location}: invalid provenance`);
  if (
    value.evidence === 'accepted' &&
    (!isRecord(value.provenance) ||
      value.provenance.tier !== 'accepted' ||
      typeof value.provenance.sourceCommit !== 'string' ||
      !COMMIT_RE.test(value.provenance.sourceCommit))
  ) {
    errors.push(`${location}: accepted event requires accepted commit provenance`);
  }
  if (value.checkpoint !== undefined) {
    if (
      !isRecord(value.checkpoint) ||
      typeof value.checkpoint.sha256 !== 'string' ||
      !BARE_SHA256_RE.test(value.checkpoint.sha256) ||
      typeof value.checkpoint.path !== 'string'
    ) {
      errors.push(`${location}: invalid checkpoint reference`);
    }
  }
  return errors;
}
