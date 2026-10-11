// `devkit ship --dry-gates` advisory: the decisions gate's deterministic smell regex on ship's exact
// staging, without the judge. Informational only — always exits 0 and stays silent on any error.

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

/** True when a record written under `decisionsDir` would be git-ignored in the caller's checkout. */
export function decisionsDirIgnored(root: string, decisionsDir: string): boolean {
  try {
    git(root, ['check-ignore', '-q', '--no-index', '--', path.join(decisionsDir, '__probe__.md')]);
    return true;
  } catch {
    return false; // exit 1 = not ignored; anything else cannot prove it ignored either
  }
}

/** The advisory lines for each (smell, file) pair, with the remedy this repo layout allows. */
export function renderAdvisory(
  sources: { label: string; path: string }[],
  ignored: boolean,
  decisionsDir: string,
): string[] {
  if (sources.length === 0) return [];
  const lines = sources.map(
    (s) => `⚠️  decision smell (regex only — the judge did not run): ${s.label} — ${s.path}`,
  );
  lines.push(
    ignored
      ? `   ${decisionsDir} is git-ignored here: do not pass a record to ship (it would be force-committed). The real ship's judge may clear this as ROUTINE; otherwise GUARD_NO_LOG=1 needs the user's OK.`
      : `   Record the decision (guard-decisions) and pass the record's path to devkit ship, or let the real ship's judge decide.`,
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
  return renderAdvisory(sources, decisionsDirIgnored(root, cfg.decisionsDir), cfg.decisionsDir);
}

export function main(argv: string[]): void {
  try {
    const at = argv.indexOf('--root');
    const root = at >= 0 && argv[at + 1] ? argv[at + 1] : process.cwd();
    for (const line of adviseStaged(process.cwd(), root)) console.error(line);
  } catch {
    // advisory: an unreadable config or index must never change the rehearsal's outcome
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main(process.argv.slice(2));
