#!/usr/bin/env node

/**
 * guard-decisions — unified CLI for the decision-log engine.
 *
 * Dispatches to the three sub-engines, all of which resolve their paths/knobs from
 * resolveGuardConfig(process.cwd()) — i.e. against the CONSUMER repo, never the package dir (W-3):
 *
 *   guard-decisions add <slug> --target …| --note …   record a Target / append a note
 *   guard-decisions amend <slug> --target …| --note …| --note-replace OLD NEW  correct newest draft
 *   guard-decisions rescope <slug> --scope … --reason …  append-only Scope correction (a tagged note)
 *   guard-decisions query "<text>" [--top K] [--json|--full]  rank axes (semantic → lexical floor)
 *   guard-decisions reindex | list | show <slug> | check <slug>
 *   guard-decisions detect --gate | scan [--working]  architectural-smell gate (capture B)
 *   guard-decisions check-alignment --gate | scan     scope-matched alignment + depth gate (capture C)
 *   guard-decisions scoped-targets --files <a,b> [--query "<text>" --top K]   governing Targets → JSON
 *   guard-decisions categories                        per-category view (recall/category-report.mts)
 *   guard-decisions integrity [--staged]              structural-integrity scan (integrity/scan.mts);
 *                                                     --staged judges only the records THIS commit
 *                                                     touches, against HEAD (integrity/staged-gate.mts)
 *
 * `detect`, `check-alignment` and `scoped-targets` are thin re-dispatches into their .mjs by
 * re-importing them with a synthesised argv (so their own run-as-main dispatch fires); `categories`
 * and `integrity` are plain function calls (neither has a --gate/scan sub-dispatch of its own);
 * everything else routes to decisions.mjs `main`.
 *
 * `integrity` is dispatched HERE rather than alongside `drift` in decisions.mts purely because that
 * file is at its 500-line cap; `categories` set the precedent for a plain-function command living at
 * this layer.
 */

import { readdirSync, realpathSync } from 'node:fs';
import { resolveFromCwd, resolveGuardConfig } from '../config.mts';
// Type-only: erased at compile, so naming the envelope here does NOT re-link decisions.mts — the
// module that is unloadable in exactly the case this file has to answer for.
import type { QueryEnvelope } from './decisions.mts';

/**
 * Sub-engines load dynamically so a missing parser is catchable, and only via STRING LITERALS so the
 * dist rewrite and dist-integrity both see them. Why: decision-retrieval-candidate-set (sc-2692).
 */

// Dev runs the .mts source (Node strips types); the shipped dist is compiled .mjs. Derive the
// runtime extension from THIS module so the sub-engine URLs resolve in both.
const SELF_EXT = import.meta.url.endsWith('.mts') ? '.mts' : '.mjs';
const SUB_ENGINES: Record<string, URL> = {
  detect: new URL(`./detect${SELF_EXT}`, import.meta.url),
  'check-alignment': new URL(`./check-alignment${SELF_EXT}`, import.meta.url),
  'scoped-targets': new URL(`./scoped-targets${SELF_EXT}`, import.meta.url),
};

async function run(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (cmd === 'categories') {
    // recall/category-report.mts's import closure never reaches markdown.mts, so this command works
    // on a tree with no mdast installed. It only ever failed because of the static link above.
    const { cmdCategories } = await import('./recall/category-report.mts');
    cmdCategories();
    return;
  }
  if (cmd === 'integrity') {
    // A non-zero scan is a finding, not a crash — set exitCode rather than throwing into the
    // catch below, which would relabel it as `guard-decisions: <error>`.
    // --staged is the commit-time gate: same checks, scoped to this change and diffed against HEAD.
    // Bare `integrity` keeps its whole-corpus contract, known historical finding included.
    process.exitCode = rest.includes('--staged')
      ? (await import('./integrity/staged-gate.mts')).runStagedIntegrity()
      : (await import('./integrity/scan.mts')).cmdIntegrity();
    return;
  }
  const sub = SUB_ENGINES[cmd];
  if (sub) {
    // Re-enter the sub-engine as if invoked directly: it inspects process.argv and self-dispatches
    // (--gate / scan). process.argv[1] must equal the sub-engine path so its run-as-main guard fires.
    process.argv = [process.argv[0], realpathSync(sub), ...rest];
    await import(sub.href);
    return;
  }
  const { main: decisionsMain } = await import('./decisions.mts');
  await decisionsMain(argv);
}

/** The one string a caller can grep for to tell an outage from an answer. */
const UNAVAILABLE_MARKER = 'decision engine UNAVAILABLE';

