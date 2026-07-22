import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  context,
  createRepository,
  temporaryDirectory,
} from '../__tests__/repository-context-fixture.mts';
import { REVIEWED_RESPONSE } from '../__tests__/response-fixture.mts';
import {
  listPlanCritiqueRecordMetadata,
  readPlanCritiqueExactResponse,
  readPlanCritiqueProjection,
  readPlanCritiqueTranscript,
} from '../evidence-store.mts';
import { getPlanCritiqueWorkQuarantine } from '../lifecycle/work-quarantine.mts';
import { deriveClaudePlanCritiqueWorkId } from '../provider-adapters/claude-subagent-stop.mts';

const MAX_HOOK_INPUT_BYTES = 4 * 1024 * 1024;
const wrapper = path.join(import.meta.dirname, 'claude-subagent-stop.mts');
const response = JSON.stringify(REVIEWED_RESPONSE);

function evidenceRoot(home: string): string {
  return path.join(home, '.devkit', 'evidence', 'plan-critiques', 'v1');
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: 'SubagentStop',
    session_id: 'session-1',
    prompt_id: 'prompt-1',
    stop_hook_active: false,
    agent_id: 'agent-1',
    agent_type: 'feature-critique',
    last_assistant_message: response,
    cwd: '/untrusted/repository',
    repository: { fingerprint: '0'.repeat(64), branch: 'forged', head: '0'.repeat(40) },
    ...overrides,
  };
}

function hookEnvironment(home: string, telemetry?: string): NodeJS.ProcessEnv {
  const environment = { ...process.env, HOME: home };
  if (telemetry === undefined) delete environment.DEVKIT_NO_TELEMETRY;
  else environment.DEVKIT_NO_TELEMETRY = telemetry;
  return environment;
}

function runHook(
  cwd: string,
  home: string,
  input: Uint8Array | string,
  telemetry?: string,
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [wrapper], {
    cwd,
    env: hookEnvironment(home, telemetry),
    input,
    maxBuffer: 1024,
  });
}

function runHookFromFile(
  cwd: string,
  home: string,
  input: Uint8Array | string,
  telemetry?: string,
): ReturnType<typeof spawnSync> {
  const file = path.join(temporaryDirectory('critique-wrapper-input-'), 'input');
  writeFileSync(file, input);
  const descriptor = openSync(file, 'r');
  try {
    return spawnSync(process.execPath, [wrapper], {
      cwd,
      env: hookEnvironment(home, telemetry),
      stdio: [descriptor, 'pipe', 'pipe'],
    });
  } finally {
    closeSync(descriptor);
  }
}

function expectSilentSuccess(result: ReturnType<typeof spawnSync>): void {
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  expect(result.stdout).toEqual(Buffer.alloc(0));
  expect(result.stderr).toEqual(Buffer.alloc(0));
}

