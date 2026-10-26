import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { evidenceDir } from '../lib/machine/manifest.mts';
import { attachCapture } from '../lib/ship/evidence/attach.mts';
import { publishMedia, withPrEvidenceLock } from '../lib/ship/evidence/publish-media.mts';

const temps: string[] = [];
const savedPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = savedPath;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const stateSchema = z.object({
  body: z.string(),
  head: z.string(),
  base: z.string(),
  attachCalls: z.number(),
  attach: z.boolean(),
  failAttach: z.boolean().default(false),
  state: z.string().default('OPEN'),
});
type GhState = z.infer<typeof stateSchema>;

/** A `gh` holding one PR in a JSON file; `--attach` resolves `![…](./file)` from its cwd like gh 2.102,
 * rewriting matches in place (a video to a bare URL) and appending the rest. */
const FAKE_GH = `
const fs = require('node:fs'), path = require('node:path');
const file = process.env.FAKE_GH_STATE, s = JSON.parse(fs.readFileSync(file, 'utf8'));
const a = process.argv.slice(2);
if (a[0] === 'pr' && a[1] === 'view') {
  const pull = { title: 't', body: s.body, headRefOid: s.head, baseRefOid: s.base };
  process.stdout.write(JSON.stringify({ ...pull, state: s.state || 'OPEN', baseRefName: 'main' }));
} else if (a[0] === 'pr' && a[1] === 'edit' && a.includes('--help')) {
  process.stdout.write(s.attach ? 'Use --attach to upload an image or video.' : 'Edit a pull request.');
} else if (a[0] === 'pr' && a[1] === 'edit') {
  const src = a[a.indexOf('--body-file') + 1];
  let body = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
  const files = a.flatMap((x, i) => (x === '--attach' ? [a[i + 1]] : []));
  if (files.length) s.attachCalls += 1;
  if (files.length && s.failAttach) {
    fs.writeFileSync(file, JSON.stringify(s));
    process.exit(1);
  }
  for (const f of files) {
    const url = 'https://github.com/user-attachments/assets/' + path.basename(f).replace(/\\W/g, '');
    const video = f.endsWith('.webm');
    let matched = false;
    body = body.replace(/!\\[([^\\]]*)\\]\\((\\.\\/[^)]+)\\)/g, (all, alt, ref) => {
      if (path.resolve(ref) !== path.resolve(f)) return all;
      matched = true;
      return video ? url : '![' + alt + '](' + url + ')';
    });
    if (!matched) body += '\\n\\n' + (video ? url : '![' + path.parse(f).name + '](' + url + ')');
  }
  s.body = body;
  fs.writeFileSync(file, JSON.stringify(s));
}
`;

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

/** A repo whose second commit is the shipped head, a fake gh on PATH, and an empty PR body. */
function shipped(attach = true) {
  const root = mkdtempSync(join(tmpdir(), 'qa-media-'));
  temps.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['remote', 'add', 'origin', 'https://github.com/o/r.git']);
  const commit = (message: string) =>
    git(root, [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-qm',
      message,
    ]);
  writeFileSync(join(root, 'README.md'), 'base\n');
  git(root, ['add', '.']);
  commit('base');
  const base = git(root, ['rev-parse', 'HEAD']);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'page.html'), '<h1>after</h1>\n');
  git(root, ['add', '.']);
  commit('head');
  const head = git(root, ['rev-parse', 'HEAD']);
  const bin = join(root, '.fake-bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}\n${FAKE_GH}`);
  chmodSync(join(bin, 'gh'), 0o755);
  const state = join(root, '.gh-state.json');
  const initial: GhState = {
    body: 'caller text',
    head,
    base,
    attachCalls: 0,
    attach,
    state: 'OPEN',
  };
  writeFileSync(state, JSON.stringify(initial));
  process.env.PATH = `${bin}:${savedPath}`;
  process.env.FAKE_GH_STATE = state;
  const read = (): GhState => stateSchema.parse(JSON.parse(readFileSync(state, 'utf8')));
  return { root, head, read };
}

/** A passing `click` flow captured on `tree`, as `devkit machine run` writes it; `keep` adds it to the
 * flows already recorded. */
function captured(root: string, tree: string, flow = 'click', passed = true, keep = false): void {
  const dir = evidenceDir(root);
  mkdirSync(dir, { recursive: true });
  const files = [`${flow}.webm`, `${flow}.final.png`];
  const entries = files.map((file) => {
    writeFileSync(join(dir, file), `bytes of ${file}`);
    const sha256 = createHash('sha256').update(`bytes of ${file}`).digest('hex');
    const kind = file.endsWith('.webm') ? 'video' : 'screenshot';
    const facts = {
      sourceHead: 'a'.repeat(40),
      dirty: true,
      tree,
      capturedAt: '2026-10-23T00:00:00.000Z',
    };
    return { file, kind, flow, passed, sha256, bytes: 16, ...facts };
  });
  const kept = keep ? JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).entries : [];
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ entries: [...kept, ...entries] }));
}

