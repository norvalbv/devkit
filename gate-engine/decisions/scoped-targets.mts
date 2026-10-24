#!/usr/bin/env node

/**
 * `guard-decisions scoped-targets --files <a,b> [--query "<text>" --top <k>]`
 *
 * Emits (as JSON to stdout) the recorded Targets that GOVERN a change — so a consumer's critique-prep
 * step can load the governing spec by shelling out, instead of importing devkit's decision internals
 * as a package (the dev-guardrails-distribution re-target: devkit is a CLI on PATH, not an npm dep).
 *
 * Two sources, exactly mirroring what prep-critique used to compute in-process:
 *   - DETERMINISTIC scope-match (primary): every Target whose `**Scope:**` glob covers a changed file.
 *   - SEMANTIC supplement (when --query is given): the top-k ranked axes NOT already scope-matched,
 *     with their current ruling read from the axis file.
 *
 * Output: a JSON array of { slug, ruling, scope, via: 'scope-match'|'semantic' }. Empty array when
 * nothing governs. Fail-open: any error → exit 2 with `[]` so the consumer degrades to a SKIP note.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { matchesRepoGlob } from '../../skills/_devkit/review-roots.mjs';
import { resolveFromCwd, resolveGuardConfig } from '../config.mts';
import { emitGateEvent } from '../judge/gate-events.mts';
import { clip, EVENT_BUDGET } from '../judge/odb-probe.mts';
import {
  type DecisionSource,
  decisionTexts,
  matchScope,
  parseScopedTargets,
} from './check-alignment.mts';
import { currentTarget, parseDecision, rankAxes } from './decisions.mts';

/** A recorded Target that governs a change: its axis slug, current ruling, scope, and match source. */
export interface GoverningTarget {
  slug: string;
  ruling: string;
  scope: string | null;
  via: 'scope-match' | 'semantic';
}

// The current Target's full ruling + scope for an axis, read from its file (not the clamped INDEX row).
function rulingFor(
  slug: string,
  texts: Map<string, string>,
): { ruling: string; scope: string | null } | null {
  const text = texts.get(slug);
  if (text === undefined) return null;
  const t = currentTarget(parseDecision(text).body);
  if (!t?.ruling) return null;
  return { ruling: t.ruling, scope: t.scope ?? null };
}

// Newest ruling first, so a capped prompt keeps the Target just recorded. Content-keyed, and compared
// by UTF-16 code unit rather than locale, so the order and its cache salts match on every machine.
function newestFirst(a: { slug: string; date: string }, b: { slug: string; date: string }) {
  return codeUnitOrder(b.date, a.date) || codeUnitOrder(a.slug, b.slug);
}

function codeUnitOrder(x: string, y: string): number {
  return Number(x > y) - Number(x < y);
}

/**
 * @param files changed files (scope-match key)
 * @param query free-text (plan terms) for the semantic supplement; '' skips it
 * @param k semantic top-k
 * @param from 'index' for commit-time gates; the CLI briefs from the worktree draft
 */
export async function scopedTargets(
  files: string[],
  query: string,
  k = 6,
  cwd = process.cwd(),
  from: DecisionSource = 'index',
): Promise<GoverningTarget[]> {
  const decisionsDir = resolveFromCwd(resolveGuardConfig(cwd), 'decisionsDir');
  if (decisionsDir == null) return []; // fail-open: nothing resolvable → nothing governs
  const texts = decisionTexts(decisionsDir, from, cwd);
  const scoped = files.length
    ? parseScopedTargets(texts)
        .filter((t) => matchScope(files, t.scopeGlobs))
        .sort(newestFirst)
    : [];
  const scopedSlugs = new Set(scoped.map((t) => t.slug));
  const blocks: GoverningTarget[] = scoped.map((t) => ({
    slug: t.slug,
    ruling: t.ruling,
    scope: t.scopeGlobs.join(', '),
    via: 'scope-match',
  }));
  if (query?.trim()) {
    // The supplement is best-effort BY CONTRACT (sc-1442): the scope-matched half must survive any
    // semantic-tier error (embed endpoint down, unwritable vec index), or a caller that derives a
    // cache salt from the scope-match subset would see the salt move because a QUERY was supplied —
    // exactly what ship-gates-converge-not-restart forbids for the commit message.
    try {
      const { rows } = await rankAxes(query, k, cwd);
      for (const r of rows) {
        if (scopedSlugs.has(r.slug)) continue;
        const rf = rulingFor(r.slug, texts);
        if (rf) blocks.push({ slug: r.slug, ruling: rf.ruling, scope: rf.scope, via: 'semantic' });
      }
    } catch {
      // scope-matches already collected; a lost supplement degrades the prompt, never the salt
    }
  }
  return blocks;
}

