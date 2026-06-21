#!/usr/bin/env node

/**
 * Decision Log — architectural-decision *why* timeline.
 *
 * Captures the *target / why* behind reversible architectural choices (the "road not
 * taken"), keyed by decision *axis* (slug). The most recent ruling per axis is the living
 * architecture record. md is the source of truth; the per-axis embedding cache
 * (`<cwd>/.decisions/index.json`) is a derived, gitignored, rebuildable cache (lazy
 * content-hash rehash) used by `query`. It holds nothing the md files don't.
 *
 * APPEND-ONLY: a written entry is never mutated (rewriting a past ruling would lose the
 * flip-flop history this exists to preserve). The current ruling per axis = its LAST entry.
 * Per-file frontmatter is two immutable fields — {slug, created} — with NO current/updated/
 * status pointer (those duplicate the timeline and invite the "docs now say B" rewrite).
 *
 * Storage (git-tracked, under <decisionsDir>/, default docs/decisions/):
 *   INDEX.md          derived current-state spine: | [slug](slug.md) | current ruling | why-hook | updated |
 *                     (regenerable cache over the timelines — holds no history, so mutation-safe)
 *   <slug>.md         per-axis append-only timeline: {slug, created} frontmatter + dated entries
 *
 * A decision is an EPIC (PRD-altitude), not an impl patch-note. Each axis file = a stack of
 * `## Target ·` blocks (rare, the PRD) + cheap `- <date> — note`s (implementation convergence
 * under the current Target). INDEX shows the Target, never a note.
 *
 * ── W-3 (portability invariant) ──────────────────────────────────────────────────
 * All paths resolve relative to the CONSUMER cwd via resolveGuardConfig(cwd), NEVER
 * __dirname (the package dir). Run from a consumer's node_modules, this engine reads and
 * writes the CONSUMER's decision log, not files inside the package.
 *
 * Commands:
 *   add <slug> --target --context "..." --ruling "..." --consequences "..." --tradeoff "..."
 *              --vision-fit "..." [--title ... --researched ... --rejected ...
 *               --anchored-bet "[BET]" --scope "glob,glob" --source ... --ref ... --new
 *               --evidence-change "..."]                  (epic Target; updates INDEX)
 *   add <slug> --note "..."          cheap convergence note under the current Target (INDEX untouched)
 *   query "<text>" [--top K]        rank axes — semantic (Ollama), lexical floor on fallback
 *   reindex                         cold-build the derived embedding cache
 *   list / show <slug> / check <slug>
 *
 * Re-targeting an axis that already has a Target requires --evidence-change (a target moves only
 * on an evidence-state change, never on impl pain → that's a --note). APPEND-ONLY: never mutate a
 * past block; archive a mis-filed entry by moving it under a `## [archived …]` heading, never delete.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveFromCwd, resolveGuardConfig } from '../config.mjs';
import { writeFileAtomic } from './atomic-write.mjs';

const EMBED_URL = 'http://localhost:11434/api/embed';
const EMBED_MODEL = 'nomic-embed-text';

const FM_ORDER = ['slug', 'created']; // append-only: two immutable fields, no current/updated/status
const INDEX_HEADER =
  '# Decision Index\n\n' +
  'Living architecture record — the current ruling per axis. Each row links to its full\n' +
  'timeline. New rationale lives in the per-axis file.\n\n' +
  '| Axis | Current ruling | Why (hook) | Updated |\n' +
  '|------|----------------|------------|---------|\n';

// Top-level regexes (these run in loops).
const INDEX_SEPARATOR_RE = /^\|[\s:|-]+\|$/;
const INDEX_SLUG_RE = /^\[([^\]]+)\]/;
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const TRAILING_WS_RE = /\s*$/;
const WS_RE = /\s+/g;
const TOKEN_RE = /[a-z0-9]+/g;
const TARGET_HEAD_RE = /^## Target · /; // distinguishes an epic Target block from a note / old entry
const TARGET_FIELD_RE = /^\*\*([^:]+):\*\*\s*(.*)$/; // **Key:** value lines inside a Target block
const NOTE_BULLET_RE = /^-\s+\d{4}-\d{2}-\d{2}\b/; // a DATED `- <date> — …` note ends the Target block; plain `- ` bullets (Consequences) stay in it
const TITLE_CUT_RE = /\. |\.$| — |; /; // first sentence/clause boundary for deriving a heading title

// ─── Consumer-cwd path resolution (W-3) ──────────────────────────────────────────
// Every on-disk path is derived from the CONSUMER cwd via the shared config loader.
// Resolved lazily (per call) so tests and consumers can vary cwd / GUARD_* env between
// invocations without the module caching a stale package-relative path.

function paths(cwd = process.cwd()) {
  const cfg = resolveGuardConfig(cwd);
  const decisionsDir = resolveFromCwd(cfg, 'decisionsDir');
  return {
    cwd,
    decisionsDir,
    indexPath: path.join(decisionsDir, 'INDEX.md'),
    // Derived, gitignored, rebuildable embedding cache for `query` (lazy content-hash rehash).
    // DECISIONS_INDEX overrides the location (tests point it at a temp file).
    vecIndexPath: process.env.DECISIONS_INDEX ?? path.join(cwd, '.decisions', 'index.json'),
  };
}

// ─── Small pure helpers (kept top-level for ATS chunking) ───────────────────────

function today() {
  return process.env.DECISIONS_TODAY ?? new Date().toISOString().slice(0, 10);
}

function slugPath(p, slug) {
  return path.join(p.decisionsDir, `${slug}.md`);
}

// INDEX cells are pipe-delimited; strip pipes/newlines so a row always parses back.
function sanitizeCell(s) {
  return String(s ?? '')
    .replace(/[|\n\r]+/g, ' ')
    .trim();
}

function hook(why) {
  const one = sanitizeCell(why);
  return one.length > 70 ? `${one.slice(0, 67)}…` : one;
}

// ─── INDEX.md parse / render (the bounded axis spine) ───────────────────────────

export function parseIndex(md) {
  const rows = [];
  for (const line of md.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|') || !t.endsWith('|')) continue;
    if (INDEX_SEPARATOR_RE.test(t)) continue; // separator row
    const cells = t
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim());
    if (cells.length < 4) continue;
    if (cells[0].toLowerCase() === 'axis') continue; // header
    const m = cells[0].match(INDEX_SLUG_RE);
    rows.push({ slug: m ? m[1] : cells[0], ruling: cells[1], why: cells[2], updated: cells[3] });
  }
  return rows;
}

export function renderIndex(rows) {
  const body = [...rows]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((r) => `| [${r.slug}](${r.slug}.md) | ${r.ruling} | ${r.why} | ${r.updated} |`)
    .join('\n');
  return INDEX_HEADER + (body ? `${body}\n` : '');
}

export function upsertRow(rows, row) {
  const i = rows.findIndex((r) => r.slug === row.slug);
  if (i === -1) rows.push(row);
  else rows[i] = { ...rows[i], ...row };
  return rows;
}

function readIndexRows(p) {
  return existsSync(p.indexPath) ? parseIndex(readFileSync(p.indexPath, 'utf8')) : [];
}

// ─── Per-axis file parse / render ───────────────────────────────────────────────

export function parseDecision(md) {
  const m = md.match(FRONTMATTER_RE);
  if (!m) return { fm: {}, body: md };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { fm, body: m[2] };
}

export function renderDecision(fm, body) {
  const keys = [
    ...FM_ORDER.filter((k) => fm[k]),
    ...Object.keys(fm).filter((k) => !FM_ORDER.includes(k) && fm[k]),
  ];
  return `---\n${keys.map((k) => `${k}: ${fm[k]}`).join('\n')}\n---\n${body}`;
}

// An epic Target block (the PRD). ruling/context/consequences/tradeoff/visionFit are required by
// the caller; the rest are optional but encouraged.
// A short scannable heading from the ruling when no explicit --title is given (kills the old
// heading==ruling duplication): the ruling's first sentence/clause, capped.
function firstClause(s) {
  const t = String(s).trim();
  const cut = t.search(TITLE_CUT_RE);
  return (cut > 0 ? t.slice(0, cut) : t).slice(0, 100);
}

// The Target schema = the Nygard/MADR ADR spine (Context -> Decision -> Consequences) plus the
// vision/scope/anchored-bet extensions. Context = the forcing failure (WHY-now); Ruling = the
// decision (WHAT); Consequences = value protected + cost paid (SO-THAT).
export function renderTarget(date, o) {
  const lines = [`## Target · ${date} — ${sanitizeCell(o.title || firstClause(o.ruling))}`, ''];
  lines.push(`**Context:** ${o.context}`);
  lines.push(`**Ruling:** ${o.ruling}`);
  lines.push('**Consequences:**');
  lines.push(`- Positive: ${o.consequences}`);
  lines.push(`- Negative: ${o.tradeoff}`);
  lines.push(`**Vision-fit:** ${o.visionFit}`);
  if (o.researched) lines.push(`**Researched:** ${o.researched}`);
  if (o.rejected) lines.push(`**Rejected:** ${o.rejected}`);
  if (o.anchoredBet) lines.push(`**Anchored-bet:** ${o.anchoredBet}`);
  if (o.scope) lines.push(`**Scope:** ${o.scope}`);
  lines.push(`**Source:** ${[o.source || 'manual', o.ref].filter(Boolean).join(' · ')}`);
  if (o.evidenceChange) lines.push(`**Evidence-change:** ${o.evidenceChange}`);
  return lines.join('\n');
}

// A cheap convergence note (implementation step under the current Target). Not a ruling.
export function renderNote(date, text) {
  return `- ${date} — ${sanitizeCell(text)}`;
}

// The current Target = the LAST `## Target ·` block in the body. Returns {ruling, scope, fields,
// block} or null (old-format / note-only / unmigrated axes have no Target → not gate-enforced).
export function currentTarget(body) {
  let last = null;
  const parts = body.split('\n## ');
  for (let i = 0; i < parts.length; i += 1) {
    const head = i === 0 ? parts[i] : `## ${parts[i]}`;
    if (TARGET_HEAD_RE.test(head)) last = head;
  }
  if (!last) return null;
  const fields = {};
  const blockLines = [];
  for (const line of last.split('\n')) {
    if (NOTE_BULLET_RE.test(line)) break; // notes are appended after the fields → end of the Target
    blockLines.push(line);
    const m = line.match(TARGET_FIELD_RE);
    if (m) fields[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return {
    ruling: fields.ruling ?? '',
    scope: fields.scope ?? '',
    fields,
    block: blockLines.join('\n').trim(),
  };
}

// ─── Commands ───────────────────────────────────────────────────────────────────

export function cmdAdd(slug, o, cwd = process.cwd()) {
  if (!slug) {
    console.error('Usage: guard-decisions add <slug> --target … | --note "…"');
    process.exit(1);
  }
  return o.isTarget ? addTarget(slug, o, paths(cwd)) : addNote(slug, o, paths(cwd));
}

// Epic Target — the PRD. Requires context + ruling + consequences + tradeoff + vision-fit; updates INDEX.
// Reason: the branches ARE the Target-recording state machine (required-field guard, unknown-axis-without-new guard, already-targeted re-target guard, exists-vs-new render path); each guard maps to a distinct user error and extracting them hides the decision logic
// fallow-ignore-next-line complexity
function addTarget(slug, o, p) {
  if (!o.ruling || !o.context || !o.consequences || !o.tradeoff || !o.visionFit) {
    console.error(
      'Usage: guard-decisions add <slug> --target \\\n' +
        '  --context "<the forcing failure: what broke + the symptom + severity/blast-radius>" \\\n' +
        '  --ruling "<the decision / mechanism chosen>" \\\n' +
        '  --consequences "<the user/business value this protects>" \\\n' +
        '  --tradeoff "<the cost knowingly paid — latency, complexity, a road not taken>" \\\n' +
        '  --vision-fit "<which product North Star; or n/a — internal tooling>" \\\n' +
        '  [--title "<short heading>" --researched … --rejected … --anchored-bet "[BET]" --scope "glob,glob" --new --evidence-change "…"]\n' +
        '(Context=WHY-now, Ruling=WHAT, Consequences/Tradeoff=SO-THAT + cost — the ADR Context/Decision/Consequences spine.)',
    );
    process.exit(1);
  }
  const file = slugPath(p, slug);
  const exists = existsSync(file);
  if (!exists && !o.isNew) {
    console.error(
      `Unknown axis "${slug}". Reuse an existing slug if this axis exists under another name;\n` +
        `otherwise re-run with --new. Current index:\n`,
    );
    console.error(existsSync(p.indexPath) ? readFileSync(p.indexPath, 'utf8') : '(index empty)');
    process.exit(1);
  }
  const date = today();
  let fm;
  let body;
  if (exists) {
    const parsed = parseDecision(readFileSync(file, 'utf8'));
    // Re-target guard: a Target moves only on an evidence-state change, never on impl pain.
    if (currentTarget(parsed.body) && !o.evidenceChange) {
      console.error(
        `Axis "${slug}" already has a Target. An implementation change is a NOTE — drop --target:\n` +
          `  guard-decisions add ${slug} --note "<what converged>"\n` +
          'Re-target ONLY on an evidence-state change — pass --evidence-change "<what shifted>".',
      );
      process.exit(1);
    }
    fm = { slug, created: parsed.fm.created || date };
    body = `${parsed.body.replace(TRAILING_WS_RE, '')}\n\n${renderTarget(date, o)}\n`;
  } else {
    fm = { slug, created: date };
    body = `\n# ${slug}\n\n${renderTarget(date, o)}\n`;
  }
  mkdirSync(p.decisionsDir, { recursive: true });
  writeFileAtomic(file, renderDecision(fm, body));
  const rows = upsertRow(readIndexRows(p), {
    slug,
    ruling: sanitizeCell(o.ruling),
    why: hook(o.context),
    updated: date,
  });
  writeFileAtomic(p.indexPath, renderIndex(rows));
  console.log(`Recorded Target "${slug}" (${date}).`);
}

// Cheap convergence note under the current Target. INDEX untouched (a note is not a ruling).
function addNote(slug, o, p) {
  if (!o.note) {
    console.error(
      'Usage: guard-decisions add <slug> --note "…"   (or --target … for an epic Target)',
    );
    process.exit(1);
  }
  const file = slugPath(p, slug);
  if (!existsSync(file)) {
    console.error(
      `Axis "${slug}" has no Target yet — record one first:\n` +
        `  guard-decisions add ${slug} --target --context … --ruling … --consequences … --tradeoff … --vision-fit … --new`,
    );
    process.exit(1);
  }
  const date = today();
  const parsed = parseDecision(readFileSync(file, 'utf8'));
  const fm = { slug, created: parsed.fm.created || date };
  const body = `${parsed.body.replace(TRAILING_WS_RE, '')}\n${renderNote(date, o.note)}\n`;
  writeFileAtomic(file, renderDecision(fm, body));
  console.log(`Noted on "${slug}" (${date}).`);
}

export function cmdList(cwd = process.cwd()) {
  const p = paths(cwd);
  if (!existsSync(p.indexPath)) {
    console.log('No decisions recorded.');
    return;
  }
  process.stdout.write(readFileSync(p.indexPath, 'utf8'));
}

export function cmdShow(slug, cwd = process.cwd()) {
  const file = slugPath(paths(cwd), slug);
  if (!existsSync(file)) {
    console.error(`No decision axis "${slug}".`);
    process.exit(1);
  }
  process.stdout.write(readFileSync(file, 'utf8'));
}

export function checkExists(slug, cwd = process.cwd()) {
  return existsSync(slugPath(paths(cwd), slug));
}

// ─── Retrieval: lexical floor + per-axis semantic search ─────────────────────────
// Both rank IN-SCRIPT over the bounded INDEX/cache and return only top-k to the caller, so the
// agent's context never loads the whole (monotonically growing) corpus. Semantic is the happy
// path; lexical is the always-available floor + the fallback when Ollama/the model is absent.

// Prose tokenizer: lowercase, alphanumeric runs, drop single chars. NO stopword list — BM25's IDF
// down-weights common terms in a principled way (a hand-rolled stoplist is brittle + English-only).
function tokenize(text) {
  const out = [];
  for (const m of String(text).toLowerCase().matchAll(TOKEN_RE)) {
    if (m[0].length > 1) out.push(m[0]);
  }
  return out;
}

// Lexical floor (the Ollama-down fallback): rank INDEX rows by BM25. IDF rewards rare shared terms
// and discounts common ones (so "the"/"and" carry ~no weight without a stoplist); k1/b are the
// standard defaults. Pure, zero-dep.
export function bm25Rank(queryText, rows, k = 5, k1 = 1.5, b = 0.75) {
  const qTerms = [...new Set(tokenize(queryText))];
  if (qTerms.length === 0 || rows.length === 0) return [];
  const docs = rows.map((r) => tokenize(`${r.slug} ${r.ruling} ${r.why}`));
  const N = docs.length;
  const avgdl = docs.reduce((s, d) => s + d.length, 0) / N || 1;
  const df = new Map(qTerms.map((t) => [t, docs.filter((d) => d.includes(t)).length]));
  return rows
    .map((r, i) => {
      const d = docs[i];
      let score = 0;
      for (const t of qTerms) {
        const n = df.get(t);
        if (!n) continue;
        const tf = d.filter((w) => w === t).length;
        if (!tf) continue;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / avgdl)));
      }
      return { ...r, score };
    })
    .filter((r) => r.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, k);
}

export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Embed via Ollama. Returns number[] or null (opted out / Ollama down / model absent / bad
// response) → the caller falls back to the lexical floor. Never throws.
// nomic-embed-text REQUIRES task prefixes (`search_query:` / `search_document:`) for calibrated
// retrieval similarity — without them, query↔doc cosine is poorly ranked.
async function embed(text, kind = 'document') {
  if (process.env.DECISIONS_NO_EMBED) return null;
  const prefixed = `${kind === 'query' ? 'search_query: ' : 'search_document: '}${String(text).slice(0, 8000)}`;
  try {
    const res = await fetch(EMBED_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: prefixed }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const vec = (await res.json())?.embeddings?.[0];
    return Array.isArray(vec) && vec.length ? vec : null;
  } catch {
    return null;
  }
}

function axisHash(text) {
  return createHash('sha1').update(text).digest('hex');
}

// Cap the gist at the TAIL (newest entries), never the head — the current ruling is the LAST
// entry (append-only), and that's what retrieval most needs to match on a hot, oft-flipped axis.
export function clampGist(body, max = 6000) {
  const t = body.replace(WS_RE, ' ').trim();
  return t.length > max ? t.slice(-max) : t;
}

// Searchable gist of an axis = its CURRENT Target block (the stable ruling we want `query` to
// surface), not the note tail — a hot axis's notes would otherwise outrank the Target (clampGist is
// tail-biased). Falls back to the whole body for unmigrated / note-only / old-format axes.
function gistOf(p, slug) {
  const file = slugPath(p, slug);
  if (!existsSync(file)) return null;
  const { body } = parseDecision(readFileSync(file, 'utf8'));
  const t = currentTarget(body);
  return clampGist(t ? t.block : body);
}

function loadVecIndex(p) {
  if (!existsSync(p.vecIndexPath)) return {};
  try {
    return JSON.parse(readFileSync(p.vecIndexPath, 'utf8'));
  } catch {
    return {}; // corrupt derived cache → rebuilt lazily, never fatal
  }
}

function saveVecIndex(p, idx) {
  mkdirSync(path.dirname(p.vecIndexPath), { recursive: true });
  writeFileAtomic(p.vecIndexPath, `${JSON.stringify(idx)}\n`);
}

// Lazy content-hash rehash: (re)embed an axis only if its gist changed (or is new/missing).
// Returns true if it (re)embedded. No manual reindex discipline — drift self-heals on query.
async function embedAxis(p, slug, idx) {
  const gist = gistOf(p, slug);
  if (!gist) return false;
  const h = axisHash(gist);
  // Skip only if BOTH content and embedding model are unchanged — a model swap must re-embed
  // (vectors from different models aren't comparable, even at the same dimension).
  if (idx[slug]?.hash === h && idx[slug]?.model === EMBED_MODEL) return false;
  const vec = await embed(gist, 'document');
  if (!vec) return false; // embed unavailable → leave for the lexical floor; retry next query
  idx[slug] = { hash: h, vec, model: EMBED_MODEL };
  return true;
}

function printRanked(rows, mode) {
  console.log(`# top ${rows.length} ${rows.length === 1 ? 'axis' : 'axes'} (${mode})`);
  for (const r of rows) console.log(`- ${r.slug} · ${r.ruling}${r.why ? ` · ${r.why}` : ''}`);
}

// Reason: the branches ARE the query ranking algorithm's fallback tiers (semantic cosine over the vector index, then BM25 lexical floor, then raw first-k); the embed-availability and stale-dim filtering are inherent to degrading gracefully and flattening scatters one ranked lookup
// fallow-ignore-next-line complexity
export async function cmdQuery(text, k = 5, cwd = process.cwd()) {
  if (!text?.trim()) {
    console.error('Usage: guard-decisions query "<text>" [--top K]');
    process.exit(1);
  }
  const p = paths(cwd);
  const rows = readIndexRows(p);
  if (rows.length === 0) {
    console.log('No decisions recorded.');
    return;
  }
  const qvec = await embed(text, 'query');
  if (qvec) {
    const idx = loadVecIndex(p);
    let dirty = false;
    for (const r of rows) if (await embedAxis(p, r.slug, idx)) dirty = true;
    if (dirty) saveVecIndex(p, idx);
    const ranked = rows
      .filter((r) => idx[r.slug]?.vec?.length === qvec.length) // skip stale-dim vectors → lexical covers
      .map((r) => ({ ...r, score: cosine(qvec, idx[r.slug].vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    if (ranked.length) {
      printRanked(ranked, 'semantic');
      return;
    }
  }
  // Fallback floor: BM25 over the INDEX rows (or, if nothing matches, the first k rows).
  const lex = bm25Rank(text, rows, k);
  printRanked(lex.length ? lex : rows.slice(0, k), lex.length ? 'lexical' : 'index');
}

export async function cmdReindex(cwd = process.cwd()) {
  const p = paths(cwd);
  const rows = readIndexRows(p);
  const idx = loadVecIndex(p); // non-destructive: keep prior good vectors if an embed fails now
  let n = 0;
  for (const r of rows) {
    const gist = gistOf(p, r.slug);
    if (!gist) continue;
    const vec = await embed(gist, 'document'); // force re-embed (ignore hash) — e.g. after model change
    if (vec) {
      idx[r.slug] = { hash: axisHash(gist), vec, model: EMBED_MODEL };
      n += 1;
    }
  }
  saveVecIndex(p, idx);
  console.log(
    `Reindexed ${n}/${rows.length} axes${n < rows.length ? ' (some embeds unavailable — lexical still covers them)' : ''}.`,
  );
}

// ─── Dispatch (run-as-main only, so tests can import the pure helpers) ───────────

function flag(rest, name) {
  const i = rest.indexOf(name);
  return i !== -1 ? rest[i + 1] : undefined;
}

export async function main(argv) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'add': {
      const [slug, ...rest] = args;
      cmdAdd(slug, {
        isTarget: rest.includes('--target'),
        note: flag(rest, '--note'),
        title: flag(rest, '--title'),
        context: flag(rest, '--context'),
        ruling: flag(rest, '--ruling'),
        consequences: flag(rest, '--consequences'),
        tradeoff: flag(rest, '--tradeoff'),
        visionFit: flag(rest, '--vision-fit'),
        researched: flag(rest, '--researched'),
        rejected: flag(rest, '--rejected'),
        anchoredBet: flag(rest, '--anchored-bet'),
        scope: flag(rest, '--scope'),
        source: flag(rest, '--source'),
        ref: flag(rest, '--ref'),
        evidenceChange: flag(rest, '--evidence-change'),
        isNew: rest.includes('--new'),
      });
      break;
    }
    case 'query': {
      const [text, ...rest] = args;
      const top = flag(rest, '--top');
      const n = top ? Number.parseInt(top, 10) : 5;
      await cmdQuery(text, n > 0 ? n : 5);
      break;
    }
    case 'reindex':
      await cmdReindex();
      break;
    case 'list':
      cmdList();
      break;
    case 'show':
      if (!args[0]) {
        console.error('Usage: guard-decisions show <slug>');
        process.exit(1);
      }
      cmdShow(args[0]);
      break;
    case 'check':
      if (!args[0]) {
        console.error('Usage: guard-decisions check <slug>');
        process.exit(1);
      }
      process.exit(checkExists(args[0]) ? 0 : 1);
      break;
    default:
      console.error('Commands: add | query | reindex | list | show | check');
      process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`decisions: ${e?.message ?? e}`);
    process.exit(1);
  });
}
