import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commentCheck } from '../check.mts';
import { runCommentCli } from '../cli.mts';
import { runCommentFirewall } from '../gate.mts';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const THREE_LINES =
  '// The wire format counts UTF-16 code units.\n// A surrogate pair advances by two.\n// Byte slicing corrupts later frames.\n';
const TWO_LINES =
  '// The wire format counts UTF-16 code units.\n// A surrogate pair advances by two.\n';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function fixture(config: { comments?: { forbiddenRefs: string[] } } = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'guard-comments-check-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'comments@example.test']);
  git(root, ['config', 'user.name', 'Comment Test']);
  mkdirSync(path.join(root, 'src'));
  const guard = { scanRoots: ['src'], sourceExtensions: ['ts'], ...config };
  writeFileSync(path.join(root, 'guard.config.json'), `${JSON.stringify(guard)}\n`);
  writeFileSync(path.join(root, 'src/old.ts'), `${THREE_LINES}export const old = 1;\n`);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'init']);
  return root;
}

const write = (root: string, file: string, body: string) =>
  writeFileSync(path.join(root, file), body);
const indexBytes = (root: string) => readFileSync(path.join(root, '.git/index'));

describe('commentCheck', () => {
  it('names a new 3-line paragraph in an untracked file and leaves the index untouched', () => {
    const root = fixture();
    const before = indexBytes(root);
    write(root, 'src/a.ts', `${THREE_LINES}export const a = 1;\n`);
    const result = commentCheck(['src/a.ts'], root);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.line).toMatch(/^src\/a\.ts:1-3 — /);
    expect(result.remedy).toContain('fix the code');
    expect(result.remedy).not.toMatch(/2-line|two-line/);
    expect(indexBytes(root).equals(before)).toBe(true);
    expect(git(root, ['status', '--porcelain'])).toContain('?? src/a.ts');
  });

  it('reports only the named files, not paragraphs staged elsewhere', () => {
    const root = fixture();
    write(root, 'src/staged.ts', `${THREE_LINES}export const staged = 1;\n`);
    git(root, ['add', 'src/staged.ts']);
    write(root, 'src/a.ts', 'export const a = 1;\n');
    expect(commentCheck(['src/a.ts'], root).items).toEqual([]);
  });

  it('stays silent for a 2-line comment', () => {
    const root = fixture();
    write(root, 'src/a.ts', `${TWO_LINES}export const a = 1;\n`);
    expect(commentCheck(['src/a.ts'], root)).toEqual({ items: [], remedy: '' });
  });

  it('reports an unstaged edit to a tracked file', () => {
    const root = fixture();
    write(
      root,
      'src/old.ts',
      `${THREE_LINES}export const old = 1;\n${THREE_LINES}export const b = 2;\n`,
    );
    expect(commentCheck(['src/old.ts'], root).items.map((item) => item.line)).toEqual([
      expect.stringMatching(/^src\/old\.ts:5-7 — /),
    ]);
  });

  it('pairs a moved file with its old path, so untouched paragraphs stay quiet', () => {
    const root = fixture();
    git(root, ['mv', 'src/old.ts', 'src/moved.ts']);
    write(root, 'src/moved.ts', `${THREE_LINES}export const old = 2;\n`);
    expect(commentCheck(['src/moved.ts'], root).items).toEqual([]);
    git(root, ['mv', 'src/moved.ts', 'src/old.ts']);
    renameSync(path.join(root, 'src/old.ts'), path.join(root, 'src/plain.ts'));
    expect(commentCheck(['src/plain.ts'], root).items).toEqual([]);
  });

  it('reports a forbidden reference with its own remedy', () => {
    const root = fixture({ comments: { forbiddenRefs: ['\\bsc-\\d+\\b'] } });
    write(
      root,
      'src/a.ts',
      '// Residual until replies are typed (sc-3836).\nexport const a = 1;\n',
    );
    const result = commentCheck(['src/a.ts'], root);
    expect(result.items.map((item) => item.line)).toEqual([
      'src/a.ts:1 cites sc-3836 — // Residual until replies are typed (sc-3836).',
    ]);
    expect(result.remedy).toContain('Comments outlive tickets');
  });

  it('adds a bracketed path literally rather than as a glob', () => {
    const root = fixture();
    mkdirSync(path.join(root, 'src/[id]'));
    write(root, 'src/[id]/page.ts', `${THREE_LINES}export const page = 1;\n`);
    mkdirSync(path.join(root, 'src/i'));
    write(root, 'src/i/page.ts', `${THREE_LINES}export const i = 1;\n`);
    expect(commentCheck(['src/[id]/page.ts'], root).items.map((item) => item.line)).toEqual([
      expect.stringMatching(/^src\/\[id\]\/page\.ts:1-3 — /),
    ]);
  });

  it('spends no show-once block, so the commit gate still blocks the paragraph', () => {
    const root = fixture();
    write(root, 'src/a.ts', `${THREE_LINES}export const a = 1;\n`);
    commentCheck(['src/a.ts'], root);
    commentCheck(['src/a.ts'], root);
    expect(existsSync(path.join(root, '.git/devkit/comment-shown'))).toBe(false);
    git(root, ['add', 'src/a.ts']);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(runCommentFirewall(root)).toBe(1);
  });

  it('restores the caller GIT_INDEX_FILE and reports git failures as data', () => {
    const root = fixture();
    const previous = process.env.GIT_INDEX_FILE;
    const result = commentCheck(['src/missing.ts'], root);
    expect(process.env.GIT_INDEX_FILE).toBe(previous);
    expect(result.items).toEqual([]);
    expect(result.error).toMatch(/missing\.ts/);
  });

  it('reads a caller-chosen index without writing it, and hands it back', () => {
    const root = fixture();
    const alternate = path.join(root, '.git/alternate-index');
    writeFileSync(alternate, indexBytes(root));
    vi.stubEnv('GIT_INDEX_FILE', alternate);
    write(root, 'src/a.ts', `${THREE_LINES}export const a = 1;\n`);
    expect(commentCheck(['src/a.ts'], root).items).toHaveLength(1);
    expect(process.env.GIT_INDEX_FILE).toBe(alternate);
    expect(readFileSync(alternate).equals(indexBytes(root))).toBe(true);
  });

  it('removes scratch dirs a killed check left behind, never a live one', () => {
    const root = fixture();
    const stale = mkdtempSync(path.join(tmpdir(), 'devkit-comment-check-'));
    const live = mkdtempSync(path.join(tmpdir(), 'devkit-comment-check-'));
    roots.push(live);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, twoHoursAgo, twoHoursAgo);
    commentCheck(['src/old.ts'], root);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });
});

describe('guard-comments check', () => {
  it('prints the one JSON object the edit-time hook parses', () => {
    const root = fixture();
    write(root, 'src/a.ts', `${THREE_LINES}export const a = 1;\n`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(runCommentCli(['check', 'src/a.ts'], root)).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).items[0].line).toMatch(/^src\/a\.ts:1-3/);
  });

  it('needs at least one file', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(runCommentCli(['check'])).toBe(4);
  });
});
