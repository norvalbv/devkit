import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    // No guard.config.json here (fresh tmpdir) so scanRoots falls back to the
    // DEFAULT (['src']), matching this file's `src/`-targeted fixtures — and
    // isolates these hook-wiring tests from devkit's OWN dogfood scanRoots
    // (["cli","gate-engine"]), which would otherwise read every `src/`/`.`
    // target here as out-of-scope now that firstAdvisablePattern also scopes
    // to scanRoots (PR review finding, sc-1359 follow-up).
    cwd: stateDir,
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
    // No guard.config.json here (fresh tmpdir) so scanRoots falls back to the
    // DEFAULT (['src']), matching this file's `src/`-targeted fixtures — and
    // isolates these hook-wiring tests from devkit's OWN dogfood scanRoots
    // (["cli","gate-engine"]), which would otherwise read every `src/`
    // target here as out-of-scope (sc-1359 #3).
    cwd: stateDir,
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

  it('FIRES on a conceptual grep invoked via unspaced $(...) command substitution (guard-review finding, round 6)', () => {
    expect(guardFires(`result=$(grep -r "how does auth work" src/)`)).toBe(true);
  });

  it("advises on the RIGHT invocation's pattern in a compound command, not an excluded one's (guard-review finding, round 8)", () => {
    // The node_modules invocation's pattern must never be attributed just because a LATER,
    // unrelated invocation elsewhere in the command has a non-excluded target.
    const advice = runGuard(
      `grep -rn "auth flow logic" node_modules && grep -rn "the retry backoff path" src`,
    )?.hookSpecificOutput?.additionalContext;
    expect(advice).toContain('the retry backoff path');
    expect(advice).not.toContain('auth flow logic');
  });

  it('stays quiet on a target outside the configured scanRoots (PR review finding)', () => {
    // This fixture's isolated cwd has no guard.config.json, so scanRoots falls back to the
    // DEFAULT (['src']) — "docs/" is out of scope under that default.
    expect(guardFires(`grep -rn "how does the docs pipeline render" docs/`)).toBe(false);
  });

  it('in a compound command, skips the out-of-scanRoots invocation and advises on the in-scope one (PR review finding)', () => {
    const advice = runGuard(
      `grep -rn "how does the docs pipeline render" docs/ && grep -rn "the retry backoff path" src`,
    )?.hookSpecificOutput?.additionalContext;
    expect(advice).toContain('the retry backoff path');
    expect(advice).not.toContain('how does the docs pipeline render');
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

  it('stays quiet on a node_modules target regardless of pattern shape (sc-1359 #3)', () => {
    expect(guardFires(`grep -rn "where is permission handled" node_modules/foo/lib.js`)).toBe(
      false,
    );
  });

  it('stays quiet on a /tmp target regardless of pattern shape (sc-1359 #3)', () => {
    expect(guardFires(`grep -oE "FAIL +[^ ]+\\.test\\.tsx?" /tmp/vitest-out.log`)).toBe(false);
  });

  it('stays quiet on exact log strings copied from gate output (sc-3404)', () => {
    expect(guardFires(String.raw`grep -rlE "judge unavailable \(" src/`)).toBe(false);
    expect(guardFires(`grep -rln "NONE are additions" src/`)).toBe(false);
    // An acronym-led concept query is still flagged.
    expect(guardFires(`grep -rn "API rate limiting" src/`)).toBe(true);
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

  it('an out-of-index target is a NO-OP on the streak — neither increments nor resets (sc-1359 #3)', () => {
    expect(runCounter(`grep -rn "x" src/`)).toBe(false); // streak 1
    expect(runCounter(`grep -rn "y" node_modules/foo`)).toBe(false); // no-op, streak stays 1
    expect(runCounter(`grep -rn "z" src/`)).toBe(false); // streak 2 (not reset by the no-op)
    // 3rd IN-SCOPE grep still escalates — the node_modules call above didn't count toward it.
    const msg = JSON.parse(runCounterRaw(`grep -rn "w" src/`)).hookSpecificOutput.additionalContext;
    expect(msg).toContain('3 consecutive');
    // The excluded call must not appear in the recent-commands list either.
    expect(msg).not.toContain('node_modules');
  });

  it('exact log-string greps are a NO-OP on the streak — no STOP, no reset (sc-3404)', () => {
    expect(runCounter(String.raw`grep -rlE "judge unavailable \(" src/`)).toBe(false);
    expect(runCounter(`grep -rln "NONE are additions" src/`)).toBe(false);
    expect(runCounter(`grep -rn "Cannot read property 'foo' of undefined" src/`)).toBe(false);
    expect(existsSync(stateFile()) ? JSON.parse(readFileSync(stateFile(), 'utf8')).streak : 0).toBe(
      0,
    );
    // Between two identifier greps, an exact string neither counts nor resets the run.
    runCounter(`grep -rn "getUser" src/`);
    expect(runCounter(`grep -rn "NONE are additions" src/`)).toBe(false);
    runCounter(`grep -rn "getAuth" src/`);
    const msg = JSON.parse(runCounterRaw(`grep -rn "getSession" src/`)).hookSpecificOutput
      .additionalContext;
    expect(msg).toContain('3 consecutive');
    expect(msg).not.toContain('NONE are additions');
  });

  it('identifier enumeration wrapped in a code snippet still escalates (sc-3404)', () => {
    expect(runCounter(`grep -rn "function getUser" src/`)).toBe(false);
    expect(runCounter(`grep -rn "function getAuth" src/`)).toBe(false);
    expect(runCounter(`grep -rn "function getSession" src/`)).toBe(true);
  });

  it('a compound grep is exempt only when EVERY in-scope pattern is exact (sc-3404)', () => {
    const mixed = `grep -rn "NONE are additions" src/ && grep -rn "auth flow handler" src/`;
    expect(runCounter(mixed)).toBe(false);
    expect(runCounter(mixed)).toBe(false);
    expect(runCounter(mixed)).toBe(true);
  });

  it('a multi -e grep mixing exact and conceptual patterns still counts (ship review finding)', () => {
    const mixed = `grep -rn -e "NONE are additions" -e "auth flow handler" src/`;
    expect(runCounter(mixed)).toBe(false);
    expect(runCounter(mixed)).toBe(false);
    expect(runCounter(mixed)).toBe(true);
  });

  it('punctuated snippet enumeration still escalates (ship review finding)', () => {
    expect(runCounter(`grep -rn "function getUser()" src/`)).toBe(false);
    expect(runCounter(`grep -rn "function getAuth()" src/`)).toBe(false);
    expect(runCounter(`grep -rn "const MAX_RETRY" src/`)).toBe(true);
  });

  it('an exact grep chained with a find still counts (ship review finding)', () => {
    const cmd = `grep -rn "NONE are additions" src/ && find src -name "*.ts"`;
    expect(runCounter(cmd)).toBe(false);
    expect(runCounter(cmd)).toBe(false);
    expect(runCounter(cmd)).toBe(true);
  });

  it('an rtk-wrapped or cd-prefixed exact grep is a no-op too: normalize() unwraps both first', () => {
    for (let i = 0; i < 3; i++) {
      expect(runCounter(`cd /x && rtk grep -rn "NONE are additions" src/`)).toBe(false);
    }
  });

  it('an attached -e exact string is a no-op too (ship review finding)', () => {
    for (let i = 0; i < 3; i++) expect(runCounter(`grep -e"NONE are additions" src/`)).toBe(false);
  });

  it('find (no pattern) still counts toward the streak (sc-3404)', () => {
    expect(runCounter(`find src -name "*.ts"`)).toBe(false);
    expect(runCounter(`find src -name "*.mts"`)).toBe(false);
    expect(runCounter(`find src -name "*.js"`)).toBe(true);
  });

  it('degrades gracefully on a corrupt state file (concurrency safety: no throw, treated as 0)', () => {
    mkdirSync(join(stateDir, 'devkit-search-state'), { recursive: true });
    writeFileSync(stateFile(), '{ this is not valid json');
    // Must not throw, and a single concept grep after corruption is streak 1 (no warn).
    expect(runCounter(`grep -rn "auth" src/`)).toBe(false);
  });
});
