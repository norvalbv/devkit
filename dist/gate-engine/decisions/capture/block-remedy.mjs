// The decision gate's recorded-Target context, and the remedy it prints when a smell stays blocked.
// The remedy names the honest route: a Target scoped to the changed files, then a re-run.
import { spawnSync } from 'node:child_process';
const UNAVAILABLE = '## RECORDED TARGETS — UNAVAILABLE\nDecision log could not be read. Judge the diff without assuming prior approval.';
export async function loadRecordedTargets(files, cwd) {
    try {
        const [{ scopedTargets }, { renderTargets }] = await Promise.all([
            import('../scoped-targets.mjs'),
            import('../../review/evidence/targets-block.mjs'),
        ]);
        const blocks = await scopedTargets(files, '', 6, cwd);
        const text = renderTargets(blocks, {
            header: '## RECORDED TARGETS (current rulings matching changed files)',
            skipHeader: '## RECORDED TARGETS — NONE',
            skipNote: 'No scoped Target matches. Judge the diff without assuming prior approval.',
        }, 4096);
        return { slugs: blocks.map((b) => b.slug), text };
    }
    catch {
        return { slugs: null, text: UNAVAILABLE };
    }
}
// git check-ignore exits 1 only for a path it would track: 0 means ignored, 128 a symlinked dir.
export function recordStageable(cwd, decisionsDir) {
    const probe = `${decisionsDir}/__probe__.md`;
    return (spawnSync('git', ['check-ignore', '-q', '--no-index', '--', probe], { cwd, stdio: 'ignore' })
        .status === 1);
}
/** The changed files behind the smells: a dep-change source names a dependency, not a file. */
export function smellFiles(sources, entries) {
    const files = entries.filter((e) => e.depChanged).map((e) => e.path);
    for (const s of sources)
        if (s.label !== 'dep-change')
            files.push(s.path);
    return [...new Set(files)];
}
export function renderBlockRemedy(r) {
    const governing = r.slugs === null
        ? 'Recorded Targets could not be read.'
        : r.slugs.length === 0
            ? 'No recorded Target is scoped to these files.'
            : `Targets scoped to these files: ${r.slugs.join(', ')}.`;
    const lines = [
        governing,
        `If this is a road-not-taken, record it: guard-decisions add <slug> --target "<ruling>" --scope "${r.files.join(',')}"`,
        `then re-run${r.judgeLive ? '' : ' with the judge available'}: the judge reads Targets scoped to the changed files and clears a change that implements one (a scope match alone is not approval).`,
        r.stageable
            ? `Or stage the record under ${r.decisionsDir}/ — a staged record clears this gate.`
            : `${r.decisionsDir} is git-ignored or linked here: do not stage the record; the re-run reads it from disk.`,
    ];
    return lines.map((l) => `   ${l}`);
}
