#!/usr/bin/env node
/**
 * devkit CLI — wire a consumer repo onto the @norvalbv/devkit shared configs +
 * gate-engine, sync agent skills, and diagnose drift.
 *
 *   devkit init [--stack <x>] [--standalone | --overlay] [--scan-root <a,b>] [--fallow] [--yes]
 *   devkit doctor [--fix]
 *   devkit sync-skills [--dry-run]
 *   devkit release [patch|minor|major|<x.y.z>] [--dry-run] [--yes]   (maintainer-only)
 *   devkit --version
 *   devkit --help
 *
 * Plain .mjs, no build — `what you install is what runs` (devkit ships no dist/).
 */
import { readFileSync } from 'node:fs';
import { assertGit } from './lib/guard/require-git.mjs';
import { renderCommandHelp, renderTopLevelHelp } from './lib/help/render.mjs';

/** devkit's own version, read from the package it ships in (always accurate). */
function devkitVersion() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}

const COMMANDS = {
  init: () => import('./commands/init.mjs'),
  doctor: () => import('./commands/doctor.mjs'),
  clean: () => import('./commands/clean.mjs'),
  'sync-skills': () => import('./commands/sync-skills.mjs'),
  'sync-agents': () => import('./commands/sync-agents.mjs'),
  release: () => import('./commands/release.mjs'),
  update: () => import('./commands/update.mjs'),
  upgrade: () => import('./commands/upgrade.mjs'),
  migrate: () => import('./commands/migrate.mjs'),
  move: () => import('./commands/move.mjs'),
  reconcile: () => import('./commands/reconcile.mjs'),
  ship: () => import('./commands/ship.mjs'),
  'guard-branch': () => import('./commands/guard-branch.mjs'),
};

// The subcommands that shell out to git — they get a friendly missing-git preflight (require-git).
const GIT_COMMANDS = new Set([
  'ship',
  'move',
  'release',
  'update',
  'upgrade',
  'clean',
  'doctor',
  'init',
]);

/**
 * Top-level help, derived from every command's `meta.summary` (single source of truth). Each meta
 * is loaded in its own try/catch so one command module that throws at import can't take the whole
 * help surface down — that command just shows a placeholder, the rest still list.
 */
async function topLevelHelp() {
  const metas = await Promise.all(
    Object.entries(COMMANDS).map(async ([name, load]) => {
      try {
        return (await load()).meta ?? { name, summary: '' };
      } catch {
        return { name, summary: '(help unavailable — module failed to load)' };
      }
    }),
  );
  return renderTopLevelHelp(metas);
}

// Reason: flat CLI dispatch: a sequence of `if (cmd === …)` flag/alias guards routing to a command loader, near-zero nesting; high branch COUNT (version/help/help-sub/update alias/unknown/per-command --help), each trivial
// fallow-ignore-next-line complexity
async function main() {
  let cmd = process.argv[2];

  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(devkitVersion());
    process.exit(0);
  }
  if (cmd === '--update' || cmd === '-u') cmd = 'update'; // alias → the update command

  // `devkit help [<cmd>]`: bare → top-level; with a command → that command's full help.
  if (cmd === 'help') {
    const sub = process.argv[3];
    if (sub && COMMANDS[sub]) {
      console.log(renderCommandHelp((await COMMANDS[sub]()).meta));
      process.exit(0);
    }
    if (sub) console.error(`devkit: unknown command "${sub}"\n`);
    console.log(await topLevelHelp());
    process.exit(sub ? 1 : 0);
  }

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(await topLevelHelp());
    process.exit(0);
  }

  const loader = COMMANDS[cmd];
  if (!loader) {
    console.error(`devkit: unknown command "${cmd}"\n`);
    console.log(await topLevelHelp());
    process.exit(1);
  }

  const cmdArgs = process.argv.slice(3);
  // Generic per-command help: every command gets `devkit <cmd> --help` for free.
  if (cmdArgs.includes('--help') || cmdArgs.includes('-h')) {
    console.log(renderCommandHelp((await loader()).meta));
    process.exit(0);
  }

  if (GIT_COMMANDS.has(cmd)) assertGit(cmd); // friendly throw on missing git → main().catch prints it

  const mod = await loader();
  const code = await mod.default(cmdArgs, process.cwd());
  process.exit(code ?? 0);
}

main().catch((e) => {
  console.error(`devkit: ${e.message}`);
  process.exit(1);
});
