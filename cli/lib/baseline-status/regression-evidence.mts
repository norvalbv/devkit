import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

// Schema 1 described the superseded custom-reporter proof payload on the original PR branch.
// Schema 2 overclaimed caller preservation beyond the two samples the portable command observes.
export const REGRESSION_EVIDENCE_SCHEMA = 3;

export interface RegressionTestCounts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
}

export interface RegressionFailureSummary {
  fullName: string;
  message: string;
}

export interface RegressionReportSummary {
  success: boolean;
  counts: RegressionTestCounts;
  failures: RegressionFailureSummary[];
}

export interface RegressionOperandEvidence {
  requestedRef: string;
  sha: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError: boolean;
  stdoutFile: string;
  stderrFile: string;
  commandResultFile: string;
  stdoutSha256: string;
  stderrSha256: string;
  commandResultSha256: string;
  reportFile: string | null;
  reportSha256: string | null;
  reportError: string | null;
  testCounts: RegressionTestCounts | null;
  failures: RegressionFailureSummary[];
}

export interface RegressionEvidence {
  schema: typeof REGRESSION_EVIDENCE_SCHEMA;
  status: 'captured' | 'inconclusive';
  createdAt: string;
  reason: string;
  command: {
    argv: string[];
    callerPrefix: string;
    vitestReport: string | null;
  };
  red: RegressionOperandEvidence;
  green: RegressionOperandEvidence;
  dependency: { source: string | null; mutableStoreException: boolean };
  cleanup: { redCloneRemoved: boolean; greenCloneRemoved: boolean };
  callerBoundarySamples: { beforeSha256: string; afterSha256: string; matched: boolean };
}

type JsonValue = null | boolean | number | string | JsonValue[] | JsonRecord;

interface JsonRecord {
  [key: string]: JsonValue;
}

type NonFailureVitestStatus = 'passed' | 'todo' | 'skipped' | 'pending' | 'disabled';

type ParsedVitestAssertion =
  | { status: NonFailureVitestStatus }
  | { status: 'failed'; fullName: string; failureMessages: string[] };

interface ParsedVitestFile {
  assertionResults: ParsedVitestAssertion[];
}

interface ParsedVitestReport {
  success: boolean;
  counts: RegressionTestCounts;
  testResults: ParsedVitestFile[];
}

const MAX_FAILURES = 10;
const MAX_FAILURE_CHARS = 600;
const MAX_FAILURE_NAME_CHARS = 240;

function parseJson(raw: string): JsonValue {
  return JSON.parse(raw);
}

function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function isJsonString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === '[object String]';
}

function isJsonNumber(value: JsonValue | undefined): value is number {
  return Object.prototype.toString.call(value) === '[object Number]';
}

function integer(value: JsonValue | undefined, field: string): number {
  if (!isJsonNumber(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`Vitest report ${field} is not a non-negative integer`);
  }
  return value;
}

function parseVitestAssertion(value: JsonValue): ParsedVitestAssertion {
  if (!isJsonRecord(value)) {
    throw new Error('Vitest report contains an unknown assertion status');
  }
  const status = value.status;
  if (
    status !== 'passed' &&
    status !== 'failed' &&
    status !== 'todo' &&
    status !== 'skipped' &&
    status !== 'pending' &&
    status !== 'disabled'
  ) {
    throw new Error('Vitest report contains an unknown assertion status');
  }
  if (
    !isJsonString(value.fullName) ||
    !Array.isArray(value.failureMessages) ||
    !value.failureMessages.every(isJsonString)
  ) {
    throw new Error('Vitest report contains a malformed assertion');
  }
  if (status !== 'failed') return { status };
  return {
    status,
    fullName: value.fullName,
    failureMessages: value.failureMessages,
  };
}

