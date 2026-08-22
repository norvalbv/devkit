import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCommentCli, SHIP_LOG_MAX_BYTES } from '../cli.mts';
import { detectChangedComments } from '../detect.mts';
import { loadWorkingRationales } from '../rationales.mts';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'guard-comments-cli-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

const findingId = 'a1b2c3d4e5f6';
const rationale =
  'The external wire protocol requires this explanation until its next major version.';

function shipLog(root: string, body: string, name = 'feat-wire-format'): string {
  const file = path.join(root, '.devkit', `last-ship-gates-${name}.log`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}

function canonicalFinding(id = findingId): string {
  return `  • [${id}] src/wire.ts:2 — protocol note\n`;
}

function stageFinding(root: string): string {
  const source = path.join(root, 'src', 'wire.ts');
  mkdirSync(path.dirname(source), { recursive: true });
  writeFileSync(
    source,
    `// The wire protocol counts offsets in UTF-16 code units.\n// This remains required until the vendor's next major version.\n// Removing it makes byte and character offsets disagree.\nexport const width = (input: string) => input.length;\n`,
  );
  execFileSync('git', ['add', 'src/wire.ts'], { cwd: root });
  const id = detectChangedComments(root).findings[0]?.id;
  if (!id) throw new Error('fixture must produce a staged comment finding');
  return id;
}

function errors(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('guard-comments justify', () => {
  it('records a ship-only finding from the retained gate log after cleanup', () => {
    const root = repo();
    const log = shipLog(
      root,
      `guard-comments: 1 added/modified comment paragraph needs a decision.\n${canonicalFinding()}`,
    );
    const error = errors();

    expect(
      runCommentCli(['justify', findingId, rationale, '--from-ship-log', log], root),
      error.mock.calls.flat().join('\n'),
    ).toBe(0);
    expect(loadWorkingRationales(root).entries[findingId]?.rationale).toBe(rationale);
  });

  it('preserves the current-staged rejection when no ship log is supplied', () => {
    const root = repo();
    const error = errors();

    expect(runCommentCli(['justify', findingId, rationale], root)).toBe(2);
    expect(error.mock.calls.flat().join('\n')).toContain('is not a current staged finding');
    expect(loadWorkingRationales(root).entries[findingId]).toBeUndefined();
  });

  it.each([
    ['prose mention', `diagnostic mentioned [${findingId}] but emitted no finding\n`],
    ['judge result', `guard-comments: [${findingId}] rationale rejected — insufficient\n`],
    ['ANSI-prefixed record', `\u001B[31m${canonicalFinding()}\u001B[0m`],
    ['wrong finding', canonicalFinding('b1c2d3e4f5a6')],
  ])('rejects %s as ship-finding evidence', (_label, body) => {
    const root = repo();
    const log = shipLog(root, body);
    errors();

    expect(runCommentCli(['justify', findingId, rationale, '--from-ship-log', log], root)).toBe(2);
    expect(loadWorkingRationales(root).entries[findingId]).toBeUndefined();
  });

  it.each([
    ['ticket then log', ['--ticket', 'SC-1826', '--from-ship-log']],
    ['log then ticket', ['--from-ship-log', '--ticket', 'SC-1826']],
  ])('parses %s without folding options into the rationale', (_label, optionOrder) => {
    const root = repo();
    const log = shipLog(root, canonicalFinding());
    const args = optionOrder.flatMap((token) =>
      token === '--from-ship-log' ? [token, log] : [token],
    );
    errors();

    expect(runCommentCli(['justify', findingId, rationale, ...args], root)).toBe(0);
    expect(loadWorkingRationales(root).entries[findingId]).toMatchObject({
      rationale,
      ticket: 'SC-1826',
    });
  });

  it.each([
    ['duplicate log option', (log: string) => ['--from-ship-log', log, '--from-ship-log', log]],
    ['missing log value', () => ['--from-ship-log']],
    ['duplicate ticket', () => ['--ticket', 'SC-1826', '--ticket', 'SC-1826']],
    ['unknown option', () => ['--from-ship', 'feat/wire-format']],
  ])('rejects %s without mutating evidence', (_label, buildOptions) => {
    const root = repo();
    const log = shipLog(root, canonicalFinding());
    errors();

    expect(runCommentCli(['justify', findingId, rationale, ...buildOptions(log)], root)).toBe(2);
    expect(loadWorkingRationales(root).entries[findingId]).toBeUndefined();
  });

  it('preserves a valid documented current-staged invocation', () => {
    const root = repo();
    const currentId = stageFinding(root);
    const error = errors();

    expect(runCommentCli(['justify', currentId, rationale, '--ticket', 'SC-1826'], root)).toBe(0);
    expect(error.mock.calls.flat().join('\n')).toContain('local rationale recorded');
    expect(loadWorkingRationales(root).entries[currentId]).toMatchObject({
      rationale,
      ticket: 'SC-1826',
    });
  });

  it('validates a supplied ship log even for a current staged finding', () => {
    const root = repo();
    const currentId = stageFinding(root);
    const error = errors();
    const missing = path.join(root, '.devkit', 'last-ship-gates-missing.log');
    mkdirSync(path.dirname(missing), { recursive: true });

    expect(runCommentCli(['justify', currentId, rationale, '--from-ship-log', missing], root)).toBe(
      2,
    );
    expect(error.mock.calls.flat().join('\n')).toContain('justify —');
    expect(loadWorkingRationales(root).entries[currentId]).toBeUndefined();
  });

  it('resolves ship evidence from a nested working directory', () => {
    const root = repo();
    const nested = path.join(root, 'packages', 'api');
    mkdirSync(nested, { recursive: true });
    const log = shipLog(root, canonicalFinding());
    errors();

    expect(runCommentCli(['justify', findingId, rationale, '--from-ship-log', log], nested)).toBe(
      0,
    );
    expect(loadWorkingRationales(root).entries[findingId]?.rationale).toBe(rationale);
  });

  it.each(['directory', 'symlink', 'outside-root'])('rejects a %s recovery path', (kind) => {
    const root = repo();
    const target = shipLog(root, canonicalFinding(), 'target');
    const candidate = path.join(root, '.devkit', `last-ship-gates-${kind}.log`);
    if (kind === 'directory') mkdirSync(candidate);
    else if (kind === 'symlink') symlinkSync(target, candidate);
    const supplied =
      kind === 'outside-root'
        ? path.join(path.dirname(root), 'last-ship-gates-outside.log')
        : candidate;
    const error = errors();

    expect(
      runCommentCli(['justify', findingId, rationale, '--from-ship-log', supplied], root),
    ).toBe(2);
    expect(error.mock.calls.flat().join('\n')).toContain('justify —');
    expect(loadWorkingRationales(root).entries[findingId]).toBeUndefined();
  });

  it('accepts exactly the ship-log size limit', () => {
    const root = repo();
    const record = canonicalFinding();
    const padding = SHIP_LOG_MAX_BYTES - Buffer.byteLength(record);
    const log = shipLog(root, `${record}${'x'.repeat(padding)}`);
    errors();

    expect(runCommentCli(['justify', findingId, rationale, '--from-ship-log', log], root)).toBe(0);
    expect(readFileSync(log).byteLength).toBe(SHIP_LOG_MAX_BYTES);
  });

  it('rejects a ship log one byte over the size limit', () => {
    const root = repo();
    const log = shipLog(root, 'x'.repeat(SHIP_LOG_MAX_BYTES + 1));
    const error = errors();

    expect(runCommentCli(['justify', findingId, rationale, '--from-ship-log', log], root)).toBe(2);
    expect(error.mock.calls.flat().join('\n')).toContain('exceeds the size limit');
    expect(loadWorkingRationales(root).entries[findingId]).toBeUndefined();
    expect(existsSync(log)).toBe(true);
  });
});
