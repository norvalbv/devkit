import type { Reporter } from 'vitest/node';

// The skip note every bash >= 4-only test passes to ctx.skip, and the key the reporter counts by.
export const MODERN_BASH_SKIP_NOTE =
  'needs bash >= 4: brew install bash, or bun run test:linux-bash <file>';

/** The slice of vitest's TestModule read here, so tests can pass plain objects. */
type SkipSource = {
  children: { allTests(state: 'skipped'): Iterable<{ result(): { note?: string } }> };
};

export function countModernBashSkips(testModules: ReadonlyArray<SkipSource>) {
  let count = 0;
  for (const testModule of testModules) {
    for (const test of testModule.children.allTests('skipped')) {
      if (test.result().note === MODERN_BASH_SKIP_NOTE) count++;
    }
  }
  return count;
}

export function formatModernBashSkipLine(count: number) {
  return `devkit test bash: ${count} tests need bash >= 4 and were skipped — brew install bash, or bun run test:linux-bash <files>`;
}

/** A run on macOS's bash 3.2 otherwise reads "N skipped", which looks green. */
export default class ModernBashSkipReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<SkipSource>) {
    const count = countModernBashSkips(testModules);
    if (count > 0) console.error(formatModernBashSkipLine(count));
  }
}
