// Ship's pre-chain advisory: the decisions gate's deterministic smell regex on ship's exact staging,
// without the judge. Informational only — always exits 0 and prints nothing on any error.

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveGuardConfig } from '../../../../gate-engine/config.mts';
import {
  decisionFileRe,
  gateVerdict,
  gatherEntries,
  smellSources,
} from '../../../../gate-engine/decisions/detect.mts';
import { git, stagedFiles } from '../../../../gate-engine/decisions/git-io.mts';

/** False only when git proves a record under `decisionsDir` would be tracked in the caller's checkout. */
export function decisionsDirIgnored(root: string, decisionsDir: string): boolean {
  try {
    git(root, ['check-ignore', '-q', '--no-index', '--', path.join(decisionsDir, '__probe__.md')]);
    return true;
  } catch (err) {
    // exit 1 = not ignored; 128 (a symlinked decisions dir) or a spawn error cannot prove it stageable
    return !(err instanceof Error && 'status' in err && err.status === 1);
  }
}

// Named pairs before the rest collapse to a count: the advisory prints twice, and a verdict sits below it.
const SHOWN = 5;

/** The advisory lines for each (smell, file) pair, with the remedy this repo layout allows. */
export function renderAdvisory(
  sources: { label: string; path: string }[],
  opts: { ignored: boolean; noLlm: boolean; decisionsDir: string },
): string[] {
  if (sources.length === 0) return [];
  const lines = sources
    .slice(0, SHOWN)
    .map((s) => `⚠️  decision smell (regex only, not a verdict): ${s.label} — ${s.path}`);
  if (sources.length > SHOWN)
    lines.push(
      `   … and ${sources.length - SHOWN} more smelly file(s); the decisions gate judges every one.`,
    );
  lines.push(
    opts.noLlm
      ? '   The decision judge is disabled here (noLlm), so a ship will likely block on this; see the remedy below.'
      : "   No action needed now: the decisions gate's judge runs after the deterministic gates (every ship except --dry-gates) and may clear this as ROUTINE.",
    opts.ignored
      ? `   If it blocks: ${opts.decisionsDir} is git-ignored here, so do not pass a record; re-ship with GUARD_NO_LOG=1 only with the user's OK.`
      : "   If it blocks: record a real architectural decision with guard-decisions and pass the record's path to devkit ship.",
  );
  return lines;
}

/** Advisory for the staged set in `cwd`; `root` is the caller's checkout, where ignore rules live. */
export function adviseStaged(cwd: string, root: string): string[] {
  const cfg = resolveGuardConfig(cwd);
  const sources = smellSources(gatherEntries(cwd), cfg.boundaries);
  const matcher = decisionFileRe(cfg.decisionsDir);
  const verdict = gateVerdict({
    bypass: cfg.noLog,
    decisionStaged: stagedFiles(cwd).some((n) => matcher.test(n)),
    smells: sources.map((s) => s.label),
  });
  if (verdict === 0) return [];
  return renderAdvisory(sources, {
    ignored: decisionsDirIgnored(root, cfg.decisionsDir),
    noLlm: cfg.noLlm,
    decisionsDir: cfg.decisionsDir,
  });
}

export function main(argv: string[]): void {
  try {
    for (const line of adviseStaged(process.cwd(), argv[0] ?? process.cwd())) console.log(line);
  } catch {
    // advisory: an unreadable config or index must never change the ship's outcome
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main(process.argv.slice(2));
