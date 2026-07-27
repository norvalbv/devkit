import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HOOK = fileURLToPath(new URL('../../agents-hooks/decision-scope-brief.mjs', import.meta.url));

let root: string;
let n = 0;

/** A consumer repo with one scoped ruling and a stub `guard-decisions` on its node_modules/.bin. */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'brief-'));
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Stub the CLI: the hook's contract with it is only "scoped-targets --files <p> prints JSON". */
function stubBin(stdout: string, status = 0) {
  const bin = join(root, 'node_modules', '.bin', 'guard-decisions');
  writeFileSync(bin, `#!/bin/sh\ncat <<'EOF'\n${stdout}\nEOF\nexit ${status}\n`, { mode: 0o755 });
}

// A fresh session id per call unless the caller pins one. Hoisted out of the default-parameter
// expression: an assignment inside an expression is a lint error (noAssignInExpressions).
function nextSession(): string {
  n += 1;
  return `s${n}`;
}

function run(toolInput: Record<string, unknown>, toolName = 'Edit', session = nextSession()) {
  return spawnSync('node', [HOOK], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    input: JSON.stringify({ tool_name: toolName, session_id: session, tool_input: toolInput }),
  }).stdout.trim();
}

const GOVERNED = JSON.stringify([
  {
    slug: 'retrieval-candidate-set',
    ruling: 'Candidates come from the directory.',
    scope: 'src/**',
  },
]);

describe('decision-scope-brief', () => {
  it('briefs the governing ruling before a governed file is edited', () => {
    stubBin(GOVERNED);
    const out = JSON.parse(run({ file_path: 'src/a.ts' }));
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('retrieval-candidate-set');
    expect(out.hookSpecificOutput.additionalContext).toContain('src/a.ts');
  });

  // Advisory means advisory. Emitting `permissionDecision: "allow"` would auto-approve every edit and
  // silently strip the user's permission prompts — a far worse outcome than a missed hint — and
  // "deny" would let a decision record block ordinary work.
  it('never returns a permission decision, so it can neither block nor auto-approve a write', () => {
    stubBin(GOVERNED);
    const out = JSON.parse(run({ file_path: 'src/a.ts' }));
    expect(out.hookSpecificOutput).not.toHaveProperty('permissionDecision');
    expect(out).not.toHaveProperty('permissionDecisionReason');
  });

  it('stays silent when no ruling governs the file', () => {
    stubBin('[]');
    expect(run({ file_path: 'src/a.ts' })).toBe('');
  });

  // Repetition is how an advisory dies: re-shown on all thirty edits to one file, an agent learns to
  // skip it. One brief per (session, file).
  it('briefs a given file once per session, not on every edit', () => {
    stubBin(GOVERNED);
    const session = 'repeat-session';
    expect(run({ file_path: 'src/a.ts' }, 'Edit', session)).not.toBe('');
    expect(run({ file_path: 'src/a.ts' }, 'Edit', session)).toBe('');
    // …but a DIFFERENT file in the same session is still briefed.
    expect(run({ file_path: 'src/b.ts' }, 'Edit', session)).not.toBe('');
  });

  it('ignores non-mutating tools', () => {
    stubBin(GOVERNED);
    expect(run({ file_path: 'src/a.ts' }, 'Read')).toBe('');
  });

  it('ignores paths outside the project', () => {
    stubBin(GOVERNED);
    expect(run({ file_path: '/etc/hosts' })).toBe('');
  });

  // Every failure mode below must degrade to silence: an advisory is never worth costing an edit.
  it('stays silent when the guard CLI is absent — the repo simply does not use decisions', () => {
    expect(run({ file_path: 'src/a.ts' })).toBe('');
  });

  it('stays silent when the CLI errors', () => {
    stubBin('boom', 1);
    expect(run({ file_path: 'src/a.ts' })).toBe('');
  });

  it('stays silent when the CLI prints unparseable output', () => {
    stubBin('not json at all');
    expect(run({ file_path: 'src/a.ts' })).toBe('');
  });

  it('stays silent on malformed hook input', () => {
    stubBin(GOVERNED);
    const out = spawnSync('node', [HOOK], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      input: 'not json',
    });
    expect(out.stdout.trim()).toBe('');
    expect(out.status).toBe(0);
  });

  it('caps how many axes it names, so a broadly-scoped file cannot flood the context', () => {
    stubBin(
      JSON.stringify(
        Array.from({ length: 6 }, (_, i) => ({ slug: `axis-${i}`, ruling: 'r', scope: 'src/**' })),
      ),
    );
    const ctx = JSON.parse(run({ file_path: 'src/a.ts' })).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('axis-0');
    expect(ctx).not.toContain('axis-5');
    expect(ctx).toContain('3 more');
  });
});
