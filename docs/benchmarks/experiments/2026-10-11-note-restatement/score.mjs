#!/usr/bin/env node
// Zero-LLM scorer for the note-restatement experiment. README.md pre-registers every rule used here.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DIR = dirname(fileURLToPath(import.meta.url));
export const PIN = 'c29e78e6';
export const MAX_CHARS = 2000;
export const MIN_CONFIRMED_W = 8;
export const PASS_SHARE = 0.875;
export const MAX_FALSE_ALTERS = 5;
export const MODELS = ['claude-haiku-5-5', 'claude-opus-5-5'];
const SEGMENTER = new Intl.Segmenter('en', { granularity: 'sentence' });

export const norm = (s) => s.replace(/\s+/g, ' ').trim();
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const rowKey = (r) => `${r.model}|${r.rep}|${r.id}`;

/** The sentence split the CLI reuses: Intl.Segmenter, whitespace-normalised, empties dropped. */
export function rulingSentences(text) {
  return [...SEGMENTER.segment(text)].map((s) => norm(s.segment)).filter(Boolean);
}

export function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ ...JSON.parse(line), line }));
}

export function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]);
}

export function skillSection() {
  return readFileSync(join(DIR, 'skill-notes-section.md'), 'utf8').replace(/\n$/, '');
}

/** The writer's --ruling text: trimmed, minus one wrapping code fence or pair of double quotes. */
export function stripOutput(raw) {
  const t = raw.trim();
  const fence = t.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fence) return fence[1].trim();
  if (t.length > 1 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).trim();
  return t;
}

const has = (text, s) => norm(text).toLowerCase().includes(norm(s).toLowerCase());
const intersect = (a, b) => a.filter((n) => b.includes(n));
const countTrue = (rows, k) => rows.filter((r) => r[k] === true).length;

/** The pre-registered confirmation rule for one case; preview (no second rater yet) uses rater 1 alone. */
export function goldFor(c, rater2, preview) {
  const s1 = rater2.find((r) => r.stage === 1);
  const s2 = rater2.filter((r) => r.stage === 2);
  const r1Stale = c.staleSentences ?? [];
  const r2Stale = s1?.staleSentences ?? [];
  const both = intersect(r1Stale, r2Stale);
  const w = c.rater1Label === 'W' && (preview ? r1Stale.length > 0 : s1?.label === 'W' && both.length > 0);
  const stale = w ? (preview ? r1Stale : both) : [];
  const flagged = s2.findLast((r) => r.alteredSentences)?.alteredSentences;
  const altered = new Set([...(flagged ?? c.sentences.filter((s) => s.altered).map((s) => s.n)), ...r1Stale, ...r2Stale]);
  return {
    id: c.id,
    slug: c.slug,
    ruling: c.ruling,
    note: c.note,
    caseSha256: sha256(c.line),
    sampleLabel: c.sampleLabel,
    inRun: c.sampleLabel !== null || w,
    w,
    mustContain: s2.findLast((r) => r.mustContain)?.mustContain ?? c.noteClause?.mustContain ?? [],
    sentences: c.sentences,
    keep: c.sentences.filter((s) => !altered.has(s.n)),
    stale: c.sentences.filter((s) => stale.includes(s.n)),
    markers: w ? c.staleMarkers : [],
  };
}

export function loadRunSet() {
  const rater2 = readJsonl(join(DIR, 'rater2-labels.jsonl'));
  const preview = rater2.length === 0;
  const all = readJsonl(join(DIR, 'cases.jsonl')).map((c) => goldFor(c, rater2.filter((r) => r.id === c.id), preview));
  const items = all.filter((g) => g.inRun);
  return { items, dropped: all.filter((g) => !g.inRun).map((g) => g.id), confirmedW: items.filter((g) => g.w).length, confirmed: !preview };
}

export function loadKindSet() {
  return readJsonl(join(DIR, 'kind-cases.jsonl')).map((c) => ({ ...c, caseSha256: sha256(c.line) }));
}

/** One restatement against one item; an output over MAX_CHARS fails (i)-(iii) unless lengthRule is off. */
export function scoreOutput(item, text, lengthRule = true) {
  const over = lengthRule && text.length > MAX_CHARS;
  const flat = norm(text);
  const missing = item.keep.filter((s) => !flat.includes(s.text)).map((s) => s.n);
  const staleKept = item.stale.filter((s) => flat.includes(s.text)).map((s) => s.n);
  return {
    chars: text.length,
    clause: !over && item.mustContain.every((m) => has(text, m)),
    retained: !over && missing.length === 0,
    staleFree: item.w ? !over && staleKept.length === 0 : null,
    missing,
    staleKept,
    markerHits: item.markers.filter((m) => has(text, m)),
  };
}

