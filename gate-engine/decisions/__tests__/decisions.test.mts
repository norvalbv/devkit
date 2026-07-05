import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bm25Rank,
  clampGist,
  cosine,
  currentTarget,
  parseDecision,
  parseIndex,
  renderDecision,
  renderIndex,
  renderNote,
  renderTarget,
  upsertRow,
} from '../decisions.mts';

const SCRIPT = fileURLToPath(new URL('../decisions.mts', import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decisions-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      // GUARD_DECISIONS_DIR is the canonical config override (config reads GUARD_*/FRINK_*,
      // not a bare DECISIONS_DIR). It points the engine's decisionsDir at this temp dir.
      GUARD_DECISIONS_DIR: dir,
      DECISIONS_TODAY: '2026-05-29',
      DECISIONS_NO_EMBED: '1', // deterministic: lexical floor, never a live Ollama call
      DECISIONS_INDEX: join(dir, 'vec-index.json'),
    },
  });
}

// The required Target flags = the Context / Decision (Ruling) / Consequences spine.
const reqFlags = (slug) => [
  '--context',
  `${slug} broke: symptom Z, every flow affected`,
  '--ruling',
  `${slug}-ruling`,
  '--consequences',
  `${slug} value protected`,
  '--tradeoff',
  `${slug} cost knowingly paid`,
  '--vision-fit',
  'friendly dev tool for everyone',
];

// A minimal valid epic Target add for `slug`.
const target = (slug, extra = []) => [
  'add',
  slug,
  '--target',
  ...reqFlags(slug),
  '--new',
  ...extra,
];

describe('pure helpers', () => {
  it('INDEX round-trips a row', () => {
    const rows = [
      { slug: 'mcp-transport', ruling: 'http-proxy', why: 'stdin', updated: '2026-05-29' },
    ];
    expect(parseIndex(renderIndex(rows))).toEqual(rows);
  });

  it('upsertRow appends a new slug and updates an existing one', () => {
    const rows = [{ slug: 'a', ruling: 'x', why: 'h', updated: '1' }];
    upsertRow(rows, { slug: 'b', ruling: 'y', why: 'h2', updated: '2' });
    expect(rows).toHaveLength(2);
    upsertRow(rows, { slug: 'a', ruling: 'z', why: 'h3', updated: '3' });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.slug === 'a').ruling).toBe('z');
  });

  it('frontmatter round-trips', () => {
    const { fm, body } = parseDecision(
      renderDecision({ slug: 's', created: '2026-05-29' }, '\n# s\n'),
    );
    expect(fm.slug).toBe('s');
    expect(fm.created).toBe('2026-05-29');
    expect(body).toContain('# s');
  });

  it('renderTarget renders the Context/Decision/Consequences spine + optional fields', () => {
    const full = renderTarget('2026-05-29', {
      context: 'X broke causing Z',
      ruling: 'http',
      consequences: 'reliable transport',
      tradeoff: 'one extra hop',
      visionFit: 'friendly tool',
      researched: 'arxiv',
      rejected: 'stdin',
      anchoredBet: '[BET]',
      scope: 'src/**',
      source: 'brainstorm',
      evidenceChange: 'new data',
    });
    expect(full).toContain('## Target · 2026-05-29 — http'); // heading derives a title from the ruling
    expect(full).toContain('**Context:** X broke causing Z');
    expect(full).toContain('**Ruling:** http');
    expect(full).toContain('**Consequences:**');
    expect(full).toContain('- Positive: reliable transport');
    expect(full).toContain('- Negative: one extra hop');
    expect(full).toContain('**Vision-fit:** friendly tool');
    expect(full).toContain('**Scope:** src/**');
    expect(full).toContain('**Evidence-change:** new data');
    expect(full).not.toContain('**Vision / target:**'); // the overloaded field is gone
    const min = renderTarget('2026-05-29', {
      context: 'c',
      ruling: 'r',
      consequences: 'v',
      tradeoff: 't',
      visionFit: 'f',
    });
    expect(min).not.toContain('**Scope:**');
    expect(min).not.toContain('**Researched:**');
    expect(min).toContain('**Context:** c');
  });

  it('renderTarget uses an explicit --title for the heading over the derived one', () => {
    const t = renderTarget('2026-05-29', {
      title: 'short title',
      context: 'c',
      ruling: 'a very long ruling that should never become the heading by itself',
      consequences: 'v',
      tradeoff: 't',
      visionFit: 'f',
    });
    expect(t).toContain('## Target · 2026-05-29 — short title');
  });

  it('renderNote renders a dated bullet', () => {
    expect(renderNote('2026-05-29', 'converged X')).toBe('- 2026-05-29 — converged X');
  });

  it('currentTarget finds the LAST Target block + parses ruling/scope', () => {
    const body =
      '\n# s\n\n## Target · 2026-01-01 — old\n\n**Vision / target:** v1\n**Vision-fit:** f\n**Ruling:** old-ruling\n\n' +
      '## Target · 2026-02-01 — new\n\n**Vision / target:** v2\n**Vision-fit:** f\n**Scope:** src/a/**\n**Ruling:** new-ruling\n';
    const t = currentTarget(body);
    expect(t.ruling).toBe('new-ruling');
    expect(t.scope).toBe('src/a/**');
  });

  it('currentTarget returns null with no Target block (old-format / note-only)', () => {
    expect(currentTarget('\n# s\n\n## 2026-01-01 — old entry\n**Ruling:** x\n')).toBeNull();
  });

  it('currentTarget.block is Target-only — appended notes do NOT bleed in (the gistOf headline)', () => {
    const body =
      '\n# s\n\n## Target · 2026-01-01 — R\n\n**Vision / target:** v\n**Ruling:** R\n\n' +
      '- 2026-02-01 — NOTE_CHURN switched the store\n- 2026-02-03 — NOTE_CHURN again\n';
    const t = currentTarget(body);
    expect(t.ruling).toBe('R');
    expect(t.block).toContain('**Ruling:** R');
    expect(t.block).not.toContain('NOTE_CHURN'); // gistOf embeds this block → notes can't outrank the Target
  });
});

