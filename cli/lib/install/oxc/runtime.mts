/** Resolve and execute Devkit's pinned Oxc packages without PATH, hoisting, or global fallbacks. */

import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { packageDir } from '../../fs-helpers.mts';
import { ANTI_SLOP_EXECUTION_MODE_ENV, ANTI_SLOP_NATIVE_MODE } from '../anti-slop/constants.mts';

export type OxcTool = 'lint' | 'fmt';

const TOOL_PACKAGES: Record<OxcTool, { packageName: string; binName: string }> = {
  lint: { packageName: 'oxlint', binName: 'oxlint' },
  fmt: { packageName: 'oxfmt', binName: 'oxfmt' },
};
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

interface PackageManifest {
  version?: string;
  dependencies?: Record<string, string>;
  bin?: string | Record<string, string>;
}

export interface OxcRuntime {
  tool: OxcTool;
  packageName: string;
  expectedVersion: string;
  actualVersion: string;
  binPath: string;
}

export interface OxcProbe {
  ok: boolean;
  detail: string;
  runtime?: OxcRuntime;
}

type ResolvePackage = (specifier: string) => string;
type Spawn = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof spawnSync>[2],
) => SpawnSyncReturns<string | Buffer>;

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest;
}

function exactPin(packageName: string): string {
  const own = readManifest(join(packageDir(), 'package.json'));
  const pin = own.dependencies?.[packageName];
  if (!pin || !EXACT_VERSION.test(pin)) {
    throw new Error(
      `Devkit must declare an exact ${packageName} dependency (found ${pin ?? 'none'})`,
    );
  }
  return pin;
}

/** Resolve a tool from Devkit's own module graph, never the consumer's PATH or node_modules/.bin. */
export function resolveOxcRuntime(
  tool: OxcTool,
  resolvePackage: ResolvePackage = createRequire(import.meta.url).resolve,
): OxcRuntime {
  const descriptor = TOOL_PACKAGES[tool];
  const manifestPath = resolvePackage(`${descriptor.packageName}/package.json`);
  const manifest = readManifest(manifestPath);
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[descriptor.binName];
  if (!manifest.version || !bin) {
    throw new Error(`${descriptor.packageName} has no usable ${descriptor.binName} package bin`);
  }
  return {
    tool,
    packageName: descriptor.packageName,
    expectedVersion: exactPin(descriptor.packageName),
    actualVersion: manifest.version,
    binPath: join(dirname(manifestPath), bin),
  };
}

/** A bounded version probe used by doctor; it never loads a consumer config or JS plugin. */
export function probeOxcRuntime(
  tool: OxcTool,
  options: { resolvePackage?: ResolvePackage; spawn?: Spawn; timeoutMs?: number } = {},
): OxcProbe {
  let runtime: OxcRuntime;
  try {
    runtime = resolveOxcRuntime(tool, options.resolvePackage);
  } catch (error: unknown) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  if (runtime.actualVersion !== runtime.expectedVersion) {
    return {
      ok: false,
      runtime,
      detail: `${runtime.packageName} ${runtime.actualVersion} != pinned ${runtime.expectedVersion}`,
    };
  }
  const spawn = options.spawn ?? spawnSync;
  const result = spawn(process.execPath, [runtime.binPath, '--version'], {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 5_000,
  });
  if (result.status !== 0) {
    const reason =
      result.error?.message || result.stderr?.toString().trim() || `exit ${result.status}`;
    return {
      ok: false,
      runtime,
      detail: `${runtime.packageName}@${runtime.expectedVersion} unusable: ${reason.split('\n')[0]}`,
    };
  }
  return {
    ok: true,
    runtime,
    detail: `${runtime.packageName}@${runtime.actualVersion} (${result.stdout?.toString().trim()})`,
  };
}

/** Execute the real Oxc CLI with argv/cwd/stdin/out unchanged and return its exit status. */
export function runOxcRuntime(tool: OxcTool, args: string[], cwd: string): number {
  let runtime: OxcRuntime;
  try {
    runtime = resolveOxcRuntime(tool);
  } catch (error: unknown) {
    console.error(`devkit oxc ${tool}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const result = spawnSync(process.execPath, [runtime.binPath, ...args], {
    cwd,
    env:
      tool === 'lint'
        ? { ...process.env, [ANTI_SLOP_EXECUTION_MODE_ENV]: ANTI_SLOP_NATIVE_MODE }
        : process.env,
    stdio: 'inherit',
  });
  if (result.status !== null) return result.status;
  const reason =
    result.error?.message || (result.signal ? `terminated by ${result.signal}` : 'failed');
  console.error(`devkit oxc ${tool}: ${runtime.packageName}@${runtime.actualVersion} ${reason}`);
  return 1;
}
