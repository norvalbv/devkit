#!/usr/bin/env node
// @ts-nocheck — BENCH-ONLY (excluded from tsc, see tsconfig.json exclude); loose types deliberate.

/**
 * mine-ghsa — sweep GitHub Security Advisories (npm ecosystem) into KNOWN-ANSWER candidates for
 * the security suites. This is the ratified replacement (sc-1408) for the falsified
 * c-CRAB/CR-Bench TS/JS import (#307): advisories with fix commits are public known-answer
 * facts — the commit's parent tree is a confirmed-vulnerable state and the commit is the
 * confirmed fix — giving the security corpora their first ABSOLUTE-recall anchor (methodology
 * item 17: mined golds measure only precision + relative recall).
 *
 *   bun mine-ghsa.mts [--pages N] [--severity high,critical]   (defaults: 5 pages, high+critical)
 *
 * Keeps only advisories carrying at least one /commit/ reference (the known-answer anchor).
 * Output: raw/candidates-ghsa.jsonl (gitignored), merged by ghsa url (new wins) — same contract
 * as the other miners. Fixture authorship happens downstream (propose/propose-ghsa.mts →
 * anonymized adapt session); nothing here writes corpus rows. SecBench.js is deliberately NOT
 * read (unlicensed — usable as an index only, per #307); the advisory API is the source of truth.
 *
 * Read-only against GitHub (gh api). Facts (CVE ids, versions, commit shas) are not
 * copyrightable; prose summaries are capped and never reach the public corpus verbatim — the
 * adapt stage re-expresses everything as generic-identifier fixtures like every other row.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonl } from './propose/propose-common.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const RAW_DIR = path.join(here, 'raw');
const OUT = path.join(RAW_DIR, 'candidates-ghsa.jsonl');
const SUMMARY_CAP = 2000;
const COMMIT_REF_RE = /\/commit\/([0-9a-f]{7,40})/;
// GitHub Link header: `<...&after=CURSOR>; rel="next"` — cursor pagination for /advisories.
const LINK_NEXT_RE = /<[^>]*[?&]after=([^&>]+)[^>]*>;\s*rel="next"/;

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function parseArgs(argv) {
  const pagesIdx = argv.indexOf('--pages');
  const pages = pagesIdx !== -1 ? Number.parseInt(argv[pagesIdx + 1], 10) : 5;
  const sevIdx = argv.indexOf('--severity');
  const severities = (sevIdx !== -1 ? argv[sevIdx + 1] : 'high,critical').split(',');
  return { pages, severities };
}

function fetchAdvisories(pages, severity) {
  const rows = [];
  let cursor = null;
  for (let page = 0; page < pages; page += 1) {
    const after = cursor ? `&after=${encodeURIComponent(cursor)}` : '';
    const raw = gh([
      'api',
      '-i',
      `/advisories?ecosystem=npm&severity=${severity}&per_page=100${after}`,
    ]);
    const [head, body] = [
      raw.slice(0, raw.indexOf('\r\n\r\n')),
      raw.slice(raw.indexOf('\r\n\r\n')),
    ];
    rows.push(...JSON.parse(body));
    const next = LINK_NEXT_RE.exec(head);
    if (!next) break;
    cursor = decodeURIComponent(next[1]);
  }
  return rows;
}

function main() {
  const { pages, severities } = parseArgs(process.argv.slice(2));
  const merged = new Map();
  if (existsSync(OUT)) for (const row of readJsonl(OUT)) merged.set(row.url, row);

  let seen = 0;
  let anchored = 0;
  for (const severity of severities) {
    for (const a of fetchAdvisories(pages, severity)) {
      seen += 1;
      const fixCommits = (a.references ?? []).filter((r) => COMMIT_REF_RE.test(r));
      if (fixCommits.length === 0) continue; // no known-answer anchor — skip
      anchored += 1;
      // Multi-ecosystem advisories (e.g. GHSA-85rg-p3fr-xc2f: maven+pip+npm) order entries
      // arbitrarily — take the npm entry specifically, or the package/version fields describe
      // the wrong ecosystem's artifact.
      const vuln = (a.vulnerabilities ?? []).find((v) => v?.package?.ecosystem === 'npm') ?? {};
      merged.set(a.html_url, {
        kind: 'ghsa',
        url: a.html_url,
        ghsaId: a.ghsa_id,
        cveId: a.cve_id ?? null,
        severity: a.severity,
        cwes: a.cwe_ids ?? [],
        package: vuln.package?.name ?? null,
        vulnerableRange: vuln.vulnerable_version_range ?? null,
        firstPatched: vuln.first_patched_version ?? null,
        publishedAt: a.published_at,
        summary: String(a.summary ?? '').slice(0, SUMMARY_CAP),
        description: String(a.description ?? '').slice(0, SUMMARY_CAP),
        fixCommits,
      });
    }
  }

  mkdirSync(RAW_DIR, { recursive: true });
  const rows = [...merged.values()];
  const tmp = `${OUT}.tmp`;
  writeFileSync(tmp, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  renameSync(tmp, OUT);
  console.error(
    `mine-ghsa: ${seen} advisories swept → ${anchored} with fix-commit anchors this run → ${rows.length} total in ${path.relative(here, OUT)}`,
  );
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