function goldProblems(c, kind) {
  const p = [];
  if (sha256(c.ruling) !== c.rulingSha256 || sha256(c.note) !== c.noteSha256) p.push('text hash mismatch');
  const file = execFileSync('git', ['-C', DIR, 'show', `${PIN}:docs/decisions/${c.slug}.md`], { encoding: 'utf8' });
  if (!file.includes(c.ruling) || !file.includes(c.note)) p.push(`ruling or note not verbatim in ${PIN}`);
  if (kind) return p;
  if (JSON.stringify(c.sentences.map((s) => s.text)) !== JSON.stringify(rulingSentences(c.ruling))) p.push('sentences differ from rulingSentences');
  for (const m of c.noteClause?.mustContain ?? []) if (!has(c.note, m) || has(c.ruling, m)) p.push(`mustContain "${m}" must be in the note and not the ruling`);
  for (const n of c.staleSentences ?? []) if (!c.sentences.find((s) => s.n === n)?.altered) p.push(`stale S${n} not flagged altered`);
  const staleText = c.sentences.filter((s) => (c.staleSentences ?? []).includes(s.n)).map((s) => s.text).join(' ');
  for (const m of c.staleMarkers ?? []) if (!has(staleText, m)) p.push(`marker "${m}" not in a stale sentence`);
  if (c.rater1Label === 'W' && !(c.staleSentences?.length && c.staleMarkers?.length && c.noteClause)) p.push('W needs stale sentences, markers and a clause');
  if (c.sampleLabel !== null && !c.noteClause?.mustContain?.length) p.push('sample item needs mustContain');
  if (c.ruling.length > MAX_CHARS) p.push('ruling over MAX_CHARS');
  return p;
}

export function checkGold() {
  const problems = [];
  for (const c of readJsonl(join(DIR, 'cases.jsonl'))) for (const p of goldProblems(c, false)) problems.push(`${c.id}: ${p}`);
  const kinds = loadKindSet();
  for (const c of kinds) for (const p of goldProblems(c, true)) problems.push(`kind ${c.id}: ${p}`);
  const altering = kinds.filter((c) => c.label !== 'L').length;
  if (kinds.length !== 60 || altering !== 16) problems.push(`kind set must be 60 notes with 16 altering, got ${kinds.length}/${altering}`);
  return problems;
}

/** C1 (old ruling as output) and C2 (old ruling + note, length rule off) as pre-registered. */
export function controls(set) {
  const n = set.items.length;
  const ws = set.items.filter((i) => i.w);
  const c1 = set.items.map((i) => scoreOutput(i, i.ruling));
  const c2 = set.items.map((i) => scoreOutput(i, `${i.ruling}\n${i.note}`, false));
  const lines = [
    [`C1 clause 0/${n}`, countTrue(c1, 'clause') === 0, `${countTrue(c1, 'clause')}/${n}`],
    [`C1 stale fails all ${ws.length} W`, countTrue(c1, 'staleFree') === 0, `${ws.length - countTrue(c1, 'staleFree')}/${ws.length}`],
    [`C2 clause ${n}/${n}`, countTrue(c2, 'clause') === n, `${countTrue(c2, 'clause')}/${n}`],
    [`C2 retained ${n}/${n}`, countTrue(c2, 'retained') === n, `${countTrue(c2, 'retained')}/${n}`],
    [`C2 stale fails all ${ws.length} W`, countTrue(c2, 'staleFree') === 0, `${ws.length - countTrue(c2, 'staleFree')}/${ws.length}`],
  ];
  return { ok: ws.length > 0 && lines.every((l) => l[1]), lines };
}

/** The last attempt per (model, rep, id), so a retried call counts once. */
function latest(rows) {
  const m = new Map();
  for (const r of rows) m.set(rowKey(r), r);
  return m;
}

function adjudications() {
  const m = new Map();
  for (const a of readJsonl(join(DIR, 'adjudication.jsonl'))) m.set(`${a.key}|${a.criterion}`, a.verdict);
  return m;
}

const kindAnswer = (r) => (r.ok ? r.stdout.trim().match(/^\W*(progress|alters)\W*$/i)?.[1].toLowerCase() : undefined);
const auditSample = (key) => Number.parseInt(sha256(key).slice(0, 8), 16) % 5 === 0;

/** Scores one replicate cell; queue collects the rows a human must adjudicate first. */
function scoreCell(set, byKey, model, rep, adj, queue) {
  const n = set.items.length;
  const need = Math.ceil(PASS_SHARE * n);
  let clause = 0;
  let clauseExact = 0;
  let retained = 0;
  let staleFree = 0;
  for (const item of set.items) {
    const key = `${model}|${rep}|${item.id}`;
    const row = byKey.get(key);
    const s = row?.ok ? scoreOutput(item, stripOutput(row.stdout)) : null;
    if (!s) continue;
    const over = s.chars > MAX_CHARS;
    clauseExact += s.clause ? 1 : 0;
    const clauseWhy = over ? null : !s.clause ? 'clause-miss' : auditSample(key) ? 'clause-audit' : null;
    if (clauseWhy && !adj.has(`${key}|clause`)) queue.push(`${key} ${clauseWhy}`);
    clause += !over && (adj.get(`${key}|clause`) ?? s.clause) ? 1 : 0;
    retained += s.retained ? 1 : 0;
    if (!item.w) continue;
    const markerOnly = s.staleFree && s.markerHits.length > 0;
    if (markerOnly && !adj.has(`${key}|stale`)) queue.push(`${key} stale-marker ${s.markerHits.join(', ')}`);
    staleFree += s.staleFree && (adj.get(`${key}|stale`) ?? true) ? 1 : 0;
  }
  const pass = clause >= need && retained >= need && staleFree === set.confirmedW;
  const line = `${model} rep ${rep}: clause ${clause}/${n} (exact ${clauseExact}) · retained ${retained}/${n} · stale-free ${staleFree}/${set.confirmedW} W · need ${need} → ${pass ? 'PASS' : 'FAIL'}`;
  return { line, pass };
}

