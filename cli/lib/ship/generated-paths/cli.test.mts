import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs, renderAbort } from './cli.mts';

const CLI = fileURLToPath(new URL('./cli.mts', import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function repo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'gen-cli-'));
  roots.push(root);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  return root;
}

const run = (root: string, input: string, args = ['--root', root, '--base-ref', 'main']) =>
  spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8' });

describe('parseArgs', () => {
  it('reads --root and --base-ref', () => {
    expect(parseArgs(['--root', '/r', '--base-ref', 'release/1.0'])).toEqual({
      root: '/r',
      baseRef: 'release/1.0',
    });
  });

  it.each([
    [[]],
    [['--root', '/r']],
    [['--root', '--base-ref', 'main']],
    [['--root', '/r', '--base-ref', 'main', '--extra']],
  ])('rejects %j', (argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });
});

describe('renderAbort', () => {
  it('renders the self-host command form inside the devkit repo', () => {
    const root = repo({ 'package.json': JSON.stringify({ name: '@norvalbv/devkit' }) });
    const text = renderAbort(['.devkit/skills-manifest.json'], { root, baseRef: 'main' });
    expect(text).toContain('`node cli/index.mts sync-skills`');
    expect(text).not.toContain('`devkit sync-skills`');
  });

  it('prints a consumer-declared command verbatim', () => {
    const root = repo({
      'guard.config.json': JSON.stringify({
        generated: [{ glob: 'gen/*.json', command: 'pnpm codegen' }],
      }),
    });
    const text = renderAbort(['gen/api.json'], { root, baseRef: 'main' });
    expect(text).toContain('gen/api.json');
    expect(text).toContain('`pnpm codegen`');
  });
});

describe('cli (spawned, as ship-branch.sh calls it)', () => {
  it('reads NUL-delimited paths on stdin (git diff -z) and exits 0', () => {
    const r = run(repo(), '.devkit/agents-manifest.json\0src/f.mts\0');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('`devkit sync-agents`');
    expect(r.stdout).toContain('changed the same region of');
    expect(r.stdout).toContain('src/f.mts');
  });

  it('keeps a newline INSIDE a NUL-delimited path as part of that one name', () => {
    const root = repo({
      'guard.config.json': JSON.stringify({ generated: [{ glob: 'gen/**', command: 'make gen' }] }),
    });
    const r = run(root, 'gen/a\nb.json\0');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('`make gen`');
    expect(r.stdout).toContain(JSON.stringify('gen/a\nb.json'));
    expect(r.stdout).not.toContain('changed the same region of');
  });

  // Two distinct non-UTF-8 names would decode to the same string; defer to git's exact listing.
  it('exits non-zero with an EMPTY stdout on a path that is not valid UTF-8', () => {
    const input = Buffer.concat([
      Buffer.from('src/'),
      Buffer.from([0xff]),
      Buffer.from([0]),
      Buffer.from('src/'),
      Buffer.from([0xfe]),
      Buffer.from([0]),
    ]);
    const r = spawnSync(process.execPath, [CLI, '--root', repo(), '--base-ref', 'main'], {
      input,
      encoding: 'utf8',
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
  });

  it('keeps a leading U+FEFF as part of the name rather than stripping it as a BOM', () => {
    const root = repo({
      'guard.config.json': JSON.stringify({ generated: [{ glob: 'gen/**', command: 'make gen' }] }),
    });
    const r = run(root, '\uFEFFgen/a.json\0');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain('`make gen`');
    expect(r.stdout).toContain('changed the same region of');
  });

  it('prints nothing and exits 0 on empty stdin', () => {
    const r = run(repo(), '');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('exits non-zero with an EMPTY stdout on a malformed config, so ship falls back cleanly', () => {
    const root = repo({ 'guard.config.json': JSON.stringify({ generated: 'dist/**' }) });
    const r = run(root, 'dist/a.mjs\n');
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('generated');
  });

  it('exits non-zero with an EMPTY stdout on bad arguments', () => {
    const r = run(repo(), 'x\n', ['--root']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
  });
});
