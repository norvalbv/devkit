import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decide, renderOutput } from '../../agents-hooks/decision-edit-guard.mjs';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'decision-edit-guard-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const payload = (toolName: string, filePath: string, cursor = false) => ({
  tool_name: toolName,
  tool_input: { file_path: filePath },
  cwd: root,
  ...(cursor ? { cursor_version: '3.12.10' } : { hook_event_name: 'PreToolUse' }),
});

describe('decision-edit-guard path policy', () => {
  it.each([
    'Edit',
    'Write',
    'MultiEdit',
    'Delete',
  ])('blocks %s inside the default decisions directory', (toolName) => {
    const reason = decide(payload(toolName, join(root, 'docs/decisions/axis.md')), root);
    expect(reason).toContain('docs/decisions');
    expect(reason).toContain('guard-decisions add');
    expect(reason).toContain('guard-decisions amend');
  });

  it('honours a custom decisionsDir and Cursor path-shaped input', () => {
    writeFileSync(
      join(root, 'guard.config.json'),
      JSON.stringify({ decisionsDir: 'architecture/records' }),
    );
    const reason = decide(
      {
        tool_name: 'Write',
        tool_input: { path: 'architecture/records/new.md' },
        cwd: root,
        cursor_version: '3.12.10',
      },
      root,
    );
    expect(reason).toContain('architecture/records');
  });

  it('allows files outside the directory and similarly-prefixed siblings', () => {
    expect(decide(payload('Write', join(root, 'src/axis.ts')), root)).toBeNull();
    expect(decide(payload('Write', join(root, 'docs/decisions-old/axis.md')), root)).toBeNull();
  });

  it('normalizes relative traversal before testing containment', () => {
    expect(decide(payload('Edit', 'src/../docs/decisions/axis.md'), root)).not.toBeNull();
    expect(decide(payload('Edit', 'docs/decisions/../../src/axis.ts'), root)).toBeNull();
  });

  it('finds a protected path inside Claude MultiEdit nested edits', () => {
    expect(
      decide(
        {
          tool_name: 'MultiEdit',
          tool_input: {
            edits: [{ file_path: 'src/ok.ts' }, { file_path: 'docs/decisions/protected.md' }],
          },
        },
        root,
      ),
    ).not.toBeNull();
  });

  it('fails open for malformed config, unknown payloads, and non-write tools', () => {
    writeFileSync(join(root, 'guard.config.json'), '{broken');
    expect(decide(payload('Write', 'docs/decisions/axis.md'), root)).toBeNull();
    expect(decide({ tool_name: 'Write', tool_input: {}, cwd: root }, root)).toBeNull();
    expect(decide(payload('Read', 'docs/decisions/axis.md'), root)).toBeNull();
  });
});

describe('decision-edit-guard vendor adapters', () => {
  it('emits Claude PreToolUse denial JSON', () => {
    const reason = 'blocked';
    expect(renderOutput(payload('Write', 'docs/decisions/a.md'), reason)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    });
  });

  it('emits Cursor preToolUse denial JSON', () => {
    const reason = 'blocked';
    expect(renderOutput(payload('Write', 'docs/decisions/a.md', true), reason)).toEqual({
      permission: 'deny',
      user_message: reason,
      agent_message: reason,
    });
  });
});
