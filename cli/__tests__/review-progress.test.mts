import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { rootRegistry, testSpawnSync } from './_helpers.mts';

const PROGRESS_LIB = fileURLToPath(new URL('../lib/ship/review/progress.sh', import.meta.url));
const { mkTmp, cleanup } = rootRegistry();

afterEach(cleanup);

function bash(script: string, ...args: string[]) {
  const result = testSpawnSync('bash', ['-c', `. "$0"; ${script}`, PROGRESS_LIB, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe('review_heartbeat_interval (sc-2166)', () => {
  it.each([
    ['', '45'],
    ['soon', '45'],
    ['-1', '45'],
    ['1.5', '45'],
    [' 5', '45'],
    ['0', '0'],
    ['000', '0'],
    ['1', '1'],
    ['0045', '45'],
    ['2147483', '2147483'],
    ['2147484', '45'],
    ['00000002147483', '2147483'],
    ['9223372036854775807', '45'],
    // 2^64 and 2^63 wrap to 0 / negative under bash arithmetic: must fall back, never disable.
    ['18446744073709551616', '45'],
    ['9223372036854775808', '45'],
  ])('normalizes %j to %s', (raw, expected) => {
    expect(bash('review_heartbeat_interval "$1"', raw)).toBe(`${expected}\n`);
  });

  it('treats an unset value as the default', () => {
    expect(bash('review_heartbeat_interval')).toBe('45\n');
  });
});

describe('review_write_stage (sc-2166)', () => {
  it('never exposes an empty stage file to a concurrent reader', () => {
    const stage = join(mkTmp('devkit-review-progress-'), 'stage');
    // A truncate-then-write stage file showed ~480 empty reads out of this loop; rename shows none.
    const empty = bash(
      `f=$1
      review_write_stage "$f" start
      ( for i in $(seq 1 1500); do review_write_stage "$f" "preflight-verify:step-$i"; done ) &
      writer=$!
      empty=0
      while kill -0 "$writer" 2>/dev/null; do
        s=; IFS= read -r s < "$f" || s=
        [ -n "$s" ] || empty=$((empty + 1))
      done
      wait "$writer"
      IFS= read -r last < "$f"
      printf '%s %s\\n' "$empty" "$last"`,
      stage,
    );
    expect(empty).toBe('0 preflight-verify:step-1500\n');
  });

  it('leaves no temp file behind and is a silent no-op when the directory is gone', () => {
    const dir = mkTmp('devkit-review-progress-');
    const stage = join(dir, 'stage');
    expect(bash('review_write_stage "$1" gates; ls -A "$(dirname "$1")"', stage)).toBe('stage\n');
    expect(bash('review_write_stage "$1/missing/stage" gates; echo rc=$?', dir)).toBe('rc=0\n');
  });
});
