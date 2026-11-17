import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkRegistrations } from '../../doctor/asset-checks.mts';
import { installHookRegistrations } from '../install-hooks.mts';
import { checkHookRegistrations } from './check.mts';

const RETIRED = 'FALLOW_GATE_COMMIT_ONLY=1 bash "$CLAUDE_PROJECT_DIR/.claude/hooks/fallow-gate.sh"';
// A consumer's own script outside the provider hooks dir: devkit must leave it alone.
const CONSUMER_OWNED = 'bash tools/fallow-gate.sh';

// Claude Code writes "always allow" grants here, so a real settings.local.json carries them.
const PERMISSIONS = { allow: ['Bash(git status:*)'] };

let roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
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

  it("leaves a consumer's own fallow-gate.sh outside the hooks dir alone", () => {
    const root = gitRepo();
    const rel = writeSettings(root, 'settings.local.json', CONSUMER_OWNED);
    const before = readFileSync(join(root, rel), 'utf8');

    expect(checkHookRegistrations(root, [], { targets: ['claude'] }).ok).toBe(true);
    installHookRegistrations(root, [], { targets: ['claude'] });

    expect(readFileSync(join(root, rel), 'utf8')).toBe(before);
  });

  it('init --dry-run reports the retired hook in the other file without writing it', () => {
    const root = gitRepo();
    const rel = writeSettings(root, 'settings.local.json', RETIRED);
    const before = readFileSync(join(root, rel), 'utf8');

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    installHookRegistrations(root, [], { targets: ['claude'], dryRun: true });

    expect(log).toHaveBeenCalledWith(
      `  [dry-run] remove .claude/settings.local.json PreToolUse[Bash]: ${RETIRED} (retired)`,
    );
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

// fallow 3.34's walk-up handlers (crates/cli/src/setup_hooks.rs), which the exact allowlist misses.
const WALK_UP = (dir: string, tail: string) =>
  `d="$(pwd)"; until [ -f "$d/.${dir}/hooks/fallow-gate.sh" ] || [ -e "$d/.git" ] || [ "$d" = / ]; do d="$(dirname "$d")"; done; if [ -f "$d/.${dir}/hooks/fallow-gate.sh" ]; then cd "$d" && exec ./.${dir}/hooks/fallow-gate.sh; fi; ${tail}`;
const CLAUDE_WALK_UP = WALK_UP('claude', 'exec "$CLAUDE_PROJECT_DIR"/.claude/hooks/fallow-gate.sh');
const CODEX_WALK_UP = WALK_UP('codex', 'exit 0');

const advice = (provider: string, rel: string, where: string, command: string) =>
  `${provider}:unrecognised-fallow-gate ${rel} ${where}: ${command}`;

describe('checkHookRegistrations — fallow-gate.sh spellings the allowlist does not recognise', () => {
  it.each([
    'X=1 bash .claude/hooks/fallow-gate.sh',
    'bash $CLAUDE_PROJECT_DIR/.claude/hooks/fallow-gate.sh',
    'bash .claude/hooks/fallow-gate.sh && ./mine.sh',
    // The bare path at the start of the command, and a whitespace-padded one: both fail isRetired.
    '.claude/hooks/fallow-gate.sh && ./mine.sh',
    ' bash .claude/hooks/fallow-gate.sh',
    CLAUDE_WALK_UP,
  ])('advises on, and init never strips: %s', (command) => {
    const root = gitRepo();
    const rel = writeSettings(root, 'settings.json', command);

    expect(checkHookRegistrations(root, [], { targets: ['claude'] })).toMatchObject({
      ok: true,
      advisories: [advice('claude', rel, 'PreToolUse[Bash]', command)],
    });
    installHookRegistrations(root, [], { targets: ['claude'] });

    expect(JSON.parse(readFileSync(join(root, rel), 'utf8')).hooks.PreToolUse[0].hooks).toEqual([
      { type: 'command', command },
    ]);
  });

  it('advises on the settings file the scope does not own', () => {
    const root = gitRepo();
    const rel = writeSettings(root, 'settings.json', CLAUDE_WALK_UP);

    expect(checkHookRegistrations(root, [], overlay).advisories).toEqual([
      advice('claude', rel, 'PreToolUse[Bash]', CLAUDE_WALK_UP),
    ]);
  });

  it('advises on a Codex and a Cursor handler', () => {
    const root = gitRepo();
    mkdirSync(join(root, '.codex'));
    mkdirSync(join(root, '.cursor'));
    const codexHooks = [
      { matcher: '^Bash$', hooks: [{ type: 'command', command: CODEX_WALK_UP }] },
    ];
    writeFileSync(
      join(root, '.codex', 'hooks.json'),
      JSON.stringify({ hooks: { PreToolUse: codexHooks } }),
    );
    const cursor = 'bash .cursor/hooks/fallow-gate.sh && ./mine.sh';
    writeFileSync(
      join(root, '.cursor', 'hooks.json'),
      JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: cursor }] } }),
    );

    expect(checkHookRegistrations(root, [], { targets: ['codex', 'cursor'] })).toMatchObject({
      ok: true,
      advisories: [
        advice('codex', join('.codex', 'hooks.json'), 'PreToolUse[^Bash$]', CODEX_WALK_UP),
        advice('cursor', join('.cursor', 'hooks.json'), 'beforeShellExecution', cursor),
      ],
    });
  });

  it('still finds the handler beside malformed entries in a hand-edited file', () => {
    const root = gitRepo();
    const command = 'bash .claude/hooks/fallow-gate.sh && ./mine.sh';
    const handlers = [null, 7, { type: 'command', command }];
    const PreToolUse = [{ matcher: 'Bash' }, 'junk', { matcher: 'Bash', hooks: handlers }];
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { Stop: 'junk', PreToolUse } }),
    );

    expect(checkHookRegistrations(root, [], { targets: ['claude'] }).advisories).toEqual([
      advice('claude', join('.claude', 'settings.json'), 'PreToolUse[Bash]', command),
    ]);
  });

  it.each([
    'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/fallow-staged-gate.sh"',
    CONSUMER_OWNED,
    'bash .claude/hooks/fallow-gate.sh.bak',
    'echo mine',
  ])('stays silent on a handler that is not fallow-gate.sh: %s', (command) => {
    const root = gitRepo();
    writeSettings(root, 'settings.json', command);

    expect(checkHookRegistrations(root, [], { targets: ['claude'] }).advisories).toEqual([]);
  });

  it('reports a recognised spelling as retired, not as an advisory', () => {
    const root = gitRepo();
    writeSettings(root, 'settings.json', RETIRED);

    expect(checkHookRegistrations(root, [], { targets: ['claude'] })).toMatchObject({
      missing: ['claude:retired-registration'],
      advisories: [],
    });
  });
});

