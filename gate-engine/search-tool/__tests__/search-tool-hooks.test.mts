import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveGuardConfig } from '../../config.mts';
import { resolveSearchTools } from '../tools.mts';

// End-to-end tests that spawn the real hook scripts over stdin (the same JSON
// contract Claude Code uses). Covers wiring + the counter's per-session streak
// state machine. The counter is the only stateful piece, so the concurrency /
// multi-pane concern lives here: state is keyed by session_id and degrades
// gracefully (never throws / blocks) on a corrupt file.
//
// The steered tool names are config-driven (resolveGuardConfig — searchTool /
// graphTool). We read the EFFECTIVE config so the assertions track whatever the
// consumer/default configures rather than a hardcoded frink tool name.

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, '..', 'search-tool-guard.mts');
const COUNTER = join(HERE, '..', 'search-tool-counter.mts');
// Generic working dir WITH SPACES (the original false-positive trigger), kept
// provider/OS-neutral so the fixtures aren't tied to one contributor's machine.
const CWD = '/Users/dev/My Projects/cool app';

// Effective tool names resolved against this test's cwd (engine default unless
// a guard.config.json overrides them) — assertions track this, not a literal.
const SEARCH_TOOL = resolveSearchTools(resolveGuardConfig()).searchTool;

function runGuard(command, env = {}) {
  const out = execFileSync('node', [GUARD], {
    input: JSON.stringify({ tool_input: { command } }),
    env: { ...process.env, ...env },
  }).toString();
  return out ? JSON.parse(out) : null;
}
const guardFires = (cmd, env) => Boolean(runGuard(cmd, env)?.hookSpecificOutput?.additionalContext);

let stateDir: string;
let sessionId: string;
function runCounterRaw(command, toolName = 'Bash') {
  return execFileSync('node', [COUNTER], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { command }, session_id: sessionId }),
    env: { ...process.env, TMPDIR: stateDir },
  }).toString();
}
const runCounter = (command, toolName = 'Bash') =>
  runCounterRaw(command, toolName).includes('search-tool-counter');
const stateFile = () => join(stateDir, 'devkit-search-state', `${sessionId}.json`);

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'search-hooks-'));
  sessionId = `sess-${Date.now()}-${Math.random().toString(36).slice(2)}`;
});
afterEach(() => {
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
});

describe('search-tool-guard (PreToolUse)', () => {
  it('stays quiet on cwd-with-spaces + exact-identifier grep (the #1 false positive)', () => {
    expect(guardFires(`cd "${CWD}" && grep -c "getPermissionsStore" f.ts`)).toBe(false);
  });

  it('stays quiet on a cwd + rtk-wrapped identifier grep', () => {
    expect(guardFires(`cd "${CWD}" && rtk grep -n "subChatId" x.ts`)).toBe(false);
  });

  it('stays quiet when grep is mentioned inside a commit message', () => {
    expect(guardFires(`git commit -m "fix: search-tool-counter | grep false positives"`)).toBe(
      false,
    );
  });

  it('stays quiet on a tsc/vitest output filter (| grep regex)', () => {
    expect(guardFires(`tsc --noEmit | grep -E "check-edit|claude\\.ts"`)).toBe(false);
    expect(guardFires(`bun vitest run x 2>&1 | grep -E "FAIL"`)).toBe(false);
  });

  it('FIRES on a genuine conceptual grep', () => {
    expect(guardFires(`grep -rn "auth flow" .`)).toBe(true);
  });

  it('FIRES on a conceptual grep even behind a cd prefix and rtk wrapper', () => {
    expect(guardFires(`cd "${CWD}" && rtk grep -rn "permission prompt rendering" src/`)).toBe(true);
  });

  it('steers toward the CONFIGURED search tool (not a hardcoded name)', () => {
    const advice = runGuard(`grep -rn "auth flow" .`)?.hookSpecificOutput?.additionalContext;
    expect(advice).toContain(SEARCH_TOOL);
  });

  it('MODE=off suppresses everything', () => {
    expect(guardFires(`grep -rn "auth flow" .`, { SEARCH_GUARD_MODE: 'off' })).toBe(false);
  });

  it('MODE=block asks for confirmation on high-confidence conceptual', () => {
    const out = runGuard(`grep -rn "where is permission handled" src/`, {
      SEARCH_GUARD_MODE: 'block',
    });
    expect(out?.hookSpecificOutput?.permissionDecision).toBe('ask');
  });
});

describe('search-tool-counter (PostToolUse) — streak state machine', () => {
  it('warns on the 3rd consecutive exact-identifier grep too (clean identifiers are still enumeration)', () => {
    expect(runCounter(`grep -rn "getPermissionsStore" src/`)).toBe(false);
    expect(runCounter(`grep -rn "validateToolPermission" src/`)).toBe(false);
    expect(runCounter(`grep -rn "checkPermission" src/`)).toBe(true);
  });

  it('warns on the 3rd consecutive concept-word grep, listing the recent commands', () => {
    expect(runCounter(`grep -rn "auth" src/`)).toBe(false);
    expect(runCounter(`grep -rn "session" src/`)).toBe(false);
    // Parse the JSON envelope so quote-escaping doesn't trip the content checks.
    const msg = JSON.parse(runCounterRaw(`grep -rn "login" src/`)).hookSpecificOutput
      .additionalContext;
    expect(msg).toContain('3 consecutive');
    // The recent-commands list is the actionable part of the warning.
    expect(msg).toContain('grep -rn "login" src/');
    expect(msg).toContain('grep -rn "session" src/');
    // Steered tool is the configured one, not a hardcoded name.
    expect(msg).toContain(SEARCH_TOOL);
  });

  it('a non-search command resets the streak', () => {
    runCounter(`grep -rn "auth" src/`);
    runCounter(`grep -rn "session" src/`);
    expect(runCounter(`git commit -m "wip"`)).toBe(false); // reset
    expect(runCounter(`grep -rn "login" src/`)).toBe(false); // streak now 1
  });

  it('a searchCode call resets the streak', () => {
    runCounter(`grep -rn "auth" src/`);
    runCounter(`grep -rn "session" src/`);
    expect(runCounter('', 'mcp__codebase__searchCode')).toBe(false);
    expect(runCounter(`grep -rn "login" src/`)).toBe(false);
  });

  it('output-filter greps (tsc | grep) never accrue a streak', () => {
    expect(runCounter(`tsc | grep -E "FAIL"`)).toBe(false);
    expect(runCounter(`vitest 2>&1 | grep -E "FAIL"`)).toBe(false);
    expect(runCounter(`bun x 2>&1 | grep error`)).toBe(false);
  });

  it('degrades gracefully on a corrupt state file (concurrency safety: no throw, treated as 0)', () => {
    mkdirSync(join(stateDir, 'devkit-search-state'), { recursive: true });
    writeFileSync(stateFile(), '{ this is not valid json');
    // Must not throw, and a single concept grep after corruption is streak 1 (no warn).
    expect(runCounter(`grep -rn "auth" src/`)).toBe(false);
  });
});