async function runWithOpenStdin(
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }> {
  const child = spawn(process.execPath, args, {
    cwd,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('wrapper waited for stdin'));
    }, 2_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

describe('Claude plan critique runtime wrapper', () => {
  it('captures an at-limit payload in the neutral root using only cwd repository facts', () => {
    const repository = createRepository('git@github.com:owner/example.git');
    const repositoryContext = context(repository);
    const home = temporaryDirectory('critique-wrapper-home-');
    const serialized = JSON.stringify(payload());
    const padding = MAX_HOOK_INPUT_BYTES - Buffer.byteLength(serialized, 'utf8');
    expect(padding).toBeGreaterThan(0);
    const result = runHookFromFile(repository, home, `${serialized}${' '.repeat(padding)}`, 'true');

    expectSilentSuccess(result);
    const root = evidenceRoot(home);
    const records = listPlanCritiqueRecordMetadata({ root });
    expect(records).toHaveLength(1);
    const record = records[0];
    if (!record) throw new Error('capture record missing');
    expect(record).toMatchObject({
      workId: deriveClaudePlanCritiqueWorkId('session-1', 'prompt-1'),
      execution: { provider: 'claude', model: null, promptHash: null },
      repository: {
        fingerprint: repositoryContext.fingerprint,
        fingerprintSource: repositoryContext.fingerprintSource,
        branch: repositoryContext.branch,
        head: repositoryContext.head,
      },
      contract: { state: 'valid', status: 'reviewed' },
    });
    expect(readPlanCritiqueExactResponse(record.critiqueId, { root })?.toString('utf8')).toBe(
      response,
    );
    expect(readPlanCritiqueProjection(record.critiqueId, { root })).not.toBeNull();
    expect(readPlanCritiqueTranscript(record.critiqueId, { root })).toBeNull();
    expect(existsSync(path.join(repository, '.devkit', 'evidence'))).toBe(false);
    for (const providerDirectory of ['.claude', '.cursor', '.codex'])
      expect(existsSync(path.join(repository, providerDirectory))).toBe(false);
  });

  it('durably quarantines hook continuations without creating a critique record', () => {
    const repository = createRepository();
    const repositoryContext = context(repository);
    const home = temporaryDirectory('critique-wrapper-quarantine-home-');
    const result = runHook(
      repository,
      home,
      JSON.stringify(
        payload({
          stop_hook_active: true,
          agent_id: undefined,
          last_assistant_message: undefined,
        }),
      ),
    );

    expectSilentSuccess(result);
    const root = evidenceRoot(home);
    const workId = deriveClaudePlanCritiqueWorkId('session-1', 'prompt-1');
    expect(
      getPlanCritiqueWorkQuarantine(
        {
          provider: 'claude',
          repositoryFingerprint: repositoryContext.fingerprint,
          workId,
        },
        { root },
      ),
    ).toMatchObject({ status: 'quarantined', quarantine: { workId, reason: 'hook_continuation' } });
    expect(listPlanCritiqueRecordMetadata({ root })).toEqual([]);
  });

  it.each([
    { name: 'unsupported callback', input: JSON.stringify(payload({ agent_type: 'other' })) },
    { name: 'malformed JSON', input: '{' },
  ])('silently skips $name without creating evidence', ({ input }) => {
    const repository = createRepository();
    const home = temporaryDirectory('critique-wrapper-skipped-home-');
    expectSilentSuccess(runHook(repository, home, input));
    expect(existsSync(evidenceRoot(home))).toBe(false);
  });

  it('fatally rejects non-UTF-8 bytes in an otherwise capturable payload', () => {
    const repository = createRepository();
    const home = temporaryDirectory('critique-wrapper-non-utf8-home-');
    const input = Buffer.from(
      JSON.stringify(payload({ ignored: 'INVALID_UTF8_SENTINEL' })),
      'utf8',
    );
    const invalidByte = input.indexOf('INVALID_UTF8_SENTINEL');
    expect(invalidByte).toBeGreaterThan(0);
    input[invalidByte] = 0xff;

    expectSilentSuccess(runHook(repository, home, input));
    expect(existsSync(evidenceRoot(home))).toBe(false);
  });

  it('bounds oversized stdin without creating evidence', () => {
    const repository = createRepository();
    const home = temporaryDirectory('critique-wrapper-oversized-home-');
    const unpadded = JSON.stringify(payload({ ignored: '' }));
    const padding = MAX_HOOK_INPUT_BYTES + 1 - Buffer.byteLength(unpadded, 'utf8');
    expect(padding).toBeGreaterThan(0);
    const input = JSON.stringify(payload({ ignored: 'x'.repeat(padding) }));
    expect(Buffer.byteLength(input, 'utf8')).toBe(MAX_HOOK_INPUT_BYTES + 1);
    const result = runHookFromFile(repository, home, input);

    expectSilentSuccess(result);
    expect(existsSync(evidenceRoot(home))).toBe(false);
  });

  it('silently skips a valid payload outside a repository', () => {
    const cwd = temporaryDirectory('critique-wrapper-outside-repo-');
    const home = temporaryDirectory('critique-wrapper-outside-home-');
    expectSilentSuccess(runHook(cwd, home, JSON.stringify(payload())));
    expect(existsSync(evidenceRoot(home))).toBe(false);
  });

  it('fails open and emits nothing when the neutral storage root is unavailable', () => {
    const repository = createRepository();
    const scratch = temporaryDirectory('critique-wrapper-storage-failure-');
    const home = path.join(scratch, 'home-is-a-file');
    writeFileSync(home, 'not a directory');

    expectSilentSuccess(runHook(repository, home, JSON.stringify(payload())));
    expect(readFileSync(home, 'utf8')).toBe('not a directory');
  });

  it('honors the exact telemetry opt-out before reading stdin', async () => {
    const repository = createRepository();
    const home = temporaryDirectory('critique-wrapper-opt-out-home-');
    const result = await runWithOpenStdin([wrapper], repository, hookEnvironment(home, '1'));

    expect(result).toEqual({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    expect(existsSync(evidenceRoot(home))).toBe(false);
  });

  it('captures from fd 0 without constructing the non-blocking stdin stream', () => {
    const repository = createRepository();
    const home = temporaryDirectory('critique-wrapper-descriptor-input-home-');
    const source =
      `Object.defineProperty(process, 'stdin', { configurable: true, get() {` +
      `throw new Error('stdin stream accessed'); } });` +
      `await import(${JSON.stringify(pathToFileURL(wrapper).href)});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
      cwd: repository,
      env: hookEnvironment(home),
      input: JSON.stringify(payload()),
      maxBuffer: 1024,
    });

    expectSilentSuccess(result);
    const root = evidenceRoot(home);
    expect(existsSync(root)).toBe(true);
    expect(listPlanCritiqueRecordMetadata({ root })).toHaveLength(1);
  });

  it('returns before reading stdin when fd 0 is a TTY', async () => {
    const home = temporaryDirectory('critique-wrapper-tty-home-');
    const inputIsTTY = vi.fn(() => true);
    const readFromStdin = vi.fn();
    vi.doMock('node:tty', () => ({ isatty: inputIsTTY }));
    vi.doMock('node:fs', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:fs')>()),
      readSync: readFromStdin,
    }));
    vi.stubEnv('DEVKIT_NO_TELEMETRY', '');
    vi.stubEnv('HOME', home);
    try {
      await import('./claude-subagent-stop.mts');
      expect(inputIsTTY).toHaveBeenCalledWith(0);
      expect(readFromStdin).not.toHaveBeenCalled();
      expect(existsSync(evidenceRoot(home))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      vi.doUnmock('node:fs');
      vi.doUnmock('node:tty');
      vi.resetModules();
    }
  });
});
