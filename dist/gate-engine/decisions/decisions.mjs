#!/usr/bin/env node
/**
 * Decision Log — architectural-decision *why* timeline.
 *
 * Captures the *target / why* behind reversible architectural choices (the "road not
 * taken"), keyed by decision *axis* (slug). The most recent ruling per axis is the living
 * architecture record. md is the source of truth; the per-axis embedding cache
 * (`<cwd>/.decisions/index.json`) is a derived, gitignored, rebuildable cache (lazy
 * content-hash rehash) used by `query`. It holds nothing the md files don't.
 *
 * APPEND-ONLY: a written entry is never mutated (rewriting a past ruling would lose the
 * flip-flop history this exists to preserve). The current ruling per axis = its LAST entry.
 * Per-file frontmatter is two immutable fields — {slug, created} — with NO current/updated/
 * status pointer (those duplicate the timeline and invite the "docs now say B" rewrite).
 *
 * Storage (git-tracked, under <decisionsDir>/, default docs/decisions/):
 *   INDEX.md          derived current-state spine: | [slug](slug.md) | current ruling | why-hook | updated |
 *                     (regenerable cache over the timelines — holds no history, so mutation-safe)
 *   <slug>.md         per-axis append-only timeline: {slug, created} frontmatter + dated entries
 *
 * A decision is an EPIC (PRD-altitude), not an impl patch-note. Each axis file = a stack of
 * `## Target ·` blocks (rare, the PRD) + cheap `- <date> — note`s (implementation convergence
 * under the current Target). INDEX shows the Target, never a note.
 *
 * ── W-3 (portability invariant) ──────────────────────────────────────────────────
 * All paths resolve relative to the CONSUMER cwd via resolveGuardConfig(cwd), NEVER
 * __dirname (the package dir). Run from a consumer's node_modules, this engine reads and
 * writes the CONSUMER's decision log, not files inside the package.
 *
 * Commands:
 *   add <slug> --target --context "..." --ruling "..." --consequences "..." --tradeoff "..."
 *              --vision-fit "..." [--title ... --researched ... --rejected ...
 *               --anchored-bet "[BET]" --scope "glob,glob" --category "..." --source ... --ref ... --new
 *               --evidence-change "..."]                  (epic Target; updates INDEX)
 *   add <slug> --note "..."          cheap convergence note under the current Target (INDEX untouched)
 *   rescope <slug> --scope "glob,glob" --reason "..."  append-only Scope correction (a tagged note)
 *   amend <slug> --target …|--note … replace only the newest entry when it is absent from HEAD
 *   amend <slug> --note-replace OLD NEW  replace one unique substring in that draft note
 *   query "<text>" [--top K] [--json] [--full]  rank axes — semantic (Ollama), lexical floor on
 *     fallback; --json emits the bench's envelope; --full prints each matched axis's whole file
 *     body in rank order instead of the truncated ruling (exclusive with --json)
 *   reindex                         cold-build the derived embedding cache
 *   list / show <slug> / check <slug>
 *
 * Re-targeting an axis that already has a Target requires --evidence-change (a target moves only
 * on an evidence-state change, never on impl pain → that's a --note). APPEND-ONLY: never mutate a
 * past block; archive a mis-filed entry by moving it under a `## [archived …]` heading, never delete.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveFromCwd, resolveGuardConfig } from "../config.mjs";
import { amendDecision } from "./amend.mjs";
import { writeFileAtomic } from "./atomic-write.mjs";
import { currentTarget, hasTargetFields, parseDecision, parseIndex, renderDecision, renderIndex, renderNote, renderTarget, sanitizeCell, today, upsertRow, whyHook, } from "./decision-format.mjs";
import { warnNearestAxes } from "./dedupe.mjs";
import { runDrift } from "./drift.mjs";
import { assertFullNotJson, printFull, printRanked } from "./recall/full-print.mjs";
import { noteTextWithRelation } from "./recall/note-relations.mjs";
import { rankAxes as rankAxesIn, reindexAll } from "./recall/retrieval.mjs";
export { currentTarget, parseDecision, parseIndex, renderDecision, renderIndex, renderNote, renderTarget, upsertRow, } from "./decision-format.mjs";
// The recall path lives in retrieval.mts; re-exported so consumers and tests keep one entry point.
export { bm25Rank, clampGist, cosine, effectiveScope, gistOf, loadAxisRows, } from "./recall/retrieval.mjs";
// Top-level regexes (these run in loops).
const TRAILING_WS_RE = /\s*$/;
function paths(cwd = process.cwd()) {
    const cfg = resolveGuardConfig(cwd);
    const decisionsDir = resolveFromCwd(cfg, 'decisionsDir');
    // decisionsDir always resolves via DEFAULTS ('docs/decisions'); a null means a broken config
    // contract, so fail loud rather than feeding null into path.join.
    if (decisionsDir == null)
        throw new Error('decisionsDir did not resolve — check guard config');
    return {
        cwd,
        decisionsDir,
        indexPath: path.join(decisionsDir, 'INDEX.md'),
        // Derived, gitignored, rebuildable embedding cache for `query` (lazy content-hash rehash).
        // DECISIONS_INDEX overrides the location (tests point it at a temp file).
        vecIndexPath: process.env.DECISIONS_INDEX ?? path.join(cwd, '.decisions', 'index.json'),
    };
}
// ─── Small pure helpers (kept top-level for ATS chunking) ───────────────────────
function slugPath(p, slug) {
    return path.join(p.decisionsDir, `${slug}.md`);
}
// ─── INDEX.md parse / render (the bounded axis spine) ───────────────────────────
function readIndexRows(p) {
    return existsSync(p.indexPath) ? parseIndex(readFileSync(p.indexPath, 'utf8')) : [];
}
// ─── Commands ───────────────────────────────────────────────────────────────────
export function cmdAdd(slug, o, cwd = process.cwd()) {
    if (!slug) {
        console.error('Usage: guard-decisions add <slug> --target … | --note "…"');
        process.exit(1);
    }
    return o.isTarget ? addTarget(slug, o, paths(cwd)) : addNote(slug, o, paths(cwd));
}
export function cmdAmend(slug, o, cwd = process.cwd()) {
    return amendDecision(slug, o, paths(cwd));
}
// Epic Target — the PRD. Requires context + ruling + consequences + tradeoff + vision-fit; updates INDEX.
// Reason: the branches ARE the Target-recording state machine (required-field guard, unknown-axis-without-new guard, already-targeted re-target guard, exists-vs-new render path); each guard maps to a distinct user error and extracting them hides the decision logic
// fallow-ignore-next-line complexity
function addTarget(slug, o, p) {
    if (!hasTargetFields(o)) {
        console.error('Usage: guard-decisions add <slug> --target \\\n' +
            '  --context "<the forcing failure: what broke + the symptom + severity/blast-radius>" \\\n' +
            '  --ruling "<the decision / mechanism chosen>" \\\n' +
            '  --consequences "<the user/business value this protects>" \\\n' +
            '  --tradeoff "<the cost knowingly paid — latency, complexity, a road not taken>" \\\n' +
            '  --vision-fit "<which product North Star; or n/a — internal tooling>" \\\n' +
            '  [--title "<short heading>" --researched … --rejected … --anchored-bet "[BET]" --revisit-when "<condition that voids this ruling>" --scope "glob,glob" --category "<see recall/categories.mts>" --supersedes "<id>" --new --evidence-change "…"]\n' +
            '(Context=WHY-now, Ruling=WHAT, Consequences/Tradeoff=SO-THAT + cost — the ADR Context/Decision/Consequences spine.)');
        process.exit(1);
    }
    const file = slugPath(p, slug);
    const exists = existsSync(file);
    if (!exists && !o.isNew) {
        console.error(`Unknown axis "${slug}". Reuse an existing slug if this axis exists under another name;\n` +
            `otherwise re-run with --new. Current index:\n`);
        console.error(existsSync(p.indexPath) ? readFileSync(p.indexPath, 'utf8') : '(index empty)');
        process.exit(1);
    }
    if (!exists)
        warnNearestAxes(slug, o, p);
    const date = today();
    let fm;
    let body;
    if (exists) {
        const parsed = parseDecision(readFileSync(file, 'utf8'));
        // Re-target guard: a Target moves only on an evidence-state change, never on impl pain. Trimmed
        // so the CLI cannot write a hollow field that integrity/checks.mts would then flag as missing.
        if (currentTarget(parsed.body) && !o.evidenceChange?.trim()) {
            console.error(`Axis "${slug}" already has a Target. An implementation change is a NOTE — drop --target:\n` +
                `  guard-decisions add ${slug} --note "<what converged>"\n` +
                'Re-target ONLY on an evidence-state change — pass --evidence-change "<what shifted>".');
            process.exit(1);
        }
        fm = { slug, created: parsed.fm.created || date };
        body = `${parsed.body.replace(TRAILING_WS_RE, '')}\n\n${renderTarget(date, o)}\n`;
    }
    else {
        fm = { slug, created: date };
        body = `\n# ${slug}\n\n${renderTarget(date, o)}\n`;
    }
    mkdirSync(p.decisionsDir, { recursive: true });
    writeFileAtomic(file, renderDecision(fm, body));
    const rows = upsertRow(readIndexRows(p), {
        slug,
        ruling: sanitizeCell(o.ruling),
        why: whyHook(o.context),
        updated: date,
    });
    writeFileAtomic(p.indexPath, renderIndex(rows));
    console.log(`Recorded Target "${slug}" (${date}).`);
}
// Cheap convergence note under the current Target. INDEX untouched (a note is not a ruling).
function addNote(slug, o, p) {
    if (!o.note) {
        console.error('Usage: guard-decisions add <slug> --note "…"   (or --target … for an epic Target)');
        process.exit(1);
    }
    const file = slugPath(p, slug);
    if (!existsSync(file)) {
        console.error(`Axis "${slug}" has no Target yet — record one first:\n` +
            `  guard-decisions add ${slug} --target --context … --ruling … --consequences … --tradeoff … --vision-fit … --new`);
        process.exit(1);
    }
    const date = today();
    const parsed = parseDecision(readFileSync(file, 'utf8'));
    const note = noteTextWithRelation(o.note, o.supersedes, parsed.body);
    const body = `${parsed.body.replace(TRAILING_WS_RE, '')}\n${renderNote(date, note)}\n`;
    writeFileAtomic(file, renderDecision({ slug, created: parsed.fm.created || date }, body));
    console.log(`Noted on "${slug}" (${date}).`);
}
export function cmdList(cwd = process.cwd()) {
    const p = paths(cwd);
    if (!existsSync(p.indexPath)) {
        console.log('No decisions recorded.');
        return;
    }
    process.stdout.write(readFileSync(p.indexPath, 'utf8'));
}
export function cmdShow(slug, cwd = process.cwd()) {
    const file = slugPath(paths(cwd), slug);
    if (!existsSync(file)) {
        console.error(`No decision axis "${slug}".`);
        process.exit(1);
    }
    process.stdout.write(readFileSync(file, 'utf8'));
}
export function checkExists(slug, cwd = process.cwd()) {
    return existsSync(slugPath(paths(cwd), slug));
}
/** Rank axes for a consumer cwd. Thin wrapper: retrieval.mts takes resolved paths, not a cwd. */
export async function rankAxes(text, k = 5, cwd = process.cwd()) {
    return rankAxesIn(text, k, paths(cwd));
}
export async function queryEnvelope(text, k = 5, cwd = process.cwd()) {
    const started = Date.now();
    const { source, rows } = await rankAxes(text, k, cwd);
    return {
        state: rows.length ? 'RULED' : 'NO_RULING',
        source,
        tau: null,
        // Flatness of the top of the ranking. A near-zero margin over several axes is the signature of
        // the "five loosely-related results, none of which settled it" failure, so it is reported even
        // though nothing acts on it yet. Null when there is no second row to compare against.
        margin: rows.length >= 2 ? rows[0].score - rows[1].score : null,
        rows: rows.map((r, i) => ({
            rank: i + 1,
            slug: r.slug,
            score: r.score,
            liveRulingId: r.liveRulingId,
            matchedEntryId: r.matchedEntryId,
            ruling: r.ruling,
            qualifiedBy: r.qualifiers.map((q) => ({ id: q.id, date: q.date, text: q.text })),
            why: r.why,
            updated: r.updated,
        })),
        // Retrieval makes no model calls. Embedding runs on a local Ollama and is free but not
        // instant, so its cost shows up in `ms` rather than as a separate priced counter.
        cost: { llmCalls: 0, ms: Date.now() - started },
    };
}
export async function cmdQuery(text, k = 5, cwd = process.cwd(), json = false, full = false) {
    if (!text?.trim()) {
        console.error('Usage: guard-decisions query "<text>" [--top K] [--json] [--full]');
        process.exit(1);
    }
    assertFullNotJson(json, full);
    if (json) {
        console.log(JSON.stringify(await queryEnvelope(text, k, cwd), null, 2));
        return;
    }
    const { source, rows } = await rankAxes(text, k, cwd);
    if (rows.length === 0) {
        // Two different answers, deliberately worded differently — an agent must be able to tell an
        // empty log from a searched log that rules on nothing.
        console.log(source === 'empty'
            ? 'No decisions recorded.'
            : 'No recorded decision rules on this. (searched every axis; nothing matched)');
        return;
    }
    if (full) {
        printFull(rows, source, paths(cwd).decisionsDir);
        return;
    }
    printRanked(rows, source);
}
export async function cmdReindex(cwd = process.cwd()) {
    const { done, total } = await reindexAll(paths(cwd));
    console.log(`Reindexed ${done}/${total} axes${done < total ? ' (some embeds unavailable — lexical still covers them)' : ''}.`);
}
// ─── Dispatch (run-as-main only, so tests can import the pure helpers) ───────────
const OPTION_TOKEN = /^--(?:anchored-bet|category|consequences|context|evidence-change|full|json|new|note|note-replace|reason|ref|rejected|researched|revisit-when|ruling|scope|source|supersedes|target|title|top|tradeoff|vision-fit)$/;
function flag(rest, name, offset = 1) {
    const i = rest.indexOf(name);
    return i !== -1 && !OPTION_TOKEN.test(rest[i + offset] ?? '') ? rest[i + offset] : undefined;
}
function optionsFromFlags(rest) {
    return {
        isTarget: rest.includes('--target'),
        note: flag(rest, '--note'),
        noteReplace: rest.includes('--note-replace')
            ? [flag(rest, '--note-replace'), flag(rest, '--note-replace', 2)]
            : undefined,
        title: flag(rest, '--title'),
        context: flag(rest, '--context'),
        ruling: flag(rest, '--ruling'),
        consequences: flag(rest, '--consequences'),
        tradeoff: flag(rest, '--tradeoff'),
        visionFit: flag(rest, '--vision-fit'),
        researched: flag(rest, '--researched'),
        rejected: flag(rest, '--rejected'),
        anchoredBet: flag(rest, '--anchored-bet'),
        revisitWhen: flag(rest, '--revisit-when'),
        scope: flag(rest, '--scope'),
        category: flag(rest, '--category'),
        supersedes: flag(rest, '--supersedes'),
        source: flag(rest, '--source'),
        ref: flag(rest, '--ref'),
        evidenceChange: flag(rest, '--evidence-change'),
        isNew: rest.includes('--new'),
    };
}
export async function main(argv) {
    const [cmd, ...args] = argv;
    switch (cmd) {
        case 'add': {
            const [slug, ...rest] = args;
            cmdAdd(slug, optionsFromFlags(rest));
            break;
        }
        case 'amend': {
            const [slug, ...rest] = args;
            cmdAmend(slug, optionsFromFlags(rest));
            break;
        }
        case 'rescope': {
            // Append-only Scope correction: reuses addNote's append path (never touches the Target's own
            const [slug, ...rest] = args;
            const scope = flag(rest, '--scope');
            const reason = flag(rest, '--reason');
            if (!slug || !scope?.trim() || !reason?.trim()) {
                console.error('Usage: guard-decisions rescope <slug> --scope "<globs>" --reason "<why>"');
                process.exit(1);
            }
            addNote(slug, { note: `**Scope:** ${scope.trim()} — ${reason.trim()}` }, paths());
            break;
        }
        case 'query': {
            const [text, ...rest] = args;
            const top = flag(rest, '--top');
            const n = top ? Number.parseInt(top, 10) : 5;
            await cmdQuery(text, n > 0 ? n : 5, process.cwd(), rest.includes('--json'), rest.includes('--full'));
            break;
        }
        case 'drift':
            process.exitCode = runDrift(process.cwd());
            break;
        case 'reindex':
            await cmdReindex();
            break;
        case 'list':
            cmdList();
            break;
        case 'show':
            if (!args[0]) {
                console.error('Usage: guard-decisions show <slug>');
                process.exit(1);
            }
            cmdShow(args[0]);
            break;
        case 'check':
            if (!args[0]) {
                console.error('Usage: guard-decisions check <slug>');
                process.exit(1);
            }
            process.exit(checkExists(args[0]) ? 0 : 1);
            break;
        default:
            console.error('Commands: add | amend | rescope | query | drift | reindex | list | show | check');
            process.exit(1);
    }
}
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
    main(process.argv.slice(2)).catch((e) => {
        console.error(`decisions: ${e?.message ?? e}`);
        process.exit(1);
    });
}
