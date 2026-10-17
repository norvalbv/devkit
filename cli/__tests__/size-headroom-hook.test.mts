/** size-headroom-check.mjs against the real guard-size preflight: it reports only an edit that left a
 * file over its line ceiling, is owned by the size guard, and fails open everywhere else. */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { nativeProjection } from '../lib/install/hook-registration-ledger/lifecycle.mts';
import { HOOK_REGISTRATIONS } from '../lib/install/hook-registration-ledger/registrations.mts';
import {
  hookScriptsFor,
  selectedHookAssets,
  SIZE_HEADROOM_HOOK,
} from '../lib/install/hook-registration-ledger/selection.mts';
import { rootRegistry, tmpRepos } from './_helpers.mts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = join(REPO, 'agents-hooks', SIZE_HEADROOM_HOOK);
const GUARD_SIZE = join(REPO, 'gate-engine', 'ratchets', 'size-disable.mts');
// node and git, but no global guard-size: the bin must come from the fixture's node_modules.
const ISOLATED_PATH = [dirname(process.execPath), '/usr/bin', '/bin'].join(':');

const { mkTmp, cleanup } = rootRegistry();
const consumers = tmpRepos('size-headroom-init-');
afterEach(cleanup);
afterEach(consumers.cleanup);

const lines = (count: number) => 'export const x = 1;\n'.repeat(count);

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

function writeBin(root: string, body: string) {
  const bin = join(root, 'node_modules', '.bin', 'guard-size');
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
}

/** A committed repo capping `src` at `maxLines`, whose guard-size bin runs this checkout's source. */
function repo(maxLines: number, files: Record<string, string>) {
  const root = mkTmp('size-headroom-');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  writeFileSync(join(root, 'guard.config.json'), JSON.stringify({ maxLines }));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  writeBin(root, `exec "${process.execPath}" "${GUARD_SIZE}" "$@"`);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  return root;
}

const edit = (filePath: string, toolName = 'Edit') => ({
  tool_name: toolName,
  tool_input: { file_path: filePath },
});

function runHook(
  root: string,
  payload: ReturnType<typeof edit>,
  projectDir = root,
  path = ISOLATED_PATH,
) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: path, CLAUDE_PROJECT_DIR: projectDir },
  });
  return { status: result.status, output: JSON.parse(result.stdout) };
}

const context = (output: { hookSpecificOutput?: { additionalContext?: string } }) =>
  output.hookSpecificOutput?.additionalContext ?? '';

