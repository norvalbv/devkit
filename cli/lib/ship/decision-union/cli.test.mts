import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readArgs, readPairs, refusals, refusalText, unionRefusal } from './cli.mts';

const CLI = fileURLToPath(new URL('./cli.mts', import.meta.url));

const target = (date: string, ruling: string) =>
  [
    `## Target · ${date} — ${ruling}`,
    '',
    `**Context:** why ${ruling}`,
    '',
    `**Ruling:** ${ruling}`,
    '',
    '**Consequences:**',
    '- (+) kept',
    '',
  ].join('\n');

const axis = (...blocks: string[]) =>
  ['---', 'slug: ax', 'created: 2026-01-01', '---', '', '# ax', '', ...blocks].join('\n');

const FORK = axis(target('2026-01-01', 'old'), '- 2026-01-02 — fork note\n');

describe('unionRefusal', () => {
  it('accepts two notes appended under the same Target', () => {
    const base = `${FORK}- 2026-01-03 — base note\n`;
    const merged = `${base}- 2026-01-04 — caller note\n`;
    expect(unionRefusal(FORK, base, merged)).toBeNull();
  });

  it('refuses when the base added a Target the caller never saw', () => {
    const base = `${FORK}\n${target('2026-01-03', 'new')}`;
    const merged = `${base}- 2026-01-04 — caller note meant for the old ruling\n`;
    expect(unionRefusal(FORK, base, merged)).toMatch(/new Target/);
  });

  it('accepts a caller Target appended after a base note', () => {
    const base = `${FORK}- 2026-01-03 — base note\n`;
    const merged = `${base}\n${target('2026-01-04', 'caller ruling')}`;
    expect(unionRefusal(FORK, base, merged)).toBeNull();
  });

  it('refuses an Amends pointer whose date the base also noted', () => {
    const base = `${FORK}- 2026-01-03 — base note\n`;
    const merged = `${base}- 2026-01-03 — mine\n- 2026-01-04 — **Amends:** note:2026-01-03 — fix\n`;
    expect(unionRefusal(FORK, base, merged)).toMatch(/Amends/);
  });

  it('accepts an Amends pointer on a date the base did not touch, or on another axis', () => {
    const base = `${FORK}- 2026-01-03 — base note\n`;
    const merged = [
      base,
      '- 2026-01-04 — **Amends:** note:2026-01-02 — fix',
      '- 2026-01-04 — **Amends:** other#note:2026-01-03 — fix',
      '',
    ].join('');
    expect(unionRefusal(FORK, base, merged)).toBeNull();
  });

  it('ignores a union file that is not a decision record', () => {
    expect(unionRefusal('a\n', 'a\nb\n', 'a\nb\nc\n')).toBeNull();
  });
});

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A repo whose `fork` and `base` commits carry `ax.md` as given (null: absent), plus the merged oid. */
function axisRepo(fork: string | null, base: string, merged: string) {
  const root = mkdtempSync(join(tmpdir(), 'union-cli-'));
  roots.push(root);
  const git = (...a: string[]) =>
    execFileSync('git', ['-C', root, ...a], {
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    }).trim();
  const commit = (text: string | null) => {
    writeFileSync(join(root, text === null ? 'seed' : 'ax.md'), text ?? '');
    git('add', '-A');
    git('-c', 'user.name=a', '-c', 'user.email=a@b.c', 'commit', '-q', '-m', 'x');
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  const args = { root, patchBase: commit(fork), base: commit(base), baseRef: 'main' };
  writeFileSync(join(root, 'merged'), merged);
  return { args, oid: git('hash-object', '-w', 'merged') };
}

describe('refusals', () => {
  it('reads the fork, base and merged blobs from git and refuses a re-target', () => {
    const base = `${FORK}\n${target('2026-01-03', 'new')}`;
    const { args, oid } = axisRepo(FORK, base, `${base}- 2026-01-04 — caller note\n`);
    const out = refusals(args, ['ax.md', oid]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('git checkout origin/main -- ax.md');
  });

  it('throws on an unreadable revision instead of reading it as an empty file', () => {
    const { args, oid } = axisRepo(FORK, `${FORK}- 2026-01-03 — base note\n`, FORK);
    expect(() => refusals({ ...args, base: 'no-such-rev' }, ['ax.md', oid])).toThrow();
  });

  it('reads a path the fork point lacks as empty instead of failing the add/add merge', () => {
    const plain = axisRepo(null, 'a\n', 'a\nb\n');
    expect(refusals(plain.args, ['ax.md', plain.oid])).toEqual([]);
    const axis = axisRepo(null, FORK, `${FORK}- 2026-01-04 — caller note\n`);
    expect(refusals(axis.args, ['ax.md', axis.oid])[0]).toMatch(/new Target/);
  });

  it('passes a note-on-note merge', () => {
    const base = `${FORK}- 2026-01-03 — base note\n`;
    const { args, oid } = axisRepo(FORK, base, `${base}- 2026-01-04 — caller note\n`);
    expect(refusals(args, ['ax.md', oid])).toEqual([]);
  });
});

describe('input', () => {
  it('requires every flag', () => {
    expect(
      readArgs(['--root', 'r', '--base', 'b', '--patch-base', 'p', '--base-ref', 'm']),
    ).toEqual({ root: 'r', base: 'b', patchBase: 'p', baseRef: 'm' });
    expect(() => readArgs(['--root', 'r'])).toThrow(/missing/);
  });

  it('rejects an unpaired field', () => {
    expect(readPairs(new TextEncoder().encode('a\0oid\0'))).toEqual(['a', 'oid']);
    expect(() => readPairs(new TextEncoder().encode('a\0'))).toThrow(/pairs/);
  });
});

describe('cli', () => {
  it('names the recovery and never suggests a rebase', () => {
    const text = refusalText('docs/decisions/ax.md', 'why', 'main');
    expect(text).toContain('git checkout origin/main -- docs/decisions/ax.md');
    expect(text).toContain('guard-decisions add ax --note');
    expect(text).toContain('Do not rebase');
  });

  it('exits 2 on malformed input so ship fails closed', () => {
    const r = spawnSync(
      process.execPath,
      [CLI, '--root', '.', '--base', 'HEAD', '--patch-base', 'HEAD', '--base-ref', 'main'],
      { input: 'only-a-path\0', encoding: 'utf8' },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('could not verify');
  });
});
