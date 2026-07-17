import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveExistingAgentTargets } from './agent-targets.mts';

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'devkit-agent-targets-'));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('resolveExistingAgentTargets', () => {
  it('keeps an explicit record authoritative over discovered surfaces', () => {
    const cwd = root();
    mkdirSync(join(cwd, '.codex', 'agents'), { recursive: true });
    expect(resolveExistingAgentTargets(cwd, ['claude'])).toEqual(['claude']);
  });

  it('infers only the requested asset kinds for a legacy config', () => {
    const cwd = root();
    mkdirSync(join(cwd, '.agents', 'skills'), { recursive: true });
    mkdirSync(join(cwd, '.cursor', 'agents'), { recursive: true });
    expect(resolveExistingAgentTargets(cwd, undefined, ['skills'])).toEqual(['codex']);
    expect(resolveExistingAgentTargets(cwd, undefined, ['agents'])).toEqual(['cursor']);
  });

  it('uses the historical pair when no record or installed surface exists', () => {
    expect(resolveExistingAgentTargets(root())).toEqual(['claude', 'cursor']);
  });
});
