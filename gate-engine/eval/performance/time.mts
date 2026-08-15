export interface TimeMetrics {
  userSeconds: number;
  systemSeconds: number;
  maxResidentSetBytes: number;
}

export interface MeasurementRequest {
  platform: NodeJS.Platform;
  executable: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  stdoutPath: string;
  stderrPath: string;
  timingPath: string;
}

export interface MeasurementResult extends TimeMetrics {
  wallSeconds: number;
  exitCode: number;
  signal: NodeJS.Signals | null;
}

const REAL_LINE = /^real\s+([0-9.]+)$/m;
const USER_LINE = /^user\s+([0-9.]+)$/m;
const SYSTEM_LINE = /^sys\s+([0-9.]+)$/m;
const DARWIN_RSS_LINE = /^\s*(\d+)\s+maximum resident set size$/m;
const LINUX_RSS_LINE = /^maxrss_kib\s+(\d+)$/m;

function number(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`Invalid ${label} from /usr/bin/time`);
  return parsed;
}

export function timeArguments(request: MeasurementRequest): string[] {
  if (request.platform === 'darwin') {
    return ['-p', '-l', '-o', request.timingPath, request.executable, ...request.args];
  }
  if (request.platform === 'linux') {
    return [
      '-f',
      'real %e\nuser %U\nsys %S\nmaxrss_kib %M',
      '-o',
      request.timingPath,
      request.executable,
      ...request.args,
    ];
  }
  throw new Error(`Unsupported performance benchmark platform: ${request.platform}`);
}

export function parseTimeOutput(platform: NodeJS.Platform, output: string): TimeMetrics {
  const real = REAL_LINE.exec(output)?.[1];
  const user = USER_LINE.exec(output)?.[1];
  const system = SYSTEM_LINE.exec(output)?.[1];
  if (real === undefined) throw new Error('Missing monotonic cross-check from /usr/bin/time');
  number(real, 'real seconds');
  const rss =
    platform === 'darwin' ? DARWIN_RSS_LINE.exec(output)?.[1] : LINUX_RSS_LINE.exec(output)?.[1];
  if (rss === undefined) throw new Error('Missing maximum resident set size from /usr/bin/time');
  return {
    userSeconds: number(user, 'user seconds'),
    systemSeconds: number(system, 'system seconds'),
    maxResidentSetBytes:
      number(rss, 'maximum resident set size') * (platform === 'linux' ? 1024 : 1),
  };
}
