import { describe, expect, it } from 'vitest';
import { parseTimeOutput, timeArguments } from '../performance/time.mts';

const request = {
  platform: 'darwin' as const,
  executable: '/usr/bin/true',
  args: [],
  cwd: '/tmp/fixture',
  environment: {},
  stdoutPath: '/tmp/stdout',
  stderrPath: '/tmp/stderr',
  timingPath: '/tmp/time',
};

describe('performance time adapter', () => {
  it('parses Darwin bytes and wait-accounted CPU', () => {
    expect(
      parseTimeOutput(
        'darwin',
        'real 0.10\nuser 0.07\nsys 0.02\n  1179648  maximum resident set size\n',
      ),
    ).toEqual({ userSeconds: 0.07, systemSeconds: 0.02, maxResidentSetBytes: 1_179_648 });
    expect(timeArguments(request).slice(0, 4)).toEqual(['-p', '-l', '-o', '/tmp/time']);
  });

  it('converts GNU time KiB to bytes', () => {
    expect(parseTimeOutput('linux', 'real 0.10\nuser 0.06\nsys 0.03\nmaxrss_kib 2048\n')).toEqual({
      userSeconds: 0.06,
      systemSeconds: 0.03,
      maxResidentSetBytes: 2_097_152,
    });
    expect(timeArguments({ ...request, platform: 'linux' })[0]).toBe('-f');
  });

  it('fails closed when the platform output lacks memory accounting', () => {
    expect(() => parseTimeOutput('darwin', 'real 0.1\nuser 0.1\nsys 0.0\n')).toThrow(
      /maximum resident set size/,
    );
  });
});
