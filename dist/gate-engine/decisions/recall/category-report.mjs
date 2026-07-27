/**
 * `guard-decisions categories` — a per-category assembly of the decision log.
 *
 * The store is per-axis; the recurring question ("what config moves where, and why") is
 * per-category, its answer spread across however many axes share a Category. This reads every
 * axis's CURRENT Target (never a superseded one — `currentTarget` already takes the last block),
 * groups by the declared `**Category:**` field, and prints each group's rulings together.
 *
 * A view, not a gate: it never exits non-zero, and an axis with no Category (absent, or a value
 * outside the frozen list — the latter should never happen post-validation, but a hand-edited file
 * could still carry one) is reported in `uncategorised` rather than guessed into a bucket.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveFromCwd, resolveGuardConfig } from "../../config.mjs";
import { currentTarget, parseDecision, sanitizeCell } from "../decision-format.mjs";
import { CATEGORIES, isCategory } from "./categories.mjs";
// Long enough to keep a ruling recognisable, short enough that a report of ~10 axes stays scannable
// on one screen — this is a terminal report, not the full record (`show <slug>` has that).
const RULING_TRUNCATE = 100;
function truncateRuling(ruling) {
    const clean = sanitizeCell(ruling);
    return clean.length > RULING_TRUNCATE ? `${clean.slice(0, RULING_TRUNCATE - 1)}…` : clean;
}
function decisionsDirFor(cwd) {
    const cfg = resolveGuardConfig(cwd);
    const dir = resolveFromCwd(cfg, 'decisionsDir');
    if (dir == null)
        throw new Error('decisionsDir did not resolve — check guard config');
    return dir;
}
/** Read every axis file's current Target and read off its declared Category. Unparseable/absent
 * Targets fall back to an empty ruling rather than skipping the axis — even a Target-less file
 * should surface as uncategorised, not vanish from the report. */
function loadCategorizedAxes(cwd) {
    const dir = decisionsDirFor(cwd);
    if (!existsSync(dir))
        return [];
    const axes = [];
    for (const file of readdirSync(dir).sort()) {
        if (!file.endsWith('.md') || file === 'INDEX.md')
            continue;
        const slug = file.slice(0, -3);
        const { body } = parseDecision(readFileSync(path.join(dir, file), 'utf8'));
        const target = currentTarget(body);
        const raw = target?.fields.category;
        axes.push({
            slug,
            ruling: truncateRuling(target?.ruling ?? ''),
            category: raw && isCategory(raw) ? raw : null,
        });
    }
    return axes;
}
/**
 * Group axes by their declared Category, in the FROZEN list's order — never alphabetical or
 * insertion order, so the report reads identically regardless of which axis was recorded last.
 * Pure (no I/O) so the grouping logic is testable without touching a filesystem.
 */
export function groupByCategory(axes) {
    const byCategory = new Map();
    const uncategorised = [];
    for (const { category, ...axis } of axes) {
        if (category == null) {
            uncategorised.push(axis);
            continue;
        }
        const list = byCategory.get(category);
        if (list)
            list.push(axis);
        else
            byCategory.set(category, [axis]);
    }
    const groups = CATEGORIES.filter((category) => byCategory.has(category)).map((category) => ({
        category,
        axes: byCategory.get(category),
    }));
    return { groups, uncategorised };
}
export function cmdCategories(cwd = process.cwd()) {
    const axes = loadCategorizedAxes(cwd);
    if (axes.length === 0) {
        console.log('No decisions recorded.');
        return;
    }
    const { groups, uncategorised } = groupByCategory(axes);
    for (const { category, axes: inCategory } of groups) {
        console.log(`# ${category} (${inCategory.length})`);
        for (const a of inCategory)
            console.log(`- ${a.slug} · ${a.ruling}`);
        console.log('');
    }
    console.log(`# uncategorised (${uncategorised.length})`);
    for (const a of uncategorised)
        console.log(`- ${a.slug} · ${a.ruling}`);
}
