/** corpus-lint's summary must count every diagnostic it printed. Assertions are relations, not
 * counts, so they hold whatever state the real corpora are in. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../corpus/corpus-lint.mts', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const SUMMARY =
  /^corpus-lint: (\d+) row\(s\) across the reviewer corpora, (\d+) problem\(s\)(?:, (\d+) warning\(s\))?$/;

function lint(strict) {
  const env = { ...process.env };
  if (strict) env.DEVKIT_HOLDOUT_FLOOR_STRICT = '1';
  else delete env.DEVKIT_HOLDOUT_FLOOR_STRICT;
  const run = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 60000,
  });
  const lines = run.stderr.trim().split('\n');
  const m = SUMMARY.exec(lines.at(-1));
  expect(m, `summary line: ${lines.at(-1)}`).not.toBeNull();
  return {
    status: run.status,
    warningLines: lines.filter((l) => l.startsWith('corpus-lint: WARNING ')).length,
    rows: Number(m[1]),
    problems: Number(m[2]),
    suffix: m[3] !== undefined,
    warnings: Number(m[3] ?? 0),
  };
}

describe('corpus-lint summary', () => {
  const loose = lint(false);
  const strict = lint(true);

  it('counts every WARNING line it printed, and omits the suffix only when there are none', () => {
    expect(loose.warnings).toBe(loose.warningLines);
    expect(loose.suffix).toBe(loose.warningLines > 0);
  });

  it('keeps the zero-warning line unchanged: strict mode prints no WARNING lines and no suffix', () => {
    expect(strict.warningLines).toBe(0);
    expect(strict.suffix).toBe(false);
  });

  it('turns each warning into exactly one problem under strict mode, over the same rows', () => {
    expect(strict.rows).toBe(loose.rows);
    expect(strict.problems).toBe(loose.problems + loose.warnings);
  });

  it('blocks only on problems — warnings alone exit 0', () => {
    expect(loose.status !== 0).toBe(loose.problems > 0);
    expect(strict.status !== 0).toBe(strict.problems > 0);
  });
});