describe('checkRegistrations — rendering advisories', () => {
  it('an advisory alone is a non-fixing row that names the handler', () => {
    const root = gitRepo();
    writeSettings(root, 'settings.json', CLAUDE_WALK_UP);

    expect(checkRegistrations(root, [], ['claude'])).toMatchObject({
      status: 'DRIFT',
      advisory: true,
      fixable: false,
      detail: expect.stringContaining('claude:unrecognised-fallow-gate .claude/settings.json'),
      remediation: expect.stringContaining('by hand'),
    });
  });

  it('keeps advisories visible beside a fixable registration issue', () => {
    const root = gitRepo();
    writeSettings(root, 'settings.json', RETIRED, CLAUDE_WALK_UP);

    const result = checkRegistrations(root, [], ['claude']);
    expect(result).toMatchObject({ status: 'DRIFT', fixable: true });
    expect(result.detail).toContain('claude:retired-registration');
    expect(result.detail).toContain(`; also: claude:unrecognised-fallow-gate`);
  });
});

const LEDGER = '.devkit/agent-hook-registrations-manifest.json';
const read = (root: string, rel: string) => readFileSync(join(root, rel), 'utf8');

function ledgerRels(root: string) {
  const { entries } = JSON.parse(read(root, LEDGER));
  return [...new Set(entries.map((entry: { destinationRel: string }) => entry.destinationRel))];
}

