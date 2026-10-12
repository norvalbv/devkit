#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Asks qavis whether the staged change wants a QA pass, and relays its advice. */
function main() {
  if (!existsSync('.qavis/recipe.json')) return 0;
  const run = spawnSync('qavis', ['route', '--staged', '--gate'], { encoding: 'utf8' });
  if (run.error?.code === 'ENOENT') return 0;
  let verdict;
  try {
    verdict = JSON.parse(run.stdout);
  } catch {
    console.error(`qavis-advisory: qavis is unavailable (${run.stdout.trim() || run.stderr.trim()}). Retry the commit once it is back.`);
    return 1;
  }
  if (!verdict.advise) return 0;
  console.error(`qavis advises a QA pass: ${verdict.reason}`);
  return process.env.GUARD_AI_STRICT ? 3 : 0;
}

process.exit(main());
