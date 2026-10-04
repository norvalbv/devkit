#!/usr/bin/env node
import { realpathSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  applyVariant,
  QUESTION_SETS,
  VARIANTS,
  type QuestionSet,
  type Scoring,
  type SetName,
  type Variant,
} from './arms.mts';
import { type EvalItem, loadCorpus, type ReadBlob, readCorpusFile } from './corpus.mts';
import { mapLimit } from '../../review/lens/split.mts';
import { buildRequest, DECISIONS_ENDPOINT } from './request.mts';
import { type ScoredItem, summarizeVariant } from './score.mts';

const USAGE = `Offline evaluation of the Jev judge on the comment corpus. Never part of a gate or CI.
Usage: OPENROUTER_API_KEY=... node gate-engine/comment-firewall/eval/run.mts [options]
  --sets a,b         question sets (${Object.keys(QUESTION_SETS).join(', ')}); default all
  --variants a,b     restrict arms (${VARIANTS.join(', ')})
  --repo alias=path  local checkout that rebuilds manifest-only items (repeatable)
  --concurrency n    parallel requests (default 6)
  --block x          block band: load-bearing score <= x (default 0.10)
  --pass x           pass band: load-bearing score >= x (default 0.90)
  --out path         write raw rows and the summary as JSON`;

const TIMEOUT_MS = 20_000;

const probability = z.number().min(0).max(1);
const answerSchema = z.object({
  noul: probability.optional(),
  choice: z.string().optional(),
  confidence: probability.optional(),
  probabilities: z.record(z.string(), probability).optional(),
});
const responseSchema = z.object({
  answers: z.record(z.string(), answerSchema),
  usage: z.object({ cost: z.number().optional() }).optional(),
});
type Answer = z.infer<typeof answerSchema>;

interface Judged {
  score: number;
  choice?: string;
  confidence?: number;
}

interface Row {
  id: string;
  label: string;
  set: string;
  variant: Variant;
  ok: boolean;
  cost: number;
  error?: string;
  answers: Record<string, Judged>;
}

export interface RunDeps {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  out: (line: string) => void;
  err: (line: string) => void;
  corpus?: string;
  readBlob?: ReadBlob;
}

interface Job {
  item: EvalItem;
  set: SetName;
  variant: Variant;
}

function judged(answer: Answer | undefined, scoring: Scoring): Judged | null {
  if (!answer) return null;
  if (scoring.read === 'choice') {
    const score = answer.probabilities?.[scoring.option ?? scoring.positive];
    if (score === undefined || answer.choice === undefined) return null;
    return { score, choice: answer.choice, confidence: answer.confidence };
  }
  if (answer.noul === undefined) return null;
  return { score: scoring.read === 'noul' ? answer.noul : 1 - answer.noul };
}

function rowFor(job: Job, fields: Partial<Row>): Row {
  const { item, set, variant } = job;
  return {
    id: item.id,
    label: item.label,
    set,
    variant,
    ok: false,
    cost: 0,
    answers: {},
    ...fields,
  };
}

async function ask(job: Job, key: string, fetchImpl: typeof fetch): Promise<Row> {
  const spec: QuestionSet = QUESTION_SETS[job.set];
  const comment = spec.withholdComment ? null : applyVariant(job.item.comment, job.variant);
  const body = buildRequest(job.item, spec.questions, comment, spec.compare === true);
  try {
    const res = await fetchImpl(DECISIONS_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return rowFor(job, { error: `http ${res.status}` });
    const parsed = responseSchema.safeParse(await res.json());
    if (!parsed.success) return rowFor(job, { error: 'unexpected response shape' });
    const answers: Record<string, Judged> = {};
    for (const [question, scoring] of Object.entries(spec.scoring)) {
      const answer = judged(parsed.data.answers[question], scoring);
      if (!answer) return rowFor(job, { error: `missing answer: ${question}` });
      answers[question] = answer;
    }
    return rowFor(job, { ok: true, cost: parsed.data.usage?.cost ?? 0, answers });
  } catch (error) {
    return rowFor(job, { error: error instanceof Error ? error.name : 'request failed' });
  }
}

function scoredItems(rows: Row[], question: string): ScoredItem[] {
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    score: row.answers[question].score,
    choice: row.answers[question].choice,
  }));
}

const fmt = (value: number | null) =>
  value === null ? '-' : Number.isNaN(value) ? 'n/a' : value.toFixed(3);

function summarize(rows: Row[], bands: { blockAt: number; passAt: number }) {
  const sets = [...new Set(rows.map((row) => row.set))].filter((set): set is SetName =>
    Object.hasOwn(QUESTION_SETS, set),
  );
  return sets.map((set) => {
    const spec: QuestionSet = QUESTION_SETS[set];
    const setRows = rows.filter((row) => row.set === set);
    const ok = setRows.filter((row) => row.ok);
    const variants = [...new Set(setRows.map((row) => row.variant))];
    const questions = Object.entries(spec.scoring).map(([question, scoring]) => {
      const base = scoredItems(
        ok.filter((row) => row.variant === 'base'),
        question,
      );
      return {
        question,
        positive: scoring.positive,
        variants: variants.map((variant) =>
          summarizeVariant(
            variant,
            scoredItems(
              ok.filter((row) => row.variant === variant),
              question,
            ),
            base,
            scoring.positive,
            bands,
            scoring.option,
          ),
        ),
      };
    });
    return {
      set,
      calls: setRows.length,
      errors: setRows.length - ok.length,
      cost: ok.reduce((sum, row) => sum + row.cost, 0),
      questions,
    };
  });
}

