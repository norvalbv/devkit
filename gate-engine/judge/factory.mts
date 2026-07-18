// Generic diff/text judge-gate FACTORY — the shared mechanism behind every warn-by-default
// `claude -p` gate (the frink vision / sentry / critique gates are now thin callers that supply
// their prompt + verdict vocab + env names; nothing frink-specific lives here).
//
// WHY a factory: the three frink gates were near-identical — each did (1) read an input, (2) run an
// isolated `claude -p` judge, (3) word-boundary-parse a single-word verdict (null on ambiguity),
// (4) map {verdict, hard-flag} to a warn-by-default exit code (0 warn / 1 block-on-hard / 2 fail-open),
// (5) skip on an env override or no-LLM env. Only the PROMPT, the VERDICT VOCAB, the ENV NAMES, and
// the INPUT SOURCE differed. This factory owns the common 5 steps; a caller supplies the 4 differences.
//
// GOVERNING RULE (devkit "ship the generator, never the data"): this file has NO frink defaults.
// Every input — prompt, verdict vocab, the verdict that blocks, env-var names, the *_HARD flag name,
// and the input-source function — is a REQUIRED param. The frink prompts/verdicts stay in frink as
// thin callers (see the wiring-delta returned by this migration).
//
// WARN-BY-DEFAULT invariant (load-bearing): an LLM-in-gate must only ever DOWNGRADE a deterministic
// block, never CREATE one. There is no deterministic floor for "off-vision" / "should-monitor" / a
// "frame error", so a nondeterministic verdict must not be the sole creator of a hard stop (a false
// block trains reflexive bypass → dead gate). The block is therefore bounded to {hard mode AND a
// confident block-verdict}; everything else passes (exit 0). Fail-open on any could-not-run (exit 2).

import { JUDGE_ISOLATION, JUDGE_READ_ONLY } from './judge-isolation.mts';
import { execJudge } from './run-judge.mts';

// ─── Pure verdict logic (testable without claude) ───────────────────────────────

/**
 * Build a confident single-word verdict parser over a vocabulary. Word-boundary matchers
 * (NOT substring includes()): "about"/"without"/"output" contain "out", "benefit" contains
 * "fit" — a verbose reply with such words must not misparse. A SINGLE confident hit wins;
 * anything ambiguous (≥2 distinct verdicts), unknown, or empty → null (→ no block; fail toward
 * NOT blocking). `firstLineOnly` reads only the reply's first line (the sentry/critique shape,
 * where an optional why-line follows); off = scan the whole reply (the vision shape).
 *
 * @param verdicts The verdict vocabulary, e.g. ['FIT','DRIFT','OUT'].
 * @param opts
 */
export function makeVerdictParser(
  verdicts: string[],
  { firstLineOnly = false }: { firstLineOnly?: boolean } = {},
): (raw: unknown) => string | null {
  if (!Array.isArray(verdicts) || verdicts.length === 0) {
    throw new Error('makeVerdictParser: a non-empty verdict vocabulary is required.');
  }
  const re: Record<string, RegExp> = Object.fromEntries(
    verdicts.map((v) => [v, new RegExp(`\\b${v}\\b`)]),
  );
  return (raw: unknown) => {
    const text = String(raw).trim().toUpperCase();
    const scope = firstLineOnly ? (text.split('\n')[0] ?? '').trim() : text;
    const hits = verdicts.filter((v) => re[v].test(scope));
    return hits.length === 1 ? hits[0] : null;
  };
}

/**
 * Warn-by-default exit-code mapping. The block is bounded to {hard mode AND a confident
 * block-verdict}; everything else (any other verdict, null, warn mode) → exit 0.
 *
 * @param verdict The parsed verdict.
 * @param hard Whether the *_HARD escalation flag is set.
 * @param blockVerdict The single verdict that may block in hard mode.
 */
export function gateExit(verdict: string | null, hard: boolean, blockVerdict: string): 0 | 1 {
  return verdict === blockVerdict && hard ? 1 : 0;
}

// ─── claude I/O (thin) ────────────────────────────────────────────────────────

/**
 * Run the judge once over `input`, returning the parsed verdict or null (outage → execJudge
 * already warned once → fail-open). Shared so a caller and any benchmark exercise the same path.
 *
 * @param o.label execJudge warning label.
 * @param o.prompt The judge brain (positional prompt).
 * @param o.input stdin payload.
 * @param o.parse Verdict parser (from makeVerdictParser).
 * @param o.model
 * @param o.timeout
 * @param o.cwd
 */
export interface JudgeOnceOpts {
  label: string;
  prompt: string;
  input: string;
  parse: (raw: string) => string | null;
  model?: string;
  timeout?: number;
  cwd?: string;
}

