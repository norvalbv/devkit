/**
 * `guard-decisions query` prose printers.
 *
 * `printRanked` (the default view) lives here rather than in decisions.mts because that file is at
 * its 500-line size-ratchet cap with no headroom — this is a pure relocation, not a behaviour change.
 *
 * `printFull` is `--full`'s renderer: the truncated view shows one ruling line plus at most
 * PROSE_QUALIFIERS notes, so a reader who needs a Consequences/Tradeoff field, a Researched/Rejected
 * note, or qualifier #4 has to `show` the axis by hand. `--full` prints each MATCHED axis's whole
 * file body instead, in the rank order `rankAxes` already produced — it re-reads only the winning
 * files (the same bytes `show <slug>` already prints whole), never re-ranks and never re-scans the
 * full corpus a second time.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { whyHook } from '../decision-format.mjs';
/** How many qualifying notes the truncated PROSE surface shows before pointing at `show`. */
const PROSE_QUALIFIERS = 3;
// `why` is now the axis file's full Context (the INDEX cell was truncated to 70 chars), so bound it
// at print time — the ranker wants the whole thing, a terminal reader does not.
export function printRanked(rows, mode) {
    console.log(`# top ${rows.length} ${rows.length === 1 ? 'axis' : 'axes'} (${mode})`);
    for (const r of rows) {
        console.log(`- ${r.slug} · ${r.ruling}${r.why ? ` · ${whyHook(r.why)}` : ''}`);
        // Never print a ruling alone when later notes qualify it — an agent reading only the ruling
        // acts on a decision the record has already walked back. But a real axis carries ~20 notes, so
        // the prose surface shows the most QUERY-RELEVANT few (retrieval ordered them that way) and says
        // how many it held back. --json still carries the full set for machine consumers.
        for (const q of r.qualifiers.slice(0, PROSE_QUALIFIERS))
            console.log(`    ⚠ qualified by ${q.date} — ${whyHook(q.text)}`);
        if (r.qualifiers.length > PROSE_QUALIFIERS)
            console.log(`    … ${r.qualifiers.length - PROSE_QUALIFIERS} more note(s): guard-decisions show ${r.slug}`);
    }
}
/**
 * `--full` and `--json` both claim to BE the whole output — `--json` the structured envelope,
 * `--full` a prose dump of matched files — so passing both is a caller error, not a "pick one"
 * default a caller could silently get wrong. Called before any ranking work, so a bad combination
 * costs nothing.
 */
export function assertFullNotJson(json, full) {
    if (!(json && full))
        return;
    console.error('guard-decisions query: --json and --full are mutually exclusive — --json already carries ' +
        'the structured rows --full would print as text.');
    process.exit(1);
}
/**
 * `--full`: the COMPLETE file body of each matched axis, in rank order, instead of the truncated
 * ruling. Composes with `--top K` for free — it only ever prints the rows ranking already narrowed
 * to K, so a smaller K means fewer whole files printed, not a second unranked pass.
 */
export function printFull(rows, mode, decisionsDir) {
    console.log(`# top ${rows.length} ${rows.length === 1 ? 'axis' : 'axes'} (${mode}, full)`);
    rows.forEach((r, i) => {
        console.log(`\n${'─'.repeat(72)}\n${i + 1}. ${r.slug}\n${'─'.repeat(72)}\n`);
        process.stdout.write(readFileSync(path.join(decisionsDir, `${r.slug}.md`), 'utf8'));
    });
}