const args = (root: string, head: string, pr = '7') => ({ source: root, repo: 'o/r', pr, head });

describe('ship attaches the QA capture to the PR', () => {
  it('uploads the video and final screenshot in one gh call, inside the evidence block', () => {
    const { root, head, read } = shipped();
    captured(root, git(root, ['rev-parse', 'HEAD^{tree}']));
    publishMedia(args(root, head));
    const { body, attachCalls } = read();
    expect(attachCalls).toBe(1);
    expect(body.startsWith('caller text')).toBe(true);
    expect(body).toContain('<b>QA capture</b>');
    expect(body).toMatch(/^https:\/\/github\.com\/user-attachments\/assets\/\w+webm$/m);
    expect(body).toMatch(
      /!\[click screenshot\]\(https:\/\/github\.com\/user-attachments\/assets\/\w+png\)/,
    );
    expect(body).not.toContain('./');
    const uploads = JSON.parse(readFileSync(join(evidenceDir(root), 'uploads.json'), 'utf8'));
    expect(Object.values(uploads)).toEqual([
      'https://github.com/o/r/pull/7',
      'https://github.com/o/r/pull/7',
    ]);
  });

  it('never uploads the same capture twice when the PR is shipped again', () => {
    const { root, head, read } = shipped();
    captured(root, git(root, ['rev-parse', 'HEAD^{tree}']));
    publishMedia(args(root, head));
    const first = read().body;
    publishMedia(args(root, head));
    expect(read()).toMatchObject({ attachCalls: 1, body: first });
  });

  it('never retries an upload that failed, and names it on the next ship', () => {
    const { root, head, read } = shipped();
    captured(root, git(root, ['rev-parse', 'HEAD^{tree}']));
    const state = process.env.FAKE_GH_STATE ?? '';
    writeFileSync(state, JSON.stringify({ ...read(), failAttach: true }));
    publishMedia(args(root, head));
    expect(read().attachCalls).toBe(1);
    expect(read().body).toContain('upload failed');
    writeFileSync(state, JSON.stringify({ ...read(), failAttach: false }));
    publishMedia(args(root, head));
    expect(read().attachCalls).toBe(1);
    expect(read().body).toContain('upload failed on an earlier ship and is never retried');
  });

  it('leaves out a capture that ran different code than the PR ships, and says so', () => {
    const { root, head, read } = shipped();
    captured(root, git(root, ['rev-parse', 'HEAD~1^{tree}']));
    publishMedia(args(root, head));
    expect(read().attachCalls).toBe(0);
    expect(read().body).toContain(
      '`click`: not uploaded, it ran different code than this PR ships at `src/page.html`',
    );
  });

  it('does not attach a capture already attached to another PR', () => {
    const { root, head, read } = shipped();
    captured(root, git(root, ['rev-parse', 'HEAD^{tree}']));
    publishMedia(args(root, head, '7'));
    publishMedia(args(root, head, '8'));
    expect(read().attachCalls).toBe(1);
    expect(read().body).toContain('already attached to https://github.com/o/r/pull/7');
  });

  it('never copies a manifest entry that names a path outside the evidence dir or a non-hex tree', () => {
    const { root, head, read } = shipped();
    captured(root, git(root, ['rev-parse', 'HEAD^{tree}']));
    const manifest = join(evidenceDir(root), 'manifest.json');
    const tampered = readFileSync(manifest, 'utf8')
      .replace('"click.webm"', '"../../secret.webm"')
      .replace(/"tree":"[0-9a-f]+"/, '"tree":"--output=/tmp/x"');
    writeFileSync(manifest, tampered);
    publishMedia(args(root, head));
    expect(read().attachCalls).toBe(0);
    expect(read().body).toContain('not one `devkit machine run` writes');
  });

  it('accepts a flow name that starts with `_`, `-` or `.`, as `devkit machine run` writes them', () => {
    const { root, head, read } = shipped();
    captured(root, git(root, ['rev-parse', 'HEAD^{tree}']), '_login');
    publishMedia(args(root, head));
    expect(read().attachCalls).toBe(1);
    expect(read().body).toContain('**_login** · video');
  });

  it('names a capture whose file changed after it was recorded instead of uploading it', () => {
    const { root, head, read } = shipped();
    captured(root, git(root, ['rev-parse', 'HEAD^{tree}']));
    writeFileSync(join(evidenceDir(root), 'click.webm'), 'different bytes');
    publishMedia(args(root, head));
    expect(read().attachCalls).toBe(0);
    expect(read().body).toContain(
      '`click`: not uploaded, its file changed or went missing after it was captured',
    );
  });

  it('never uploads a failed flow', () => {
    const { root, head, read } = shipped();
    captured(root, git(root, ['rev-parse', 'HEAD^{tree}']), 'click', false);
    publishMedia(args(root, head));
    expect(read().attachCalls).toBe(0);
    expect(read().body).toContain('`click`: not uploaded, the flow failed');
  });

  it('changes nothing when gh cannot attach files, or the PR head moved on', () => {
    const old = shipped(false);
    captured(old.root, git(old.root, ['rev-parse', 'HEAD^{tree}']));
    publishMedia(args(old.root, old.head));
    expect(old.read()).toMatchObject({ attachCalls: 0, body: 'caller text' });
    const moved = shipped();
    captured(moved.root, git(moved.root, ['rev-parse', 'HEAD^{tree}']));
    publishMedia(args(moved.root, 'f'.repeat(40)));
    expect(moved.read()).toMatchObject({ attachCalls: 0, body: 'caller text' });
    expect(existsSync(join(evidenceDir(moved.root), 'uploads.json'))).toBe(false);
  });
});

