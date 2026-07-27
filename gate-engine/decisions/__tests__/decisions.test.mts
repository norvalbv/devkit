import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bm25Rank,
  clampGist,
  cosine,
  currentTarget,
  effectiveScope,
  loadAxisRows,
  parseDecision,
  parseIndex,
  renderDecision,
  renderIndex,
  renderNote,
  renderTarget,
  upsertRow,
} from '../decisions.mts';
import {
  allTargetBlocks,
  parseSupersedesId,
  resolveSupersession,
} from '../recall/supersession.mts';

const SCRIPT = fileURLToPath(new URL('../decisions.mts', import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decisions-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'decisions@test.invalid'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Decision Tests'], { cwd: dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: dir,
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

function commitAll(message = 'decision baseline') {
  spawnSync('git', ['add', '.'], { cwd: dir });
  const result = spawnSync('git', ['commit', '-qm', message], { cwd: dir, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
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

  it('renderIndex sanitizes Markdown table delimiters and line breaks', () => {
    const rendered = renderIndex([
      {
        slug: 'safe-axis',
        ruling: 'first | second\nthird',
        why: 'line one\r\nline two',
        updated: '2026-05-29|later',
      },
    ]);
    expect(rendered).toContain(
      '| [safe-axis](safe-axis.md) | first second third | line one line two | 2026-05-29 later |',
    );
    expect(parseIndex(rendered)).toEqual([
      {
        slug: 'safe-axis',
        ruling: 'first second third',
        why: 'line one line two',
        updated: '2026-05-29 later',
      },
    ]);
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

  it('renderTarget renders **Supersedes:** only when given, alongside Scope/Revisit-when/Anchored-bet', () => {
    const withSupersedes = renderTarget('2026-05-29', {
      context: 'c',
      ruling: 'r',
      consequences: 'v',
      tradeoff: 't',
      visionFit: 'f',
      supersedes: 'other-axis#target:2026-06-13',
    });
    expect(withSupersedes).toContain('**Supersedes:** other-axis#target:2026-06-13');
    const without = renderTarget('2026-05-29', {
      context: 'c',
      ruling: 'r',
      consequences: 'v',
      tradeoff: 't',
      visionFit: 'f',
    });
    expect(without).not.toContain('**Supersedes:**');
  });

  // currentTarget's contract stays "last block wins" — unchanged by Supersedes. Its generic
  // `**Field:**` capture already surfaces `fields.supersedes` for free; nothing about resolving
  // whether that pointer is valid or live belongs in this function (see resolveSupersession).
  it('currentTarget still returns only the LAST block, and exposes its own Supersedes field', () => {
    const body =
      '\n# s\n\n## Target · 2026-01-01 — old\n\n**Ruling:** old-ruling\n\n' +
      '## Target · 2026-02-01 — new\n\n**Ruling:** new-ruling\n**Supersedes:** target:2026-01-01\n';
    const t = currentTarget(body);
    expect(t.ruling).toBe('new-ruling');
    expect(t.fields.supersedes).toBe('target:2026-01-01');
  });
});

describe('supersession (recall/supersession.mts)', () => {
  const write = (name, body) => writeFileSync(join(dir, name), body);
  const axis = (slug, blocks) =>
    `---\nslug: ${slug}\ncreated: 2026-01-01\n---\n\n# ${slug}\n\n${blocks}`;
  const targetBlock = (date, ruling, extraFields = '') =>
    `## Target · ${date} — ${ruling}\n\n**Context:** a forcing failure\n**Ruling:** ${ruling}\n${extraFields}**Source:** manual\n`;

  it('parseSupersedesId parses bare and slug-qualified ids of both kinds; rejects garbage', () => {
    expect(parseSupersedesId('target:2026-06-13')).toEqual({
      slug: null,
      id: 'target:2026-06-13',
    });
    expect(parseSupersedesId('entry:2026-06-13')).toEqual({ slug: null, id: 'entry:2026-06-13' });
    expect(parseSupersedesId('other-axis#target:2026-06-13')).toEqual({
      slug: 'other-axis',
      id: 'target:2026-06-13',
    });
    expect(parseSupersedesId('other-axis#entry:2026-01-01')).toEqual({
      slug: 'other-axis',
      id: 'entry:2026-01-01',
    });
    expect(parseSupersedesId('not an id')).toBeNull();
  });

  it('allTargetBlocks returns EVERY Target block, not just the last (currentTarget stays last-only)', () => {
    write(
      'axis.md',
      axis(
        'axis',
        `${targetBlock('2026-01-01', 'first')}\n${targetBlock('2026-03-03', 'second', '**Supersedes:** target:2026-01-01\n')}`,
      ),
    );
    const body = parseDecision(readFileSync(join(dir, 'axis.md'), 'utf8')).body;
    const blocks = allTargetBlocks(body);
    expect(blocks.map((b) => b.id)).toEqual(['target:2026-01-01', 'target:2026-03-03']);
    expect(blocks[1].supersedes).toBe('target:2026-01-01');
    expect(blocks[0].supersedes).toBeNull();
  });

  // renderTarget writes Vision-fit/Scope/Supersedes/Source right after the Consequences bullets with
  // NO blank line — CommonMark treats that as a LAZY CONTINUATION of the list's last item, not new
  // prose, so a naive `section.prose`-only read would silently drop every field rendered after
  // Consequences. This exercises the ACTUAL renderTarget output, not a hand-rolled fixture that
  // dodges the shape.
  it('reads Supersedes from a REAL renderTarget block (fields after Consequences are not swallowed)', () => {
    const rendered = renderTarget('2026-06-14', {
      context: 'c',
      ruling: 'r',
      consequences: 'v',
      tradeoff: 't',
      visionFit: 'f',
      supersedes: 'older#target:2026-06-13',
    });
    const blocks = allTargetBlocks(`\n# axis\n\n${rendered}\n`);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].supersedes).toBe('older#target:2026-06-13');
  });

  it('a Target explicitly superseding an earlier one in the SAME axis clears the ambiguity', () => {
    write(
      'axis.md',
      axis(
        'axis',
        `${targetBlock('2026-01-01', 'first')}\n${targetBlock('2026-03-03', 'second', '**Supersedes:** target:2026-01-01\n')}`,
      ),
    );
    const { multipleLive, unresolved } = resolveSupersession(dir);
    expect(unresolved).toEqual([]);
    expect(multipleLive).toEqual([]);
  });

  // The motivating gap: two axes, two live-looking Targets, no link between them. Once the newer
  // one declares Supersedes, the older axis's current block is READ-TIME resolved as no longer
  // live — the file itself is never touched (append-only survives).
  it('a superseded Target is not treated as live — cross-axis reference resolves', () => {
    write('older.md', axis('older', targetBlock('2026-06-13', 'via npx-skills')));
    write(
      'newer.md',
      axis(
        'newer',
        targetBlock('2026-06-14', 'NOT npx-skills', '**Supersedes:** older#target:2026-06-13\n'),
      ),
    );
    const { supersededBy, unresolved } = resolveSupersession(dir);
    expect(unresolved).toEqual([]);
    expect(supersededBy.get('older')).toBe('newer#target:2026-06-14');
    expect(supersededBy.get('newer')).toBeNull(); // the superseding block itself is uncontested
  });

  it('a Supersedes id referencing a LEGACY entry (in another axis) resolves', () => {
    write(
      'legacy-old.md',
      axis(
        'legacy-old',
        '## 2025-12-01 — old ruling\n\n**Ruling:** old ruling\n**Source:** manual\n',
      ),
    );
    write(
      'modern-new.md',
      axis(
        'modern-new',
        targetBlock('2026-06-14', 'new ruling', '**Supersedes:** legacy-old#entry:2025-12-01\n'),
      ),
    );
    expect(resolveSupersession(dir).unresolved).toEqual([]);
  });

  it('an unresolvable Supersedes id — bad shape, missing date, or unknown axis — is reported', () => {
    write(
      'bad-shape.md',
      axis('bad-shape', targetBlock('2026-06-14', 'r', '**Supersedes:** not-an-id\n')),
    );
    write(
      'dangling.md',
      axis('dangling', targetBlock('2026-06-14', 'r', '**Supersedes:** target:1999-01-01\n')),
    );
    write(
      'cross-dangling.md',
      axis(
        'cross-dangling',
        targetBlock('2026-06-14', 'r', '**Supersedes:** nope#target:2026-06-13\n'),
      ),
    );
    const { unresolved } = resolveSupersession(dir);
    expect(unresolved.map((u) => u.slug).sort()).toEqual([
      'bad-shape',
      'cross-dangling',
      'dangling',
    ]);
  });

  // Every axis written before the Supersedes field exists has several Target blocks and declares
  // none; for those the documented rule is positional — the last block is current. Reporting them
  // flagged 5 of 5 multi-Target axes on the real corpus, a 100% false-positive rate, which is how a
  // check gets switched off. Ambiguity is only reportable where the field is actually in use; the
  // partial-adoption case that IS a real inconsistency is covered in drift.test.mts.
  it('an axis that declares no Supersedes at all is NOT flagged ambiguous', () => {
    write(
      'ambiguous.md',
      axis(
        'ambiguous',
        `${targetBlock('2026-01-01', 'first')}\n${targetBlock('2026-03-03', 'second')}`,
      ),
    );
    expect(resolveSupersession(dir).multipleLive).toEqual([]);
  });
});

// effectiveScope resolves what currentTarget().scope structurally cannot see: a rescope note is a
// note bullet, and currentTarget stops at the first one on purpose (notes are cheap convergence,
// not the ruling). These fixtures use the same `\n# s\n\n## Target · …` shape as the currentTarget
// tests above — effectiveScope reads the same body.
describe('effectiveScope (rescope resolution)', () => {
  const withTrailer = (trailer: string) =>
    '\n# ax\n\n## Target · 2026-01-01 — R\n\n**Context:** c\n**Ruling:** R\n' +
    '**Consequences:**\n- Positive: p\n- Negative: n\n**Scope:** src/old/**\n**Source:** manual\n' +
    trailer;

  it('no rescope note: falls back to the Target’s own Scope', () => {
    expect(effectiveScope(withTrailer(''))).toBe('src/old/**');
  });

  it('a rescope note overrides the stale Target Scope', () => {
    const body = withTrailer('- 2026-02-01 — **Scope:** src/new/** — directory renamed\n');
    expect(effectiveScope(body)).toBe('src/new/**');
  });

  it('the LAST rescope note wins when the axis was rescoped more than once', () => {
    const body = withTrailer(
      '- 2026-02-01 — **Scope:** src/new/** — first move\n' +
        '- 2026-03-01 — **Scope:** src/newer/** — second move\n',
    );
    expect(effectiveScope(body)).toBe('src/newer/**');
  });

  it('an ordinary note that is not a Scope tag does not override the Target Scope', () => {
    const body = withTrailer('- 2026-02-01 — unrelated implementation convergence note\n');
    expect(effectiveScope(body)).toBe('src/old/**');
  });

  it('no Target at all: empty string, never throws', () => {
    expect(effectiveScope('\n# ax\n\nno heading structure a Target could be read from\n')).toBe('');
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

describe('loadAxisRows (the retrieval candidate set)', () => {
  const paths = () => ({
    cwd: dir,
    decisionsDir: dir,
    indexPath: join(dir, 'INDEX.md'),
    vecIndexPath: join(dir, 'vec-index.json'),
  });
  const write = (name, body) => writeFileSync(join(dir, name), body);
  const axis = (slug, blocks) =>
    `---\nslug: ${slug}\ncreated: 2026-01-01\n---\n\n# ${slug}\n\n${blocks}`;
  const targetBlock = (date, ruling, context = 'a forcing failure') =>
    `## Target · ${date} — ${ruling}\n\n**Context:** ${context}\n**Ruling:** ${ruling}\n**Source:** manual\n`;

  it('returns an axis with NO INDEX row — the 27%-unreachable bug', () => {
    // INDEX.md deliberately omits `orphan`; before this it could not be returned at any k.
    write(
      'INDEX.md',
      renderIndex([{ slug: 'listed', ruling: 'r', why: 'w', updated: '2026-01-01' }]),
    );
    write('listed.md', axis('listed', targetBlock('2026-01-01', 'listed ruling')));
    write('orphan.md', axis('orphan', targetBlock('2026-02-02', 'orphan ruling')));

    const rows = loadAxisRows(paths());
    expect(rows.map((r) => r.slug).sort()).toEqual(['listed', 'orphan']);
    expect(rows.find((r) => r.slug === 'orphan')?.ruling).toBe('orphan ruling');
  });

  it('drops an INDEX row whose file is gone (it could never be shown)', () => {
    write(
      'INDEX.md',
      renderIndex([{ slug: 'ghost', ruling: 'r', why: 'w', updated: '2026-01-01' }]),
    );
    expect(loadAxisRows(paths())).toEqual([]);
  });

  it('takes the LAST Target on a re-targeted axis, not the first', () => {
    write(
      'axis.md',
      axis(
        'axis',
        `${targetBlock('2026-01-01', 'superseded ruling')}\n${targetBlock('2026-03-03', 'current ruling')}`,
      ),
    );
    const row = loadAxisRows(paths())[0];
    expect(row.ruling).toBe('current ruling');
    expect(row.updated).toBe('2026-03-03');
  });

  it('reads the legacy pre-Target schema (## <date> — … with **Why / target:**)', () => {
    // 49 of 86 blocks in the real corpus still use this shape; currentTarget() returns null for it.
    write(
      'legacy.md',
      axis(
        'legacy',
        '## 2026-04-04 — no embeddings in v1\n\n**Ruling:** no embeddings in v1\n**Why / target:** axis set is bounded\n**Source:** brainstorm\n',
      ),
    );
    const row = loadAxisRows(paths())[0];
    expect(row.ruling).toBe('no embeddings in v1');
    expect(row.why).toBe('axis set is bounded');
    expect(row.updated).toBe('2026-04-04');
  });

  it('liveRulingId names the block a ruling was read from, per schema generation', () => {
    write('modern.md', axis('modern', targetBlock('2026-01-01', 'r')));
    write(
      'legacy.md',
      axis('legacy', '## 2026-04-04 — old\n\n**Ruling:** r\n**Source:** manual\n'),
    );
    write('bare.md', axis('bare', '- 2026-05-05 — a note with no block at all\n'));
    const byslug = Object.fromEntries(loadAxisRows(paths()).map((r) => [r.slug, r.liveRulingId]));
    expect(byslug).toEqual({
      modern: 'target:2026-01-01',
      legacy: 'entry:2026-04-04',
      bare: null,
    });
  });

  it('liveRulingId reports the LAST Target, so a stale ruling is visible against `updated`', () => {
    // The real-corpus pathology, made machine-checkable without an LLM: the block answering the
    // query is dated months before the file's newest content.
    write(
      'hot.md',
      axis(
        'hot',
        `${targetBlock('2026-06-08', 'hooks follow the user')}- 2026-07-25 — actually they cannot\n`,
      ),
    );
    const row = loadAxisRows(paths())[0];
    expect(row.liveRulingId).toBe('target:2026-06-08');
    expect(row.updated).toBe('2026-07-25'); // the gap IS the staleness signal
  });

  it('bounds qualifiers at BOTH ends: past a trailing [archived] heading, and not INTO it', () => {
    // The archived block carries its own dated bullets — the shape the first version of this test
    // failed to exercise (it used a bullet-free '> retired' body, so the missing end-boundary went
    // unnoticed). Archiving rather than deleting is the documented way to retire a mis-filed entry,
    // so retired bullets are normal and must never be served as live qualifiers.
    write(
      'trailing.md',
      axis(
        'trailing',
        `${targetBlock('2026-03-03', 'the live ruling')}- 2026-04-04 — this note falsifies it\n\n` +
          '## [archived — impl-note, not an epic]\n\n' +
          '- 2026-01-01 — RETIRED bullet that must not resurface\n' +
          '- 2026-02-02 — another RETIRED bullet\n',
      ),
    );
    const row = loadAxisRows(paths()).find((r) => r.slug === 'trailing');
    expect(row?.liveRulingId).toBe('target:2026-03-03');
    expect(row?.qualifiers.map((q) => q.date)).toEqual(['2026-04-04']);
    expect(JSON.stringify(row?.entries)).not.toContain('RETIRED');
  });

  it('a multi-block LEGACY axis indexes only its current block, not the whole file', () => {
    // Append-only legacy files stack `## <date>` blocks. Taking the whole body as the ruling text
    // meant every SUPERSEDED block was indexed as though it were current — 12 files in the real
    // corpus have this shape. The seed corpus had none, which is why no test caught it.
    write(
      'legacy-stack.md',
      axis(
        'legacy-stack',
        '## 2026-01-05 — the retired ruling\n\n**Ruling:** SUPERSEDED_TEXT wall clock\n**Source:** seed\n' +
          '- 2026-01-08 — a note under the RETIRED block\n\n' +
          '## 2026-01-12 — the current ruling\n\n**Ruling:** monotonic source only\n**Source:** seed\n' +
          '- 2026-02-02 — a note under the CURRENT block\n',
      ),
    );
    const row = loadAxisRows(paths()).find((r) => r.slug === 'legacy-stack');
    expect(row?.liveRulingId).toBe('entry:2026-01-12');
    expect(row?.entries[0].text).not.toContain('SUPERSEDED_TEXT');
    // Only the note under the CURRENT block qualifies it.
    expect(row?.qualifiers.map((q) => q.date)).toEqual(['2026-02-02']);
  });

  it('two blocks sharing a DATE bind to the last one, not the first', () => {
    // today() is day-granularity, so an axis amended twice in one day has two same-date headings.
    // Array.find would take the SUPERSEDED one and attach its notes to the current ruling.
    write(
      'same-day.md',
      axis(
        'same-day',
        `${targetBlock('2026-03-11', 'the morning ruling')}- 2026-03-11 — note under the SUPERSEDED block\n\n` +
          `${targetBlock('2026-03-11', 'the afternoon ruling')}- 2026-04-02 — note under the CURRENT block\n`,
      ),
    );
    const row = loadAxisRows(paths()).find((r) => r.slug === 'same-day');
    expect(row?.entries[0].text).toContain('afternoon');
    expect(row?.entries[0].text).not.toContain('morning');
    expect(row?.qualifiers.map((q) => q.date)).toEqual(['2026-04-02']);
  });

  it('dates from a note bullet count toward `updated` (notes are newer than their Target)', () => {
    write(
      'hot.md',
      axis('hot', `${targetBlock('2026-01-01', 'the ruling')}- 2026-06-09 — a later note\n`),
    );
    expect(loadAxisRows(paths())[0].updated).toBe('2026-06-09');
  });

  // Untagged notes keep exactly today's meaning (relation absent); only a note whose text BEGINS
  // `**Amends:**` gets the marker — qualifying the Target rather than merely logging progress.
  it('a note tagged **Amends:** carries relation "amends"; an untagged note does not', () => {
    write(
      'axis.md',
      axis(
        'axis',
        `${targetBlock('2026-01-01', 'the ruling')}` +
          '- 2026-02-02 — **Amends:** narrows the ruling to only the http transport\n' +
          '- 2026-02-03 — plain progress note, not a relation tag\n',
      ),
    );
    const row = loadAxisRows(paths()).find((r) => r.slug === 'axis');
    const amends = row?.qualifiers.find((q) => q.date === '2026-02-02');
    const plain = row?.qualifiers.find((q) => q.date === '2026-02-03');
    expect(amends?.relation).toBe('amends');
    expect(plain?.relation).toBeUndefined();
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

  it('--category writes **Category:** when it is a frozen value', () => {
    const r = run(target('mcp-transport', ['--category', 'commit-gates']));
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, 'mcp-transport.md'), 'utf8')).toContain(
      '**Category:** commit-gates',
    );
  });

  it('--category refuses an unrecognised value and writes nothing', () => {
    const r = run(target('mcp-transport', ['--category', 'not-a-real-category']));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Unknown category "not-a-real-category"');
    expect(existsSync(join(dir, 'mcp-transport.md'))).toBe(false);
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

  it('a --supersedes flag round-trips into the rendered Target block', () => {
    const r = run(target('ax', ['--supersedes', 'other-axis#target:2026-06-13']));
    expect(r.status).toBe(0);
    const md = readFileSync(join(dir, 'ax.md'), 'utf8');
    expect(md).toContain('**Supersedes:** other-axis#target:2026-06-13');
  });

  describe('rescope (append-only Scope correction)', () => {
    it('appends a tagged note in the ruled form; the original Scope line is untouched', () => {
      run(target('ax', ['--scope', 'src/old/**']));
      const before = readFileSync(join(dir, 'ax.md'), 'utf8');

      const r = run(['rescope', 'ax', '--scope', 'src/new/**', '--reason', 'directory renamed']);
      expect(r.status).toBe(0);

      const md = readFileSync(join(dir, 'ax.md'), 'utf8');
      expect(md).toContain('- 2026-05-29 — **Scope:** src/new/** — directory renamed');
      // Append-only: the ORIGINAL Target block — including its own Scope line — is byte-identical.
      expect(md.startsWith(before.replace(/\n$/, ''))).toBe(true);
      expect(md).toContain('**Scope:** src/old/**');
    });

    it('does NOT touch the INDEX (a rescope is a note, not a ruling)', () => {
      run(target('ax', ['--scope', 'src/old/**']));
      const before = readFileSync(join(dir, 'INDEX.md'), 'utf8');
      run(['rescope', 'ax', '--scope', 'src/new/**', '--reason', 'moved']);
      expect(readFileSync(join(dir, 'INDEX.md'), 'utf8')).toBe(before);
    });

    it('does NOT require --evidence-change, unlike a --target re-target', () => {
      run(target('ax', ['--scope', 'src/old/**']));
      const r = run(['rescope', 'ax', '--scope', 'src/new/**', '--reason', 'moved']);
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain('--evidence-change');
    });

    it('errors on an unknown axis', () => {
      const r = run(['rescope', 'ghost', '--scope', 'src/**', '--reason', 'x']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('record one first');
    });

    it('requires both --scope and --reason', () => {
      run(target('ax'));
      const noScope = run(['rescope', 'ax', '--reason', 'x']);
      expect(noScope.status).toBe(1);
      expect(noScope.stderr).toContain('Usage: guard-decisions rescope');
      const noReason = run(['rescope', 'ax', '--scope', 'src/**']);
      expect(noReason.status).toBe(1);
      expect(noReason.stderr).toContain('Usage: guard-decisions rescope');
    });
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

describe('draft amendments', () => {
  it('rejects ambiguous target-and-note amendment modes', () => {
    run(target('axis'));
    const before = readFileSync(join(dir, 'axis.md'), 'utf8');
    const blocked = run([
      'amend',
      'axis',
      '--target',
      ...reqFlags('replacement'),
      '--note',
      'also a note',
    ]);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain('Usage: guard-decisions amend');
    expect(readFileSync(join(dir, 'axis.md'), 'utf8')).toBe(before);
  });

  it('amends the sole Target on a new uncommitted axis and regenerates INDEX', () => {
    expect(run(target('new-axis')).status).toBe(0);
    const amended = run([
      'amend',
      'new-axis',
      '--target',
      ...reqFlags('replacement'),
      '--title',
      'replacement title',
    ]);
    expect(amended.status, amended.stderr).toBe(0);
    const md = readFileSync(join(dir, 'new-axis.md'), 'utf8');
    expect(md).toContain('replacement title');
    expect(md).not.toContain('new-axis-ruling');
    expect(readFileSync(join(dir, 'INDEX.md'), 'utf8')).toContain('replacement-ruling');
  });

  it('rejects an incomplete Target amendment without changing the decision or INDEX', () => {
    expect(run(target('axis')).status).toBe(0);
    const file = join(dir, 'axis.md');
    const index = join(dir, 'INDEX.md');
    const beforeFile = readFileSync(file, 'utf8');
    const beforeIndex = readFileSync(index, 'utf8');
    const blocked = run([
      'amend',
      'axis',
      '--target',
      '--ruling',
      'replacement-ruling',
      '--consequences',
      'replacement value protected',
      '--tradeoff',
      'replacement cost',
      '--vision-fit',
      'friendly dev tool for everyone',
    ]);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain('amend --target requires');
    expect(readFileSync(file, 'utf8')).toBe(beforeFile);
    expect(readFileSync(index, 'utf8')).toBe(beforeIndex);
  });

  it('amends an appended Target while preserving committed history', () => {
    run(target('axis'));
    commitAll();
    expect(
      run(['add', 'axis', '--target', ...reqFlags('second'), '--evidence-change', 'new benchmark'])
        .status,
    ).toBe(0);
    const amended = run([
      'amend',
      'axis',
      '--target',
      ...reqFlags('final'),
      '--evidence-change',
      'corrected benchmark',
    ]);
    expect(amended.status, amended.stderr).toBe(0);
    const md = readFileSync(join(dir, 'axis.md'), 'utf8');
    expect(md).toContain('**Ruling:** axis-ruling');
    expect(md).toContain('**Ruling:** final-ruling');
    expect(md).not.toContain('**Ruling:** second-ruling');
    expect(readFileSync(join(dir, 'INDEX.md'), 'utf8')).toContain('final-ruling');
  });

  it('rejects amending an appended Target without evidence change, atomically', () => {
    run(target('axis'));
    commitAll();
    expect(
      run(['add', 'axis', '--target', ...reqFlags('second'), '--evidence-change', 'new benchmark'])
        .status,
    ).toBe(0);
    const file = join(dir, 'axis.md');
    const index = join(dir, 'INDEX.md');
    const beforeFile = readFileSync(file, 'utf8');
    const beforeIndex = readFileSync(index, 'utf8');

    const blocked = run(['amend', 'axis', '--target', ...reqFlags('replacement')]);

    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain('requires --evidence-change');
    expect(readFileSync(file, 'utf8')).toBe(beforeFile);
    expect(readFileSync(index, 'utf8')).toBe(beforeIndex);
  });

  it('amends the newest uncommitted note without changing INDEX', () => {
    run(target('axis'));
    commitAll();
    expect(run(['add', 'axis', '--note', 'draft note']).status).toBe(0);
    const beforeIndex = readFileSync(join(dir, 'INDEX.md'), 'utf8');
    const amended = run(['amend', 'axis', '--note', 'corrected note']);
    expect(amended.status, amended.stderr).toBe(0);
    expect(readFileSync(join(dir, 'axis.md'), 'utf8')).toContain('corrected note');
    expect(readFileSync(join(dir, 'axis.md'), 'utf8')).not.toContain('draft note');
    expect(readFileSync(join(dir, 'INDEX.md'), 'utf8')).toBe(beforeIndex);
  });

  it('surgically replaces one substring in a long draft note and preserves every other byte', () => {
    run(target('axis'));
    commitAll();
    const oldText = 'the restart path always resumes the original run';
    const newText = 'the restart path creates a successor run';
    const longNote = `${'unchanged context '.repeat(300)}${oldText}${' unchanged tail'.repeat(100)}`;
    expect(run(['add', 'axis', '--note', longNote]).status).toBe(0);
    const file = join(dir, 'axis.md');
    const before = readFileSync(file, 'utf8');
    const beforeIndex = readFileSync(join(dir, 'INDEX.md'), 'utf8');

    const amended = run(['amend', 'axis', '--note-replace', oldText, newText]);

    expect(amended.status, amended.stderr).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(before.replace(oldText, newText));
    expect(readFileSync(join(dir, 'INDEX.md'), 'utf8')).toBe(beforeIndex);
  });

  it('refuses a missing or ambiguous note substring atomically', () => {
    run(target('axis'));
    commitAll();
    expect(run(['add', 'axis', '--note', 'repeat me once, then repeat me twice']).status).toBe(0);
    const file = join(dir, 'axis.md');
    const before = readFileSync(file, 'utf8');

    const missing = run(['amend', 'axis', '--note-replace', 'axis-ruling', 'changed']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('does not occur in the newest draft note');
    expect(readFileSync(file, 'utf8')).toBe(before);

    const ambiguous = run(['amend', 'axis', '--note-replace', 'repeat me', 'changed']);
    expect(ambiguous.status).toBe(1);
    expect(ambiguous.stderr).toContain('occurs 2 times in the newest draft note');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('requires exactly one amendment mode and complete replacement arguments', () => {
    run(target('axis'));
    commitAll();
    expect(run(['add', 'axis', '--note', 'draft note']).status).toBe(0);
    const file = join(dir, 'axis.md');
    const before = readFileSync(file, 'utf8');

    const mixed = run([
      'amend',
      'axis',
      '--note',
      'whole replacement',
      '--note-replace',
      'draft',
      'corrected',
    ]);
    expect(mixed.status).toBe(1);
    expect(mixed.stderr).toContain('Usage: guard-decisions amend');

    const missingNew = run(['amend', 'axis', '--note-replace', 'draft']);
    expect(missingNew.status).toBe(1);
    expect(missingNew.stderr).toContain('requires both');

    const emptyOld = run(['amend', 'axis', '--note-replace', '', 'corrected']);
    expect(emptyOld.status).toBe(1);
    expect(emptyOld.stderr).toContain('requires a non-empty');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses surgical replacement in a committed note', () => {
    run(target('axis'));
    expect(run(['add', 'axis', '--note', 'draft note']).status).toBe(0);
    commitAll();
    const file = join(dir, 'axis.md');
    const before = readFileSync(file, 'utf8');

    const blocked = run(['amend', 'axis', '--note-replace', 'draft', 'corrected']);

    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain('already committed');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses a committed newest entry without changing either file', () => {
    run(target('axis'));
    commitAll();
    const file = join(dir, 'axis.md');
    const index = join(dir, 'INDEX.md');
    const beforeFile = readFileSync(file, 'utf8');
    const beforeIndex = readFileSync(index, 'utf8');
    const blocked = run(['amend', 'axis', '--target', ...reqFlags('replacement')]);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain('already committed');
    expect(readFileSync(file, 'utf8')).toBe(beforeFile);
    expect(readFileSync(index, 'utf8')).toBe(beforeIndex);
  });

  it('refuses when earlier committed history changed, atomically', () => {
    run(target('axis'));
    commitAll();
    run(['add', 'axis', '--note', 'draft note']);
    const file = join(dir, 'axis.md');
    const changed = readFileSync(file, 'utf8').replace('axis-ruling', 'tampered-ruling');
    writeFileSync(file, changed);
    const beforeIndex = readFileSync(join(dir, 'INDEX.md'), 'utf8');

    const blocked = run(['amend', 'axis', '--note', 'replacement note']);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain('earlier decision history differs from HEAD');
    expect(readFileSync(file, 'utf8')).toBe(changed);
    expect(readFileSync(join(dir, 'INDEX.md'), 'utf8')).toBe(beforeIndex);
  });
});

describe('query --json envelope (the bench contract)', () => {
  const write = (name, body) => writeFileSync(join(dir, name), body);
  const axis = (slug, ruling) =>
    `---\nslug: ${slug}\ncreated: 2026-01-01\n---\n\n# ${slug}\n\n## Target · 2026-01-01 — ${ruling}\n\n**Context:** a forcing failure\n**Ruling:** ${ruling}\n**Source:** manual\n`;
  const json = (args) => JSON.parse(run(args).stdout);

  it('RULED: ranks are 1..n, scores descend, margin is top1 - top2', () => {
    write('http-transport.md', axis('http-transport', 'use an http proxy transport'));
    write('auth-provider.md', axis('auth-provider', 'verify jwks at the edge'));
    const env = json(['query', 'http proxy transport', '--json']);

    expect(env.state).toBe('RULED');
    expect(env.tau).toBeNull(); // no threshold is applied yet — null means "none", not zero
    expect(env.rows.map((r) => r.rank)).toEqual([1]);
    expect(env.rows[0].slug).toBe('http-transport');
    expect(env.rows[0].liveRulingId).toBe('target:2026-01-01');
    expect(env.cost.llmCalls).toBe(0);
    expect(typeof env.cost.ms).toBe('number');
  });

  it('NO_RULING: nothing matched — empty rows, null margin, never a consolation list', () => {
    write('http-transport.md', axis('http-transport', 'use an http proxy transport'));
    const env = json(['query', 'kubernetes helm chart autoscaling', '--json']);
    expect(env.state).toBe('NO_RULING');
    expect(env.source).toBe('none');
    expect(env.rows).toEqual([]);
    expect(env.margin).toBeNull();
  });

  it('distinguishes an EMPTY log from a searched one that rules on nothing', () => {
    expect(json(['query', 'anything', '--json']).source).toBe('empty');
  });

  it('ties break by slug so rank is reproducible across runs', () => {
    // Identical bodies ⇒ identical BM25 scores; only the slug can order them.
    write('zzz-axis.md', axis('zzz-axis', 'the shared ruling text'));
    write('aaa-axis.md', axis('aaa-axis', 'the shared ruling text'));
    const first = json(['query', 'shared ruling text', '--json']);
    const second = json(['query', 'shared ruling text', '--json']);
    expect(first.rows[0].score).toBeCloseTo(first.rows[1].score);
    expect(first.rows.map((r) => r.slug)).toEqual(['aaa-axis', 'zzz-axis']);
    expect(second.rows.map((r) => r.slug)).toEqual(first.rows.map((r) => r.slug));
  });
});

describe('query --full', () => {
  it('prints the whole body of the top match, including text the truncated view omits', () => {
    run(target('proxy-transport-axis'));
    run(target('auth-provider-axis'));
    const truncated = run(['query', 'proxy transport axis ruling']);
    const full = run(['query', 'proxy transport axis ruling', '--full']);
    expect(truncated.status).toBe(0);
    expect(full.status).toBe(0);
    // Consequences is written to every axis file (renderTarget), but the truncated prose view
    // (printRanked) only ever prints the ruling + why-hook + a few qualifiers — never this field.
    expect(truncated.stdout).not.toContain('Consequences');
    expect(full.stdout).toContain('**Consequences:**');
    expect(full.stdout).toContain('proxy-transport-axis value protected');
  });

  it('composes with --top: prints exactly the K whole records ranking narrowed to', () => {
    run(target('gateway-transport-one'));
    run(target('gateway-transport-two'));
    run(target('gateway-transport-three'));
    const r = run(['query', 'gateway transport', '--top', '2', '--full']);
    expect(r.status).toBe(0);
    // Each printed whole file carries exactly one `slug: <axis>` frontmatter line.
    expect([...r.stdout.matchAll(/^slug: /gm)]).toHaveLength(2);
  });

  it('errors when combined with --json instead of silently picking one', () => {
    const r = run(['query', 'anything', '--full', '--json']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--json and --full are mutually exclusive/);
  });

  it('plain query (neither --full nor --json) keeps the truncated one-line view unchanged', () => {
    run(target('plain-query-axis'));
    const r = run(['query', 'plain-query-axis-ruling']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('# top 1 axis (lexical)');
    expect(r.stdout).toContain('- plain-query-axis · plain-query-axis-ruling');
    expect(r.stdout).not.toContain('Consequences');
    expect(r.stdout).not.toContain('slug: plain-query-axis');
  });
});

// Creating a second axis on a question an existing axis already rules on is how the corpus ended
// up with two live contradictory rulings. The nudge SHOWS the neighbour; it deliberately does not
// block, because BM25 ruling-similarity measured over 30 real axes puts legitimately-distinct pairs
// at the very top of the ranking, so any blocking threshold would reject good work.
describe('new-axis duplicate nudge', () => {
  it('names the nearest existing ruling and still records the Target', () => {
    expect(
      run(['add', 'ranking-algorithm', '--target', '--new', ...reqFlags('ranking-algorithm')])
        .status,
    ).toBe(0);

    const res = run([
      'add',
      'ranking-rival',
      '--target',
      '--new',
      '--context',
      'rival broke: symptom Z',
      '--ruling',
      'ranking-algorithm-ruling',
      '--consequences',
      'value',
      '--tradeoff',
      'cost',
      '--vision-fit',
      'n/a',
    ]);
    expect(res.stderr).toContain('nearest existing rulings');
    expect(res.stderr).toContain('ranking-algorithm');
    expect(res.status).toBe(0); // advisory — a nudge that blocks is a nudge that gets disabled
  });

  it('says nothing when the log is empty — there is no neighbour to point at', () => {
    const res = run(['add', 'first-ever', '--target', '--new', ...reqFlags('first-ever')]);
    expect(res.stderr).not.toContain('nearest existing rulings');
    expect(res.status).toBe(0);
  });
});
