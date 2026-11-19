import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { anchorHookCommand, nativeProjection, recoverProjectionHome } from './projection.mts';
import { HOOK_REGISTRATIONS } from './registrations.mts';

const ALL = Object.values(HOOK_REGISTRATIONS).flat();
const PRIOR_ART = HOOK_REGISTRATIONS.priorArtGate[0];
const scratch = mkdtempSync(join(tmpdir(), 'hook-anchor-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('anchorHookCommand', () => {
  it.each(['sh', 'bash'])(
    'runs the anchored script under %s with nothing in the home expanded',
    (shell) => {
      const home = join(scratch, `a b/$x/"q"/\`t\`/\\s/$&`);
      mkdirSync(join(home, '.claude/hooks'), { recursive: true });
      // A bash runner: node refuses a module path holding a backslash, a shell does not.
      writeFileSync(join(home, '.claude/hooks/echo.sh'), 'printf "%s" "$0"');
      const command = anchorHookCommand('bash "$CLAUDE_PROJECT_DIR/.claude/hooks/echo.sh"', home);
      const out = execFileSync(shell, ['-c', command], { env: { ...process.env, x: 'EXPANDED' } });
      expect(out.toString()).toBe(join(home, '.claude/hooks/echo.sh'));
    },
  );

  it('every live source command names $CLAUDE_PROJECT_DIR exactly once', () => {
    for (const { command } of ALL) expect(command.split('$CLAUDE_PROJECT_DIR')).toHaveLength(2);
  });
});

describe('nativeProjection', () => {
  it('keeps the unanchored spellings byte-identical', () => {
    expect(nativeProjection('claude', PRIOR_ART, null)?.command).toBe(
      'node "$CLAUDE_PROJECT_DIR/.claude/hooks/prior-art-gate.mjs"',
    );
    expect(nativeProjection('codex', PRIOR_ART, null)?.command).toBe(
      'node "$(git rev-parse --show-toplevel)/.codex/hooks/prior-art-gate.mjs"',
    );
  });

  it('anchors Claude and Codex at the home, and never Cursor', () => {
    expect(nativeProjection('claude', PRIOR_ART, '/h o/me')?.command).toBe(
      'node "/h o/me/.claude/hooks/prior-art-gate.mjs"',
    );
    expect(nativeProjection('codex', PRIOR_ART, '/h o/me')?.command).toBe(
      'node "/h o/me/.codex/hooks/prior-art-gate.mjs"',
    );
    for (const registration of ALL)
      expect(nativeProjection('cursor', registration, '/h')).toEqual(
        nativeProjection('cursor', registration, null),
      );
  });
});

describe('recoverProjectionHome', () => {
  it.each(['claude', 'codex'] as const)('round-trips a %s home', (provider) => {
    for (const home of ['/plain', '/a b/$x/"q"', '/back\\slash']) {
      const command = nativeProjection(provider, PRIOR_ART, home)!.command;
      expect(recoverProjectionHome(provider, PRIOR_ART, command)).toBe(home);
    }
  });

  it.each([
    ['an unanchored command', 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/prior-art-gate.mjs"'],
    ['a relative home', 'node "rel/.claude/hooks/prior-art-gate.mjs"'],
    ['an unescaped quote', 'node "/a"b/.claude/hooks/prior-art-gate.mjs"'],
    ['an unescaped dollar', 'node "/a$HOME/.claude/hooks/prior-art-gate.mjs"'],
    ['another script', 'node "/a/.claude/hooks/other.mjs"'],
    ['an appended command', 'node "/a/.claude/hooks/prior-art-gate.mjs"; rm -rf /'],
  ])('rejects %s', (_, command) => {
    expect(recoverProjectionHome('claude', PRIOR_ART, command)).toBeNull();
  });

  it('never recovers a Cursor command', () => {
    expect(recoverProjectionHome('cursor', PRIOR_ART, '/a/.cursor/hooks/x.mjs')).toBeNull();
  });
});
