import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installHookRegistrations } from '../install-hooks.mts';
import { checkHookRegistrations } from './check.mts';

const RETIRED = 'FALLOW_GATE_COMMIT_ONLY=1 bash "$CLAUDE_PROJECT_DIR/.claude/hooks/fallow-gate.sh"';
// fallow's own `hooks install --target agent` spelling: fallow owns it, devkit must leave it alone.
const FALLOW_OWNED = '"$CLAUDE_PROJECT_DIR"/.claude/hooks/fallow-gate.sh';

// Claude Code writes "always allow" grants here, so a real settings.local.json carries them.
const PERMISSIONS = { allow: ['Bash(git status:*)'] };

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), 'hook-check-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  mkdirSync(join(root, '.claude'));
  return root;
}

function writeSettings(root: string, file: string, ...commands: string[]) {
  const hooks = commands.map((command) => ({ type: 'command', command }));
  const rel = join('.claude', file);
  writeFileSync(
    join(root, rel),
    JSON.stringify({
      permissions: PERMISSIONS,
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks }] },
    }),
  );
  return rel;
}

const overlay = { targets: ['claude'], overlay: true };

describe('checkHookRegistrations — the Claude settings file the scope does not own', () => {
  it('shared scope flags and init strips a retired hook in settings.local.json', () => {
    const root = gitRepo();
    const rel = writeSettings(root, 'settings.local.json', RETIRED, 'echo mine');

    expect(checkHookRegistrations(root, [], { targets: ['claude'] }).missing).toEqual([
      `claude:retired-registration:${rel}`,
    ]);
    installHookRegistrations(root, [], { targets: ['claude'] });

    const kept = readFileSync(join(root, rel), 'utf8');
    expect(kept).not.toContain('FALLOW_GATE_COMMIT_ONLY');
    expect(kept).toContain('echo mine');
    expect(JSON.parse(kept).permissions).toEqual(PERMISSIONS);
    expect(checkHookRegistrations(root, [], { targets: ['claude'] }).ok).toBe(true);
  });

  it('overlay scope flags and strips a retired hook in an untracked settings.json', () => {
    const root = gitRepo();
    const rel = writeSettings(root, 'settings.json', RETIRED);

    expect(checkHookRegistrations(root, [], overlay).missing).toEqual([
      `claude:retired-registration:${rel}`,
    ]);
    const { wrote } = installHookRegistrations(root, [], overlay);

    expect(wrote).not.toContain(rel); // overlay git-excludes `wrote`; this file is the user's
    expect(readFileSync(join(root, rel), 'utf8')).not.toContain('fallow-gate.sh');
    expect(checkHookRegistrations(root, [], overlay)).toMatchObject({ ok: true, advisories: [] });
  });

  it('overlay scope only advises on a committed settings.json and never edits it', () => {
    const root = gitRepo();
    const rel = writeSettings(root, 'settings.json', RETIRED);
    execFileSync('git', ['add', rel], { cwd: root });
    const before = readFileSync(join(root, rel), 'utf8');

    expect(checkHookRegistrations(root, [], overlay)).toMatchObject({
      ok: true,
      advisories: [`claude:retired-registration:${rel}`],
    });
    installHookRegistrations(root, [], overlay);

    expect(readFileSync(join(root, rel), 'utf8')).toBe(before);
  });

  it("leaves fallow's own fallow-gate.sh registration alone", () => {
    const root = gitRepo();
    const rel = writeSettings(root, 'settings.local.json', FALLOW_OWNED);
    const before = readFileSync(join(root, rel), 'utf8');

    expect(checkHookRegistrations(root, [], { targets: ['claude'] }).ok).toBe(true);
    installHookRegistrations(root, [], { targets: ['claude'] });

    expect(readFileSync(join(root, rel), 'utf8')).toBe(before);
  });

  it('init --dry-run reports the retired hook in the other file without writing it', () => {
    const root = gitRepo();
    const rel = writeSettings(root, 'settings.local.json', RETIRED);
    const before = readFileSync(join(root, rel), 'utf8');

    installHookRegistrations(root, [], { targets: ['claude'], dryRun: true });

    expect(readFileSync(join(root, rel), 'utf8')).toBe(before);
  });

  it.each([
    ['invalid JSON', '{ "hooks": {}, }'],
    ['an empty file', ''],
    ['a non-object', '[]'],
  ])("ignores an unreadable other file (%s): it is the user's, not devkit's", (_, body) => {
    const root = gitRepo();
    writeFileSync(join(root, '.claude', 'settings.local.json'), body);

    expect(checkHookRegistrations(root, [], { targets: ['claude'] }).ok).toBe(true);
    expect(() => installHookRegistrations(root, [], { targets: ['claude'] })).not.toThrow();
    expect(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8')).toBe(body);
  });
});
