/** `devkit baseline-status --test`: one test's verdict, from the names a FAILED file recorded. */
import type { FileTests, TestReportSummary } from './produce.mts';
import type { FileStatus } from './query.mts';

export type TestStatus = 'passed' | 'failed' | 'file-passed' | 'unknown';

export interface TestAnswer {
  /** The name as compared, after the console's `<file> > ` prefix is stripped. */
  name: string;
  status: TestStatus;
  reason?: string;
}

/** The failed file's CI failing test names, carried on the per-file answer. */
export interface FailingTests {
  failingTests?: string[];
  failingTestsTruncated?: true;
}

/** Why a failed file has no names: an artifact without per-test data, or the summary's budget. */
type NoNames = { missing: 'no-data' | 'not-recorded' };

/** The console prints `<file> > describe > test`; the summary stores `describe > test`. */
export function normaliseTestName(name: string, path: string): string {
  const prefix = `${path} > `;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** A failed file's recorded names. parseSummary has already dropped a malformed `tests` map. */
function recordedTests(summary: TestReportSummary, path: string): FileTests | NoNames {
  if (!summary.tests) return { missing: 'no-data' };
  if (!Object.hasOwn(summary.tests, path)) return { missing: 'not-recorded' };
  return summary.tests[path];
}

export function failingTestsOf(summary: TestReportSummary, path: string): FailingTests {
  const tests = recordedTests(summary, path);
  if ('missing' in tests) return {};
  return tests.truncated
    ? { failingTests: tests.failed, failingTestsTruncated: true }
    : { failingTests: tests.failed };
}

/** One test's answer, given its file's status in the same run. */
export function testVerdict(
  summary: TestReportSummary,
  fileStatus: FileStatus,
  path: string,
  rawName: string,
): TestAnswer {
  const name = normaliseTestName(rawName, path);
  const unknown = (reason: string): TestAnswer => ({ name, status: 'unknown', reason });
  if (fileStatus === 'passed') {
    return {
      name,
      status: 'file-passed',
      reason: 'the file passed; test names are recorded only for failed files',
    };
  }
  if (fileStatus !== 'failed') return unknown(`the file is ${fileStatus} in this run`);
  const tests = recordedTests(summary, path);
  if ('missing' in tests) {
    return unknown(
      tests.missing === 'no-data'
        ? 'this run recorded no test names (its producer does not record them, or predates them)'
        : 'names for this file exceeded the summary budget',
    );
  }
  if (tests.failed.includes(name)) return { name, status: 'failed' };
  if (tests.passed.includes(name)) return { name, status: 'passed' };
  const capped = tests.truncated ? "; this file's name list was capped" : '';
  return unknown(`not in this run's report (misspelt, renamed, skipped or not collected${capped})`);
}