describe('size-headroom-check.mjs', () => {
  it('reports an edit that left a file over the cap, and never blocks', () => {
    const root = repo(5, { 'src/a.ts': lines(5) });
    writeFileSync(join(root, 'src/a.ts'), lines(7));
    const { status, output } = runHook(root, edit(join(root, 'src/a.ts')));
    expect(status).toBe(0);
    expect(context(output)).toContain('src/a.ts: 7 lines (max 5)');
    expect(output.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(JSON.stringify(output)).not.toMatch(/permissionDecision|"decision"/);
  });

  it('measures a grandfathered file against its baseline, not the cap', () => {
    const root = repo(5, { 'src/big.ts': lines(7) });
    expect(
      spawnSync(join(root, 'node_modules/.bin/guard-size'), ['freeze'], { cwd: root }).status,
    ).toBe(0);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'freeze');
    expect(runHook(root, edit(join(root, 'src/big.ts'))).output).toEqual({});
    writeFileSync(join(root, 'src/big.ts'), lines(8));
    expect(context(runHook(root, edit(join(root, 'src/big.ts'))).output)).toContain(
      'src/big.ts: 8 lines (max 7)',
    );
    // A file the agent just created is untracked and unbaselined, so the cap applies to it.
    writeFileSync(join(root, 'src/new.ts'), lines(6));
    expect(context(runHook(root, edit(join(root, 'src/new.ts'), 'Write')).output)).toContain(
      'src/new.ts: 6 lines (max 5)',
    );
  });

  it('stays silent at or under the ceiling, on non-source files and on other tools', () => {
    const root = repo(5, { 'src/a.ts': lines(5), 'src/notes.md': lines(9) });
    expect(runHook(root, edit(join(root, 'src/a.ts'), 'Write')).output).toEqual({});
    expect(runHook(root, edit(join(root, 'src/notes.md'))).output).toEqual({});
    writeFileSync(join(root, 'src/a.ts'), lines(9));
    expect(runHook(root, edit(join(root, 'src/a.ts'), 'Read')).output).toEqual({});
  });

  it('ignores a file outside the project', () => {
    const root = repo(5, { 'src/a.ts': lines(5) });
    const outside = repo(5, { 'src/a.ts': lines(9) });
    expect(runHook(root, edit(join(outside, 'src/a.ts'))).output).toEqual({});
  });

  it('stays silent when no guard.config.json governs the file', () => {
    const root = repo(5, { 'src/a.ts': lines(9) });
    rmSync(join(root, 'guard.config.json'));
    expect(runHook(root, edit(join(root, 'src/a.ts'))).output).toEqual({});
  });

  it('fails open when the bin is missing, crashes, or the repo has no commit', () => {
    const crash = repo(5, { 'src/a.ts': lines(9) });
    writeBin(crash, "echo 'TypeError: boom' >&2\necho '    at preflightLines' >&2\nexit 1");
    expect(runHook(crash, edit(join(crash, 'src/a.ts')))).toEqual({ status: 0, output: {} });

    const missing = repo(5, { 'src/a.ts': lines(9) });
    rmSync(join(missing, 'node_modules'), { recursive: true });
    expect(runHook(missing, edit(join(missing, 'src/a.ts')))).toEqual({ status: 0, output: {} });

    const fresh = mkTmp('size-headroom-');
    git(fresh, 'init', '-q');
    writeFileSync(join(fresh, 'guard.config.json'), JSON.stringify({ maxLines: 5 }));
    mkdirSync(join(fresh, 'src'));
    writeFileSync(join(fresh, 'src/a.ts'), lines(9));
    writeBin(fresh, `exec "${process.execPath}" "${GUARD_SIZE}" "$@"`);
    expect(runHook(fresh, edit(join(fresh, 'src/a.ts')))).toEqual({ status: 0, output: {} });
  });

  it('falls back to a guard-size on PATH when no local bin is installed', () => {
    const root = repo(5, { 'src/a.ts': lines(5) });
    const globalBin = join(mkTmp('size-headroom-global-'), 'node_modules', '.bin');
    rmSync(join(root, 'node_modules'), { recursive: true });
    writeBin(dirname(dirname(globalBin)), `exec "${process.execPath}" "${GUARD_SIZE}" "$@"`);
    writeFileSync(join(root, 'src/a.ts'), lines(6));
    const onPath = runHook(
      root,
      edit(join(root, 'src/a.ts')),
      root,
      `${globalBin}:${ISOLATED_PATH}`,
    );
    expect(context(onPath.output)).toContain('src/a.ts: 6 lines (max 5)');
  });

  it('resolves a symlinked project root against the real file path', () => {
    const root = repo(5, { 'src/a.ts': lines(5) });
    writeFileSync(join(root, 'src/a.ts'), lines(6));
    const link = join(mkTmp('size-headroom-link-'), 'project');
    symlinkSync(root, link);
    const payload = edit(join(realpathSync(root), 'src/a.ts'));
    expect(context(runHook(root, payload, link).output)).toContain('src/a.ts: 6 lines (max 5)');
  });

  it('measures a monorepo package against its own guard.config.json', () => {
    const root = repo(3, { 'packages/a/src/a.ts': lines(3) });
    writeFileSync(join(root, 'guard.config.json'), '{}');
    writeFileSync(join(root, 'packages/a/guard.config.json'), JSON.stringify({ maxLines: 3 }));
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'package config');
    writeFileSync(join(root, 'packages/a/src/a.ts'), lines(4));
    expect(context(runHook(root, edit(join(root, 'packages/a/src/a.ts'))).output)).toContain(
      'src/a.ts: 4 lines (max 3)',
    );
  });
});

describe('size-headroom-check ownership', () => {
  const none = {
    agentHooks: false,
    decisions: false,
    fallow: false,
    adhd: false,
    priorArtGate: false,
  };

  it('is installed by the size guard alone, never by the agent-hook bundle', () => {
    expect(hookScriptsFor({ ...none, size: true })).toEqual([SIZE_HEADROOM_HOOK]);
    expect(hookScriptsFor({ ...none, agentHooks: true })).not.toContain(SIZE_HEADROOM_HOOK);
    const assets = selectedHookAssets({ guards: ['size'] });
    expect(assets.components).toContain('size');
    expect(assets.scripts).toContain(SIZE_HEADROOM_HOOK);
    expect(selectedHookAssets({ guards: ['decisions'] }).scripts).not.toContain(SIZE_HEADROOM_HOOK);
  });

  it('survives a full sync-hooks while the size guard is recorded, and is absent without it', () => {
    const { tmpRepo, devkit } = consumers;
    const script = (root: string) => join(root, '.claude', 'hooks', SIZE_HEADROOM_HOOK);
    const sized = tmpRepo();
    expect(devkit(sized, 'init', '--stack', 'generic', '--yes', '--guards', 'size').status).toBe(0);
    expect(devkit(sized, 'sync-hooks').status).toBe(0);
    expect(existsSync(script(sized))).toBe(true);
    const settings = JSON.parse(readFileSync(join(sized, '.claude', 'settings.json'), 'utf8'));
    expect(JSON.stringify(settings.hooks?.PostToolUse ?? [])).toContain(SIZE_HEADROOM_HOOK);
    const unsized = tmpRepo();
    expect(
      devkit(unsized, 'init', '--stack', 'generic', '--yes', '--guards', 'decisions').status,
    ).toBe(0);
    expect(existsSync(script(unsized))).toBe(false);
  });

  it('projects to Claude and Codex but not to Cursor, whose afterFileEdit has no output', () => {
    const [registration] = HOOK_REGISTRATIONS.size ?? [];
    expect(registration).toMatchObject({ event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit' });
    expect(nativeProjection('cursor', registration!)).toBeNull();
    expect(nativeProjection('claude', registration!)?.command).toContain(SIZE_HEADROOM_HOOK);
    expect(nativeProjection('codex', registration!)?.event).toBe('PostToolUse');
  });
});