/** `attachCapture`'s exit code and what it told the agent. */
function attached(root: string, target: string | undefined) {
  const lines: string[] = [];
  const spy = vi
    .spyOn(console, 'error')
    .mockImplementation((line) => void lines.push(String(line)));
  try {
    return { code: attachCapture(root, target), said: lines.join('\n') };
  } finally {
    spy.mockRestore();
  }
}

describe('devkit machine attach puts a capture recorded after the ship into its PR', () => {
  it('uploads it once to the PR it names, then reports it already there', () => {
    const { root, read } = shipped();
    captured(root, git(root, ['rev-parse', 'HEAD^{tree}']));
    expect(attached(root, '7')).toMatchObject({
      code: 0,
      said: expect.stringContaining('attached to #7'),
    });
    expect(read().body).toContain('<b>QA capture</b>');
    expect(attached(root, 'https://github.com/o/r/pull/7/files')).toMatchObject({
      code: 0,
      said: expect.stringContaining('already in #7: click.webm, click.final.png'),
    });
    expect(read().attachCalls).toBe(1);
  });

  it('fails while any apt capture is still not in the PR, even with another one already there', () => {
    const { root, read } = shipped();
    const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
    captured(root, tree);
    expect(attached(root, '7').code).toBe(0);
    captured(root, tree, 'login', true, true);
    writeFileSync(process.env.FAKE_GH_STATE ?? '', JSON.stringify({ ...read(), attach: false }));
    const { code, said } = attached(root, '7');
    expect(code).toBe(1);
    expect(said).toContain('already in #7: click.webm');
    expect(said).toContain('needs gh 2.99 or newer');
  });

  it('keeps failing on a rerun while a capture whose upload failed is still not in the PR', () => {
    const { root, read } = shipped();
    const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
    captured(root, tree);
    expect(attached(root, '7').code).toBe(0);
    captured(root, tree, 'login', true, true);
    const state = process.env.FAKE_GH_STATE ?? '';
    writeFileSync(state, JSON.stringify({ ...read(), failAttach: true }));
    expect(attached(root, '7').code).toBe(1);
    writeFileSync(state, JSON.stringify({ ...read(), failAttach: false }));
    const rerun = attached(root, '7');
    expect(rerun.code).toBe(1);
    expect(rerun.said).toContain('`login.webm`: its upload failed on an earlier ship');
    expect(read().attachCalls).toBe(2);
  });

  it('names the paths a capture differs at, and leaves the PR untouched', () => {
    const { root, read } = shipped();
    captured(root, git(root, ['rev-parse', 'HEAD~1^{tree}']));
    const { code, said } = attached(root, '7');
    expect(code).toBe(1);
    expect(said).toContain('it ran different code than this PR ships at `src/page.html`');
    expect(read()).toMatchObject({ attachCalls: 0, body: 'caller text' });
  });

  it('refuses a merged PR, a PR of another repo, a missing PR and an empty capture', () => {
    const { root, read } = shipped();
    expect(attached(root, '7').said).toContain('no capture in this worktree');
    captured(root, git(root, ['rev-parse', 'HEAD^{tree}']));
    expect(attached(root, undefined).said).toContain(
      'usage: devkit machine attach <pr-number|pr-url>',
    );
    expect(attached(root, 'https://github.com/x/fork/pull/7').said).toContain('is not in o/r');
    const state = process.env.FAKE_GH_STATE ?? '';
    writeFileSync(state, JSON.stringify({ ...read(), state: 'MERGED' }));
    expect(attached(root, '7')).toMatchObject({
      code: 1,
      said: expect.stringContaining('#7 is merged'),
    });
    expect(read()).toMatchObject({ attachCalls: 0, body: 'caller text' });
  });

  it("waits for nobody: a ship publishing the same PR's evidence makes it stop and say so", () => {
    const { root, read } = shipped();
    captured(root, git(root, ['rev-parse', 'HEAD^{tree}']));
    const result = withPrEvidenceLock(root, { repo: 'o/r', pr: '7' }, () => attached(root, '7'), 0);
    expect(result).toMatchObject({
      code: 1,
      said: expect.stringContaining('a devkit ship is publishing #7'),
    });
    expect(read().attachCalls).toBe(0);
  });
});
