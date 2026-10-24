/** `devkit machine attach <pr>`: put a capture recorded after the ship into the PR now, through ship's
 * own QA step and its rules. QA stays advisory, so this is the agent's explicit act, never a gate. */
import { execFileSync, spawnSync } from 'node:child_process';
import { z } from 'zod';
import { LockHeldError } from '../../../../gate-engine/judge/process/process-lock.mjs';
import { evidenceDir, readManifest } from '../../machine/manifest.mjs';
import { errorMessage } from '../review/shared/common.mjs';
import { originRepo } from '../ship-intent-codec.mjs';
import { publishMedia, withPrEvidenceLock } from './publish-media.mjs';
const PR_NUMBER = /^[1-9]\d*$/;
const PR_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)(?:[/?#].*)?$/;
const pullSchema = z.object({
    state: z.string(),
    title: z.string(),
    headRefOid: z.string(),
    baseRefOid: z.string(),
    baseRefName: z.string(),
});
const say = (line) => console.error(`devkit machine attach: ${line}`);
/** The PR number `target` names in origin's repo, which is the repo devkit ship pushes to. */
function prIn(repo, target) {
    if (!target)
        return { reason: 'usage: devkit machine attach <pr-number|pr-url>' };
    if (PR_NUMBER.test(target))
        return { pr: target };
    const url = PR_URL.exec(target);
    if (!url)
        return { reason: `"${target}" is neither a PR number nor a github.com PR URL` };
    if (url[1].toLowerCase() !== repo.toLowerCase())
        return { reason: `${target} is not in ${repo}, the repo devkit ship pushes to (origin)` };
    return { pr: url[2] };
}
/** Fetch the PR's head and base commits when this clone lacks either (GitHub made a newer one). */
function ensureCommits(root, pr, pull) {
    const has = (rev) => spawnSync('git', ['cat-file', '-e', `${rev}^{commit}`], { cwd: root }).status === 0;
    if (has(pull.headRefOid) && has(pull.baseRefOid))
        return;
    const base = `+refs/heads/${pull.baseRefName}:refs/remotes/origin/${pull.baseRefName}`;
    const fetch = ['fetch', '--quiet', 'origin', base, `refs/pull/${pr}/head`];
    execFileSync('git', fetch, { cwd: root, stdio: 'ignore', timeout: 120_000 });
}
function report(pr, title, result) {
    if (!result) {
        say(`nothing to attach to #${pr}`);
        return 1;
    }
    if (result.attached.length)
        say(`attached to #${pr} "${title}": ${result.attached.join(', ')}`);
    if (result.present.length)
        say(`already in #${pr}: ${result.present.join(', ')}`);
    for (const note of result.notes)
        say(`not attached: ${note}`);
    const shown = result.attached.length + result.present.length;
    return shown > 0 && result.missing.length === 0 ? 0 : 1;
}
const isMissingBinary = (cause) => cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
/** Attach this worktree's passing capture to PR `target`; 0 once every apt capture is in it. */
export function attachCapture(root, target) {
    const repo = originRepo(root);
    if (!repo) {
        say('origin is not a GitHub repo, so there is no PR to attach to');
        return 1;
    }
    const picked = prIn(repo, target);
    if ('reason' in picked) {
        say(picked.reason);
        return 1;
    }
    const { pr } = picked;
    try {
        if (readManifest(evidenceDir(root)).length === 0) {
            say('no capture in this worktree: run `devkit machine up`, then `devkit machine run <flow>`');
            return 1;
        }
        const fields = ['--json', 'state,title,headRefOid,baseRefOid,baseRefName'];
        const view = execFileSync('gh', ['pr', 'view', pr, '--repo', repo, ...fields], {
            encoding: 'utf8',
            timeout: 60_000,
        });
        const pull = pullSchema.parse(JSON.parse(view));
        if (pull.state !== 'OPEN') {
            say(`#${pr} is ${pull.state.toLowerCase()}, so nothing is attached`);
            return 1;
        }
        ensureCommits(root, pr, pull);
        const publish = () => publishMedia({ source: root, repo, pr, head: pull.headRefOid }, { picksOnly: true });
        return report(pr, pull.title, withPrEvidenceLock(root, { repo, pr }, publish, 0));
    }
    catch (cause) {
        if (cause instanceof LockHeldError)
            say(`a devkit ship is publishing #${pr}'s evidence; rerun attach once it finishes`);
        else if (isMissingBinary(cause))
            say('gh is not installed; install the GitHub CLI and run `gh auth login`');
        else
            say(errorMessage(cause));
        return 1;
    }
}
