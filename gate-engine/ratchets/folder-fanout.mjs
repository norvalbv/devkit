#!/usr/bin/env node
// Folder fan-out ratchet: no directory may hold more than `fanoutCap` non-test
// implementation files — at ANY depth (the recursive complement to a lib/ domain
// registry, which only governs level 1). A folder that hits the cap must be split
// into cohesive kebab subfolders; flat piles can grow no further, and new folders
// must be born organized.
//
// Threshold precedent (research, 2026-06): Angular's LIFT guide splits at 7 files;
// steiger (the FSD linter — the only count-based structure linter found) uses 15/20.
// No off-the-shelf tool enforces this recursively with a brownfield baseline, hence
// this script. The default cap (12) sits mid-range; tune via guard.config.json.
//
//   bunx guard-fanout freeze   # re-count + write the consumer's baseline
//   bunx guard-fanout gate     # fail on growth (pre-commit)
//
// PARAMETERIZED (W-3): scanRoots / fanoutCap / fanoutExempt come from
// resolveGuardConfig(cwd) — the CONSUMER's guard.config.json + GUARD_* env, never
// hardcoded. The baseline (eslint/baselines/fanout.json) is per-repo STATE: it is
// read/written under the CONSUMER cwd, never the package dir.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveGuardConfig } from '../config.mjs';

// Per-repo STATE, resolved against the consumer cwd (never __dirname).
const BASELINE = 'eslint/baselines/fanout.json';
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', '__snapshots__', '__tests__', '_shared']);
const IS_SOURCE = /\.(ts|tsx)$/;
const IS_TEST = /\.(test|spec)\.(ts|tsx)$/;
// Barrels don't add to a pile's cognitive load; everything else does.
const IS_BARREL = /^index\.(ts|tsx)$/;

// Returns { '<dir>': <impl-file count> } for every scanned directory under `root`,
// honouring the consumer's scanRoots + fanoutExempt. `scanRoots`/`exempt` are passed
// explicitly so callers (tests, gate) share one code path; both default off cfg(root).
export function countFanout(root = process.cwd(), scanRoots, exempt) {
  const cfg = resolveGuardConfig(root);
  const rootsToScan = scanRoots ?? cfg.scanRoots;
  const exemptSet = new Set(exempt ?? cfg.fanoutExempt);
  const counts = {};
  // Reason: recursive directory walk: one branch per entry kind (subdir recurse vs impl/test/barrel file count) mirrors the filesystem tree; flattening scatters a single traversal
  // fallow-ignore-next-line complexity
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    let n = 0;
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(`${dir}/${e.name}`);
      } else if (IS_SOURCE.test(e.name) && !IS_TEST.test(e.name) && !IS_BARREL.test(e.name)) {
        n += 1;
      }
    }
    if (n > 0 && !exemptSet.has(dir)) counts[dir] = n;
  };
  for (const r of rootsToScan) walk(r);
  return counts;
}

export function overCap(counts, cap) {
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > cap));
}

function runCli(cmd) {
  const root = process.cwd();
  const cfg = resolveGuardConfig(root);
  const cap = cfg.fanoutCap;
  const baselineFile = join(root, BASELINE);
  const offenders = overCap(countFanout(root), cap);

  if (cmd === 'freeze') {
    const out = { cap, dirs: offenders };
    mkdirSync(dirname(baselineFile), { recursive: true });
    writeFileSync(baselineFile, `${JSON.stringify(out, null, 2)}\n`);
    console.log(
      `✓ ${BASELINE}: cap ${cap}, ${Object.keys(offenders).length} over-cap folder(s) grandfathered (shrink-only)`,
    );
    process.exit(0);
  }

  // Reason: the two ratchets (folder-fanout / size-disable) are parallel-by-design independent guard bins (+ tests); each self-contained with the same freeze/gate CLI shell
  // fallow-ignore-next-line code-duplication
  if (cmd === 'gate') {
    if (!existsSync(baselineFile)) {
      console.error(`fanout-ratchet: ${BASELINE} missing — run \`guard-fanout freeze\` first.`);
      process.exit(2); // fail-open before the baseline exists
    }
    const frozen = JSON.parse(readFileSync(baselineFile, 'utf8'));
    const grew = Object.entries(offenders).filter(
      ([dir, n]) => n > Math.max(frozen.cap, frozen.dirs[dir] ?? 0),
    );
    if (grew.length > 0) {
      console.error(`🚫 Folder fan-out exceeded (cap ${frozen.cap} impl files/folder, any depth):`);
      for (const [dir, n] of grew) {
        const allowed = Math.max(frozen.cap, frozen.dirs[dir] ?? 0);
        console.error(`   ${dir}: ${n} files (allowed ${allowed})`);
      }
      console.error(
        '   Split into cohesive kebab subfolders (group by concern — graphify/co-occurrence can suggest clusters).',
      );
      process.exit(1);
    }
    const shrank = Object.entries(frozen.dirs).filter(([dir, n]) => (offenders[dir] ?? 0) < n);
    if (shrank.length > 0) {
      console.log(
        `✓ fan-out debt shrank in ${shrank.length} folder(s) — run \`guard-fanout freeze\` to lock it in.`,
      );
    }
    process.exit(0);
  }

  console.error('usage: guard-fanout <freeze|gate>');
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  runCli(process.argv[2]);
}
