/** Historical location/proximity proxy; claim-cli.mts measures exact occurrence precision.
 * Deduplication here uses (diff12, lens, file, line//10), not semantic defect identity. */

// Usage: `report [--banks a,b] [--adjudications f] [--by who]` · `sample --n 40 --seed 7 [--min 3] --out dir`.
// Adjudications JSONL: {key, verdict: 'REAL'|'NOT'|'UNSURE', by, at, note?}; haiku proxy never counted.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wilsonScoreInterval } from '../../../../eval/statistics.mts';
import { splitDiffByFile } from '../../../../judge/diff-focus.mts';
import { identityByPath } from '../../../lens/chunk.mts';
import { arg, argInt } from './bench-args.mts';
import {
  extractLocations,
  linesMatch,
  readArchivedDiff,
  resolvedLocations,
  resolveToStaged,
  type ResultsFile,
} from './labels.mts';
import { createHash } from 'node:crypto';

const RESEARCH = path.join(os.homedir(), '.devkit', 'research', '2026-08-22-ship-attempts');
export const DEFAULT_BANKS = [
  'probe-codex/gpt-5.6-sol',
  'probe-codex/gpt-5.6-terra',
  'probe-codex/gpt-5.6-terra-high',
  'probe-codex/gpt-5.6-terra-xhigh',
  'probe-codex/gpt-5.6-terra-xhigh-k2',
  'probe',
  'probe-haiku',
  'probe-haiku100',
];

export type Family = 'codex' | 'claude';
export interface Extra {
  key: string;
  diff: string;
  lens: string;
  file: string;
  line: number | null;
  text: string;
  raisers: string[]; // `${family}:${model}:${arm}`
}
export type Tier = 'cross-family' | 'codex-only' | 'claude-only';
export interface Verdict {
  key: string;
  verdict: 'REAL' | 'NOT' | 'UNSURE';
  by?: string;
  at?: string;
  note?: string;
}

/** Rows in the historical Claude banks carry no model; the bank's directory name says which. */
export function modelOf(row: { model?: string }, bank: string): string {
  if (row.model) return row.model;
  return /haiku/.test(bank) ? 'haiku' : 'sonnet';
}
export const familyOf = (model: string): Family => (model.startsWith('gpt-') ? 'codex' : 'claude');

export function tierOf(e: Extra): Tier {
  const fams = new Set(e.raisers.map((r) => r.split(':')[0]));
  if (fams.has('codex') && fams.has('claude')) return 'cross-family';
  return fams.has('codex') ? 'codex-only' : 'claude-only';
}

/** Every deduped extra across the given bank dirs (absolute paths). */
export function collectExtras(
  bankDirs: string[],
  readDiff: (sha: string) => string | null = readArchivedDiff,
) {
  const byKey = new Map<string, Extra>();
  const skipped: string[] = [];
  for (const dir of bankDirs) {
    if (!existsSync(dir)) {
      skipped.push(`${dir}: missing`);
      continue;
    }
    const bank = path.basename(dir);
    for (const f of readdirSync(dir)
      .filter((n) => n.startsWith('results-') && n.endsWith('.json'))
      .sort()) {
      let res: ResultsFile;
      try {
        // SAFETY: results-*.json is written (tmp+rename) only by scale-bench.mts with this shape.
        res = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      } catch {
        skipped.push(`${bank}/${f}: unreadable`);
        continue;
      }
      const whole = readDiff(res.diff);
      if (!whole) {
        skipped.push(`${bank}/${f}: archived diff missing`);
        continue;
      }
      const stagedPaths = [...identityByPath(whole).keys()];
      const isLabel = (file: string, line: number | null): boolean => {
        const r = resolveToStaged(file, stagedPaths);
        return r !== undefined && res.labels.some((l) => l.file === r && linesMatch(l.line, line));
      };
      for (const row of res.rows) {
        if (row.status !== undefined && row.status !== 'pass' && row.status !== 'fail') continue;
        const model = modelOf(row, bank);
        const raiser = `${familyOf(model)}:${model}:${row.arm}`;
        for (const issue of row.issues ?? []) {
          const locs = extractLocations(issue.text);
          if (locs.length === 0 || locs.some((l) => isLabel(l.file, l.line))) continue;
          const resolved = resolvedLocations(issue.text, stagedPaths);
          if (resolved.length === 0) continue;
          const [first] = resolved;
          const bucket = first.line === null ? '' : String(Math.floor(first.line / 10));
          const key = `${res.diff.slice(0, 12)}|${issue.lens}|${first.file}|${bucket}`;
          const e = byKey.get(key);
          if (e) {
            if (!e.raisers.includes(raiser)) e.raisers.push(raiser);
          } else
            byKey.set(key, {
              key,
              diff: res.diff,
              lens: issue.lens,
              file: first.file,
              line: first.line,
              text: issue.text,
              raisers: [raiser],
            });
        }
      }
    }
  }
  const extras = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const e of extras) e.raisers.sort();
  return { extras, skipped };
}