function render(summary: ReturnType<typeof summarize>, out: (line: string) => void): void {
  for (const set of summary) {
    out(`\n## ${set.set}: ${set.calls} calls, ${set.errors} errors, cost $${set.cost.toFixed(4)}`);
    for (const q of set.questions) {
      out(`  ${q.question} (higher = ${q.positive})`);
      for (const v of q.variants) {
        const block = v.block.map((item) => `${item.id}:${item.label}`).join(' ') || 'empty';
        out(
          `    ${v.variant.padEnd(8)} n=${v.n} auroc=${fmt(v.auroc)} padded_auroc=${fmt(v.paddedAuroc)} shift=${fmt(v.negativeShift)}${v.flipped === null ? '' : ` flipped=${v.flipped}`} pass=${v.pass.positives}+/${v.pass.negatives}- block=[${block}]`,
        );
      }
    }
  }
}

const REPO_SPEC = /^([^=]+)=(.+)$/;

function checkouts(specs: string[]): Record<string, string> | null {
  const pairs = specs.map((spec) => REPO_SPEC.exec(spec));
  if (pairs.some((match) => match === null)) return null;
  return Object.fromEntries(pairs.flatMap((match) => (match ? [[match[1], match[2]]] : [])));
}

const list = (value: string | undefined) => value?.split(',').filter(Boolean);

interface Options {
  repos: Record<string, string>;
  sets: SetName[];
  variants: Variant[];
  concurrency: number;
  bands: { blockAt: number; passAt: number };
}

const isSet = (name: string): name is SetName => Object.hasOwn(QUESTION_SETS, name);
const isVariant = (name: string): name is Variant => VARIANTS.some((v) => v === name);
const isProbability = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;
/** Blank text is not zero: an empty flag value must fail validation, never become a threshold. */
const toNumber = (text: string) => (text.trim() === '' ? Number.NaN : Number(text));

interface RawOptions {
  repo: string[];
  sets?: string;
  variants?: string;
  concurrency: string;
  block: string;
  pass: string;
}

/** Every option is validated up front, so a typo can never shrink or empty the evaluation. */
function parseOptions(values: RawOptions): { options: Options } | { error: string } {
  const sets = list(values.sets) ?? Object.keys(QUESTION_SETS);
  const badSets = sets.filter((name) => !isSet(name));
  if (badSets.length > 0) return { error: `unknown question set: ${badSets.join(', ')}` };
  const variants = list(values.variants) ?? [...VARIANTS];
  const badVariants = variants.filter((name) => !isVariant(name));
  if (badVariants.length > 0) return { error: `unknown variant: ${badVariants.join(', ')}` };
  const repos = checkouts(values.repo);
  if (!repos) return { error: `--repo must be alias=path, got ${values.repo.join(' ')}` };
  const concurrency = toNumber(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    return { error: `--concurrency must be a positive integer, got ${values.concurrency}` };
  }
  const blockAt = toNumber(values.block);
  const passAt = toNumber(values.pass);
  if (!isProbability(blockAt) || !isProbability(passAt) || blockAt >= passAt) {
    return {
      error: `--block and --pass must be numbers between 0 and 1 with block below pass, got ${values.block} and ${values.pass}`,
    };
  }
  return {
    options: {
      repos,
      sets: sets.filter(isSet),
      variants: variants.filter(isVariant),
      concurrency,
      bands: { blockAt, passAt },
    },
  };
}

export async function runEval(args: string[], deps: RunDeps): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      sets: { type: 'string' },
      variants: { type: 'string' },
      repo: { type: 'string', multiple: true, default: [] },
      concurrency: { type: 'string', default: '6' },
      block: { type: 'string', default: '0.10' },
      pass: { type: 'string', default: '0.90' },
      out: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    deps.out(USAGE);
    return 0;
  }
  const key = deps.env.OPENROUTER_API_KEY;
  if (!key) {
    deps.err(
      'OPENROUTER_API_KEY is not set; this offline eval reads the key from the environment only.',
    );
    return 2;
  }
  const parsed = parseOptions(values);
  if ('error' in parsed) {
    deps.err(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  const { options } = parsed;
  let skipped = 0;
  const warn = (message: string) => {
    skipped += 1;
    deps.err(message);
  };
  const items = loadCorpus(deps.corpus ?? readCorpusFile(), options.repos, warn, deps.readBlob);
  const jobs: Job[] = [];
  for (const set of options.sets) {
    const variants = QUESTION_SETS[set].variants.filter((v) => options.variants.includes(v));
    for (const item of items) for (const variant of variants) jobs.push({ item, set, variant });
  }
  if (jobs.length === 0) {
    deps.err(
      'no calls selected: the chosen sets and variants have no arm in common, or no items loaded',
    );
    return 2;
  }
  deps.err(`${items.length} items, ${jobs.length} calls`);
  const rows = await mapLimit(jobs, options.concurrency, (job) => ask(job, key, deps.fetch));
  const summary = summarize(rows, options.bands);
  render(summary, deps.out);
  const failed = rows.filter((row) => !row.ok).length;
  const complete = failed === 0 && skipped === 0;
  if (values.out) {
    writeFileSync(values.out, `${JSON.stringify({ complete, skipped, rows, summary }, null, 1)}\n`);
  }
  if (complete) return 0;
  if (skipped > 0) {
    deps.err(
      `${skipped} corpus item(s) skipped: pass --repo alias=path for every external repo, or the result is not valid evidence`,
    );
  }
  if (failed === 0) return 1;
  deps.err(
    `${failed} of ${rows.length} calls failed: the summary covers successful calls only and is not valid evidence`,
  );
  return 1;
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(new URL(import.meta.url))) {
  process.exitCode = await runEval(process.argv.slice(2), {
    env: process.env,
    fetch,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
