import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCommentCli } from '../cli.mts';
import { detectChangedComments } from '../detect.mts';
import { describeRationaleStore, RATIONALES_FILE, recordRationale } from '../rationales.mts';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'guard-comment-location-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'work'], { cwd: root });
  for (const args of [
    ['config', 'user.email', 'a@b.c'],
    ['config', 'user.name', 'a'],
    ['commit', '-q', '--allow-empty', '-m', 'base'],
  ])
    execFileSync('git', args, { cwd: root });
  return root;
}

function writeStore(root: string, body: string): string {
  const file = path.join(root, '.git', RATIONALES_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}

function entry(rationale: string): string {
  return JSON.stringify({ rationale, at: '2026-08-29T00:00:00.000Z' });
}

const PARAGRAPH = [
  '// The wire protocol counts offsets in UTF-16 code units, not bytes.',
  "// This stays until the vendor's next major version renumbers them.",
  '// Removing it makes byte and character offsets silently disagree.',
  'export const width = (input: string) => input.length;',
  '',
].join('\n');

function stageParagraph(root: string): void {
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'wire.ts'), PARAGRAPH);
  execFileSync('git', ['add', 'src/wire.ts'], { cwd: root });
}

/** DEVKIT_REVIEW_DATA_ROOT is validated as an absolute PHYSICAL directory, so resolve the symlink. */
function reviewDataRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'guard-comment-location-review-'));
  roots.push(dir);
  return realpathSync(dir);
}

describe('describeRationaleStore', () => {
  it('reports an absent store as absent rather than as an empty one', () => {
    const root = repo();
    const store = describeRationaleStore(root);

    expect(store.sharedExists).toBe(false);
    expect(store.sharedFindingIds).toEqual([]);
    expect(store.privateReview).toBe(false);
    expect(store.writableFile).toBe(store.sharedFile);
    expect(store.sharedFile).toBe(path.join(realpathSync(root), '.git', RATIONALES_FILE));
  });

  it('separates an existing but empty store from an absent one', () => {
    const root = repo();
    writeStore(root, JSON.stringify({ version: 1, entries: {} }));
    const store = describeRationaleStore(root);

    expect(store.sharedExists).toBe(true);
    expect(store.sharedFindingIds).toEqual([]);
  });

  it('counts a single entry as one, not as a plural boundary slip', () => {
    const root = repo();
    writeStore(
      root,
      JSON.stringify({
        version: 1,
        entries: {
          a1b2c3d4e5f6: JSON.parse(entry('A single specific rationale for one finding.')),
        },
      }),
    );

    expect(describeRationaleStore(root).sharedFindingIds).toEqual(['a1b2c3d4e5f6']);
  });

  it('reports an unreadable store as unknown rather than throwing or claiming zero', () => {
    const root = repo();
    writeStore(root, '{broken');
    const store = describeRationaleStore(root);

    expect(store.sharedExists).toBe(true);
    expect(store.sharedFindingIds).toBeNull();
  });

  it('reports a store whose schema is wrong as unknown, not as empty', () => {
    const root = repo();
    writeStore(root, JSON.stringify({ version: 2, entries: {} }));

    expect(describeRationaleStore(root).sharedFindingIds).toBeNull();
  });

  // sc-2237 claimed a linked worktree resolves a different store. It does not; this pins that.
  it('resolves the identical shared file from a linked worktree and from the main checkout', () => {
    const root = repo();
    const linkedParent = mkdtempSync(path.join(tmpdir(), 'guard-comment-location-linked-'));
    roots.push(linkedParent);
    const linked = path.join(linkedParent, 'checkout');
    execFileSync('git', ['worktree', 'add', '-q', '--detach', linked, 'HEAD'], { cwd: root });
    writeStore(root, JSON.stringify({ version: 1, entries: {} }));

    expect(describeRationaleStore(linked).sharedFile).toBe(describeRationaleStore(root).sharedFile);
    expect(describeRationaleStore(linked).sharedExists).toBe(true);
    expect(describeRationaleStore(linked).privateReview).toBe(false);
  });

  // The end-to-end shape of sc-2237, without spawning a nested `devkit ship`: evidence recorded in
  // one worktree must satisfy the gate running in an ephemeral worktree cut from it.
  it('lets a rationale justified in one worktree satisfy the gate in an ephemeral sibling', () => {
    const root = repo();
    writeFileSync(
      path.join(root, 'guard.config.json'),
      '{"scanRoots":["src"],"sourceExtensions":["ts"]}\n',
    );
    execFileSync('git', ['add', 'guard.config.json'], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', 'config'], { cwd: root });
    stageParagraph(root);
    const id = detectChangedComments(root).findings[0]?.id;
    if (!id) throw new Error('fixture must produce a staged comment finding');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Ship cuts its gate worktree from the caller's; the same staged paragraph appears in both.
    const ephemeralParent = mkdtempSync(path.join(tmpdir(), 'guard-comment-location-gate-'));
    roots.push(ephemeralParent);
    const ephemeral = path.join(ephemeralParent, 'worktree');
    execFileSync('git', ['worktree', 'add', '-q', '--detach', ephemeral, 'HEAD'], { cwd: root });
    stageParagraph(ephemeral);
    expect(detectChangedComments(ephemeral).findings[0]?.id).toBe(id);

    // Pin, never inherit: an outer `devkit ship` exports GUARD_AI_STRICT=1, which turns the
    // judge-outage exit below from 2 into 3 and makes this assertion depend on the caller.
    vi.stubEnv('GUARD_NO_LLM', '1');
    vi.stubEnv('GUARD_AI_STRICT', '');
    vi.stubEnv('DEVKIT_RUN_MODE', '');
    expect(runCommentCli(['gate'], ephemeral), 'unjustified finding must block').toBe(1);

    expect(
      runCommentCli(
        ['justify', id, 'The vendor wire protocol defines offsets in UTF-16 code units.'],
        root,
      ),
    ).toBe(0);

    // 2 = the judge was REACHED and was unavailable (fail-open), not 1 = still missing evidence.
    expect(runCommentCli(['gate'], ephemeral), 'justified finding must reach the judge').toBe(2);
  });

  it('flags a managed-review data root and still counts only what ship can read', () => {
    const root = repo();
    recordRationale(
      root,
      'a1b2c3d4e5f6',
      'Shared developer evidence recorded before managed review takes over the write path.',
    );
    const dataRoot = reviewDataRoot();
    vi.stubEnv('DEVKIT_RUN_MODE', 'review');
    vi.stubEnv('DEVKIT_REVIEW_DATA_ROOT', dataRoot);
    recordRationale(
      root,
      'b1c2d3e4f5a6',
      'Managed review evidence that a real devkit ship must never count as present.',
    );
    const store = describeRationaleStore(root);

    expect(store.privateReview).toBe(true);
    expect(store.writableFile).toBe(path.join(dataRoot, 'comment-firewall-rationales.json'));
    // Deliberately shared-only: it answers "what would ship see", not "what did I load".
    expect(store.sharedFindingIds).toEqual(['a1b2c3d4e5f6']);
  });

  it.each([
    ['run mode alone', { DEVKIT_RUN_MODE: 'review' }],
    ['a data root alone', { DEVKIT_REVIEW_DATA_ROOT: '/tmp' }],
    ['a review id alone', { DEVKIT_REVIEW_ID: 'rev-1' }],
  ])('does not claim a private review store from %s', (_label, env) => {
    const root = repo();
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const store = describeRationaleStore(root);

    expect(store.privateReview).toBe(false);
    expect(store.writableFile).toBe(store.sharedFile);
  });
});
