import { RuleTester } from 'oxlint/plugins-dev';
import { describe, it } from 'vitest';
import { noElapsedTimeAssertionsRule } from '../src/devkit/rules/no-elapsed-time-assertions.ts';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } });
const error = { messageId: 'elapsedTimeAssertion' };

tester.run('anti-slop/no-elapsed-time-assertions', noElapsedTimeAssertionsRule, {
  valid: [
    // A value the product reports is its own contract, not a measurement the test took.
    'expect(result.elapsedMs).toBeLessThanOrEqual(61_000);',
    'const started = Date.now(); expect(Math.abs(Date.now() - started)).toBeLessThan(60_000);',
    'const started = Date.now(); expect(Date.now() - started).toBe(1_000);',
    'let elapsed = Date.now() - started; elapsed = 0; expect(elapsed).toBeLessThan(5);',
    'const Date = { now: () => 1 }; expect(Date.now() - started).toBeLessThan(5);',
    'const performance = { now: () => 1 }; expect(performance.now() - started).toBeLessThan(5);',
    'expect(count - 1).toBeLessThan(3);',
    'expect(Number(seen.deadline)).toBeGreaterThan(Date.now());',
    'const started = Date.now(); assertWithin(Date.now() - started).toBeLessThan(5);',
    'const started = Date.now(); expect(Date.now() - started)[matcher](5);',
    // Deadlines of any size stay legal: the rule judges the subject, never a timeout or a constant.
    'expect(ALIGNMENT_JUDGE_TIMEOUT_MS).toBeGreaterThan(120_000);',
    'it("slow", async () => { await run(); }, Number.MAX_SAFE_INTEGER);',
    'spawnSync(cmd, { timeout: Number.MAX_SAFE_INTEGER });',
    'import { performance } from "./fake-clock"; expect(performance.now() - started).toBeLessThan(5);',
  ],
  invalid: [
    {
      code: 'expect(Date.now() - started).toBeLessThan(Number.MAX_SAFE_INTEGER);',
      errors: [error],
    },
    { code: 'expect(Date.now() - started).toBeGreaterThanOrEqual(0);', errors: [error] },
    {
      code: 'import { performance } from "node:perf_hooks"; expect(performance.now() - t).toBeLessThan(5);',
      errors: [error],
    },
    {
      code: 'import { performance as perf } from "perf_hooks"; const t = perf.now(); expect(perf.now() - t).toBeLessThan(5);',
      errors: [error],
    },
    // The subtrahend is unconstrained: a parameter or a deadline still makes a wall-clock budget.
    {
      code: 'function within(expiresAt: number) { expect(Date.now() - expiresAt).toBeLessThan(0); }',
      errors: [error],
    },
    // Fake timers are not exempt: a faked Date in hooks can sit beside a real-clock assertion.
    {
      code: 'vi.useFakeTimers(); const s = Date.now(); vi.advanceTimersByTime(10); expect(Date.now() - s).toBeGreaterThanOrEqual(10);',
      errors: [error],
    },
    {
      code: 'const started = Date.now(); expect(Date.now() - started).toBeLessThan(5_000);',
      errors: [error],
    },
    { code: 'expect(Date.now() - started).toBeLessThanOrEqual(5_000);', errors: [error] },
    { code: 'expect(Date.now() - started).toBeGreaterThan(1_200);', errors: [error] },
    { code: 'expect(Date.now() - started).toBeGreaterThanOrEqual(1_200);', errors: [error] },
    { code: 'expect(Date.now() - started).not.toBeGreaterThan(9);', errors: [error] },
    { code: 'expect.soft(Date.now() - started).toBeLessThan(9);', errors: [error] },
    {
      code: 'const elapsed = Date.now() - started; expect(elapsed, `stalled: ${elapsed}ms`).toBeLessThan(120_000);',
      errors: [error],
    },
    {
      code: 'const start = performance.now(); const end = performance.now(); expect(end - start).toBeGreaterThanOrEqual(1);',
      errors: [error],
    },
    { code: 'expect((Date.now() - started) as number).toBeLessThan(3_000);', errors: [error] },
    {
      code: 'it("x", async () => { const t = Date.now(); await run(); const ms = Date.now() - t; expect(ms).toBeLessThan(3_000); });',
      errors: [error],
    },
  ],
});
