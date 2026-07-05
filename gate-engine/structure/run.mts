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
// Exit contract (the shared gate trichotomy guard-deterministic applies): 0 clean, 1 violations,
// 2 fail-open (could-not-run).

import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ESLint } from 'eslint'; // devkit's OWN eslint (now a dependency), never the consumer's
import { resolveGuardConfig } from '../config.mts';
import { buildStructureConfigs } from './eslint-config.mts';

// The one field this gate reads off each structure.trees[] entry — its on-disk root.
interface StructureTree {
  root?: string;
}

// Outcome of the folder-structure gate: 0 clean / nothing to lint, 1 violations, 2 fail-open.
interface StructureGateResult {
  code: 0 | 1 | 2;
  errorCount: number;
  text?: string;
}

// ESLint throws "No files matching the pattern" for an absent tree and "…are ignored" when every file
// in a present tree is ignored — both mean "nothing to lint" (clean), not a failure. Hoisted (perf).
const NOTHING_TO_LINT_RE = /No files matching|are ignored/i;

/**
 * Run the folder-structure gate over a repo's declared structure roots. `cwd` is the consumer root
 * (holds guard.config.json + eslint/baselines/). Result code: 0 = clean / nothing to lint,
 * 1 = violations, 2 = fail-open (internal error).
 */
export async function runStructureGate(cwd = process.cwd()): Promise<StructureGateResult> {
  try {
    const cfg = resolveGuardConfig(cwd);
    // Lint only roots that EXIST on disk (an absent root has nothing to enforce yet).
    const trees: StructureTree[] = cfg.structure?.trees ?? [];
    const roots = trees
      .map((t) => t.root)
      .filter((r): r is string => (r ? existsSync(join(cwd, r)) : false));
    // Nothing declared / nothing present (generic guard.config, electron-only preset, empty tree).
    if (!roots.length) return { code: 0, errorCount: 0 };
    const baseConfig = await buildStructureConfigs(cwd);
    if (!baseConfig.length) return { code: 0, errorCount: 0 }; // no grammar trees (preset-only)

    const eslint = new ESLint({ cwd, overrideConfigFile: true, baseConfig });
    // Lint each root INDEPENDENTLY. ESLint 10's lintFiles fail-fasts on the FIRST unmatched/all-ignored
    // pattern, so a single ignored/empty root in a batched `lintFiles(roots)` would throw and mask a
    // violation in a sibling root. Per-root: a root that's all-ignored / matches nothing is that root's
    // own "clean" (skip it), while other roots still get enforced.
    const allResults = [];
    for (const root of roots) {
      try {
        allResults.push(...(await eslint.lintFiles([root])));
      } catch (e: unknown) {
        // Nothing-to-lint for THIS root → clean; any other throw is a real failure → fail-open below.
        const message = e instanceof Error ? e.message : '';
        if (NOTHING_TO_LINT_RE.test(message)) continue;
        throw e;
      }
    }
    const errorCount = allResults.reduce((n, r) => n + r.errorCount, 0);
    if (errorCount === 0) return { code: 0, errorCount: 0 };
    const text = await (await eslint.loadFormatter('stylish')).format(allResults);
    return { code: 1, errorCount, text };
  } catch (e: unknown) {
    // Fail OPEN (exit 2), like the ratchet gates when their baseline is missing — a structure gate
    // that can't run must never wedge a commit. guard-deterministic treats 2 as fail-open (continue).
    const message = e instanceof Error ? e.message : String(e);
    return { code: 2, errorCount: 0, text: `guard-structure: ${message}` };
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
