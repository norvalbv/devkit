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
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface PackageManifest {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

function safePackageParts(name: string): string[] {
  const parts = name.split('/');
  const validPart = (part: string): boolean =>
    part.length > 0 && part !== '.' && part !== '..' && !part.includes('\\');
  const valid =
    (parts.length === 1 && !name.startsWith('@') && validPart(parts[0] as string)) ||
    (parts.length === 2 &&
      (parts[0] as string).startsWith('@') &&
      (parts[0] as string).length > 1 &&
      parts.every(validPart));
  if (!valid) throw new Error(`invalid dependency name in package.json: ${JSON.stringify(name)}`);
  return parts;
}

function declaredDependencies(manifest: PackageManifest): string[] {
  const names = new Set<string>();
  for (const section of [manifest.dependencies, manifest.devDependencies]) {
    if (section === undefined) continue;
    if (section === null || typeof section !== 'object' || Array.isArray(section)) {
      throw new Error('dependencies and devDependencies must be objects');
    }
    for (const name of Object.keys(section)) {
      safePackageParts(name);
      names.add(name);
    }
  }
  return [...names].sort();
}

function run(args: string[]): number {
  if (args.length !== 2) {
    throw new Error('usage: dependency-preflight <package.json> <node_modules>');
  }
  const [manifestPath, nodeModulesPath] = args as [string, string];
  if (!existsSync(manifestPath)) return 0;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest;
  const missing = declaredDependencies(manifest).filter(
    (name) => !existsSync(join(nodeModulesPath, ...safePackageParts(name), 'package.json')),
  );
  if (missing.length === 0) return 0;
  process.stdout.write(`${missing.join('\n')}\n`);
  return 1;
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `devkit ship: dependency preflight failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}
