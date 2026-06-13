#!/usr/bin/env node
// Size-debt ratchet: the inline `eslint-disable max-lines` / `max-lines-per-function`
// directives are the ONLY way a file escapes the project's line/function caps. A NEW
// oversized file would need such a disable — so we freeze the current disable counts
// and refuse to let them GROW. Existing giants are grandfathered; the count can only
// shrink (split a file, delete its disable).
//
// This is the mechanism that makes another 5k-LOC monolith un-birthable: max-lines is
// already enforced at commit, so without a new disable a fresh oversized file fails
// lint — and this gate blocks the new disable.
//
//   bunx guard-size freeze   # re-count + write the consumer's baseline
//   bunx guard-size gate     # fail if counts grew (pre-commit)
//
// PARAMETERIZED (W-3): scanRoots come from resolveGuardConfig(cwd) — the CONSUMER's
// guard.config.json + GUARD_* env, never hardcoded. The baseline
// (eslint/baselines/size.json) is per-repo STATE: read/written under the CONSUMER cwd,
// never the package dir. Per the "never hard-code a count" rule, freeze re-walks the
// tree and writes whatever it finds — never a literal.

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
const BASELINE = 'eslint/baselines/size.json';
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', '__snapshots__', '_shared']);
const IS_SOURCE = /\.(ts|tsx)$/;
const IS_TEST = /\.(test|spec)\.(ts|tsx)$/;
// Only an actual directive comment counts — a line that merely MENTIONS the phrase
// (string literal, prose comment) must not inflate the ratchet and falsely block.
const DIRECTIVE_START = /^\s*(?:\/\/|\/\*)\s*eslint-disable/;

function walk(root, dir, files) {
  let entries;
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return files;
  }
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(root, rel, files);
    } else if (IS_SOURCE.test(e.name) && !IS_TEST.test(e.name)) {
      files.push(rel);
    }
  }
  return files;
}

// Count disable directives, distinguishing the file-level `max-lines` rule from
// `max-lines-per-function` (the former is a substring of the latter). `scanRoots`
// is passed explicitly so callers share one path; defaults off cfg(root).
export function countDisables(root = process.cwd(), scanRoots) {
  const rootsToScan = scanRoots ?? resolveGuardConfig(root).scanRoots;
  const files = rootsToScan.flatMap((r) => walk(root, r, []));
  let fileDisables = 0;
  let fnDisables = 0;
  for (const f of files) {
    const text = readFileSync(join(root, f), 'utf8');
    for (const line of text.split('\n')) {
      if (!DIRECTIVE_START.test(line)) continue;
      const fn = (line.match(/max-lines-per-function/g) || []).length;
      const file = (line.replace(/max-lines-per-function/g, '').match(/max-lines\b/g) || []).length;
      fnDisables += fn;
      fileDisables += file;
    }
  }
  return { fileDisables, fnDisables, scannedFiles: files.length };
}

function runCli(cmd) {
  const root = process.cwd();
  const baselineFile = join(root, BASELINE);
  const current = countDisables(root);

  if (cmd === 'freeze') {
    const out = { fileDisables: current.fileDisables, fnDisables: current.fnDisables };
    mkdirSync(dirname(baselineFile), { recursive: true });
    writeFileSync(baselineFile, `${JSON.stringify(out, null, 2)}\n`);
    console.log(
      `✓ ${BASELINE}: frozen max-lines disables = ${out.fileDisables} file-level, ${out.fnDisables} per-function (from ${current.scannedFiles} source files)`,
    );
    process.exit(0);
  }

  if (cmd === 'gate') {
    if (!existsSync(baselineFile)) {
      console.error(`size-ratchet: ${BASELINE} missing — run \`guard-size freeze\` first.`);
      process.exit(2); // fail-open: don't block commits before the baseline exists
    }
    const frozen = JSON.parse(readFileSync(baselineFile, 'utf8'));
    const grewFile = current.fileDisables > frozen.fileDisables;
    const grewFn = current.fnDisables > frozen.fnDisables;
    if (grewFile || grewFn) {
      console.error('🚫 New `eslint-disable max-lines` directive(s) — size debt may only SHRINK.');
      if (grewFile)
        console.error(
          `   file-level: ${current.fileDisables} now vs ${frozen.fileDisables} allowed`,
        );
      if (grewFn)
        console.error(`   per-function: ${current.fnDisables} now vs ${frozen.fnDisables} allowed`);
      console.error('   Split the file below the cap instead of disabling.');
      process.exit(1);
    }
    // Counts dropped → remind to re-freeze so the ratchet tightens.
    if (current.fileDisables < frozen.fileDisables || current.fnDisables < frozen.fnDisables) {
      console.log(
        `✓ size debt shrank (${current.fileDisables}/${current.fnDisables} vs frozen ${frozen.fileDisables}/${frozen.fnDisables}) — run \`guard-size freeze\` to lock it in.`,
      );
    }
    process.exit(0);
  }

  console.error('usage: guard-size <freeze|gate>');
  process.exit(2);
}

// Run as a CLI only when invoked directly; importing this module (tests) has no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  runCli(process.argv[2]);
}
