import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectMerged } from '../lib/reconcile.mts';

// The reconcile suite (reconcile.test.mts) drives real git subprocesses and stubs the merge verdict
// via the DEVKIT_RECONCILE_MERGED_OVERRIDE seam — so it returns BEFORE the gh call and never sees the
// argv. That blind spot let `gh pr view --head <branch>` (an invalid flag; --head is `gh pr list`'s)
// ship and silently degrade every pr:null lookup to UNKNOWN. This isolated file mocks child_process so
// it can assert the exact argv; keep the mock OUT of reconcile.test.mts, whose real gits need it live.
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
const mockExec = vi.mocked(execFileSync);

describe('detectMerged — gh argv', () => {
  beforeEach(() => {
    delete process.env.DEVKIT_RECONCILE_MERGED_OVERRIDE; // else the VITEST seam short-circuits before the gh call
    delete process.env.DEVKIT_RECONCILE_DEBUG;
    mockExec.mockReset();
  });

  it('looks a pr:null branch up POSITIONALLY, never via the invalid `gh pr view --head`', () => {
    mockExec.mockReturnValue('MERGED\n');
    expect(detectMerged({ repo: 'o/r', prNumber: null, branch: 'feat' })).toBe('MERGED');
    const call = mockExec.mock.calls[0];
    expect(call?.[0]).toBe('gh');
    expect(call?.[1] as string[]).toEqual([
      'pr',
      'view',
      'feat',
      '--repo',
      'o/r',
      '--json',
      'state',
      '-q',
      '.state',
    ]);
    expect(call?.[1] as string[]).not.toContain('--head');
  });

  it('uses the PR number positionally when present', () => {
    mockExec.mockReturnValue('MERGED\n');
    detectMerged({ repo: 'o/r', prNumber: 42, branch: 'feat' });
    const args = mockExec.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(['pr', 'view', '42', '--repo', 'o/r', '--json', 'state', '-q', '.state']);
    expect(args).not.toContain('--head');
  });

  it('maps a non-MERGED state to OPEN and any gh failure to UNKNOWN', () => {
    mockExec.mockReturnValueOnce('OPEN\n');
    expect(detectMerged({ repo: 'o/r', prNumber: 1, branch: 'feat' })).toBe('OPEN');
    mockExec.mockImplementationOnce(() => {
      throw new Error('gh boom');
    });
    expect(detectMerged({ repo: 'o/r', prNumber: 1, branch: 'feat' })).toBe('UNKNOWN');
  });

  it('collapses CLOSED (closed-unmerged) to OPEN, not MERGED — only a true merge restores/prunes', () => {
    mockExec.mockReturnValue('CLOSED\n');
    expect(detectMerged({ repo: 'o/r', prNumber: 1, branch: 'feat' })).toBe('OPEN');
  });
});

describe('detectMerged — DEVKIT_RECONCILE_DEBUG stderr seam', () => {
  beforeEach(() => {
    delete process.env.DEVKIT_RECONCILE_MERGED_OVERRIDE;
    mockExec.mockReset();
  });
  afterEach(() => {
    delete process.env.DEVKIT_RECONCILE_DEBUG;
  });

  it('keeps stderr silent (stdio ignore) and never logs on the happy path when debug is off', () => {
    delete process.env.DEVKIT_RECONCILE_DEBUG;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExec.mockReturnValue('MERGED\n');
    expect(detectMerged({ repo: 'o/r', prNumber: 1, branch: 'feat' })).toBe('MERGED');
    expect((mockExec.mock.calls[0]?.[2] as { stdio?: unknown }).stdio).toEqual([
      'ignore',
      'pipe',
      'ignore',
    ]);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('stays quiet on a gh failure when debug is off', () => {
    delete process.env.DEVKIT_RECONCILE_DEBUG;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExec.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(detectMerged({ repo: 'o/r', prNumber: 1, branch: 'feat' })).toBe('UNKNOWN');
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('when debug is on, pipes stderr and returns the state unchanged on success (no log)', () => {
    process.env.DEVKIT_RECONCILE_DEBUG = '1';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExec.mockReturnValue('MERGED\n');
    expect(detectMerged({ repo: 'o/r', prNumber: 1, branch: 'feat' })).toBe('MERGED');
    expect((mockExec.mock.calls[0]?.[2] as { stdio?: unknown }).stdio).toEqual([
      'ignore',
      'pipe',
      'pipe',
    ]);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('when debug is on, surfaces gh stderr and still returns UNKNOWN', () => {
    process.env.DEVKIT_RECONCILE_DEBUG = '1';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExec.mockImplementation(() => {
      const e = new Error('Command failed');
      (e as unknown as { stderr: string }).stderr = 'gh: could not resolve to a Repository';
      throw e;
    });
    expect(detectMerged({ repo: 'o/r', prNumber: 1, branch: 'feat' })).toBe('UNKNOWN');
    expect(errSpy).toHaveBeenCalledOnce();
    expect(errSpy.mock.calls[0]?.[0]).toContain('could not resolve to a Repository');
    errSpy.mockRestore();
  });

  it('when debug is on and the error carries no stderr, logs the message and does not crash', () => {
    process.env.DEVKIT_RECONCILE_DEBUG = '1';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExec.mockImplementation(() => {
      throw new Error('spawn gh ENOENT');
    });
    expect(detectMerged({ repo: 'o/r', prNumber: null, branch: 'feat' })).toBe('UNKNOWN');
    expect(errSpy).toHaveBeenCalledOnce();
    expect(errSpy.mock.calls[0]?.[0]).toContain('spawn gh ENOENT');
    errSpy.mockRestore();
  });
});
