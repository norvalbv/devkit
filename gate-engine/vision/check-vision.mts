#!/usr/bin/env node

/**
 * Vision gate (guard-vision --gate) — LLM judge of the staged diff vs the consumer's recorded
 * PRODUCT VISION. Catches the class of change no path-based reviewer can: a diff that compiles,
 * passes review, and quietly builds the wrong product.
 *
 * OWNERSHIP SPLIT (the qavis-advisory-gate precedent): devkit owns the MECHANISM — the
 * FIT/DRIFT/OUT verdict scaffold, confident-single-word parsing, exit contract, judge isolation —
 * and the consumer supplies only its product CONTENT: `guard.config.json` `vision.statement`,
 * prose defining the vision and the lines a diff must not cross (what OUT and DRIFT mean for
 * THAT product). No statement configured → the gate self-skips (exit 0), like the frontend
 * reviewers with no frontendRoots.
 *
 * HARD-BY-DEFAULT (review-gate-in-chain, 2026-07-12: no LLM judge gate is warn-by-default — a
 * warn printed to a headless agent is a dead channel). The block stays BOUNDED: only a confident
 * single-word OUT blocks; fuzzy DRIFT stays a ⚠️ warn (exit 0) because "off the spine" has no
 * deterministic floor; anything ambiguous parses to null → no block. GUARD_VISION_HARD=0 softens
 * a one-off OUT back to a warn.
 *
 * Fail-OPEN toward not blocking: no `claude` / offline / timeout / ambiguous verdict → no block
 * (execJudge prints one visible stderr warning — the dark judge is never a silent no-op).
 *
 *   --gate    : exit 0 = fit / drift-warn / softened / skipped / judge-dark · exit 1 = confident
 *               OUT (default hard) · exit 2 = could-not-run (git/config failure)
 *   (no flag) : report mode — judge the staged diff and PRINT the verdict, exit 0.
 *
 * Knobs (GUARD_* with FRINK_* aliases): GUARD_NO_VISION=1 skip · GUARD_VISION_HARD=0 soften ·
 * GUARD_VISION_NO_LLM=1 skip (can't judge without the LLM).
 *
 * Known limits (by design, do not over-harden): the diff sample is capped at ~12k, so an
 * off-vision module in the tail of a huge diff can read FIT. The diff body is judge input, so it
 * can carry verdict-injection — code-injection-proof via execFileSync, and bounded by fail-open +
 * the explicit bypass; the threat model is the author's own commit.
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { envBool, envFlag, resolveGuardConfig } from '../config.mts';
import { JUDGE_ISOLATION, JUDGE_READ_ONLY } from '../judge/judge-isolation.mts';
import { execJudge } from '../judge/run-judge.mts';

const MODEL = 'opus'; // hard-by-default: a blocking verdict gets the strongest judge
const TIMEOUT_MS = 120000; // claude -p cold-start (MCP/hooks/skills load) ~20s+; generous ceiling
const DIFF_CAP = 12000;

/** Wrap the consumer's vision statement in the fixed verdict scaffold the parser depends on. */
export function buildVisionPrompt(statement: string): string {
  return (
    'You judge whether a staged git diff (changed file paths + a diff sample on stdin) fits the ' +
    'product vision below. Judge ONLY against that statement — it defines what OUT and DRIFT ' +
    'mean for this product.\n' +
    '───── PRODUCT VISION ─────\n' +
    `${statement.trim()}\n` +
    '───── END PRODUCT VISION ─────\n' +
    'Reply with exactly one word: FIT, DRIFT, or OUT. OUT = the diff clearly crosses a line the ' +
    'statement forbids. DRIFT = it pulls the product off the direction or audience the statement ' +
    'commits to. FIT = everything else. If uncertain, reply FIT.'
  );
}

// Word-boundary matchers — NOT substring includes(): "about"/"without"/"output" contain "out",
// "benefit" contains "fit". A verbose reply with such words must not misparse as a verdict.
const VERDICT_RE = { OUT: /\bOUT\b/, DRIFT: /\bDRIFT\b/, FIT: /\bFIT\b/ };

/**
 * Confident single-word parse — anything ambiguous ("OUT but really FIT"), unknown, or empty →
 * null → no block (fail toward NOT blocking).
 */
export function parseVisionVerdict(raw: unknown): 'OUT' | 'DRIFT' | 'FIT' | null {
  const out = String(raw).trim().toUpperCase();
  const hits = (['OUT', 'DRIFT', 'FIT'] as const).filter((v) => VERDICT_RE[v].test(out));
  return hits.length === 1 ? hits[0] : null;
}

/** The block is bounded to {hard mode AND a confident OUT}. Everything else passes. */
export function visionExit(verdict: string | null, hard: boolean): number {
  return verdict === 'OUT' && hard ? 1 : 0;
}

/** Trimmed git stdout in <cwd>; throws on failure (caught by run's fail-open catch). */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

// File paths anchor the judgement (whose product surface); the sampled body adds detail.
function stagedJudgeInput(cwd: string): string {
  const names = git(cwd, ['diff', '--cached', '--name-only']).trim();
  const diff = git(cwd, ['diff', '--cached']);
  return `CHANGED PATHS:\n${names}\n\nDIFF SAMPLE:\n${diff}`.slice(0, DIFF_CAP);
}

/** Injectable judge-exec for tests (same shape as execJudge). */
export interface VisionDeps {
  exec?: typeof execJudge;
}

/**
 * The gate → exit code (see module contract). Report mode (gate=false) always prints a verdict
 * line and returns 0.
 */
export function runVision(
  gate: boolean,
  cwd = process.cwd(),
  { exec = execJudge }: VisionDeps = {},
): number {
  try {
    if (envFlag('NO_VISION')) {
      if (!gate) console.log('vision: skipped (GUARD_NO_VISION)');
      return 0;
    }
    const statement = resolveGuardConfig(cwd).vision.statement;
    if (!statement?.trim()) {
      if (!gate) console.log('vision: skipped (no vision.statement in guard.config.json)');
      return 0;
    }
    // Hard unless explicitly softened for this one commit (GUARD_VISION_HARD=0); unset → hard.
    const hard = envBool('VISION_HARD') ?? true;
    const input = stagedJudgeInput(cwd);
    let verdict: ReturnType<typeof parseVisionVerdict> = null;
    if (!envFlag('VISION_NO_LLM') && input.trim()) {
      const raw = exec({
        label: 'vision',
        args: [
          '-p',
          '--model',
          MODEL,
          ...JUDGE_READ_ONLY,
          ...JUDGE_ISOLATION,
          buildVisionPrompt(statement),
        ],
        input,
        timeout: TIMEOUT_MS,
        cwd,
      });
      // null = outage (execJudge already warned once) → no verdict → no block.
      verdict = raw === null ? null : parseVisionVerdict(raw);
    }
    if (!gate) {
      console.log(`vision: ${verdict ?? 'no verdict (nothing staged, or judge unavailable)'}`);
      return 0;
    }
    if (verdict === 'OUT' || verdict === 'DRIFT') {
      const tail =
        verdict === 'OUT'
          ? 'diff conflicts with the recorded product vision.'
          : 'diff may drift off the recorded product vision.';
      console.error(`⚠️  vision: ${verdict} — ${tail}`);
    }
    return visionExit(verdict, hard);
  } catch (e: unknown) {
    console.error(`guard-vision: could not run — ${e instanceof Error ? e.message : String(e)}`);
    return 2; // fail-open
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) process.exit(runVision(process.argv.includes('--gate')));
