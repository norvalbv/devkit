/**
 * Duplicate-axis surfacing for the write path.
 *
 * Split from decisions.mts so the writer stays under its size budget, and because this is a
 * hygiene check over the corpus rather than part of recording a decision.
 */
import { bm25Rank, loadAxisRows } from "./recall/retrieval.mjs";
/** How many neighbouring axes to surface when a NEW one is created. */
const NEAREST_ON_NEW = 3;
/**
 * Creating a new axis: SHOW the nearest live rulings, never block on them.
 *
 * The failure this addresses is real and measured — `dev-guardrails-distribution` and
 * `devkit-onboarding-cli` carry directly contradictory live rulings ("via npx-skills" vs "NOT
 * npx-skills"), both current, because nothing told either author the other axis existed. But
 * BLOCKING on ruling similarity does not work: measured over 30 real axes, every one of the six
 * highest-scoring pairs is legitimately distinct (top pair 70.20 is the recall BENCHMARK vs the
 * ranking ALGORITHM). BM25 measures topic overlap, and decisions about one subsystem share
 * vocabulary by nature, so any threshold catching real duplicates would block legitimate axes —
 * the precise asymmetry `correctness-reviewer-precision` rules against, since a gate that blocks
 * good work gets switched off.
 *
 * So this is a nudge with no threshold and no failure mode: it costs one line of output and can
 * only ever help the author notice the file they should have appended to instead.
 */
export function warnNearestAxes(slug, o, p) {
    let near = [];
    try {
        const rows = loadAxisRows(p).filter((r) => r.slug !== slug);
        near = bm25Rank(String(o.ruling ?? ''), rows, NEAREST_ON_NEW);
    }
    catch {
        return; // the nudge must never be the reason a write fails
    }
    if (!near.length)
        return;
    console.error(`\nNew axis "${slug}". The nearest existing rulings are:`);
    for (const r of near)
        console.error(`  · ${r.slug} — ${r.ruling.slice(0, 100)}`);
    console.error('If one of those already rules on this question, append THERE instead — a second axis on the\n' +
        'same question leaves two live rulings and no way to tell which won.\n');
}
