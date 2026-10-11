import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

// Schema 1 described the superseded custom-reporter proof payload on the original PR branch.
// Schema 2 overclaimed caller preservation beyond the two samples the portable command observes.
// Schema 3 counted a red file that failed to load as red evidence.
export const REGRESSION_EVIDENCE_SCHEMA = 4;
export const SKIPPED_ON_GREEN = 'every red-failing test was skipped on green';

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

/** One test's outcome keyed by checkout-relative file and full name; skips and todos read skipped. */
export type RegressionTestOutcomes = Map<string, 'passed' | 'failed' | 'skipped'>;

// A repeated name keeps its worst outcome, so a later pass never hides an earlier failure.
const OUTCOME_RANK = { passed: 0, skipped: 1, failed: 2 } as const;

export interface RegressionReportSummary {
  success: boolean;
  counts: RegressionTestCounts;
  failures: RegressionFailureSummary[];
  fileErrors: RegressionFailureSummary[];
  tests: RegressionTestOutcomes;
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
  fileErrors: RegressionFailureSummary[];
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

interface ParsedVitestAssertion {
  status: NonFailureVitestStatus | 'failed';
  fullName: string;
  failureMessages: string[];
}

interface ParsedVitestFile {
  name: string;
  status: string;
  message: string;
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
  return { status, fullName: value.fullName, failureMessages: value.failureMessages };
}

function parseVitestFile(value: JsonValue): ParsedVitestFile {
  if (!isJsonRecord(value) || !Array.isArray(value.assertionResults)) {
    throw new Error('Vitest report assertionResults is not an array');
  }
  const message = value.message ?? '';
  if (!isJsonString(value.name) || !isJsonString(value.status) || !isJsonString(message)) {
    throw new Error('Vitest report contains a malformed test file result');
  }
  return {
    name: value.name,
    status: value.status,
    message,
    assertionResults: value.assertionResults.map(parseVitestAssertion),
  };
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

function scrubRoots(value: string, checkoutRoot?: string, dependencySource?: string | null) {
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
  return scrubbed;
}

function boundedText(
  value: string,
  limit: number,
  checkoutRoot?: string,
  dependencySource?: string | null,
): string {
  const normalized = scrubRoots(value, checkoutRoot, dependencySource).replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

/** A file that failed with no failed assertion: it did not load, or a hook threw before any test. */
function fileError(file: ParsedVitestFile, root: string, dependencySource: string | null) {
  if (file.status !== 'failed' || file.assertionResults.some((a) => a.status === 'failed')) {
    return null;
  }
  return {
    fullName: boundedText(file.name, MAX_FAILURE_NAME_CHARS, root, dependencySource),
    message: boundedText(file.message || '(no message)', MAX_FAILURE_CHARS, root, dependencySource),
  };
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
  const fileErrors: RegressionFailureSummary[] = [];
  const tests: RegressionTestOutcomes = new Map();
  const assertionCounts: RegressionTestCounts = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    todo: 0,
  };
  for (const file of report.testResults) {
    const error = fileError(file, checkoutRoot, dependencySource);
    if (error) fileErrors.push(error);
    const fileKey = scrubRoots(file.name, checkoutRoot);
    for (const assertion of file.assertionResults) {
      const { status } = assertion;
      const outcome = status === 'passed' || status === 'failed' ? status : 'skipped';
      const key = `${fileKey}\0${assertion.fullName}`;
      const prior = tests.get(key);
      if (!prior || OUTCOME_RANK[outcome] > OUTCOME_RANK[prior]) tests.set(key, outcome);
      assertionCounts.total += 1;
      if (assertion.status === 'passed') assertionCounts.passed += 1;
      else if (assertion.status === 'failed') assertionCounts.failed += 1;
      else if (assertion.status === 'todo') assertionCounts.todo += 1;
      else assertionCounts.skipped += 1;
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
  return {
    success: report.success,
    counts,
    failures: failures.slice(0, MAX_FAILURES),
    fileErrors: fileErrors.slice(0, MAX_FAILURES),
    tests,
  };
}

export interface RegressionConclusion {
  status: RegressionEvidence['status'];
  reason: string;
}

/** With a report, only an assertion that failed on red and passed on green is red evidence. */
function concludeFromTests(
  red: RegressionOperandEvidence,
  tests: { red: RegressionTestOutcomes; green: RegressionTestOutcomes },
): RegressionConclusion {
  const failing = [...tests.red].filter(([, outcome]) => outcome === 'failed').map(([id]) => id);
  if (failing.length === 0) {
    const reason = red.fileErrors.length
      ? 'red failed only at file level (a load, collection or hook error), never in an assertion'
      : 'red exited nonzero without a failed assertion';
    return { status: 'inconclusive', reason };
  }
  const fixed = failing.filter((id) => tests.green.get(id) === 'passed').length;
  if (fixed > 0) {
    return {
      status: 'captured',
      reason: `${fixed} of ${failing.length} red-failing tests passed on green`,
    };
  }
  if (failing.every((id) => tests.green.get(id) === 'skipped')) {
    return { status: 'inconclusive', reason: SKIPPED_ON_GREEN };
  }
  return { status: 'inconclusive', reason: 'no red-failing test passed on green' };
}

export function concludeRegression(
  red: RegressionOperandEvidence,
  green: RegressionOperandEvidence,
  tests: { red: RegressionTestOutcomes; green: RegressionTestOutcomes } | null,
  callerSamplesMatched: boolean,
  cleanup: RegressionEvidence['cleanup'],
): RegressionConclusion {
  if (!callerSamplesMatched) {
    return { status: 'inconclusive', reason: 'caller boundary fingerprints differ' };
  }
  if (!cleanup.redCloneRemoved || !cleanup.greenCloneRemoved) {
    return { status: 'inconclusive', reason: 'a disposable clone could not be removed' };
  }
  if (red.signal || green.signal) {
    return { status: 'inconclusive', reason: 'a test command ended from a signal' };
  }
  if (red.spawnError || green.spawnError) {
    return { status: 'inconclusive', reason: 'a test command could not be started' };
  }
  if (red.reportError || green.reportError) {
    return { status: 'inconclusive', reason: 'a requested structured report was unavailable' };
  }
  if (red.exitCode === null || red.exitCode === 0 || green.exitCode !== 0) {
    return {
      status: 'inconclusive',
      reason: `expected red nonzero and green zero; got ${String(red.exitCode)}/${String(green.exitCode)}`,
    };
  }
  if (tests) return concludeFromTests(red, tests);
  return {
    status: 'captured',
    reason: `the same argv exited ${red.exitCode} on red and 0 on green`,
  };
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

export function inlineJson(value: string): string {
  const json = JSON.stringify(stripVTControlCharacters(value));
  const longest = Math.max(0, ...(json.match(/`+/g)?.map((run) => run.length) ?? []));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${json}${fence}`;
}

export function fencedJson(value: readonly string[]): string {
  const json = JSON.stringify(value, null, 2);
  const longest = Math.max(0, ...(json.match(/~+/g)?.map((run) => run.length) ?? []));
  const fence = '~'.repeat(Math.max(3, longest + 1));
  return `${fence}json\n${json}\n${fence}`;
}

function renderFailures(failures: RegressionFailureSummary[], none: string): string {
  if (failures.length === 0) return `- ${none}`;
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

${renderFailures(evidence.red.failures, 'No structured red failure details supplied.')}

Red file-level errors (not counted as red evidence):

${renderFailures(evidence.red.fileErrors, 'None.')}

This is attributable execution evidence for the selected command, not automatic proof of causality
or whole-suite health. Review the red failure against the ticket before publishing this Markdown.
The complete stdout, stderr, optional Vitest reports, and authoritative JSON are retained beside it.
${evidence.dependency.mutableStoreException ? 'A caller dependency store was shared and is outside the caller-byte immutability claim; its exact local path is retained only in evidence.json.' : evidence.dependency.source ? 'The caller dependency store was copied independently into each operand; caller dependency bytes were not linked.' : 'No caller dependency store was linked.'}
`;
}
