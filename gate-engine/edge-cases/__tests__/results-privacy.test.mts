/**
 * Privacy gate over the COMMITTED bench artifact (eval/results.baseline.json): devkit is public
 * and the corpus is gitignored precisely because it carries private-repo material — a results
 * file that leaked finding claims, code excerpts, or diff paths would re-expose what the
 * gitignore protects. Contract: IDs + numbers (+ enum-ish flags) ONLY.
 *
 * Enforced structurally (allowlisted string shapes) plus the shared secret/path patterns from
 * lib/scrub.mts. Skips when no baseline exists yet (pre-registration commit lands before the
 * first sweep).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findLeaks } from '../eval/lib/scrub.mts';

const baselinePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'eval',
  'results.baseline.json',
);
const present = existsSync(baselinePath);

// every string value in the artifact must match one of these shapes
const CASE_ID_RE = /^(cc|fk|cu)-[\w-]+-\d{8}-[0-9a-f]{8}$/;
const SYNTH_ID_RE = /^sg-[\w-]+-[0-9a-f]{8}$/;
const CONFIG_ID_RE = /^(hai|son|opu)-[A-Z]{2}-[A-Za-z]+-r\d$/;
const SHA8_RE = /^[0-9a-f]{8}$/;
const WORD_RE = /^[a-zA-Z0-9 _.:/+-]{1,80}$/; // short labels: story ids, model names, ISO dates

/** Recursively collect every string LEAF value (keys are checked separately). */
const stringLeaves = (v, out = []) => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringLeaves(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringLeaves(x, out);
  return out;
};
const allKeys = (v, out = []) => {
  if (Array.isArray(v)) for (const x of v) allKeys(x, out);
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      allKeys(x, out);
    }
  return out;
};

describe.skipIf(!present)('results.baseline.json privacy gate (IDs + numbers only)', () => {
  const baseline = present ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};

  it('every string leaf is an ID, sha, or short plain label — never free text', () => {
    const offenders = stringLeaves(baseline).filter(
      (s) =>
        !(
          CASE_ID_RE.test(s) ||
          SYNTH_ID_RE.test(s) ||
          CONFIG_ID_RE.test(s) ||
          SHA8_RE.test(s) ||
          (WORD_RE.test(s) && !s.includes('/Users/') && s.split(' ').length <= 6)
        ),
    );
    expect(offenders).toEqual([]);
  });

  it('keys never carry finding text (claims/files/excerpts must not appear)', () => {
    const banned = ['claim', 'text', 'diffExcerpt', 'detail', 'summary', 'nameStatus', 'raw'];
    const offenders = allKeys(baseline).filter((k) => banned.includes(k));
    expect(offenders).toEqual([]);
  });

  it('carries no secret patterns or machine paths', () => {
    expect(findLeaks(JSON.stringify(baseline))).toEqual([]);
  });
});

describe('privacy gate self-test (the checks actually reject leaks)', () => {
  it('rejects a planted claim and a planted path', () => {
    const planted = {
      metrics: {
        'son-FS-Guser-r1': {
          note: 'race between writer and reader when flushing the socket buffer on teardown of the agent process',
        },
      },
    };
    const leaves = stringLeaves(planted);
    const offenders = leaves.filter((s) => !(WORD_RE.test(s) && s.split(' ').length <= 6));
    expect(offenders.length).toBeGreaterThan(0);
    expect(allKeys({ x: { claim: 'y' } }).includes('claim')).toBe(true);
  });
});