describe('retrieval helpers', () => {
  const rows = [
    { slug: 'mcp-transport', ruling: 'http-proxy', why: 'stdin lifecycle', updated: '2026-05-29' },
    { slug: 'auth-provider', ruling: 'neon', why: 'jwks verification', updated: '2026-05-29' },
  ];

  it('bm25Rank ranks by BM25 and drops zero-overlap rows', () => {
    const r = bm25Rank('http proxy transport', rows);
    expect(r[0].slug).toBe('mcp-transport');
    expect(r.find((x) => x.slug === 'auth-provider')).toBeUndefined();
  });

  it('bm25Rank: IDF down-weights a term common to all rows (no stoplist needed)', () => {
    const corpus = [
      { slug: 'a', ruling: 'the system uses postgres', why: 'durable', updated: 'x' },
      { slug: 'b', ruling: 'the system uses sqlite', why: 'local', updated: 'x' },
      { slug: 'c', ruling: 'the system uses redis', why: 'cache', updated: 'x' },
    ];
    // "the/system/uses" appear in every row (IDF≈0); "postgres" is rare (high IDF) → ranks 'a' top.
    const r = bm25Rank('the system uses postgres', corpus, 5);
    expect(r[0].slug).toBe('a');
  });

  it('cosine: identical = 1, orthogonal = 0', () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('clampGist keeps the TAIL when over cap', () => {
    const g = clampGist(`OLD ${'x '.repeat(4000)} CURRENT`, 200);
    expect(g).toContain('CURRENT');
    expect(g).not.toContain('OLD');
    expect(g.length).toBeLessThanOrEqual(200);
  });
});

describe('CLI round-trip', () => {
  it('refuses an unknown slug without --new', () => {
    const r = run(['add', 'mystery', '--target', ...reqFlags('mystery')]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Unknown axis "mystery"');
    expect(existsSync(join(dir, 'mystery.md'))).toBe(false);
  });

  it('--target requires the Context/Consequences spine', () => {
    const r = run(['add', 's', '--target', '--ruling', 'r', '--vision-fit', 'f', '--new']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--context');
  });

  it('records an epic Target with --new; INDEX shows the ruling; show/check round-trip', () => {
    const r = run(target('mcp-transport', ['--scope', 'src/main/lib/mcp/**']));
    expect(r.status).toBe(0);
    const md = readFileSync(join(dir, 'mcp-transport.md'), 'utf8');
    expect(md).toContain('## Target · 2026-05-29 — mcp-transport-ruling');
    expect(md).toContain('**Vision-fit:** friendly dev tool for everyone');
    expect(md).toContain('**Scope:** src/main/lib/mcp/**');
    expect(md).toContain('created: 2026-05-29');
    expect(md).not.toContain('status:');
    expect(readFileSync(join(dir, 'INDEX.md'), 'utf8')).toContain('mcp-transport-ruling');
    expect(run(['check', 'mcp-transport']).status).toBe(0);
    expect(run(['show', 'mcp-transport']).stdout).toContain('**Ruling:** mcp-transport-ruling');
  });

  it('re-targeting requires --evidence-change; both Targets preserved (append-only)', () => {
    run(target('ax'));
    const blocked = run(['add', 'ax', '--target', ...reqFlags('ax')]);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain('--evidence-change');
    const ok = run([
      'add',
      'ax',
      '--target',
      '--context',
      'ax broke again',
      '--ruling',
      'r2',
      '--consequences',
      'v2',
      '--tradeoff',
      't2',
      '--vision-fit',
      'f',
      '--evidence-change',
      'new benchmark',
    ]);
    expect(ok.status).toBe(0);
    const md = readFileSync(join(dir, 'ax.md'), 'utf8');
    expect((md.match(/^## Target · /gm) || []).length).toBe(2);
    expect(md).toContain('**Ruling:** ax-ruling');
    expect(md).toContain('**Ruling:** r2');
  });

  it('a --note appends under the Target and leaves the INDEX ruling untouched', () => {
    run(target('ax'));
    const before = readFileSync(join(dir, 'INDEX.md'), 'utf8');
    const r = run(['add', 'ax', '--note', 'switched localStorage to sqlite for concurrency']);
    expect(r.status).toBe(0);
    const md = readFileSync(join(dir, 'ax.md'), 'utf8');
    expect(md).toContain('- 2026-05-29 — switched localStorage to sqlite for concurrency');
    expect(readFileSync(join(dir, 'INDEX.md'), 'utf8')).toBe(before);
  });

  it('a --note on an axis with no Target errors', () => {
    const r = run(['add', 'ghost', '--note', 'x']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('record one first');
  });

  it('leaves no .tmp siblings (atomic writes)', () => {
    run(target('a'));
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('query falls back to the lexical floor when embed is off, exits 0', () => {
    run([
      'add',
      'mcp-transport',
      '--target',
      '--context',
      'transport proxy scaling broke',
      '--ruling',
      'http-proxy',
      '--consequences',
      'reliable transport',
      '--tradeoff',
      'one extra hop',
      '--vision-fit',
      'f',
      '--new',
    ]);
    run([
      'add',
      'auth-provider',
      '--target',
      '--context',
      'jwks sessions',
      '--ruling',
      'neon',
      '--consequences',
      'secure auth',
      '--tradeoff',
      'vendor lock',
      '--vision-fit',
      'f',
      '--new',
    ]);
    const r = run(['query', 'transport proxy http']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('(lexical)');
    expect(r.stdout).toContain('mcp-transport');
    expect(r.stdout).not.toContain('auth-provider');
  });

  it('query on an empty corpus exits 0', () => {
    const r = run(['query', 'anything']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No decisions recorded.');
  });

  it('query with whitespace-only text exits 1', () => {
    expect(run(['query', '   ']).status).toBe(1);
  });

  it('reindex runs and exits 0 (lexical-only env embeds nothing)', () => {
    run(target('a'));
    const r = run(['reindex']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Reindexed 0/1');
  });
});