/** Hand verdicts, last write per key wins; a row with an unknown verdict value is ignored. */
export function readVerdicts(file: string, by?: string): Map<string, Verdict> {
  if (!existsSync(file)) return new Map();
  // SAFETY: the verdict field is checked against the closed set before a row is kept.
  const rows = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Verdict)
    .filter((v) => v.key && ['REAL', 'NOT', 'UNSURE'].includes(v.verdict))
    // A tier is measured per judge: `--by owner` reads only hand verdicts, never AI-assisted ones.
    .filter((v) => by === undefined || v.by === by);
  return new Map(rows.map((v) => [v.key, v]));
}

export interface TierReport {
  tier: Tier | 'all';
  extras: number;
  judged: number;
  real: number;
  not: number;
  unsure: number;
  precision: { value: number; lower: number; upper: number } | null;
}
/** Hand-tier precision = REAL / (REAL + NOT); UNSURE is reported, never averaged. */
export function reportTiers(extras: Extra[], verdicts: Map<string, Verdict>): TierReport[] {
  const tiers: Array<Tier | 'all'> = ['cross-family', 'codex-only', 'claude-only', 'all'];
  return tiers.map((tier) => {
    const set = tier === 'all' ? extras : extras.filter((e) => tierOf(e) === tier);
    let real = 0;
    let not = 0;
    let unsure = 0;
    for (const e of set) {
      const v = verdicts.get(e.key)?.verdict;
      if (v === 'REAL') real += 1;
      else if (v === 'NOT') not += 1;
      else if (v === 'UNSURE') unsure += 1;
    }
    const n = real + not;
    const ci = n > 0 ? wilsonScoreInterval(real, n) : null;
    return {
      tier,
      extras: set.length,
      judged: real + not + unsure,
      real,
      not,
      unsure,
      precision: ci ? { value: real / n, lower: ci.lower, upper: ci.upper } : null,
    };
  });
}

/** Hash-ordered: each extra's rank is sha256(seed|key), so a sample is reproducible from its seed
 * and pre-registerable without a PRNG. */
function shuffled(items: Extra[], seed: number): Extra[] {
  const rank = (e: Extra): string => createHash('sha256').update(`${seed}|${e.key}`).digest('hex');
  return [...items].sort((a, b) => (rank(a) < rank(b) ? -1 : 1));
}

/** Stratified by tier: proportional to tier size with a floor of `min` per non-empty tier. */
export function stratifiedSample(extras: Extra[], n: number, seed: number, min = 3): Extra[] {
  const groups = new Map<Tier, Extra[]>();
  for (const e of extras) {
    const t = tierOf(e);
    groups.set(t, [...(groups.get(t) ?? []), e]);
  }
  const total = extras.length;
  const perTier = new Map<Tier, Extra[]>();
  for (const [t, g] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const want = Math.min(g.length, Math.max(min, Math.round((n * g.length) / total)));
    perTier.set(t, shuffled(g, seed).slice(0, want));
  }
  // Rounding can overshoot n: trim the LARGEST tier, never the small ones the floor protects.
  let over = [...perTier.values()].reduce((s, g) => s + g.length, 0) - n;
  while (over > 0) {
    const [t, g] = [...perTier.entries()].sort((x, y) => y[1].length - x[1].length)[0];
    perTier.set(t, g.slice(0, -1));
    over -= 1;
  }
  return shuffled([...perTier.values()].flat(), seed);
}

