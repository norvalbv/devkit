#!/usr/bin/env node
/**
 * devkit CLI — wire a consumer repo onto the @norvalbv/devkit shared configs +
 * gate-engine, sync agent skills, and diagnose drift.
 *
 *   devkit init [--stack <x>] [--standalone | --overlay] [--scan-root <a,b>] [--fallow] [--yes]
 *   devkit doctor [--fix]
 *   devkit review [--target <path>] [--base <ref>]
 *   devkit sync-skills [--dry-run]
 *   devkit sync-hooks [--only <a.sh,b.mjs>] [--targets <claude,cursor>] [--dry-run] [--force]
 *   devkit sync-hook-runner [--dry-run]
 *   devkit release [patch|minor|major|<x.y.z>] [--dry-run] [--yes]   (maintainer-only)
 *   devkit --version
 *   devkit --help
 *
 * TypeScript source (.mts), shipped as a prebuilt .mjs dist/ (compiled by `devkit release`).
 * Consumers install prebuilt .mjs — no build on their side.
 */
import { readFileSync } from 'node:fs';
import { assertGit } from './lib/guard/require-git.mts';
import { type CommandMeta, renderCommandHelp, renderTopLevelHelp } from './lib/help/render.mts';

/** The devkit-owned package.json fields this CLI reads. */
interface DevkitPackageJson {
  version: string;
}

/** The common shape every `./commands/*` module exposes to the dispatcher. */
interface CommandModule {
  meta: CommandMeta;
  default: (args: string[], cwd: string) => number | undefined | Promise<number | undefined>;
}

type CommandLoader = () => Promise<CommandModule>;

/** devkit's own version, read from the package it ships in (always accurate). */
function devkitVersion(): string {
  // readFileSync + JSON.parse boundary — the shipped package.json always carries a version.
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as DevkitPackageJson;
  return pkg.version;
}

const COMMANDS: Record<string, CommandLoader> = {
  init: () => import('./commands/init.mts'),
  doctor: () => import('./commands/doctor.mts'),
  clean: () => import('./commands/clean.mts'),
  'sync-skills': () => import('./commands/sync/sync-skills.mts'),
  'sync-agents': () => import('./commands/sync/sync-agents.mts'),
  'sync-hooks': () => import('./commands/sync/sync-hooks.mts'),
  'sync-hook-runner': () => import('./commands/sync/sync-hook-runner.mts'),
  release: () => import('./commands/release.mts'),
  update: () => import('./commands/update.mts'),
  upgrade: () => import('./commands/upgrade.mts'),
  move: () => import('./commands/move.mts'),
  reconcile: () => import('./commands/reconcile.mts'),
  ship: () => import('./commands/ship.mts'),
  review: () => import('./commands/review.mts'),
  'guard-branch': () => import('./commands/guard-branch.mts'),
};

// The subcommands that shell out to git — they get a friendly missing-git preflight (require-git).
const GIT_COMMANDS = new Set([
  'ship',
  'review',
  'move',
  'release',
  'update',
  'upgrade',
  'clean',
  'doctor',
  'init',
  'sync-hook-runner',
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
