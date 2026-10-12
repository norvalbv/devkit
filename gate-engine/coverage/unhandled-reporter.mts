// Names the unhandled errors vitest's frozen json reporter omits (vitest-dev/vitest#8669).
// Never throws: it runs inside the consumer's vitest.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Reporter, SerializedError, TestModule, Vitest } from 'vitest/node';

/** Written beside the json report, in the run directory only this run may touch. */
export const UNHANDLED_NAME = 'unhandled.json';

/** What ended a run that exited non-zero with no failed test. `file` is null when vitest did not say. */
export interface UnhandledError {
  file: string | null;
  message: string;
}

/** vitest's worker stamps the originating test file onto every unhandled error. */
type ReportedError = SerializedError & { VITEST_TEST_PATH?: string };

export default class UnhandledReporter implements Reporter {
  private out: string | null = null;

  onInit(vitest: Vitest): void {
    try {
      const { outputFile } = vitest.config;
      const json = outputFile instanceof Object ? outputFile.json : undefined;
      if (json) this.out = join(dirname(json), UNHANDLED_NAME);
    } catch {
      this.out = null;
    }
  }

  onTestRunEnd(_modules: ReadonlyArray<TestModule>, errors: ReadonlyArray<ReportedError>): void {
    if (!this.out || errors.length === 0) return;
    try {
      const entries = errors.map((e) => ({
        file: e.VITEST_TEST_PATH ?? null,
        message: `${e.name ?? 'Error'}: ${e.message ?? ''}`.split('\n')[0],
      }));
      writeFileSync(this.out, JSON.stringify(entries));
    } catch {
      /* diagnosis is a courtesy, not a guarantee */
    }
  }
}

/** The reporter's errors, once each (vitest projects repeat them), or one generic entry when it wrote
 * none: a threshold miss or an empty filter is no error at all, and an older vitest never calls it. */
export function readUnhandled(file: string, exitCode: number): UnhandledError[] {
  try {
    const parsed: UnhandledError[] = JSON.parse(readFileSync(file, 'utf8'));
    const unique = new Map(parsed.map((e) => [`${e.file}\0${e.message}`, e]));
    if (unique.size > 0) return [...unique.values()];
  } catch {
    /* absent or torn — fall through to the generic cause */
  }
  return [
    {
      file: null,
      message: `vitest exited ${exitCode} with no failed test — its output above names why: an unhandled error, a coverage threshold, or no test files matched`,
    },
  ];
}
