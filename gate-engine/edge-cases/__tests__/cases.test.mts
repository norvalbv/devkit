/**
 * Permanent gate over the committed edge-cases corpus (eval/cases.jsonl): every row parses,
 * schema-validates, carries zero secret-pattern leaks and zero machine paths, live-bug/noise
 * labels are human-reviewed, and code excerpts only appear for allowlisted (owned) repos.
 *
 * Shares PATTERNS/validators with the pipeline (lib/scrub.mts, lib/schema.mts) so the gate and
 * the scrubber cannot drift. Runs under vitest/node — it must never import bun:sqlite (that lives
 * only in lib/sources.mts). Known limit (see eval/README.md): pattern checks catch modeled secret
 * shapes, not novel ones — the repo allowlist and PR review cover the rest.
 *
 * The suite skips when cases.jsonl is absent: the corpus data may live in a private repo while
 * this tooling ships publicly.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXCERPT_ALLOWLIST, validateCase } from '../eval/lib/schema.mts';
import { findLeaks } from '../eval/lib/scrub.mts';

// EDGE_CASES_CORPUS lets CI (or a checkout holding the canonical private copy) point the gate at
// the real corpus; the local gitignored working copy is the fallback.
const casesPath =
  process.env.EDGE_CASES_CORPUS ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'eval', 'cases.jsonl');

const present = existsSync(casesPath);

describe.skipIf(!present)('edge-cases corpus (cases.jsonl)', () => {
  // the suite callback runs at collection even when skipIf skips its tests — guard the read
  const lines = present ? readFileSync(casesPath, 'utf8').split('\n').filter(Boolean) : [];
  const cases = lines.map((l) => JSON.parse(l));

  it('has at least 10 labeled cases (sc-1118 acceptance floor)', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  it('every row schema-validates', () => {
    const errors = cases.flatMap((c) => validateCase(c));
    expect(errors).toEqual([]);
  });

  it('carries no secret-pattern leaks and no machine paths', () => {
    // scan DECODED values (re-serialized), not raw lines — /-style JSON escapes must not
    // hide a machine path or token from the patterns
    const leaks = cases.flatMap((c, i) =>
      findLeaks(JSON.stringify(c)).map((k) => `line ${i + 1}: ${k}`),
    );
    expect(leaks).toEqual([]);
  });

  it('live-bug and noise labels are human-reviewed', () => {
    const unreviewed = cases.flatMap((c) =>
      c.findings
        .filter(
          (f) =>
            (String(f.wasLiveBug) === 'true' || f.verdict === 'noise') &&
            f.evidence?.reviewed !== true,
        )
        .map((f) => `${c.id}#${f.idx}`),
    );
    expect(unreviewed).toEqual([]);
  });

  it('code excerpts only for allowlisted repos', () => {
    const offenders = cases
      .filter((c) => c.anchor.diffExcerpt && !EXCERPT_ALLOWLIST.includes(c.repo))
      .map((c) => c.id);
    expect(offenders).toEqual([]);
  });
});