/** A block's best literal-prefix length over the globs that match `files`; leading `**` scores 0. */
function specificity(files: string[], block: GoverningTarget): number {
  let best = -1;
  for (const glob of block.scope?.split(',').map((g) => g.trim()) ?? []) {
    const literal = glob.search(/[*?]/);
    if (files.some((f) => matchesRepoGlob(f, glob)))
      best = Math.max(best, literal === -1 ? glob.length : literal);
  }
  return best;
}

/** Scope matches most-specific first (stable, so ties keep readdir order); semantic rows stay last. */
export function rankBySpecificity(files: string[], blocks: GoverningTarget[]): GoverningTarget[] {
  const scored = blocks.filter((b) => b.via === 'scope-match');
  const score = new Map(scored.map((b) => [b, specificity(files, b)]));
  scored.sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0));
  return [...scored, ...blocks.filter((b) => b.via !== 'scope-match')];
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

interface HookSpec {
  tool: string;
  ints: number[];
}

/** The pre-edit hook's `<tool>,<int>…` flag value. Null when malformed, so no row is written. */
function hookSpec(raw: string | undefined, arity: number, min: number): HookSpec | null {
  const [tool = '', ...nums] = raw?.split(',') ?? [];
  const valid =
    /^[A-Za-z]{1,32}$/.test(tool) &&
    nums.length === arity &&
    nums.every((n) => /^\d{1,9}$/.test(n) && Number(n) >= min);
  return valid ? { tool, ints: nums.map(Number) } : null;
}

/** The brief the hook prints: the first `max_axes` slugs, with each ruling's full length. */
export function briefShownEvent(file: string, blocks: GoverningTarget[], spec: HookSpec) {
  const [maxAxes, cap] = spec.ints;
  const shown = blocks.slice(0, maxAxes);
  const hidden = blocks.slice(maxAxes).map((b) => b.slug);
  const event = {
    type: 'brief_shown',
    file: clip(file),
    tool: spec.tool,
    shown: shown.map((b) => b.slug),
    lengths: shown.map((b) => b.ruling.trim().length),
    hidden,
    hidden_count: hidden.length,
    cap,
    max_axes: maxAxes,
  };
  // hidden[] is the one unbounded field; hidden_count keeps the row honest once it is dropped.
  return Buffer.byteLength(JSON.stringify(event)) > EVENT_BUDGET
    ? { ...event, hidden: undefined }
    : event;
}

export async function main(args: string[]): Promise<void> {
  const fileArg = flag(args, '--files') ?? '';
  const files = fileArg
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // The hook's first return to a file it already briefed: recorded, never retrieved, nothing printed.
  if (args.includes('--brief-again')) {
    const again = hookSpec(flag(args, '--brief-again'), 1, 0);
    if (again) {
      emitGateEvent({
        type: 'brief_edited_again',
        file: clip(fileArg),
        tool: again.tool,
        secs_since_brief: again.ints[0],
      });
    }
    return;
  }
  const brief = hookSpec(flag(args, '--brief'), 2, 1);
  const query = flag(args, '--query') ?? '';
  const top = Number.parseInt(flag(args, '--top') ?? '6', 10) || 6;
  await scopedTargets(files, query, top, process.cwd(), 'worktree')
    .then((blocks) => rankBySpecificity(files, blocks))
    .then((blocks) => {
      process.stdout.write(JSON.stringify(blocks));
      if (brief && blocks.length) emitGateEvent(briefShownEvent(fileArg, blocks, brief));
    })
    .catch((e) => {
      // Fail-open: emit [] so a consumer's prep step degrades to a SKIP note, never an error.
      console.error(`scoped-targets: ${e?.message ?? e}`);
      if (brief) emitGateEvent({ type: 'brief_unavailable', file: clip(fileArg), reason: 'error' });
      process.stdout.write('[]');
      process.exit(2);
    });
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main(process.argv.slice(2));
