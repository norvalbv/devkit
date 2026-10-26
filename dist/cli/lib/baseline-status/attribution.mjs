/**
 * Which of a red PR's failures its base already had: the PR run's per-file summary against the run
 * on its merge commit's first parent. Never guesses; an unreadable input is a named reason.
 */
import { unhandledKey, } from '../../../gate-engine/coverage/unhandled-reporter.mjs';
import { GhUnavailable, commitCi, gh, runById, runView } from './gh.mjs';
import { configuredSource, loadSummary, workflowSelector } from './source.mjs';
/** Listed values per field; past this the line says `+N` rather than growing without bound. */
const LIST_CAP = 5;
const own = (map, key) => map && Object.hasOwn(map, key) ? map[key] : undefined;
/**
 * Both-failed is inherited only on complete, non-empty name lists: an import error records no names.
 * A failed name the base lists as PASSED is new whatever else is truncated.
 */
export function classifyFile(file, pr, base) {
    if (own(base.files, file) !== 'failed')
        return 'fresh';
    const p = own(pr.tests, file);
    const b = own(base.tests, file);
    const complete = (t) => !!t && !t.truncated && t.failed.length > 0;
    if (p?.failed.some((name) => b?.passed.includes(name)))
        return 'fresh';
    if (!complete(p) || !complete(b))
        return 'unsure';
    return p.failed.every((name) => b.failed.includes(name)) ? 'inherited' : 'fresh';
}
/** Every file the PR run failed, bucketed against the base run. */
export function compareSummaries(pr, base) {
    const out = { inherited: [], fresh: [], unsure: [] };
    for (const [file, outcome] of Object.entries(pr.files)) {
        if (outcome === 'failed')
            out[classifyFile(file, pr, base)].push(file);
    }
    return out;
}
/** `inherited-only` is earned: no new or unsure file, no new failing step or outside-test error, no
 * check left unread. `extraUnhandled` is null when either run did not record its errors. */
export function attributionToken(files, newSteps, unattributed, extraUnhandled) {
    if ([files.fresh, newSteps, extraUnhandled ?? []].some((list) => list.length > 0))
        return 'new';
    const unread = extraUnhandled === null || [files.unsure, unattributed].some((l) => l.length > 0);
    return unread ? 'unknown' : 'inherited-only';
}
/**
 * The PR's outside-test errors its base lacks, by file + message. Null when that is unproven: either
 * run unrecorded, the base list truncated, or nothing new among a truncated PR list's shown errors.
 */
export function newUnhandled(pr, base) {
    const { unhandled: p } = pr;
    if (p?.errors.length === 0 && !p.truncated)
        return [];
    return p && base.unhandled && !base.unhandled.truncated ? unlisted(p, base.unhandled) : null;
}
/** `pr`'s errors missing from a complete `base` list; null when only a truncated tail could hold one. */
function unlisted(pr, base) {
    const known = new Set(base.errors.map(unhandledKey));
    const fresh = pr.errors.filter((e) => !known.has(unhandledKey(e)));
    return fresh.length > 0 || !pr.truncated ? fresh : null;
}
/** A shard of `shardJob` (GitHub names each `<job> (<matrix values>)`) keys on its step number, so a
 * failure that moved shard matches whatever the step is named; any other step keys on its label. */
export function stepKey(step, shardJob) {
    const shard = step.job.startsWith(`${shardJob} (`) && step.step !== null;
    return shard ? `${shardJob} › #${step.step}` : step.label;
}
/**
 * The PR's failing steps the base did not fail. A shard that moved may match one unmatched base
 * failure of its key, once per inherited file not already explaining an exact match.
 */