describe('scope switch — devkit registrations follow the scope to its own settings file', () => {
  const ids = ['searchSteering'];
  const shared = { targets: ['claude'] };

  it('shared → overlay: doctor flags, init clears devkit hooks from an untracked settings.json', () => {
    const root = gitRepo();
    const rel = writeSettings(root, 'settings.json', 'echo mine');
    installHookRegistrations(root, ids, shared);

    expect(checkHookRegistrations(root, ids, overlay).missing).toContain(
      `claude:scope-switch:${rel}`,
    );
    installHookRegistrations(root, ids, overlay);

    const kept = read(root, rel);
    expect(kept).not.toContain('search-tool');
    expect(kept).toContain('echo mine');
    expect(JSON.parse(kept).permissions).toEqual(PERMISSIONS);
    expect(read(root, '.claude/settings.local.json')).toContain('search-tool-guard');
    expect(ledgerRels(root)).toEqual(['.claude/settings.local.json']);
    expect(checkHookRegistrations(root, ids, overlay)).toMatchObject({ ok: true, advisories: [] });
  });

  it("overlay → shared: settings.local.json keeps the user's hooks and permissions", () => {
    const root = gitRepo();
    const rel = writeSettings(root, 'settings.local.json', 'echo mine');
    installHookRegistrations(root, ids, overlay);
    installHookRegistrations(root, ids, shared);

    const kept = read(root, rel);
    expect(kept).not.toContain('search-tool');
    expect(kept).toContain('echo mine');
    expect(JSON.parse(kept).permissions).toEqual(PERMISSIONS);
    expect(ledgerRels(root)).toEqual(['.claude/settings.json']);
    expect(checkHookRegistrations(root, ids, shared).ok).toBe(true);
  });

  it('overlay leaves a committed settings.json byte-identical and only advises', () => {
    const root = gitRepo();
    installHookRegistrations(root, ids, shared);
    const rel = '.claude/settings.json';
    execFileSync('git', ['add', rel], { cwd: root });
    const before = read(root, rel);

    installHookRegistrations(root, ids, overlay);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    installHookRegistrations(root, ids, overlay);

    const printed = log.mock.calls.flat().join('\n');
    expect(read(root, rel)).toBe(before);
    expect(printed).not.toContain(`removed ${rel}`);
    expect(printed).toContain(`! ${rel} is git-tracked — devkit's hooks there are yours to remove`);
    expect(checkHookRegistrations(root, ids, overlay)).toMatchObject({
      ok: true,
      advisories: [`claude:scope-switch:${rel}`],
    });
  });

  it('advises on a superseded spelling left in a committed settings.json', () => {
    const root = gitRepo();
    installHookRegistrations(root, ids, shared);
    const rel = '.claude/settings.json';
    const downgrade = (text: string) => text.replaceAll('/dist/gate-engine/', '/gate-engine/');
    writeFileSync(join(root, rel), downgrade(read(root, rel)));
    writeFileSync(join(root, LEDGER), downgrade(read(root, LEDGER)));
    execFileSync('git', ['add', rel], { cwd: root });
    const before = read(root, rel);

    installHookRegistrations(root, ids, overlay);

    expect(read(root, rel)).toBe(before);
    expect(checkHookRegistrations(root, ids, overlay)).toMatchObject({
      ok: true,
      advisories: [`claude:scope-switch:${rel}`],
    });
  });

  // Committed too: releasing a row whose handler is gone never edits the file, so it is not advice.
  it.each([false, true])('releases rows whose handlers are gone (committed: %s)', (committed) => {
    const root = gitRepo();
    installHookRegistrations(root, ids, shared);
    const rel = writeSettings(root, 'settings.json', 'echo mine');
    if (committed) execFileSync('git', ['add', rel], { cwd: root });

    expect(checkHookRegistrations(root, ids, overlay).missing).toContain(
      `claude:scope-switch:${rel}`,
    );
    installHookRegistrations(root, ids, overlay);

    expect(ledgerRels(root)).toEqual(['.claude/settings.local.json']);
    expect(checkHookRegistrations(root, ids, overlay).ok).toBe(true);
  });

  it("never adopts or removes the user's identical, unledgered copy in the other file", () => {
    const root = gitRepo();
    installHookRegistrations(root, ids, overlay);
    const rel = '.claude/settings.json';
    writeFileSync(join(root, rel), read(root, '.claude/settings.local.json'));
    const before = read(root, rel);

    installHookRegistrations(root, ids, { ...overlay, legacyOwnedComponentIds: ids });

    expect(read(root, rel)).toBe(before);
    expect(ledgerRels(root)).toEqual(['.claude/settings.local.json']);
    expect(checkHookRegistrations(root, ids, overlay)).toMatchObject({ ok: true, advisories: [] });
  });

  it('leaves a drifted handler in the other file, moves the rest, and advises', () => {
    const root = gitRepo();
    installHookRegistrations(root, ids, shared);
    const rel = '.claude/settings.json';
    const settings = JSON.parse(read(root, rel));
    settings.hooks.PreToolUse.push(...settings.hooks.PreToolUse); // a merge left it twice
    writeFileSync(join(root, rel), JSON.stringify(settings));

    expect(() => installHookRegistrations(root, ids, overlay)).not.toThrow();

    const kept = read(root, rel);
    expect(kept).not.toContain('search-tool-counter'); // the untouched one still moves
    expect(kept.match(/search-tool-guard/g)).toHaveLength(2);
    expect(checkHookRegistrations(root, ids, overlay)).toMatchObject({
      ok: true,
      advisories: [`claude:scope-switch:${rel}`],
    });
  });

  it('never follows a symlinked settings file out of the repository', () => {
    const root = gitRepo();
    installHookRegistrations(root, ids, shared);
    const rel = '.claude/settings.json';
    const outside = join(mkdtempSync(join(tmpdir(), 'hook-check-outside-')), 'settings.json');
    roots.push(dirname(outside));
    writeFileSync(outside, read(root, rel));
    rmSync(join(root, rel));
    symlinkSync(outside, join(root, rel));
    const before = readFileSync(outside, 'utf8');

    expect(() => installHookRegistrations(root, ids, overlay)).not.toThrow();

    expect(readFileSync(outside, 'utf8')).toBe(before);
    expect(checkHookRegistrations(root, ids, overlay).ok).toBe(true);
  });
});