/** The finding's own file hunk from the archived diff, windowed around its line when it has one. */
export function hunkFor(e: Extra, diff: string, window = 60): string {
  const part = splitDiffByFile(diff).find((p) => {
    const m = p.match(/^\+\+\+ b\/(.+)$/m) ?? p.match(/^diff --git a\/(.+?) b\//m);
    return m?.[1] === e.file;
  });
  if (!part) return '(file hunk not found in archived diff)';
  if (e.line === null)
    return part
      .split('\n')
      .slice(0, window * 2)
      .join('\n');
  // Walk the post-image line numbers to find the window around e.line.
  const lines = part.split('\n');
  let post = 0;
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const h = lines[i].match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (h) {
      post = Number(h[1]) - 1;
      continue;
    }
    if (!lines[i].startsWith('-')) post += 1;
    if (post === e.line && start === -1) start = i;
  }
  if (start === -1) return lines.slice(0, window * 2).join('\n');
  return lines.slice(Math.max(0, start - window), start + window).join('\n');
}

function main(): void {
  const cmd = process.argv[2];
  const banks = (arg('banks') ?? DEFAULT_BANKS.join(','))
    .split(',')
    .map((b) => (path.isAbsolute(b) ? b : path.join(RESEARCH, b)));
  const verdictFile = arg('adjudications') ?? path.join(RESEARCH, 'adjudications.jsonl');
  const { extras, skipped } = collectExtras(banks);
  for (const s of skipped) console.error(`extras-adjudicate: skipped ${s}`);
  const verdicts = readVerdicts(verdictFile, arg('by'));
  if (cmd === 'report') {
    console.log(
      `banks ${banks.length} · distinct extras ${extras.length} · verdicts on file ${verdicts.size} (${path.basename(verdictFile)}${arg('by') ? `, by=${arg('by')}` : ''})`,
    );
    for (const r of reportTiers(extras, verdicts))
      console.log(
        `  ${r.tier.padEnd(13)} extras ${String(r.extras).padStart(4)} · judged ${r.judged} (REAL ${r.real} / NOT ${r.not} / UNSURE ${r.unsure})` +
          (r.precision
            ? ` · historical location-proxy precision ${r.precision.value.toFixed(2)} [${r.precision.lower.toFixed(2)}, ${r.precision.upper.toFixed(2)}] (legacy interval)`
            : ' · historical location-proxy precision n/a'),
      );
    const byLens = new Map<string, number>();
    for (const e of extras) byLens.set(e.lens, (byLens.get(e.lens) ?? 0) + 1);
    console.log(
      `  by lens: ${[...byLens]
        .sort((a, b) => b[1] - a[1])
        .map(([l, n]) => `${l} ${n}`)
        .join(' · ')}`,
    );
    return;
  }
  if (cmd === 'sample') {
    const n = argInt('n', 40);
    const seed = argInt('seed', 1);
    const out = arg('out') ?? path.join(RESEARCH, 'adjudication');
    mkdirSync(out, { recursive: true });
    const unjudged = extras.filter((e) => !verdicts.has(e.key));
    const picks = stratifiedSample(unjudged, n, seed, argInt('min', 3));
    const md: string[] = [
      `# Extras adjudication sample — n=${picks.length} of ${unjudged.length} unjudged (seed ${seed}, ${new Date().toISOString().slice(0, 10)})`,
      '',
      'Verdict per finding: REAL (a defect a maintainer would fix), NOT (not a defect, or not in this diff), UNSURE. Judge the CODE, not the prose.',
      '',
    ];
    const template: string[] = [];
    picks.forEach((e, i) => {
      const diff = readArchivedDiff(e.diff) ?? '';
      md.push(
        `## ${i + 1}. ${e.key}`,
        '',
        `- tier: **${tierOf(e)}** · raised by: ${e.raisers.join(', ')}`,
        `- lens: ${e.lens} · file: ${e.file}${e.line === null ? '' : `:${e.line}`}`,
        '',
        `> ${e.text.replace(/\n/g, '\n> ')}`,
        '',
        '```diff',
        hunkFor(e, diff),
        '```',
        '',
      );
      template.push(JSON.stringify({ key: e.key, verdict: '', by: '', at: '', note: '' }));
    });
    writeFileSync(path.join(out, `sample-seed${seed}.md`), `${md.join('\n')}\n`);
    writeFileSync(path.join(out, `sample-seed${seed}.template.jsonl`), `${template.join('\n')}\n`);
    console.log(
      `wrote ${picks.length} findings → ${out}/sample-seed${seed}.md (+ .template.jsonl); tiers: ${['cross-family', 'codex-only', 'claude-only'].map((t) => `${t} ${picks.filter((e) => tierOf(e) === t).length}`).join(' · ')}`,
    );
    return;
  }
  console.error(
    'usage: extras-adjudicate.mts report|sample [--banks a,b] [--adjudications f] [--n N] [--seed S] [--out dir]',
  );
  process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
