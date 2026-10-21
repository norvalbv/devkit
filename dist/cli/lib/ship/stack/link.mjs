#!/usr/bin/env node
/**
 * `link.mjs <owner/repo> <pr-number>` — after ship opens a PR whose base branch is itself an open
 * PR, registers both in a GitHub native stack through the Stacks REST API. Best-effort, stderr only.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { appendShipRow } from '../telemetry/row.mjs';
/** Per-call cap: this runs after the PR is open, so a hung gh must not hold the ship's exit. */
const GH_TIMEOUT_MS = 30_000;
const pullSchema = z.object({
    number: z.number(),
    stack: z.object({ number: z.number(), position: z.number(), size: z.number() }).nullish(),
    base: z.object({
        ref: z.string(),
        repo: z.object({
            full_name: z.string(),
            default_branch: z.string(),
            owner: z.object({ login: z.string() }),
        }),
    }),
});
const pullsSchema = z.array(pullSchema);
const stackSchema = z.object({ number: z.number() });
const NONE = { outcome: 'none', lines: [] };
// stderr is inherited so gh's own error (404 not enabled, 422 ineligible) reaches the operator.
const runGh = (args, input) => {
    const r = spawnSync('gh', args, {
        input: input ?? '',
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'inherit'],
        timeout: GH_TIMEOUT_MS,
    });
    return { status: r.status, stdout: r.stdout ?? '' };
};
/** null when gh printed no JSON at all; `failed` when GitHub answered JSON of another shape. */
function readJson(stdout, schema) {
    let raw;
    try {
        raw = JSON.parse(stdout);
    }
    catch {
        return null;
    }
    const parsed = schema.safeParse(raw);
    return parsed.success ? parsed.data : 'failed';
}
/** `failed` when gh exited non-zero or timed out; otherwise what readJson makes of its answer. */
function ghJson(gh, args, schema) {
    const r = gh(args);
    return r.status === 0 ? readJson(r.stdout, schema) : 'failed';
}
function failed(pr, what, retry) {
    const tail = retry ? ` Retry: ${retry}` : '';
    return {
        outcome: 'failed',
        lines: [`ship: ${what} failed; #${pr} is open but not stacked.${tail}`],
    };
}
function skipped(parent, why) {
    return { outcome: 'skipped', parent, lines: [`ship: not stacked — ${why}`] };
}
/** Reads the new PR, then the open same-repo PR on its base; a StackResult ends the run early. */
function findParent(repo, pr, gh) {
    const own = ghJson(gh, ['api', `repos/${repo}/pulls/${pr}`], pullSchema);
    if (own === 'failed')
        return failed(pr, `reading #${pr}`);
    if (own === null)
        return NONE;
    if (own.stack)
        return {
            outcome: 'already',
            stack: own.stack.number,
            lines: [`ship: #${pr} is already in GitHub stack #${own.stack.number}`],
        };
    const { full_name: canonical, default_branch: trunk, owner } = own.base.repo;
    if (own.base.ref === trunk)
        return NONE;
    // owner:ref matches same-repo heads only: GitHub never lets a fork share its parent's owner.
    const head = `head=${owner.login}:${own.base.ref}`;
    const listArgs = ['api', '-X', 'GET', `repos/${canonical}/pulls`, '-f', head, '-f', 'state=open'];
    const parents = ghJson(gh, listArgs, pullsSchema);
    if (parents === 'failed')
        return failed(pr, `listing open PRs on '${own.base.ref}'`);
    if (parents === null || parents.length === 0)
        return NONE;
    if (parents.length > 1)
        return skipped(parents[0].number, `${parents.length} open PRs have head '${own.base.ref}'`);
    return { pull: parents[0], canonical, trunk };
}
/** Appends to the parent's stack or creates [parent, PR]; skips what a linear stack cannot hold. */
function joinParent(pr, { pull: parent, canonical, trunk }, gh) {
    if (parent.stack && parent.stack.position !== parent.stack.size)
        return skipped(parent.number, `#${parent.number} is mid-stack in GitHub stack #${parent.stack.number}, and stacks are linear`);
    if (!parent.stack && parent.base.ref !== trunk)
        return skipped(parent.number, `#${parent.number} targets '${parent.base.ref}', not '${trunk}'; link the chain bottom-up by hand: gh stack link <lower PRs…> ${parent.number} ${pr}`);
    const adding = parent.stack?.number;
    const path = adding ? `repos/${canonical}/stacks/${adding}/add` : `repos/${canonical}/stacks`;
    const members = adding ? [pr] : [parent.number, pr];
    const posted = gh(['api', '-X', 'POST', path, '--input', '-'], JSON.stringify({ pull_requests: members }));
    // The retry is this exact call: `gh stack link` reads a bare stack number as a PR on older versions.
    const fields = members.map((n) => `-F 'pull_requests[]=${n}'`).join(' ');
    if (posted.status !== 0)
        return failed(pr, adding ? `adding to stack #${adding}` : 'creating the stack', `gh api -X POST ${path} ${fields}`);
    const made = readJson(posted.stdout, stackSchema);
    const stack = made === null || made === 'failed' ? adding : made.number;
    const label = stack ? ` (GitHub stack #${stack})` : '';
    return {
        outcome: adding ? 'added' : 'created',
        parent: parent.number,
        stack,
        lines: [
            `ship: stacked #${pr} on #${parent.number}${label}; merging #${pr} now merges the PRs below it too (--no-stack opts out)`,
        ],
    };
}
/** One level only: the new PR joins its direct parent's stack, or a new [parent, PR] stack. */
export function linkStack(repo, pr, gh = runGh) {
    const found = findParent(repo, pr, gh);
    return 'outcome' in found ? found : joinParent(pr, found, gh);
}
/** The queryable twin of the stderr line, beside ship_pr on the same JSONL stream. */
export function recordStackEvent(result, pr, env = process.env) {
    const file = env.DEVKIT_GATE_EVENTS;
    const shipId = env.DEVKIT_SHIP_ID;
    if (!file || !shipId || result.outcome === 'none')
        return;
    const row = {
        type: 'ship_stack',
        ship_id: shipId,
        devkit_version: env.DEVKIT_TELEMETRY_VERSION ?? null,
        pr_number: pr,
        parent_pr: result.parent ?? null,
        stack_number: result.stack ?? null,
        outcome: result.outcome,
        ts: new Date().toISOString(),
    };
    appendShipRow(file, row, env);
}
function main(argv) {
    const [repo, prArg] = argv;
    const pr = Number(prArg);
    if (!repo || !Number.isInteger(pr) || pr <= 0) {
        console.error('stack-link: <owner/repo> <pr-number> required');
        return 1;
    }
    const result = linkStack(repo, pr);
    for (const line of result.lines)
        console.error(line);
    recordStackEvent(result, pr);
    return 0;
}
// Run only as a CLI entrypoint, realpath'd so the guard also fires through a symlink.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
    process.exit(main(process.argv.slice(2)));
