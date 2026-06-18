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

/** devkit's own version, read from the package it ships in (always accurate). */
function devkitVersion() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}

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
    --standalone             NO-PACKAGE mode (à la \`fallow init\`): vendors configs + writes a
                             fail-open hook calling the GLOBAL guard-* bins; adds NOTHING to
                             package.json. For shared repos where a private dep is unwanted.
                             Requires devkit installed globally (\`bun add -g\`).
    --overlay                LOCAL-ONLY mode for a repo you can't modify: everything is
                             git-ignored via .git/info/exclude (invisible to the team), the
                             local hook chains to the repo's own (no committed change), and
                             eslint/biome configs EXTEND the repo's. Requires global devkit.
    --scan-root <a,b,…>      Override guard.config.json scanRoots up front (set BEFORE the
                             freezes) — e.g. --scan-root services/webapp/src for a nested app.
    --remove-deselected      With --yes: REMOVE any installed-but-now-deselected component
                             (default off — removal is opt-in / non-destructive).

  devkit doctor [--fix]      Diagnose drift for the INSTALLED component set (read-only).
                             --fix re-runs init for the recorded selection.
  devkit clean [--yes] [--dry-run]  UNINSTALL devkit — reverse init for the recorded mode
                             (overlay restores core.hooksPath + prunes .git/info/exclude;
                             package/standalone removes configs, the hook block, deps, skills).
  devkit sync-skills [--dry-run]  Copy devkit skills into .claude/skills + .cursor/skills.
  devkit sync-agents [--dry-run]  Copy devkit review/testing agents into .claude/agents + .cursor/agents.
  devkit release [bump]      MAINTAINER-ONLY (run in the devkit repo): bump the version,
                             run tests, commit, tag, and push. bump = patch (default) | minor
                             | major | an explicit x.y.z. --dry-run prints the plan; --yes skips
                             the confirm. Refuses outside the devkit repo or on a dirty tree.
  devkit --version           Print devkit's version.
  devkit --help              This help.`;

const COMMANDS = {
  init: () => import('./commands/init.mjs'),
  doctor: () => import('./commands/doctor.mjs'),
  clean: () => import('./commands/clean.mjs'),
  'sync-skills': () => import('./commands/sync-skills.mjs'),
  'sync-agents': () => import('./commands/sync-agents.mjs'),
  release: () => import('./commands/release.mjs'),
};

async function main() {
  const cmd = process.argv[2];

  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(devkitVersion());
    process.exit(0);
  }

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
