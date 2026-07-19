#!/usr/bin/env node
/**
 * `guard-decisions scoped-targets --files <a,b> [--query "<text>" --top <k>]`
 *
 * Emits (as JSON to stdout) the recorded Targets that GOVERN a change — so a consumer's critique-prep
 * step can load the governing spec by shelling out, instead of importing devkit's decision internals
 * as a package (the dev-guardrails-distribution re-target: devkit is a CLI on PATH, not an npm dep).
 *
 * Two sources, exactly mirroring what prep-critique used to compute in-process:
 *   - DETERMINISTIC scope-match (primary): every Target whose `**Scope:**` glob covers a changed file.
 *   - SEMANTIC supplement (when --query is given): the top-k ranked axes NOT already scope-matched,
 *     with their current ruling read from the axis file.
 *
 * Output: a JSON array of { slug, ruling, scope, via: 'scope-match'|'semantic' }. Empty array when
 * nothing governs. Fail-open: any error → exit 2 with `[]` so the consumer degrades to a SKIP note.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveFromCwd, resolveGuardConfig } from '../config.mjs';
import { loadScopedTargets, matchScope } from './check-alignment.mjs';
import { currentTarget, parseDecision, rankAxes } from './decisions.mjs';
// The current Target's full ruling + scope for an axis, read from its file (not the clamped INDEX row).
function rulingFor(slug, decisionsDir) {
    const file = path.join(decisionsDir, `${slug}.md`);
    if (!existsSync(file))
        return null;
    const t = currentTarget(parseDecision(readFileSync(file, 'utf8')).body);
    if (!t?.ruling)
        return null;
    return { ruling: t.ruling, scope: t.scope ?? null };
}
/**
 * @param files changed files (scope-match key)
 * @param query free-text (plan terms) for the semantic supplement; '' skips it
 * @param k semantic top-k
 */
export async function scopedTargets(files, query, k = 6, cwd = process.cwd()) {
    const decisionsDir = resolveFromCwd(resolveGuardConfig(cwd), 'decisionsDir');
    if (decisionsDir == null)
        return []; // fail-open: nothing resolvable → nothing governs
    const scoped = files.length
        ? loadScopedTargets(decisionsDir).filter((t) => matchScope(files, t.scopeGlobs))
        : [];
    const scopedSlugs = new Set(scoped.map((t) => t.slug));
    const blocks = scoped.map((t) => ({
        slug: t.slug,
        ruling: t.ruling,
        scope: t.scopeGlobs.join(', '),
        via: 'scope-match',
    }));
    if (query?.trim()) {
        const { rows } = await rankAxes(query, k, cwd);
        for (const r of rows) {
            if (scopedSlugs.has(r.slug))
                continue;
            const rf = rulingFor(r.slug, decisionsDir);
            if (rf)
                blocks.push({ slug: r.slug, ruling: rf.ruling, scope: rf.scope, via: 'semantic' });
        }
    }
    return blocks;
}
function flag(args, name) {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
}
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
    const args = process.argv.slice(2);
    const files = (flag(args, '--files') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const query = flag(args, '--query') ?? '';
    const top = Number.parseInt(flag(args, '--top') ?? '6', 10) || 6;
    scopedTargets(files, query, top)
        .then((blocks) => process.stdout.write(JSON.stringify(blocks)))
        .catch((e) => {
        // Fail-open: emit [] so a consumer's prep step degrades to a SKIP note, never an error.
        console.error(`scoped-targets: ${e?.message ?? e}`);
        process.stdout.write('[]');
        process.exit(2);
    });
}