/** Commands that ANSWER from the log, where an outage is mistakable for "nothing rules on this".
 * Every other command fails visibly on its own terms and needs no retrieval caveat. */
const RETRIEVAL_COMMANDS = new Set(['query', 'scoped-targets']);

/**
 * The dependency an unloadable engine named, else null. Positive-signal-only: anything but
 * ERR_MODULE_NOT_FOUND stays an ordinary error (judge-outage-classified-not-blocked).
 */
function missingModule(error: Error): string | null {
  // SAFETY: Node module-resolution failures carry ErrnoException.code; an absent field fails below.
  const { code } = error as NodeJS.ErrnoException;
  if (code !== 'ERR_MODULE_NOT_FOUND') return null;
  const named = /Cannot find (?:package|module) '([^']+)'/.exec(error.message);
  return named?.[1] ?? 'a required dependency';
}

/**
 * Axis FILENAMES, alphabetical and deliberately unranked — never record content.
 * Why both: decision-format-parsed-not-regexed, and the note on decision-retrieval-candidate-set.
 */
function axisSlugs(): string[] | null {
  try {
    const dir = resolveFromCwd(resolveGuardConfig(process.cwd()), 'decisionsDir');
    return dir == null
      ? null
      : readdirSync(dir)
          .filter((f) => f.endsWith('.md') && f !== 'INDEX.md')
          .map((f) => f.slice(0, -3))
          .sort();
  } catch {
    return null;
  }
}

/**
 * Built HERE because decisions.mts is the module that failed. `rows: []` keeps a rows-only consumer
 * at "abstained". Field-by-field reasoning: the sc-2692 note on decision-retrieval-candidate-set.
 */
const UNAVAILABLE_ENVELOPE: QueryEnvelope = {
  state: 'UNAVAILABLE',
  source: 'unavailable',
  tau: null,
  margin: null,
  rows: [],
  cost: { llmCalls: 0, ms: 0 },
};

/** Say what did not happen, then hand over the manual route. Everything here goes to STDERR. */
function reportUnavailable(dependency: string, cmd: string | undefined) {
  console.error(
    `guard-decisions: ${UNAVAILABLE_MARKER} — could not load ('${dependency}' is not installed).`,
  );
  console.error("Remedy: install this package's dependencies (e.g. `bun install`), then re-run.");
  // Only a command that ANSWERS from the log can have its outage misread as an empty answer, so
  // only those get the caveat and the manual route. `integrity` failing is just a failure.
  if (!RETRIEVAL_COMMANDS.has(cmd ?? '')) return;
  console.error(
    'Nothing was searched. This is NOT "no governing Target", and must not be read as one.',
  );

  const slugs = axisSlugs();
  if (slugs == null) {
    console.error(
      'The decisions directory could not be resolved either — check guard.config.json.',
    );
    return;
  }
  if (slugs.length === 0) {
    console.error('The decisions directory is empty: nothing has been recorded.');
    return;
  }
  const noun = slugs.length === 1 ? 'axis' : 'axes';
  console.error(`\nRead the log by hand. ${slugs.length} ${noun}, ALPHABETICAL — not a ranking:`);
  for (const slug of slugs) console.error(`  ${slug}`);
  console.error(
    '\n  1. INDEX.md in that directory — the rendered spine (a view, and it can omit axes)',
  );
  console.error('  2. cat <decisionsDir>/<slug>.md');
  console.error(
    "  3. grep -n '^## ' <decisionsDir>/<slug>.md — a LATER `## Target ·` block supersedes an earlier one",
  );
}

// Captured BEFORE run(): the SUB_ENGINES dispatch rewrites process.argv to re-enter its engine, so
// by the time a failed import rejects, process.argv[2] is that engine's first flag, not the command.
const argv = process.argv.slice(2);

run(argv).catch((error) => {
  // Narrowed as gate-engine/structure/load-baseline.mts does: a non-Error throw carries no code.
  const dependency = error instanceof Error ? missingModule(error) : null;
  if (dependency) {
    reportUnavailable(dependency, argv[0]);
    // --json gets the envelope; every other invocation leaves stdout EMPTY, because a `[]` here is
    // exactly how an outage gets read as "nothing governs".
    if (argv[0] === 'query' && argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify(UNAVAILABLE_ENVELOPE, null, 2)}\n`);
    }
    // exitCode, not process.exit (which can truncate a piped stdout). 1 not 3, per
    // gate-opt-out-is-visible-and-detectable: this is a local, reproducible could-not-run.
    process.exitCode = 1;
    return;
  }
  console.error(`guard-decisions: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
