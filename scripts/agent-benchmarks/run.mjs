#!/usr/bin/env node

/**
 * Agent benchmark runner — scores the feature-critique / feature-completeness agents against a
 * golden trap-set. Exists because the agents' judgement is set by prompt edits, and a prompt edit
 * is unverifiable without a measurable check (see memory feedback_challenge_the_frame_not_just_approach).
 *
 * Each case = `cases/<id>.prompt.md` (a SELF-CONTAINED critique request — plan + the recorded
 * Targets inlined, so the agent needs no repo/tool access) + `cases/<id>.expected.json`:
 *   { agent, expectVerdict[], expectFrameMeta[], requireAny[], forbid[], note }
 *
 * The runner builds the agent's own instructions (its .md body) + a BENCHMARK directive (all
 * context inline, run no tools, emit only the summary block) and asks `claude -p` to judge the
 * case, then scores VERDICT / FRAME_META / keyword presence. This measures the agent's INTRINSIC
 * frame reasoning (the prompt edits) — the check-critique.mjs meta-judge is a separate net, not
 * exercised here.
 *
 *   node scripts/agent-benchmarks/run.mjs            # run all cases
 *   node scripts/agent-benchmarks/run.mjs case-01    # run one case (id prefix match)
 *   FRINK_BENCH_MODEL=sonnet node scripts/agent-benchmarks/run.mjs
 *
 * Exit 0 = all passed · 1 = a case failed · 2 = could not run (no claude / no cases).
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const CASES_DIR = path.join(__dirname, 'cases');
const MODEL = process.env.DEVKIT_BENCH_MODEL ?? process.env.FRINK_BENCH_MODEL ?? 'opus';

const AGENT_FILE = {
  'feature-critique': path.join(ROOT, '.claude', 'agents', 'feature-critique.md'),
};

const BENCHMARK_DIRECTIVE = [
  '',
  '=== BENCHMARK MODE ===',
  'Everything you need is in the CRITIQUE REQUEST below. Do NOT run any tools, scripts, research,',
  'MCP calls, or file reads, and do NOT write any files — treat the inlined "RECORDED TARGET(S)" as',
  'the authoritative decision log. Apply your full judgement (especially the Frame check), then',
  'output ONLY your final summary block: the VERDICT / FRAME_META / UX_IMPACT lines and a 1-2 line',
  'reason. No file path, no edge-case artifact.',
  '',
  '=== CRITIQUE REQUEST ===',
  '',
].join('\n');

const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n/;

function stripFrontmatter(md) {
  return md.startsWith('---') ? md.replace(FRONTMATTER_RE, '') : md;
}

function loadCases(filter) {
  const ids = [
    ...new Set(
      readdirSync(CASES_DIR)
        .filter((f) => f.endsWith('.prompt.md'))
        .map((f) => f.replace('.prompt.md', '')),
    ),
  ].sort();
  return ids
    .filter((id) => !filter || id.startsWith(filter))
    .map((id) => ({
      id,
      prompt: readFileSync(path.join(CASES_DIR, `${id}.prompt.md`), 'utf8'),
      expected: JSON.parse(readFileSync(path.join(CASES_DIR, `${id}.expected.json`), 'utf8')),
    }));
}

function ask(agent, requestBody) {
  const instructions = stripFrontmatter(readFileSync(AGENT_FILE[agent], 'utf8'));
  return execFileSync(
    'claude',
    ['-p', '--model', MODEL, instructions + BENCHMARK_DIRECTIVE + requestBody],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 300000,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
}

function lineValue(out, label) {
  const m = out.match(new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'im'));
  return m ? m[1].trim() : '';
}

/** True when `list` has entries but none satisfy `pred` — i.e. an expectation went unmet. */
function unmet(list, pred) {
  return Boolean(list?.length) && !list.some(pred);
}

// Each check reads the parsed context + the case's expectations and returns a
// failure string or null. Data-driven so `score` stays a flat map/filter (and
// adding a new assertion type is one array entry, not another branch).
const CHECKS = [
  ({ verdict }, exp) =>
    unmet(exp.expectVerdict, (v) => verdict.includes(v.toUpperCase()))
      ? `verdict "${verdict || '(none)'}" not in [${exp.expectVerdict.join(', ')}]`
      : null,
  ({ meta }, exp) =>
    meta && unmet(exp.expectFrameMeta, (v) => meta.includes(v.toUpperCase()))
      ? `frame_meta "${meta}" not in [${exp.expectFrameMeta.join(', ')}]`
      : null,
  ({ lower }, exp) =>
    unmet(exp.requireAny, (k) => lower.includes(k.toLowerCase()))
      ? `none of requireAny present: [${exp.requireAny.join(', ')}]`
      : null,
  ({ lower }, exp) => {
    const hit = (exp.forbid ?? []).find((k) => lower.includes(k.toLowerCase()));
    return hit ? `forbidden term present: "${hit}"` : null;
  },
];

function score(out, expected) {
  const ctx = {
    lower: out.toLowerCase(),
    verdict: lineValue(out, 'VERDICT').toUpperCase(),
    meta: lineValue(out, 'FRAME_META').toUpperCase(),
  };
  const fails = CHECKS.map((check) => check(ctx, expected)).filter(Boolean);
  return { verdict: ctx.verdict, meta: ctx.meta, fails };
}

/** Print one case result; returns 1 if it passed, 0 otherwise (for the tally). */
function report({ verdict, meta, fails }) {
  const tag = `[verdict=${verdict}${meta ? `, meta=${meta}` : ''}]`;
  if (fails.length === 0) {
    console.log(`PASS  ${tag}`);
    return 1;
  }
  console.log(`FAIL  ${tag}`);
  for (const f of fails) console.log(`        ✗ ${f}`);
  return 0;
}

/** Load cases or exit(2) with a reason — keeps the read/empty guards out of main. */
function loadCasesOrExit(filter) {
  try {
    const cases = loadCases(filter);
    if (cases.length) return cases;
    console.error(`bench: no cases${filter ? ` matching "${filter}"` : ''}`);
  } catch (e) {
    console.error(`bench: cannot read cases — ${e?.message ?? e}`);
  }
  return process.exit(2);
}

/** Run + score one case, printing its line; exit(2) if claude itself is unavailable. */
function runCase(c) {
  process.stdout.write(`▶ ${c.id} (${c.expected.title ?? c.expected.agent}) … `);
  let out;
  try {
    out = ask(c.expected.agent ?? 'feature-critique', c.prompt);
  } catch (e) {
    console.log(`SKIP (claude unavailable: ${e?.message ?? e})`);
    return process.exit(2);
  }
  return report(score(out, c.expected));
}

function main() {
  const cases = loadCasesOrExit(process.argv[2]);
  let passed = 0;
  for (const c of cases) passed += runCase(c);
  console.log(`\n${passed}/${cases.length} passed`);
  process.exit(passed === cases.length ? 0 : 1);
}

main();
