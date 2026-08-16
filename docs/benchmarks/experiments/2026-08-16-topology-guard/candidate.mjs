#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveGuardConfig, resolveTreeExtensions } from "../../../../gate-engine/config.mts";
import { makeBaselineLoaders } from "../../../../gate-engine/structure/load-baseline.mts";
import { walkTree } from "../../../../gate-engine/structure/walk.mts";

export async function runCandidate(cwd = process.cwd()) {
  try {
    const config = resolveGuardConfig(cwd);
    const loaders = makeBaselineLoaders(cwd);
    const diagnostics = [];
    for (const tree of config.structure?.trees ?? []) {
      if (!tree.grammar || !tree.root || !tree.name) continue;
      const absoluteRoot = join(cwd, tree.root);
      if (!existsSync(absoluteRoot)) continue;
      const ignored = new Set([
        ...(await loaders.loadBaseline(tree.name)),
        ...(await loaders.loadExempt(tree.name)),
      ]);
      const extensions = resolveTreeExtensions(config, tree);
      for (const relativePath of walkTree(tree, absoluteRoot, extensions)) {
        if (!ignored.has(relativePath)) {
          diagnostics.push({ tree: tree.name, path: `${tree.root}/${relativePath}` });
        }
      }
    }
    return { code: diagnostics.length > 0 ? 1 : 0, diagnostics };
  } catch (error) {
    return {
      code: 2,
      diagnostics: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runCandidate();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result));
  } else if (!process.argv.includes("--bench")) {
    for (const diagnostic of result.diagnostics) {
      console.error(`${diagnostic.path}: topology violation`);
    }
    if (result.error) console.error(`guard-topology candidate: ${result.error}`);
  }
  process.exit(
    process.argv.includes("--json") || process.argv.includes("--bench") ? 0 : result.code,
  );
}
