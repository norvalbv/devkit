// Overlay registrations carry the overlay home's realpath. These pin every way an anchor changes:
// an upgrade from the unanchored spelling, a moved clone, a crash mid-rewrite, a scope switch.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkHookRegistrations } from './hook-registration-ledger/check.mts';
import { HOOK_REGISTRATION_LEDGER_REL } from './hook-registration-ledger/codec.mts';
import { installHookRegistrations, removeHookRegistrations } from './install-hooks.mts';

const LOCAL = '.claude/settings.local.json';
const CODEX = '.codex/hooks.json';
const UNANCHORED = { claude: '$CLAUDE_PROJECT_DIR', codex: '$(git rev-parse --show-toplevel)' };
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const parent = mkdtempSync(join(tmpdir(), 'hook-anchor-'));
  dirs.push(parent);
  const root = join(parent, 'home');
  mkdirSync(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

const read = (root: string, rel: string) => readFileSync(join(root, rel), 'utf8');
/** Every handler command in a provider file, decoded from its JSON string literal. */
const commands = (root: string, rel: string): string[] =>
  [...read(root, rel).matchAll(/"command": ("(?:[^"\\]|\\.)*")/g)].map(([, literal]) =>
    String(JSON.parse(literal)),
  );
const overlay = (targets = ['claude']) => ({ overlay: true, targets });
const install = (root: string, targets = ['claude'], extra = {}) =>
  installHookRegistrations(root, ['priorArtGate'], { ...overlay(targets), ...extra });
const checkAgentHooks = (root: string) => checkHookRegistrations(root, ['agentHooks'], overlay());
const check = (root: string, targets = ['claude']) =>
  checkHookRegistrations(root, ['priorArtGate'], overlay(targets));

function canWrite(dir: string): boolean {
  try {
    writeFileSync(join(dir, '.probe'), '');
    rmSync(join(dir, '.probe'));
    return true;
  } catch {
    return false;
  }
}

/** Rewrite a file from one spelling of the home to another, the way an older install left it. */
function respell(root: string, rel: string, from: string, to: string) {
  writeFileSync(join(root, rel), read(root, rel).replaceAll(from, to));
}

describe('overlay hook commands anchor at the overlay home', () => {
  it('registers every overlay Claude command at the realpath of the home', () => {
    const root = repo();
    install(root);
    const home = realpathSync.native(root);
    expect(commands(root, LOCAL)).toHaveLength(4);
    for (const command of commands(root, LOCAL))
      expect(command).toContain(`"${home}/.claude/hooks/`);
    expect(check(root)).toMatchObject({ ok: true, advisories: [] });
  });

  it('reports devkit commands in a shared settings.json, which now run beside the anchored ones', () => {
    const root = repo();
    const shared = repo();
    installHookRegistrations(shared, ['priorArtGate'], { targets: ['claude'] });
    mkdirSync(join(root, '.claude'));
    cpSync(join(shared, '.claude/settings.json'), join(root, '.claude/settings.json'));
    install(root);

    const { ok, advisories } = check(root);
    expect(ok).toBe(true);
    expect(advisories.filter((a) => a.startsWith('claude:unanchored-duplicate'))).toHaveLength(4);
    expect(read(root, '.claude/settings.json')).toBe(read(shared, '.claude/settings.json'));
  });

  it('keeps the unanchored spelling where the home path holds a control character', () => {
    const parent = mkdtempSync(join(tmpdir(), 'hook-anchor-'));
    dirs.push(parent);
    const root = join(parent, 'line\nbreak');
    mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    expect(() => install(root)).not.toThrow();
    expect(read(root, LOCAL)).toContain('$CLAUDE_PROJECT_DIR/.claude/hooks/');
    expect(check(root).ok).toBe(true);
    expect(() =>
      installHookRegistrations(root, ['priorArtGate'], { targets: ['claude'] }),
    ).not.toThrow();
  });

  it('upgrades an unanchored install in place: no throw, one handler per registration', () => {
    const root = repo();
    install(root);
    const home = realpathSync.native(root);
    for (const rel of [LOCAL, HOOK_REGISTRATION_LEDGER_REL])
      respell(root, rel, home, UNANCHORED.claude);
    expect(check(root).missing).toContain('claude:superseded-registration');

    expect(() => install(root)).not.toThrow();

    expect(commands(root, LOCAL)).toHaveLength(4);
    expect(read(root, LOCAL)).not.toContain('$CLAUDE_PROJECT_DIR');
    expect(check(root).ok).toBe(true);
  });

  it('reports a moved clone and re-anchors it on the next install', () => {
    const root = repo();
    install(root);
    const before = realpathSync.native(root);
    const moved = join(root, '..', 'moved');
    renameSync(root, moved);
    expect(check(moved).missing).toContain('claude:superseded-registration');

    expect(() => install(moved)).not.toThrow();

    expect(read(moved, LOCAL)).not.toContain(before);
    expect(commands(moved, LOCAL).every((c) => c.includes(realpathSync.native(moved)))).toBe(true);
    expect(check(moved).ok).toBe(true);
  });

  it('recovers a re-anchor that crashed before its provider file was written', (ctx) => {
    const root = repo();
    install(root);
    const before = realpathSync.native(root);
    const moved = join(root, '..', 'moved');
    renameSync(root, moved);
    chmodSync(join(moved, '.claude'), 0o555);
    if (canWrite(join(moved, '.claude'))) {
      chmodSync(join(moved, '.claude'), 0o755);
      ctx.skip(); // a privileged process (root) writes through the mode, so nothing can fail here
    }
    try {
      expect(() => install(moved)).toThrow();
    } finally {
      chmodSync(join(moved, '.claude'), 0o755);
    }
    // The ledger written before the crash still names the spelling the document holds.
    expect(read(moved, HOOK_REGISTRATION_LEDGER_REL)).toContain(before);

    install(moved);

    expect(read(moved, LOCAL)).not.toContain(before);
    expect(commands(moved, LOCAL)).toHaveLength(4);
    expect(check(moved).ok).toBe(true);
  });

  it('cleans a moved clone, stripping the handlers anchored at its old path', () => {
    const root = repo();
    install(root);
    const moved = join(root, '..', 'moved');
    renameSync(root, moved);

    removeHookRegistrations(moved, overlay());

    expect(commands(moved, LOCAL)).toEqual([]);
  });

  it('anchors one case on a case-insensitive disk, whatever case the cwd was typed in', (ctx) => {
    const parent = mkdtempSync(join(tmpdir(), 'hook-anchor-'));
    dirs.push(parent);
    const root = join(parent, 'Home');
    mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    const typed = join(parent, 'home');
    if (!existsSync(typed)) ctx.skip(); // a case-sensitive disk has no second spelling
    install(root);
    expect(check(typed).ok).toBe(true);
    install(typed);
    expect(read(root, LOCAL)).toContain('/Home/.claude/hooks/');
    expect(read(root, LOCAL)).not.toContain('/home/.claude/hooks/');
  });

  it('anchors the same through a symlinked path, so doctor reports no false drift', () => {
    const root = repo();
    install(root);
    const link = join(root, '..', 'link');
    symlinkSync(root, link);
    expect(check(link).ok).toBe(true);
    install(link);
    expect(read(root, LOCAL)).toContain(realpathSync.native(root));
  });

  it('adopts a pre-ledger unanchored handler and re-anchors it, never duplicating it', () => {
    const root = repo();
    installHookRegistrations(root, ['agentHooks'], overlay());
    const home = realpathSync.native(root);
    respell(root, LOCAL, home, UNANCHORED.claude);
    rmSync(join(root, HOOK_REGISTRATION_LEDGER_REL));
    const count = commands(root, LOCAL).length;

    installHookRegistrations(root, ['agentHooks'], {
      ...overlay(),
      legacyOwnedComponentIds: ['agentHooks'],
    });

    expect(commands(root, LOCAL)).toHaveLength(count);
    expect(read(root, LOCAL)).not.toContain('$CLAUDE_PROJECT_DIR');
  });

  it('re-anchors a moved clone whose ledger was lost, leaving no handler at the old path', () => {
    const root = repo();
    installHookRegistrations(root, ['agentHooks'], overlay());
    const before = realpathSync.native(root);
    const count = commands(root, LOCAL).length;
    rmSync(join(root, HOOK_REGISTRATION_LEDGER_REL));
    const moved = join(root, '..', 'moved');
    renameSync(root, moved);

    installHookRegistrations(moved, ['agentHooks'], {
      ...overlay(),
      legacyOwnedComponentIds: ['agentHooks'],
    });

    expect(commands(moved, LOCAL)).toHaveLength(count);
    expect(read(moved, LOCAL)).not.toContain(before);
  });

  it('strips the unanchored handler a crashed first upgrade left beside an anchored ledger', () => {
    const root = repo();
    installHookRegistrations(root, ['agentHooks'], overlay());
    const count = commands(root, LOCAL).length;
    // The first upgrade wrote its ledger, then died before rewriting the provider file.
    respell(root, LOCAL, realpathSync.native(root), UNANCHORED.claude);
    expect(checkAgentHooks(root).missing).toContain('claude:superseded-registration');

    installHookRegistrations(root, ['agentHooks'], overlay());

    expect(commands(root, LOCAL)).toHaveLength(count);
    expect(read(root, LOCAL)).not.toContain('$CLAUDE_PROJECT_DIR');
    expect(checkAgentHooks(root).ok).toBe(true);
  });

  it('strips the unanchored current command a crashed first upgrade left for a superseded registration', () => {
    const root = repo();
    installHookRegistrations(root, ['searchSteering'], overlay());
    const count = commands(root, LOCAL).length;
    respell(root, LOCAL, realpathSync.native(root), UNANCHORED.claude);
    const steering = () => checkHookRegistrations(root, ['searchSteering'], overlay());
    expect(steering().missing).toContain('claude:superseded-registration');

    installHookRegistrations(root, ['searchSteering'], overlay());

    expect(commands(root, LOCAL)).toHaveLength(count);
    expect(read(root, LOCAL)).not.toContain('$CLAUDE_PROJECT_DIR');
    expect(steering().ok).toBe(true);
  });

  it('reports every unledgered copy in a shared settings.json, and survives a non-object one', () => {
    const root = repo();
    const shared = repo();
    installHookRegistrations(shared, ['priorArtGate'], { targets: ['claude'] });
    const doc = JSON.parse(read(shared, '.claude/settings.json'));
    doc.hooks.PostToolUse[0].hooks.push({ ...doc.hooks.PostToolUse[0].hooks[0] });
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude/settings.json'), JSON.stringify(doc));
    install(root);
    const duplicates = (r: string) =>
      check(r).advisories.filter((a) => a.startsWith('claude:unanchored-duplicate'));
    expect(duplicates(root)).toHaveLength(4);

    writeFileSync(join(root, '.claude/settings.json'), '[]');
    expect(duplicates(root)).toEqual([]);
  });

  it('switches Codex between scopes in its one hooks file, leaving exactly one spelling', () => {
    const root = repo();
    installHookRegistrations(root, ['priorArtGate'], { targets: ['codex'] });
    const shared = commands(root, CODEX);
    expect(shared.every((c) => c.includes(UNANCHORED.codex))).toBe(true);

    install(root, ['codex']);
    const anchored = commands(root, CODEX);
    expect(anchored).toHaveLength(shared.length);
    expect(anchored.every((c) => c.includes(`"${realpathSync.native(root)}/.codex/hooks/`))).toBe(
      true,
    );
    expect(check(root, ['codex']).ok).toBe(true);

    installHookRegistrations(root, ['priorArtGate'], { targets: ['codex'] });
    expect(commands(root, CODEX)).toEqual(shared);
  });

  it('leaves shared-scope Claude commands unanchored', () => {
    const root = repo();
    installHookRegistrations(root, ['priorArtGate'], { targets: ['claude'] });
    for (const command of commands(root, '.claude/settings.json'))
      expect(command).toContain('"$CLAUDE_PROJECT_DIR/.claude/hooks/');
    cpSync(root, `${root}-copy`, { recursive: true });
    dirs.push(`${root}-copy`);
    expect(
      checkHookRegistrations(`${root}-copy`, ['priorArtGate'], { targets: ['claude'] }).ok,
    ).toBe(true);
  });
});
