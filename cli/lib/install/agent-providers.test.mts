import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FRESH_DEFAULT_AGENT_PROVIDERS,
  LEGACY_AGENT_PROVIDERS,
  requireAgentProviders,
  resolveExistingAgentProviders,
  SUPPORTED_AGENT_PROVIDERS,
} from './agent-providers.mts';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devkit-agent-providers-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('agent provider model', () => {
  it('separates supported providers from legacy and fresh defaults', () => {
    expect(SUPPORTED_AGENT_PROVIDERS).toEqual(['claude', 'codex', 'cursor']);
    expect(LEGACY_AGENT_PROVIDERS).toEqual(['claude', 'cursor']);
    expect(FRESH_DEFAULT_AGENT_PROVIDERS).toEqual(['claude', 'codex', 'cursor']);
  });

  it('strictly validates, de-duplicates, and orders requested providers', () => {
    expect(requireAgentProviders(['cursor', 'claude', 'cursor'])).toEqual(['claude', 'cursor']);
    expect(() => requireAgentProviders(['claude', 'other'])).toThrow(
      'Unsupported agent provider: "other"',
    );
  });
});

describe('resolveExistingAgentProviders', () => {
  it('keeps every explicit recorded array authoritative, including an empty array', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
    mkdirSync(join(root, '.cursor', 'agents'), { recursive: true });

    expect(resolveExistingAgentProviders(root, [])).toEqual([]);
    expect(resolveExistingAgentProviders(root, null)).toEqual(['claude', 'cursor']);
    expect(
      resolveExistingAgentProviders(root, ['codex', 'claude', 'codex', 'unsupported']),
    ).toEqual(['codex', 'claude']);
  });

  it('infers only historical Claude and Cursor surfaces for a legacy config', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
    mkdirSync(join(root, '.cursor', 'agents'), { recursive: true });

    expect(resolveExistingAgentProviders(root, undefined, ['skills'])).toEqual(['claude']);
    expect(resolveExistingAgentProviders(root, undefined, ['agents'])).toEqual(['cursor']);
  });

  it('never infers ownership from existing .codex or .agents directories', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.codex', 'agents'), { recursive: true });
    mkdirSync(join(root, '.agents', 'skills'), { recursive: true });

    expect(resolveExistingAgentProviders(root)).toEqual(['claude', 'cursor']);
  });

  it('falls back to the historical pair when a legacy config has no inferred surface', () => {
    expect(resolveExistingAgentProviders(tempRoot())).toEqual(['claude', 'cursor']);
  });
});