export function scoreRuns(files) {
  const set = loadRunSet();
  const rows = files.flatMap((f) => readJsonl(f)).filter((r) => r.phase === 'decisive');
  const byKey = latest(rows);
  const adj = adjudications();
  const queue = [];
  const cells = MODELS.flatMap((model) => [1, 2, 3].map((rep) => scoreCell(set, byKey, model, rep, adj, queue)));
  return { cells, queue };
}

export function scoreKind(files) {
  const kinds = new Map(loadKindSet().map((k) => [k.id, k]));
  const nL = [...kinds.values()].filter((k) => k.label === 'L').length;
  const rows = [...latest(files.flatMap((f) => readJsonl(f)).filter((r) => r.phase === 'kind')).values()];
  return MODELS.map((model) => {
    const mine = rows.filter((r) => r.model === model);
    const falseAlters = mine.filter((r) => kinds.get(r.id).label === 'L' && kindAnswer(r) !== 'progress').length;
    const recall = mine.filter((r) => kinds.get(r.id).label !== 'L' && kindAnswer(r) === 'alters').length;
    const pass = mine.length === kinds.size && falseAlters <= MAX_FALSE_ALTERS;
    const line = `${model} kind: ${mine.length}/${kinds.size} answered · false-alters ${falseAlters}/${nL} (max ${MAX_FALSE_ALTERS}) · recall ${recall}/${kinds.size - nL} → ${pass ? 'PASS' : 'FAIL'}`;
    return { line, pass };
  });
}

const sentenceFlag = (item, s) => (item.stale.includes(s) ? 'STALE' : item.keep.includes(s) ? 'keep' : 'may change');

/** Stage-2 view for the second rater: each run item's clause strings and per-sentence gold. */
export function goldSheet(set) {
  return set.items.flatMap((i) => [
    `### ${i.id} (${i.w ? (set.confirmed ? 'confirmed W' : 'rater-1 W') : `sample ${i.sampleLabel}`})`,
    `mustContain: ${i.mustContain.map((m) => `\`${m}\``).join(', ')}`,
    ...i.sentences.map((s) => `- S${s.n} [${sentenceFlag(i, s)}] ${s.text}`),
    `- NOTE: ${i.note}`,
    '',
  ]);
}

function verdict(set, cells, kind, queue) {
  if (!set.confirmed) return 'NOT READY (second rater pending)';
  if (set.confirmedW < MIN_CONFIRMED_W) return `INCONCLUSIVE (${set.confirmedW} confirmed W, ${MIN_CONFIRMED_W} needed)`;
  if (queue.length) return `PENDING (${queue.length} rows to adjudicate)`;
  return [...cells, ...kind].every((c) => c.pass) ? 'PASS' : 'FAIL';
}

function argFiles(argv, flag) {
  const rest = argv.slice(argv.indexOf(flag) + 1);
  const end = rest.findIndex((a) => a.startsWith('--'));
  return end === -1 ? rest : rest.slice(0, end);
}

function main(argv) {
  const problems = checkGold();
  for (const p of problems) console.error(`gold: ${p}`);
  if (problems.length) return 1;
  const set = loadRunSet();
  console.log(`gold OK · run set ${set.items.length} items · ${set.confirmedW} W ${set.confirmed ? 'confirmed' : '(rater 1 only: second rater pending)'} · dropped ${set.dropped.length}`);
  if (argv.includes('--controls')) {
    const c = controls(set);
    for (const [name, ok, got] of c.lines) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}`);
    console.log(`controls ${c.ok ? 'PASS' : 'FAIL'}`);
    if (!c.ok) return 1;
  }
  if (argv.includes('--runs') && argv.includes('--kind')) {
    const { cells, queue } = scoreRuns(argFiles(argv, '--runs'));
    const kind = scoreKind(argFiles(argv, '--kind'));
    for (const c of [...cells, ...kind]) console.log(c.line);
    for (const q of queue) console.log(`adjudicate: ${q}`);
    console.log(`VERDICT: ${verdict(set, cells, kind, queue)}`);
  }
  if (argv.includes('--gold-sheet')) for (const l of goldSheet(set)) console.log(l);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
