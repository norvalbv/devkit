#!/usr/bin/env node
/**
 * Verify that a node_modules candidate contains every root dependency the ship base declares.
 *
 * Package-manager lockfiles do not expose a portable "this install matches me" marker. The failure
 * this closes is narrower and deterministic: a base commit adds a direct runtime/dev dependency,
 * ship reuses an older populated install, and a later gate dies with ERR_MODULE_NOT_FOUND.
 *
 * Usage: dependency-preflight.mjs <package.json> <node_modules>
 * Missing packages are emitted one per line and exit 1. An unreadable/unsafe manifest exits 2.
 * `dependency-preflight.mjs --remedy <dir>` prints the frozen install command for `dir` and exits 0.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  dependencyInstallRemedy,
  missingDeclaredDependencies,
} from '../../../gate-engine/coverage/dependencies.mts';

function run(args: string[]): number {
  if (args.length !== 2) {
    throw new Error('usage: dependency-preflight <package.json> <node_modules> | --remedy <dir>');
  }
  if (args[0] === '--remedy') {
    process.stdout.write(`${dependencyInstallRemedy(args[1] as string)}\n`);
    return 0;
  }
  const [manifestPath, nodeModulesPath] = args as [string, string];
  const missing = missingDeclaredDependencies(manifestPath, nodeModulesPath);
  if (missing.length === 0) return 0;
  process.stdout.write(`${missing.join('\n')}\n`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `devkit ship: dependency preflight failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
