#!/usr/bin/env node
/**
 * guard-decisions — unified CLI for the decision-log engine.
 *
 * Dispatches to the three sub-engines, all of which resolve their paths/knobs from
 * resolveGuardConfig(process.cwd()) — i.e. against the CONSUMER repo, never the package dir (W-3):
 *
 *   guard-decisions add <slug> --target …| --note …   record a Target / append a note
 *   guard-decisions amend <slug> --target …| --note …| --note-replace OLD NEW  correct newest draft
 *   guard-decisions rescope <slug> --scope … --reason …  append-only Scope correction (a tagged note)
 *   guard-decisions query "<text>" [--top K] [--json|--full]  rank axes (semantic → lexical floor)
 *   guard-decisions reindex | list | show <slug> | check <slug>
 *   guard-decisions detect --gate | scan [--working]  architectural-smell gate (capture B)
 *   guard-decisions check-alignment --gate | scan     scope-matched alignment + depth gate (capture C)
 *   guard-decisions scoped-targets --files <a,b> [--query "<text>" --top K]   governing Targets → JSON
 *   guard-decisions categories                        per-category view (recall/category-report.mts)
 *   guard-decisions integrity                         structural-integrity scan (integrity/scan.mts)
 *
 * `detect`, `check-alignment` and `scoped-targets` are thin re-dispatches into their .mjs by
 * re-importing them with a synthesised argv (so their own run-as-main dispatch fires); `categories`
 * and `integrity` are plain function calls (neither has a --gate/scan sub-dispatch of its own);
 * everything else routes to decisions.mjs `main`.
 *
 * `integrity` is dispatched HERE rather than alongside `drift` in decisions.mts purely because that
 * file is at its 500-line cap; `categories` set the precedent for a plain-function command living at
 * this layer.
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
import { cmdIntegrity } from "./integrity/scan.mjs";
import { cmdCategories } from "./recall/category-report.mjs";
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
    if (cmd === 'categories') {
        cmdCategories();
        return;
    }
    if (cmd === 'integrity') {
        // A non-zero scan is a finding, not a crash — set exitCode rather than throwing into the
        // catch below, which would relabel it as `guard-decisions: <error>`.
        process.exitCode = cmdIntegrity();
        return;
    }
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
