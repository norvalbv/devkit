#!/usr/bin/env node
/**
 * devkit CLI — wire a consumer repo onto the @norvalbv/devkit shared configs +
 * gate-engine, sync agent skills, and diagnose drift.
 *
 *   devkit init [--stack <x>] [--yes] [--dry-run] [--force]
 *   devkit doctor [--fix]
 *   devkit sync-skills [--dry-run]
 *   devkit --help
 *
 * Plain .mjs, no build — `what you install is what runs` (devkit ships no dist/).
 */

const HELP = `devkit — wire a repo onto @norvalbv/devkit's shared configs + gate-engine.

Usage:
  devkit init [options]      Scaffold guard.config.json, biome/tsconfig, husky gates,
                             skills, and .devkit/config.json (idempotent, create-if-absent).
    --stack <x>              electron | next | node-service | generic (default: auto-detect)
    --yes                    Assume yes (no prompts).
    --dry-run                Print every file action + diff; write nothing.
    --force                  Overwrite existing devkit-managed files.

  devkit doctor [--fix]      Diagnose drift (read-only). --fix re-runs idempotent steps.
  devkit sync-skills [--dry-run]  Copy devkit skills into .claude/skills + .cursor/skills.
  devkit --help              This help.`;

const COMMANDS = {
  init: () => import('./commands/init.mjs'),
  doctor: () => import('./commands/doctor.mjs'),
  'sync-skills': () => import('./commands/sync-skills.mjs'),
};

async function main() {
  const cmd = process.argv[2];

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(HELP);
    process.exit(0);
  }

  const loader = COMMANDS[cmd];
  if (!loader) {
    console.error(`devkit: unknown command "${cmd}"\n`);
    console.log(HELP);
    process.exit(1);
  }

  const mod = await loader();
  const code = await mod.default(process.argv.slice(3), process.cwd());
  process.exit(code ?? 0);
}

main().catch((e) => {
  console.error(`devkit: ${e.message}`);
  process.exit(1);
});