function parseVitestFile(value: JsonValue): ParsedVitestFile {
  if (!isJsonRecord(value) || !Array.isArray(value.assertionResults)) {
    throw new Error('Vitest report assertionResults is not an array');
  }
  return { assertionResults: value.assertionResults.map(parseVitestAssertion) };
}

function parseVitestReport(json: string): ParsedVitestReport {
  const value = parseJson(json);
  if (
    !isJsonRecord(value) ||
    (value.success !== true && value.success !== false) ||
    !Array.isArray(value.testResults)
  ) {
    throw new Error('report is not a complete Vitest JSON result');
  }
  return {
    success: value.success,
    counts: {
      total: integer(value.numTotalTests, 'numTotalTests'),
      passed: integer(value.numPassedTests, 'numPassedTests'),
      failed: integer(value.numFailedTests, 'numFailedTests'),
      skipped: integer(value.numPendingTests, 'numPendingTests'),
      todo: integer(value.numTodoTests, 'numTodoTests'),
    },
    testResults: value.testResults.map(parseVitestFile),
  };
}

function boundedText(
  value: string,
  limit: number,
  checkoutRoot?: string,
  dependencySource?: string | null,
): string {
  let scrubbed = stripVTControlCharacters(value);
  for (const [root, replacement] of [
    [checkoutRoot, '<checkout>'],
    [dependencySource, '<dependency-store>'],
  ] as const) {
    if (!root) continue;
    for (const spelling of new Set([root, root.replaceAll('\\', '/'), pathToFileURL(root).href])) {
      scrubbed = scrubbed.split(spelling).join(replacement);
    }
  }
  const normalized = scrubbed.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

/** Parse Vitest's built-in JSON reporter, used only as an optional reviewer-facing adapter. */
export function parseVitestRegressionReport(
  json: string,
  checkoutRoot: string,
  dependencySource: string | null = null,
): RegressionReportSummary {
  const report = parseVitestReport(json);
  const { counts } = report;
  if (counts.passed + counts.failed + counts.skipped + counts.todo !== counts.total) {
    throw new Error('Vitest report test counts do not add up');
  }

  const failures: RegressionFailureSummary[] = [];
  const assertionCounts: RegressionTestCounts = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    todo: 0,
  };
  for (const file of report.testResults) {
    for (const assertion of file.assertionResults) {
      assertionCounts.total += 1;
      if (assertion?.status === 'passed') assertionCounts.passed += 1;
      else if (assertion?.status === 'failed') assertionCounts.failed += 1;
      else if (assertion?.status === 'todo') assertionCounts.todo += 1;
      else if (
        assertion?.status === 'skipped' ||
        assertion?.status === 'pending' ||
        assertion?.status === 'disabled'
      ) {
        assertionCounts.skipped += 1;
      }
      if (assertion.status !== 'failed') continue;
      const raw = assertion.failureMessages[0];
      failures.push({
        fullName:
          boundedText(assertion.fullName, MAX_FAILURE_NAME_CHARS, checkoutRoot, dependencySource) ||
          '(unnamed test)',
        message: boundedText(
          raw ?? '(no failure message)',
          MAX_FAILURE_CHARS,
          checkoutRoot,
          dependencySource,
        ),
      });
    }
  }
  if (
    assertionCounts.total !== counts.total ||
    assertionCounts.passed !== counts.passed ||
    assertionCounts.failed !== counts.failed ||
    assertionCounts.skipped !== counts.skipped ||
    assertionCounts.todo !== counts.todo
  ) {
    throw new Error('Vitest report aggregate counts do not match assertion results');
  }
  if (report.success && counts.failed > 0) {
    throw new Error('Vitest report success is true despite failed assertion results');
  }
  return { success: report.success, counts, failures: failures.slice(0, MAX_FAILURES) };
}

export function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function renderCounts(counts: RegressionTestCounts | null): string {
  if (!counts) return 'not supplied';
  return `${counts.total} total; ${counts.passed} passed; ${counts.failed} failed; ${counts.skipped} skipped; ${counts.todo} todo`;
}

