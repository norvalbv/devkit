#!/usr/bin/env node
// Structure-lint gate — folder-structure enforcement run entirely from DEVKIT's own install, so a
// consumer needs NO eslint / eslint-plugin-project-structure / parser in their package.json (the
// point of the zero-consumer-dependency model). `buildStructureConfigs(cwd)` reads the CONSUMER's
// guard.config.json `structure` block + baselines and returns a runnable eslint flat-config that
// embeds the plugin as a LOADED OBJECT — so ESLint never resolves the plugin from the consumer.
//
//   guard-structure gate   # lint the declared structure roots (pre-commit); default subcommand
//
// PARAMETERIZED (W-3): the trees / roots / grammar / baselines all come from resolveGuardConfig(cwd)
// — the consumer's guard.config.json under the consumer cwd, never the package dir. Grandfathering is
// NOT done here: the baselines are frozen by `devkit init` (runStructureBaselines), same as the
// ratchets. Config-driven only — buildStructureConfigs skips electron preset trees (no `grammar`).
//
// Exit contract (matches __dk_gate / the ratchet gates): 0 clean, 1 violations, 2 fail-open.

import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ESLint } from 'eslint'; // devkit's OWN eslint (now a dependency), never the consumer's
import { resolveGuardConfig } from '../config.mjs';
import { buildStructureConfigs } from './eslint-config.mjs';

// ESLint throws "No files matching the pattern" for an absent tree and "…are ignored" when every file
// in a present tree is ignored — both mean "nothing to lint" (clean), not a failure. Hoisted (perf).
const NOTHING_TO_LINT_RE = /No files matching|are ignored/i;

/**
 * Run the folder-structure gate over a repo's declared structure roots.
 * @param {string} cwd consumer root (holds guard.config.json + eslint/baselines/)
 * @returns {Promise<{ code: 0|1|2, errorCount: number, text?: string }>}
 *   code 0 = clean / nothing to lint, 1 = violations, 2 = fail-open (internal error).
 */
export async function runStructureGate(cwd = process.cwd()) {
  try {
    const cfg = resolveGuardConfig(cwd);
    // Lint only roots that EXIST on disk. Passing an absent root to ESLint throws "No files matching"
    // for the WHOLE call — which would mask a real violation in a sibling root. Filtering keeps each
    // present root enforced regardless of whether another declared root has been created yet.
    const roots = (cfg.structure?.trees ?? [])
      .map((t) => t.root)
      .filter((r) => r && existsSync(join(cwd, r)));
    // Nothing declared / nothing present (generic guard.config, electron-only preset, empty tree).
    if (!roots.length) return { code: 0, errorCount: 0 };
    const baseConfig = await buildStructureConfigs(cwd);
    if (!baseConfig.length) return { code: 0, errorCount: 0 }; // no grammar trees (preset-only)

    const eslint = new ESLint({ cwd, overrideConfigFile: true, baseConfig });
    let results;
    try {
      results = await eslint.lintFiles(roots);
    } catch (e) {
      // Nothing-to-lint throws are clean, not a failure. Any other lint-time throw falls through to
      // the fail-open catch below.
      if (NOTHING_TO_LINT_RE.test(e?.message ?? '')) return { code: 0, errorCount: 0 };
      throw e;
    }
    const errorCount = results.reduce((n, r) => n + r.errorCount, 0);
    if (errorCount === 0) return { code: 0, errorCount: 0 };
    const text = await (await eslint.loadFormatter('stylish')).format(results);
    return { code: 1, errorCount, text };
  } catch (e) {
    // Fail OPEN (exit 2), like the ratchet gates when their baseline is missing — a structure gate
    // that can't run must never wedge a commit. __dk_gate treats 2 as pass.
    return { code: 2, errorCount: 0, text: `guard-structure: ${e?.message ?? e}` };
  }
}

export async function runCli(cmd = 'gate') {
  if (cmd !== 'gate') {
    console.error('usage: guard-structure gate');
    process.exit(2);
  }
  const { code, text } = await runStructureGate(process.cwd());
  if (code === 1) {
    if (text) console.error(text);
    console.error(
      '🚫 Structure violations (folder-structure). Rename/relocate the file(s) to match the declared grammar, or (if intentional) re-grandfather via `devkit init`.',
    );
  } else if (code === 2 && text) {
    console.error(text); // fail-open notice on stderr; still exits 2 (pass)
  }
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  runCli(process.argv[2]);
}