export function judgeOnce({
  label,
  prompt,
  input,
  parse,
  model = 'opus',
  timeout = 120000,
  cwd,
}: JudgeOnceOpts): string | null {
  if (!String(input).trim()) return null;
  const raw = execJudge({
    label,
    args: ['-p', '--model', model, ...JUDGE_READ_ONLY, ...JUDGE_ISOLATION, prompt],
    input,
    timeout,
    cwd,
    // Factory-built gates have no gate-level transcript store of their own (unlike the review
    // gate) — opt into the exec-level one so their sessions are inspectable downstream.
    transcript: true,
  });
  return raw === null ? null : parse(raw);
}

// ─── Gate factory ────────────────────────────────────────────────────────────

/**
 * Build a warn-by-default judge gate. ALL behaviour-bearing inputs are REQUIRED — there are no
 * frink (or any) defaults baked in; a caller injects its prompt, vocab, env names, and input source.
 *
 * @param cfg.label execJudge warning label + report-line prefix.
 * @param cfg.prompt The judge brain.
 * @param cfg.verdicts Verdict vocabulary.
 * @param cfg.blockVerdict The single verdict that may hard-block.
 * @param cfg.warnVerdicts Verdicts that emit a stderr warning in gate mode.
 * @param cfg.readInput Returns the judge's stdin payload (staged diff, commit
 *   message, raw stdin — the per-gate difference). Resolves data from the CONSUMER cwd.
 * @param cfg.env Env-var NAMES (no values, no frink prefixes baked in):
 * @param cfg.env.skip      set → skip the gate entirely (exit 0).
 * @param cfg.env.noLlm     set → skip the LLM (can't judge → no verdict).
 * @param cfg.env.hard      set → escalate a confident block-verdict to exit 1.
 * @param cfg.env.model   optional: env name whose value overrides the model.
 * @param cfg.model
 * @param cfg.timeout
 * @param cfg.firstLineOnly Parse only the reply's first line.
 * @param cfg.cwd Consumer cwd handed to claude (defaults to process.cwd() at run).
 * @param cfg.warnTail Optional: per-verdict warning detail.
 */
export interface JudgeGateConfig {
  label: string;
  prompt: string;
  verdicts: string[];
  blockVerdict: string;
  warnVerdicts?: string[];
  readInput: () => string;
  env: { skip: string; noLlm: string; hard: string; model?: string };
  model?: string;
  timeout?: number;
  firstLineOnly?: boolean;
  cwd?: string;
  warnTail?: (verdict: string | null) => string;
}

export interface JudgeGate {
  run: (gate: boolean) => void;
  judge: (input: string) => string | null;
  parse: (raw: string) => string | null;
}

export function makeJudgeGate(cfg: JudgeGateConfig): JudgeGate {
  const {
    label,
    prompt,
    verdicts,
    blockVerdict,
    warnVerdicts = [],
    readInput,
    env,
    model = 'opus',
    timeout = 120000,
    firstLineOnly = false,
    cwd,
    warnTail,
  } = cfg;

  for (const [k, v] of Object.entries({ label, prompt, blockVerdict, readInput, env })) {
    if (v == null || (typeof v === 'string' && !v)) {
      throw new Error(`makeJudgeGate: required param "${k}" is missing.`);
    }
  }
  for (const k of ['skip', 'noLlm', 'hard'] as const) {
    if (!env[k]) throw new Error(`makeJudgeGate: required env name "env.${k}" is missing.`);
  }
  if (!verdicts.includes(blockVerdict)) {
    throw new Error(`makeJudgeGate: blockVerdict "${blockVerdict}" is not in the verdict vocab.`);
  }

  const parse = makeVerdictParser(verdicts, { firstLineOnly });

  const judge = (input: string) => {
    if (process.env[env.noLlm]) return null;
    const m = (env.model && process.env[env.model]) || model;
    return judgeOnce({
      label,
      prompt,
      input,
      parse,
      model: m,
      timeout,
      cwd: cwd ?? process.cwd(),
    });
  };

  // Reason: the branches ARE the gate lifecycle states (skip, print-mode vs gate-mode, warn-verdict tail, fail-open catch); flat sequential guards each dispatching to a process.exit, near-zero nesting — high branch COUNT, each trivial, extracting them scatters one exit-code decision
  // fallow-ignore-next-line complexity
  const run = (gate: boolean) => {
    try {
      if (process.env[env.skip]) {
        if (!gate) console.log(`${label}: skipped (${env.skip})`);
        process.exit(0);
      }
      const hard = Boolean(process.env[env.hard]);
      const verdict = judge(readInput());
      if (!gate) {
        console.log(
          `${label}: ${verdict ?? 'no verdict (nothing to judge, or judge unavailable)'}`,
        );
        process.exit(0);
      }
      if (verdict && warnVerdicts.includes(verdict)) {
        const tail = warnTail ? warnTail(verdict) : '';
        console.error(`⚠️  ${label}: ${verdict}${tail ? ` — ${tail}` : ''}`);
      }
      process.exit(gateExit(verdict, hard, blockVerdict));
    } catch (e: unknown) {
      const detail = e instanceof Error ? e.message : String(e);
      console.error(`${label}-gate: could not run — ${detail}`);
      process.exit(2); // fail-open
    }
  };

  return { run, judge, parse };
}