function renderExit(operand: RegressionOperandEvidence): string {
  return operand.signal ? `signal ${operand.signal}` : String(operand.exitCode);
}

function inlineJson(value: string): string {
  const json = JSON.stringify(stripVTControlCharacters(value));
  const longest = Math.max(0, ...(json.match(/`+/g)?.map((run) => run.length) ?? []));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${json}${fence}`;
}

function fencedJson(value: readonly string[]): string {
  const json = JSON.stringify(value, null, 2);
  const longest = Math.max(0, ...(json.match(/~+/g)?.map((run) => run.length) ?? []));
  const fence = '~'.repeat(Math.max(3, longest + 1));
  return `${fence}json\n${json}\n${fence}`;
}

function renderFailures(failures: RegressionFailureSummary[]): string {
  if (failures.length === 0) return '- No structured red failure details supplied.';
  return failures
    .map((item) => `- ${inlineJson(item.fullName)} — ${inlineJson(item.message)}`)
    .join('\n');
}

function renderReport(operand: RegressionOperandEvidence, requestedPath: string | null): string {
  if (!requestedPath) return 'not requested';
  if (operand.reportError) return `warning: ${inlineJson(operand.reportError)}`;
  return operand.reportFile && operand.reportSha256
    ? `${inlineJson(operand.reportFile)} (SHA-256 \`${operand.reportSha256}\`)`
    : 'warning: requested report has no retained artifact';
}

/** PR-ready view. The JSON and retained logs remain the complete local evidence. */
export function renderRegressionEvidence(evidence: RegressionEvidence): string {
  const icon = evidence.status === 'captured' ? '✅' : '❌';
  return `# Regression evidence

${icon} **${evidence.status.toUpperCase()}** — ${evidence.reason}

## Exact experiment

- Red: \`${evidence.red.sha}\` (requested ${inlineJson(evidence.red.requestedRef)})
- Green: \`${evidence.green.sha}\` (requested ${inlineJson(evidence.green.requestedRef)})
- Working directory within each clone: ${inlineJson(evidence.command.callerPrefix || '.')}
- Caller source/Git boundary fingerprints matched: ${evidence.callerBoundarySamples.matched ? 'yes' : 'no'}

Command argv (JSON):

${fencedJson(evidence.command.argv)}

## Results

| Operand | Exit | Test counts | stdout SHA-256 | stderr SHA-256 | command-result SHA-256 |
| --- | ---: | --- | --- | --- | --- |
| Red | ${renderExit(evidence.red)} | ${renderCounts(evidence.red.testCounts)} | \`${evidence.red.stdoutSha256}\` | \`${evidence.red.stderrSha256}\` | \`${evidence.red.commandResultSha256}\` |
| Green | ${renderExit(evidence.green)} | ${renderCounts(evidence.green.testCounts)} | \`${evidence.green.stdoutSha256}\` | \`${evidence.green.stderrSha256}\` | \`${evidence.green.commandResultSha256}\` |

## Optional structured report

- Requested path: ${evidence.command.vitestReport ? inlineJson(evidence.command.vitestReport) : 'not requested'}
- Red: ${renderReport(evidence.red, evidence.command.vitestReport)}
- Green: ${renderReport(evidence.green, evidence.command.vitestReport)}

## Structured red failures

${renderFailures(evidence.red.failures)}

This is attributable execution evidence for the selected command, not automatic proof of causality
or whole-suite health. Review the red failure against the ticket before publishing this Markdown.
The complete stdout, stderr, optional Vitest reports, and authoritative JSON are retained beside it.
${evidence.dependency.mutableStoreException ? 'A caller dependency store was shared and is outside the caller-byte immutability claim; its exact local path is retained only in evidence.json.' : evidence.dependency.source ? 'The caller dependency store was copied independently into each operand; caller dependency bytes were not linked.' : 'No caller dependency store was linked.'}
`;
}
