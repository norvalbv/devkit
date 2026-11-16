#!/usr/bin/env node
// Ship's PR-body steps, run by publish-evidence.sh. `budget` sizes the bound, `publish` writes the
// red/green block, `publish-media` the QA capture, `notes` advisories, `body` cleans caller text and
// adds the UI task item, and `ui-item` adds that item to an open PR whose body this ship did not write.
import { mkdtempSync, readFileSync, realpathSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveGuardConfig } from '../../../../gate-engine/config.mjs';
import { emitGateEvent } from '../../../../gate-engine/judge/gate-events.mjs';
import { clip } from '../../../../gate-engine/judge/odb-probe.mjs';
import { captureRegressionEvidence, } from '../../baseline-status/regression-proof.mjs';
import { prepareRegressionRepository, } from '../../baseline-status/regression-repository.mjs';
import { git } from '../../../../gate-engine/decisions/git-io.mjs';
import { instruction, UI_EVIDENCE, uiPathReason, } from '../../../../gate-engine/ui-evidence/check.mjs';
import { textOf } from '../digest/fields.mjs';
import { telemetrySink } from '../../../../gate-engine/judge/run-context.mjs';
import { ATTEMPT, readShipEvents } from '../digest/gate-digest.mjs';
import { readJson } from '../../fs-helpers.mjs';
import { errorMessage } from '../review/shared/common.mjs';
import { carryEvidenceBlock, readEvidenceBlock, renderEvidenceBlock, replaceKeepingSections, verdictUnavailable, } from './block.mjs';
import { expandCommand, readEvidenceConfig } from './config.mjs';
import { inconclusive, notRun, outcomeFromRegression } from './outcome.mjs';
import { publishBody, readPull } from './pr-body.mjs';
import { publishMedia, withPrEvidenceLock } from './publish-media.mjs';
import { buildRedCommit, classifyChange, prBase, treeOf } from './red-ref.mjs';
import { noteLines, upsertNotes } from './reviewer-notes.mjs';
import { withUiItem } from './ui-item.mjs';
/** Ship waits out a `devkit machine attach` on the same PR, whose upload is bounded at 300 s. */
const LOCK_WAIT_MS = 330_000;
const REPORT = '.devkit-evidence-report.json';
const SKIPPED_QUIET = `📸 ${UI_EVIDENCE}: the gates were skipped (an earlier run passed them), so only file paths were checked, and none is a UI file; if this change is visible, add before/after screenshots to the PR`;
const NO_OUTCOME = { status: null, reason: null, detail: null };
/** One row per completed run; a run without a ship id (by hand, or a test) records nothing. */
export function recordEvidenceEvent(published, run, now = Date.now()) {
    if (!process.env.DEVKIT_SHIP_ID)
        return;
    const { status, reason, detail } = published.outcome ?? NO_OUTCOME;
    emitGateEvent({
        type: 'ship_evidence',
        // Every caller passes a numeric PR; anything else serializes as null.
        pr_number: Number(run.pr),
        head: run.head,
        status,
        reason,
        detail: detail && clip(detail),
        test_files: published.tests,
        publish: published.publish,
        verdict: published.verdict,
        failed: run.failed,
        duration_s: Math.max(0, Math.round((now - run.startedMs) / 1000)),
    });
}
/** `setup 6s, red 212s`: each phase runs until the next one starts, the last until `now`. */
export function phaseTimes(marks, now) {
    return marks
        .map(({ name, at }, index) => {
        const end = marks[index + 1]?.at ?? now;
        return `${name} ${Math.round((end - at) / 1000)}s`;
    })
        .join(', ');
}
/** The capture's own SIGTERM path stops the test tree and removes both clones at the deadline. */
async function captureWithin(prepared, seconds) {
    // Monotonic, like the timer itself, so a wall-clock step cannot skew a phase or make it negative.
    const marks = [{ name: 'setup', at: performance.now() }];
    let stalled = null;
    const timer = setTimeout(() => {
        stalled = `${phaseTimes(marks, performance.now())} unfinished`;
        process.kill(process.pid, 'SIGTERM');
    }, seconds * 1000);
    try {
        const captured = await captureRegressionEvidence(prepared, (name) => marks.push({ name, at: performance.now() }));
        return { captured, timing: phaseTimes(marks, performance.now()) };
    }
    catch (error) {
        throw stalled ? new Error(`the tests did not finish within ${seconds}s (${stalled})`) : error;
    }
    finally {
        clearTimeout(timer);
    }
}
async function produce(cwd, head, baseRefOid, config) {
    const base = prBase(cwd, baseRefOid, head);
    const change = classifyChange(cwd, base, head, config.supportPaths);
    const tests = change.tests.length;
    const abstain = (reason, detail) => ({
        outcome: notRun(reason, detail, head, base),
        evidence: null,
        tests,
    });
    if (change.docsOnly)
        return abstain('docs-only', 'the PR changes only Markdown');
    if (tests === 0)
        return abstain('no-test-change', 'the PR adds or changes no test');
    const red = buildRedCommit(cwd, base, change.overlay);
    if (treeOf(cwd, red) === treeOf(cwd, head)) {
        const detail = 'the PR changes only test and support files, so red and green are one tree';
        return { outcome: inconclusive(detail, head, base), evidence: null, tests };
    }
    // Ship's own run env (mode, slot, telemetry sink) must not reach the consumer's test suite; it
    // comes back afterwards so this run's telemetry row still names the ship.
    const shipEnv = Object.entries(process.env).filter(([key]) => key.startsWith('DEVKIT_'));
    for (const [key] of shipEnv)
        delete process.env[key];
    try {
        const argv = expandCommand(config.command, change.tests, REPORT);
        console.error(`evidence: running ${tests} test file(s) on red and green (at most ${config.timeoutSeconds}s)`);
        const prepared = prepareRegressionRepository(['--red', red, '--green', head, '--vitest-report', REPORT, '--', ...argv], cwd);
        const { captured, timing } = await captureWithin(prepared, config.timeoutSeconds);
        const { evidence, evidenceDir } = captured;
        const outcome = outcomeFromRegression(evidence, head, base);
        return {
            outcome: { ...outcome, detail: `${outcome.detail} (${timing})` },
            evidence,
            tests,
            evidenceDir,
        };
    }
    catch (error) {
        return { ...notProduced(errorMessage(error), head), tests };
    }
    finally {
        Object.assign(process.env, Object.fromEntries(shipEnv));
    }
}
const notProduced = (why, head) => ({
    outcome: inconclusive(`evidence could not be produced: ${why}`, head, null),
    evidence: null,
    tests: null,
});
/** Loaded only once a block is being written, so a ship that writes none never pays for it. */
async function shipVerdict(input) {
    try {
        const { printVerdict } = await import('../merge-verdict/ship-change.mjs');
        return printVerdict(input);
    }
    catch (error) {
        return verdictUnavailable(errorMessage(error));
    }
}
function keepEvidence(dir, keepIn, captured) {
    if (!dir || !keepIn || captured)
        return;
    try {
        const kept = join(mkdtempSync(join(keepIn, 'devkit-evidence-kept-')), 'evidence');
        renameSync(dir, kept);
        console.error(`evidence: kept the red/green logs at ${kept}`);
    }
    catch (error) {
        console.error(`evidence: the red/green logs were not kept: ${errorMessage(error)}`);
    }
}
/** Null when no block was written for lack of an evidence entry. */
export async function publish(args) {
    const { cwd, repo, pr, head, failed } = args;
    const nothing = { outcome: null, tests: null, verdict: null };
    const pull = readPull(repo, pr);
    if (pull.headRefOid !== head) {
        console.error(`evidence: PR head is no longer ${head.slice(0, 12)}; nothing was published`);
        return { ...nothing, publish: 'head-moved' };
    }
    const current = readEvidenceBlock(pull.body, head);
    const redo = args.recapture === true && current?.stale === false && current.status === 'inconclusive';
    if (current?.stale === false && !redo) {
        const hint = current.status === 'inconclusive' ? `; re-capture it with devkit pr-evidence ${pr}` : '';
        console.error(`evidence: the PR body already records ${current.status} evidence for this head${hint}`);
        const verdict = current.mergeVerdict?.verdict ?? null;
        return { ...nothing, outcome: current, verdict, publish: 'unchanged' };
    }
    const config = readEvidenceConfig(cwd);
    if (!config)
        return null;
    const env = { ...process.env };
    let produced = {
        outcome: inconclusive(failed ?? '', head, null),
        evidence: null,
        tests: null,
    };
    if (!failed) {
        try {
            produced = await produce(cwd, head, pull.baseRefOid, config);
        }
        catch (error) {
            produced = notProduced(errorMessage(error), head);
        }
    }
    if (redo && current) {
        const detail = `${produced.outcome.detail} (recaptured; previously inconclusive: ${current.detail})`;
        produced.outcome = { ...produced.outcome, detail };
    }
    const { title, baseRefOid } = pull;
    const verdict = await shipVerdict({
        cwd,
        head,
        baseRefOid,
        title,
        outcome: produced.outcome,
        env,
    });
    const block = renderEvidenceBlock(produced.outcome, produced.evidence, verdict);
    const write = () => publishBody(repo, pr, head, (body) => replaceKeepingSections(body, block));
    const result = withPrEvidenceLock(cwd, { repo, pr }, write, LOCK_WAIT_MS);
    const { status, reason, detail } = produced.outcome;
    const edit = result === 'written'
        ? `; edit it with devkit pr-body ${pr} --body-file <f>, not gh pr edit`
        : '';
    console.error(`evidence: ${status}${reason ? ` (${reason})` : ''}: ${detail} [PR body ${result}${edit}]`);
    const { outcome, tests } = produced;
    keepEvidence(produced.evidenceDir, args.keepIn, status === 'captured');
    return { outcome, tests, publish: result, verdict: verdict?.verdict?.verdict ?? null };
}
/** This ship's reviewer advisories into the PR body; a ship whose reviewers raised none makes no gh call. */
function publishNotes(repo, pr, head, replace) {
    const events = readShipEvents(telemetrySink() ?? '', process.env.DEVKIT_SHIP_ID ?? '');
    const lines = noteLines(events, head);
    if (!lines.length)
        return;
    const write = () => publishBody(repo, pr, head, (body) => upsertNotes(body, lines, replace));
    const result = withPrEvidenceLock(process.cwd(), { repo, pr }, write, LOCK_WAIT_MS);
    console.error(`reviewer notes: ${lines.length} advisory row(s) [PR body ${result}]`);
}
/** This ship attempt's screenshot reminder, read from its own gate events; null when it was quiet. */
function uiEvidenceDetail(env) {
    const events = readShipEvents(env.DEVKIT_GATE_EVENTS ?? '', env.DEVKIT_SHIP_ID ?? '');
    // One ship id can span attempts: only rows after the newest marker are this run's. With no
    // marker the rows cannot be attributed, and a reminder that cannot tell stays quiet.
    const opened = events.map((e) => e.type).lastIndexOf(ATTEMPT);
    const mine = opened < 0 ? [] : events.slice(opened);
    const rows = mine.filter((e) => e.type === 'advisory_result' && e.gate === UI_EVIDENCE);
    // A sink row is arbitrary JSON, so a non-string detail reads as no reminder instead of throwing.
    return textOf(rows[rows.length - 1]?.detail) || null;
}
/** The reminder a gate-skipped run would have given: the model-free path rule over its commit. */
function skippedCommitDetail(cwd, commit) {
    const paths = git(cwd, ['diff', '--name-only', '-z', `${commit}^`, commit]).split('\0');
    const reason = uiPathReason(paths.filter(Boolean), resolveGuardConfig(cwd).uiEvidence.paths);
    return reason ? instruction(reason) : null;
}
/** Whether the repo installed the ui-evidence guard; a deselected one never reminds. */
function uiEvidenceSelected(cwd) {
    const record = readJson(join(cwd, '.devkit', 'config.json'));
    const guards = record?.components?.guards;
    return Array.isArray(guards) && guards.includes(UI_EVIDENCE);
}
/** Add the item to the open PR's own body; an item already there, ticked or not, is left alone. */
function publishUiItem(cwd, repo, pr, skipped) {
    if (skipped && !uiEvidenceSelected(cwd))
        return;
    const detail = skipped ? skippedCommitDetail(cwd, skipped) : uiEvidenceDetail(process.env);
    if (!detail) {
        if (skipped)
            console.error(SKIPPED_QUIET);
        return;
    }
    if (publishBody(repo, pr, null, (body) => withUiItem(body, body, detail)) === 'written') {
        console.error(`📸 ${UI_EVIDENCE}: added the screenshot task item to the PR`);
    }
}
function required(values, name) {
    const value = values[name];
    if (!value)
        throw new Error(`--${name} is required`);
    return value;
}
async function main(argv) {
    const [command, ...rest] = argv;
    if (command === 'budget') {
        process.stdout.write(`${readEvidenceConfig(rest[0] ?? '.')?.timeoutSeconds ?? 0}\n`);
        return;
    }
    const options = {
        cwd: { type: 'string' },
        repo: { type: 'string' },
        pr: { type: 'string' },
        head: { type: 'string' },
        failed: { type: 'string' },
        source: { type: 'string' },
        mode: { type: 'string' },
        started: { type: 'string' },
        'keep-in': { type: 'string' },
        'skipped-commit': { type: 'string' },
    };
    const { values } = parseArgs({ args: rest, options, strict: true });
    if (command === 'body') {
        const caller = readFileSync(0, 'utf8');
        const current = values.pr ? readPull(required(values, 'repo'), values.pr).body : '';
        const body = carryEvidenceBlock(caller, current);
        process.stdout.write(withUiItem(body, current, uiEvidenceDetail(process.env)));
        return;
    }
    if (command === 'ui-item') {
        const [cwd, repo, pr] = ['cwd', 'repo', 'pr'].map((name) => required(values, name));
        publishUiItem(cwd, repo, pr, values['skipped-commit']);
        return;
    }
    if (command === 'publish-media') {
        const [source, repo, pr] = [
            required(values, 'source'),
            required(values, 'repo'),
            required(values, 'pr'),
        ];
        const media = () => publishMedia({ source, repo, pr, head: required(values, 'head') });
        withPrEvidenceLock(source, { repo, pr }, media, LOCK_WAIT_MS);
        return;
    }
    if (command === 'notes') {
        const [repo, pr, head] = ['repo', 'pr', 'head'].map((name) => required(values, name));
        if (resolveGuardConfig(values.cwd ?? process.cwd()).review.prNotes !== false)
            publishNotes(repo, pr, head, values.mode === 'replace');
        return;
    }
    if (command !== 'publish')
        throw new Error('usage: run.mts budget <dir> | publish … | publish-media … | notes … | body … | ui-item …');
    // The step's start, from the shell, so a fallback run after a killed one times the whole step.
    const started = Number(values.started) * 1000;
    const run = {
        pr: required(values, 'pr'),
        head: required(values, 'head'),
        startedMs: Number.isFinite(started) && started > 0 ? started : Date.now(),
        failed: values.failed !== undefined,
    };
    const published = await publish({
        cwd: required(values, 'cwd'),
        repo: required(values, 'repo'),
        pr: run.pr,
        head: run.head,
        failed: values.failed,
        keepIn: values['keep-in'],
    });
    // Last, never in a finally: a run that throws exits 1 and its --failed fallback writes the row.
    if (published)
        recordEvidenceEvent(published, run);
}
async function runCli() {
    try {
        await main(process.argv.slice(2));
    }
    catch (error) {
        console.error(`evidence: ${errorMessage(error)}`);
        process.exitCode = 1;
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    void runCli();
}
