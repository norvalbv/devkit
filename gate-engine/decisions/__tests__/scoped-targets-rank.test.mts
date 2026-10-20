/**
 * Specificity ranking of scoped-targets output: the hook shows only the first three axes, so a broad
 * Scope must not take a slot ahead of a narrow one just because its slug sorts first.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type GoverningTarget, rankBySpecificity } from '../scoped-targets.mts';

const CLI = fileURLToPath(new URL('../cli.mts', import.meta.url));

let root: string;
let sink: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scoped-rank-'));
  sink = join(root, 'events.jsonl');
  writeFileSync(join(root, 'guard.config.json'), '{"decisionsDir":"docs/decisions"}\n');
  mkdirSync(join(root, 'docs', 'decisions'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeAxis(slug: string, scope: string) {
  writeFileSync(
    join(root, 'docs', 'decisions', `${slug}.md`),
    `---\nslug: ${slug}\ncreated: 2026-01-01\n---\n\n## Target · 2026-01-01 — ${slug}\n\n` +
      `**Ruling:** Ruling for ${slug}.\n**Scope:** ${scope}\n`,
  );
}

function cli(args: string[]) {
  return spawnSync('node', [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: root,
      DECISIONS_NO_EMBED: '1',
      DEVKIT_REVIEW_DATA_ROOT: root,
      DEVKIT_GATE_EVENTS: sink,
      DEVKIT_NO_TELEMETRY: undefined,
    },
  });
}

function slugs(stdout: string): string[] {
  const parsed: GoverningTarget[] = JSON.parse(stdout);
  return parsed.map((t) => t.slug);
}

function block(slug: string, scope: string | null, via: GoverningTarget['via'] = 'scope-match') {
  return { slug, ruling: `Ruling for ${slug}.`, scope, via };
}

describe('scoped-targets CLI ranks scope matches most-specific first', () => {
  it('puts three narrow axes ahead of a broad one whose slug sorts first', () => {
    writeAxis('aaa-broad', 'cli/**');
    for (const s of ['gates-x', 'semantic-x', 'shell-x']) writeAxis(s, 'cli/lib/husky/**');

    const r = cli(['scoped-targets', '--files', 'cli/lib/husky/x.mts', '--brief', 'Edit,3,320']);

    expect(r.status).toBe(0);
    expect(slugs(r.stdout)).toEqual(['gates-x', 'semantic-x', 'shell-x', 'aaa-broad']);
    expect(existsSync(sink)).toBe(true);
    const shown = readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .find((e) => e.type === 'brief_shown');
    expect(shown).toMatchObject({
      shown: ['gates-x', 'semantic-x', 'shell-x'],
      hidden: ['aaa-broad'],
    });
  });

  it('ranks an exact-path Scope above a subtree Scope', () => {
    writeAxis('a-subtree', 'cli/lib/husky/**');
    writeAxis('b-exact', 'docs/**, cli/lib/husky/x.mts');

    expect(slugs(cli(['scoped-targets', '--files', 'cli/lib/husky/x.mts']).stdout)).toEqual([
      'b-exact',
      'a-subtree',
    ]);
  });
});

describe('rankBySpecificity', () => {
  it('keeps the input order for equal scores', () => {
    const blocks = [block('c', 'src/**'), block('a', 'src/**'), block('b', 'src/**')];
    expect(rankBySpecificity(['src/x.ts'], blocks).map((b) => b.slug)).toEqual(['c', 'a', 'b']);
  });

  it('scores by the best glob that matches any listed file, ignoring globs that match none', () => {
    const blocks = [
      block('subtree', 'a/**'),
      block('exact', 'z.ts'),
      block('unmatched-narrow', 'a/b/c/d/e/**, z.ts'),
    ];
    const ranked = rankBySpecificity(['a/b/c.ts', 'z.ts'], blocks).map((b) => b.slug);
    expect(ranked).toEqual(['exact', 'unmatched-narrow', 'subtree']);
  });

  it('scores a mid-segment stem glob by its literal text, above the enclosing subtree', () => {
    const blocks = [block('subtree', 'cli/lib/**'), block('stem', 'cli/lib/base-drift-?.mjs')];
    const ranked = rankBySpecificity(['cli/lib/base-drift-a.mjs'], blocks).map((b) => b.slug);
    expect(ranked).toEqual(['stem', 'subtree']);
  });

  it('leaves semantic rows after every scope match, in their original order', () => {
    const blocks = [
      block('broad', 'src/**'),
      block('sem-2', 'src/x.ts', 'semantic'),
      block('narrow', 'src/x.ts'),
      block('sem-1', null, 'semantic'),
    ];
    expect(rankBySpecificity(['src/x.ts'], blocks).map((b) => b.slug)).toEqual([
      'narrow',
      'broad',
      'sem-2',
      'sem-1',
    ]);
  });
});
