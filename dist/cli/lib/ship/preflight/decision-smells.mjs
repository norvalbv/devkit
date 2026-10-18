// Ship's pre-chain advisory: the decisions gate's deterministic smell regex on ship's exact staging,
// without the judge. Informational only — always exits 0 and prints nothing on any error.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveGuardConfig } from '../../../../gate-engine/config.mjs';
import { decisionFileRe, gateVerdict, gatherEntries, smellSources, } from '../../../../gate-engine/decisions/detect.mjs';
import { git, stagedFiles } from '../../../../gate-engine/decisions/git-io.mjs';
/** True only when git proves a record under `decisionsDir` would be tracked in the caller's checkout. */
export function decisionsDirStageable(root, decisionsDir) {
    try {
        git(root, ['check-ignore', '-q', '--no-index', '--', path.join(decisionsDir, '__probe__.md')]);
        return false;
    }
    catch (err) {
        // exit 1 = not ignored; 128 (a symlinked decisions dir) or a spawn error cannot prove it stageable
        return err instanceof Error && 'status' in err && err.status === 1;
    }
}
// Named pairs before the rest collapse to a count: the advisory prints twice, and a verdict sits below it.
const SHOWN = 5;
function smellLines(sources) {
    const lines = sources
        .slice(0, SHOWN)
        .map((s) => `⚠️  decision smell (regex only, not a verdict): ${s.label} — ${s.path}`);
    if (sources.length > SHOWN)
        lines.push(`   … and ${sources.length - SHOWN} more smelly file(s); the decisions gate judges every one.`);
    return lines;
}
function guidanceLines(opts) {
    return [
        opts.noLlm
            ? '   The decision judge is disabled here (noLlm), so a ship will likely block on this; see the remedy below.'
            : "   No action needed now: the decisions gate's judge runs after the deterministic gates (every ship except --dry-gates) and may clear this as ROUTINE.",
        opts.stageable
            ? "   If it blocks: record a real architectural decision with guard-decisions and pass the record's path to devkit ship."
            : `   If it blocks: git cannot confirm ${opts.decisionsDir} is stageable here (git-ignored, or a symlink git will not follow), so do not pass a record; re-ship with GUARD_NO_LOG=1 only with the user's OK.`,
    ];
}
/** The advisory lines for each (smell, file) pair, with the remedy this repo layout allows. */
export function renderAdvisory(sources, opts) {
    return sources.length === 0 ? [] : [...smellLines(sources), ...guidanceLines(opts)];
}
/** Advisory for the staged set in `cwd`; `root` is the caller's checkout, where ignore rules live. */
export function adviseStaged(cwd, root) {
    const cfg = resolveGuardConfig(cwd);
    const sources = smellSources(gatherEntries(cwd), cfg.boundaries);
    const matcher = decisionFileRe(cfg.decisionsDir);
    const verdict = gateVerdict({
        bypass: cfg.noLog,
        decisionStaged: stagedFiles(cwd).some((n) => matcher.test(n)),
        smells: sources.map((s) => s.label),
    });
    if (verdict === 0)
        return [];
    return renderAdvisory(sources, {
        stageable: decisionsDirStageable(root, cfg.decisionsDir),
        noLlm: cfg.noLlm,
        decisionsDir: cfg.decisionsDir,
    });
}
export function main(argv) {
    try {
        for (const line of adviseStaged(process.cwd(), argv[0] ?? process.cwd()))
            console.log(line);
    }
    catch {
        // advisory: an unreadable config or index must never change the ship's outcome
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
    main(process.argv.slice(2));
