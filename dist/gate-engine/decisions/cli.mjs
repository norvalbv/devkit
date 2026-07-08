#!/usr/bin/env node
/**
 * guard-decisions — unified CLI for the decision-log engine.
 *
 * Dispatches to the three sub-engines, all of which resolve their paths/knobs from
 * resolveGuardConfig(process.cwd()) — i.e. against the CONSUMER repo, never the package dir (W-3):
 *
 *   guard-decisions add <slug> --target …| --note …   record a Target / append a note
 *   guard-decisions query "<text>" [--top K]          rank axes (semantic → lexical floor)
 *   guard-decisions reindex | list | show <slug> | check <slug>
 *   guard-decisions detect --gate | scan [--working]  architectural-smell gate (capture B)
 *   guard-decisions check-alignment --gate | scan     scope-matched alignment + depth gate (capture C)
 *   guard-decisions scoped-targets --files <a,b> [--query "<text>" --top K]   governing Targets → JSON
 *
 * `detect`, `check-alignment` and `scoped-targets` are thin re-dispatches into their .mjs by
 * re-importing them with a synthesised argv (so their own run-as-main dispatch fires); everything
 * else routes to decisions.mjs `main`.
 */
var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { realpathSync } from 'node:fs';
import { main as decisionsMain } from "./decisions.mjs";
// Dev runs the .mts source (Node strips types); the shipped dist is compiled .mjs. Derive the
// runtime extension from THIS module so the sub-engine URLs resolve in both.
const SELF_EXT = import.meta.url.endsWith('.mts') ? '.mts' : '.mjs';
const SUB_ENGINES = {
    detect: new URL(`./detect${SELF_EXT}`, import.meta.url),
    'check-alignment': new URL(`./check-alignment${SELF_EXT}`, import.meta.url),
    'scoped-targets': new URL(`./scoped-targets${SELF_EXT}`, import.meta.url),
};
async function run(argv) {
    const [cmd, ...rest] = argv;
    const sub = SUB_ENGINES[cmd];
    if (sub) {
        // Re-enter the sub-engine as if invoked directly: it inspects process.argv and self-dispatches
        // (--gate / scan). process.argv[1] must equal the sub-engine path so its run-as-main guard fires.
        process.argv = [process.argv[0], realpathSync(sub), ...rest];
        await import(__rewriteRelativeImportExtension(sub.href));
        return;
    }
    await decisionsMain(argv);
}
run(process.argv.slice(2)).catch((e) => {
    console.error(`guard-decisions: ${e?.message ?? e}`);
    process.exit(1);
});
