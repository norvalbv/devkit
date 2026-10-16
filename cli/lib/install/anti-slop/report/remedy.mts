/** What a blocked anti-slop run tells its author to do next (sc-3469). Hints never go in a rule
 * message: the diagnostic is part of the baseline fingerprint (see oxc-toolchain-migration). */

import type { AntiSlopBaseline } from '../baseline.mts';
import { ANTI_SLOP_BASELINE_REL } from '../constants.mts';
import type { FindingGroup } from '../diagnostics.mts';
import {
  classifyRelocations,
  formatSources,
  relocationKey,
  relocationRemedy,
  type SourceCredit,
} from '../relocations.mts';

type NewErrorGroup = FindingGroup & { additionalCount: number };

/** Acceptance route with a committed baseline. No one-run bypass: CI's `check --base` would still
 * fail the PR, while an override is durable and visible in the diff. */
export const ACCEPT_VIA_OVERRIDE =
  "to accept it deliberately, change the rule's severity or add a path-scoped override in the repository Oxlint config (a reviewer sees it in the diff; anti-slop has no one-run bypass)";

/** Overlay rewrites its entry config on every sync, so the override route would silently vanish. */
const ACCEPT_IN_OVERLAY =
  'to accept it in this clone, run `devkit anti-slop create --force <paths>` — the overlay baseline is per-clone and git-ignored, and the overlay entry config is rewritten on every sync, so an override there would not last';

/** Concrete alternatives, keyed on the namespaced ruleId the diagnostics carry. */
const RULE_REMEDIES = new Map([
  [
    'anti-slop/no-module-mocking',
    'no-module-mocking: give the module a seam instead of mocking its imports — e.g. an optional `deps = { spawn, existsSync }` parameter (defaulting to the real imports) that the test passes fakes through',
  ],
  [
    'anti-slop/require-safety-comment-for-type-assertion',
    'require-safety-comment-for-type-assertion: if the value comes from I/O (JSON.parse, env, argv, a file or network body), decode it where it enters with a schema (e.g. zod `Schema.safeParse(JSON.parse(text))`) instead of casting; otherwise state the invariant on a `// SAFETY:` line directly above the assertion',
  ],
]);

/** One hint per distinct rule, then the acceptance route this install mode actually supports. */
export function antiSlopRemedyLines(ruleIds: readonly string[], overlay: boolean): string[] {
  const hints = [...new Set(ruleIds)].flatMap((ruleId) => {
    const hint = RULE_REMEDIES.get(ruleId);
    return hint === undefined ? [] : [`anti-slop: hint — ${hint}`];
  });
  return [...hints, `anti-slop: ${overlay ? ACCEPT_IN_OVERLAY : ACCEPT_VIA_OVERRIDE}`];
}

/** Names the move route when new findings repeat debt baselined under another file. A check
 * without Git evidence cannot tell a move from new code, so the line states both outcomes. */
export function relocationHint(
  errors: readonly NewErrorGroup[],
  baseline: AntiSlopBaseline,
  overlay: boolean,
  baseRef?: string,
): string[] {
  const baselinedCredit = new Map<string, SourceCredit[]>();
  const ordered = [...baseline.entries].sort(
    (a, b) => a.file.localeCompare(b.file) || a.fingerprint.localeCompare(b.fingerprint),
  );
  for (const { file, fingerprint, count, ...identity } of ordered) {
    const key = relocationKey(identity);
    const credit = { source: file, fingerprint, count };
    baselinedCredit.set(key, [...(baselinedCredit.get(key) ?? []), credit]);
  }
  const { relocated } = classifyRelocations(errors, baselinedCredit);
  const matched = relocated.reduce((sum, group) => sum + group.relocatedCount, 0);
  if (matched === 0) return [];
  const sources = relocated.flatMap((group) => group.from.map((credit) => credit.source));
  const stage = overlay ? '' : `, then stage ${ANTI_SLOP_BASELINE_REL}`;
  return [
    `anti-slop: ${matched} of these finding(s) are identical (rule and source line) to debt already baselined in ${formatSources(sources)}. If you moved this code from there, do not rewrite it: delete it there, git add both files, run \`${relocationRemedy(baseRef)}\`${stage}. New or copied code is not a move: fix it as below`,
  ];
}

/** Everything a new-finding FAIL prints after its verdict line: the move route, then the hints. */
export function antiSlopFailRemedy(
  errors: readonly NewErrorGroup[],
  baseline: AntiSlopBaseline,
  overlay: boolean,
  baseRef?: string,
): string[] {
  return [
    ...relocationHint(errors, baseline, overlay, baseRef),
    ...antiSlopRemedyLines(
      errors.map((group) => group.ruleId),
      overlay,
    ),
  ];
}
