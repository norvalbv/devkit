import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JUDGE_TIMEOUT_MS, judgeUiVisible } from '../judge.mts';

const judge = vi.fn<(opts: { timeout: number }) => string | null>();

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ui-evidence-judge-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

describe('judgeUiVisible', () => {
  beforeEach(() => judge.mockReset());

  it('spawns the judge with its own timeout, not the deep-judge ceiling', () => {
    judge.mockReturnValue('Prices change.\nVERDICT: VISIBLE');
    expect(judgeUiVisible(repo(), 'diff', 'haiku', judge)).toEqual({
      visible: true,
      why: 'Prices change.',
    });
    expect(judge.mock.calls[0]?.[0].timeout).toBe(JUDGE_TIMEOUT_MS);
  });

  it('a timed-out judge gives no verdict and is asked again next run', () => {
    judge.mockReturnValue(null);
    const dir = repo();
    expect(judgeUiVisible(dir, 'diff', 'haiku', judge)).toBeNull();
    expect(judgeUiVisible(dir, 'diff', 'haiku', judge)).toBeNull();
    expect(judge).toHaveBeenCalledTimes(2);
  });
});
