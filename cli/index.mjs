#!/usr/bin/env node
/**
 * devkit CLI — wire a consumer repo onto the @norvalbv/devkit shared configs +
 * gate-engine, sync agent skills, and diagnose drift.
 *
 *   devkit init [--stack <x>] [--scan-root <a,b>] [--fallow] [--yes] [--dry-run] [--force]
 *   devkit doctor [--fix]
 *   devkit sync-skills [--dry-run]
 *   devkit --help
 *
 * Plain .mjs, no build — `what you install is what runs` (devkit ships no dist/).
 */

const HELP = `devkit — wire a repo onto @norvalbv/devkit's shared configs + gate-engine.

Usage:
  devkit init [options]      Interactive SETUP WIZARD (on a TTY) to SELECT which components
                             to install — biome, tsconfig, skills, husky, guards, structure —
                             and to REMOVE a deselected one on a later run. Idempotent.
    --stack <x>              electron | react-app | next | node-service | generic
                             (default: auto-detect; structure preset ships for electron + react-app)
    --yes                    Non-interactive: all recommended defaults (no prompts).
    --dry-run                Print every file action; write nothing.
    --force                  Overwrite existing devkit-managed files.
    --no-<component>         Skip a component: --no-biome --no-tsconfig --no-skills
                             --no-husky --no-structure --no-guards --no-fallow.
    --guards <a,b,…>         Only these guards (subset of size,fanout,dup,clone,decisions).
    --fallow                 Also install the optional fallow code-health layer (off by default).
    --scan-root <a,b,…>      Override guard.config.json scanRoots up front (set BEFORE the
                             freezes) — e.g. --scan-root services/webapp/src for a nested app.
    --remove-deselected      With --yes: REMOVE any installed-but-now-deselected component
                             (default off — removal is opt-in / non-destructive).

  devkit doctor [--fix]      Diagnose drift for the INSTALLED component set (read-only).
                             --fix re-runs init for the recorded selection.
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