export function newFailingSteps(pr, base, inheritedFiles, shardJob) {
    const exact = new Set(base.map((b) => b.label).filter((l) => pr.some((p) => p.label === l)));
    const spare = base.filter((b) => !exact.has(b.label)).map((b) => stepKey(b, shardJob));
    const exactShards = pr.filter((p) => exact.has(p.label) && stepKey(p, shardJob) !== p.label);
    let moves = inheritedFiles - exactShards.length;
    return pr
        .filter((step) => !exact.has(step.label))
        .filter((step) => {
        const at = moves > 0 ? spare.indexOf(stepKey(step, shardJob)) : -1;
        if (at !== -1) {
            spare.splice(at, 1);
            moves--;
        }
        return at === -1;
    })
        .map((step) => step.label);
}
/** One verdict-line value: whitespace collapsed (the line is grepped line-wise), capped, or `none`. */
export function capped(values) {
    if (values.length === 0)
        return 'none';
    const shown = values.slice(0, LIST_CAP).map((v) => v.replace(/\s+/g, ' ').trim());
    const rest = values.length - shown.length;
    return rest > 0 ? `${shown.join(',')},+${rest}` : shown.join(',');
}
/** The verdict-line field for outside-test errors: absent when the PR added none. `truncated` marks a
 * comparison a capped list cut short, or a new count that is only a floor. */
function unhandledField(extra, pr, base) {
    if (extra === null)
        return pr && base ? ' unhandled=truncated' : ' unhandled=unrecorded';
    if (extra.length === 0)
        return '';
    return ` unhandled=+${extra.length}${pr?.truncated ? ',truncated' : ''}`;
}
const unknown = (reason, base = '') => ({
    token: 'unknown',
    inherited: null,
    fresh: null,
    line: `attribution=unknown reason=${reason}${base}`,
});
const RUN_ID = /\/actions\/runs\/(\d+)/;
/** The run a failing check links to, or null for a check that is not a GitHub Actions job. */
const runIdOf = (row) => {
    const id = RUN_ID.exec(row.link)?.[1];
    return id ? Number(id) : null;
};
/** The failing checks' run that belongs to the configured workflow, with its attempt. */
function workflowRun(cwd, failures, workflow) {
    for (const id of new Set(failures.map(runIdOf))) {
        if (id === null)
            continue;
        const run = runById(cwd, id);
        if (workflowSelector(run.path) === workflow)
            return run;
    }
    return null;
}
/**
 * Attribute a failed PR's checks. Every gh call resolves the repository from `cwd`, so the PR, its
 * runs and the base run can never come from two different remotes.
 */
export function attributeFailures({ cwd, pr, failures, }) {
    const { workflow, artifact, shardJob } = configuredSource(cwd);
    let base = ''; // named once known, so a later unreadable artifact still reports the base's state
    try {
        const run = workflowRun(cwd, failures, workflow);
        if (!run)
            return unknown('no-workflow-run');
        const unattributed = failures.filter((f) => runIdOf(f) !== run.databaseId).map((f) => f.name);
        const prSummary = loadSummary({ cwd, run, artifact });
        if (!prSummary.sha)
            return unknown('base-unknown');
        const ref = gh(['pr', 'view', pr, '--json', 'baseRefName', '--jq', '.baseRefName'], cwd).trim();
        const sha = gh(['api', `repos/{owner}/{repo}/commits/${prSummary.sha}`, '--jq', '.parents[0].sha'], cwd).trim();
        if (!ref || !sha)
            return unknown('base-unknown');
        const ci = commitCi({ cwd, workflow, ref, sha });
        if (!ci.run || !ci.failing)
            return unknown(`base-${ci.verdict}`);
        base = ` base-run=${ci.run.databaseId} base-ci=${ci.verdict}`;
        const baseSummary = loadSummary({ cwd, run: ci.run, artifact });
        const files = compareSummaries(prSummary, baseSummary);
        const prSteps = runView(cwd, run.databaseId).failing;
        const newSteps = newFailingSteps(prSteps, ci.failing, files.inherited.length, shardJob);
        const extraUnhandled = newUnhandled(prSummary, baseSummary);
        const token = attributionToken(files, newSteps, unattributed, extraUnhandled);
        const unsure = files.unsure.length > 0 ? ` unsure=${files.unsure.length}` : '';
        const other = unattributed.length > 0 ? ` unattributed=${capped(unattributed)}` : '';
        return {
            token,
            inherited: files.inherited.length,
            fresh: files.fresh.length,
            line: `attribution=${token} inherited=${files.inherited.length} new=${files.fresh.length}${unsure}` +
                ` new-failing=${capped(files.fresh)} new-steps=${capped(newSteps)}` +
                `${unhandledField(extraUnhandled, prSummary.unhandled, baseSummary.unhandled)}${other}${base}`,
        };
    }
    catch (e) {
        if (e instanceof GhUnavailable)
            return unknown(e.reason, base);
        throw e;
    }
}
