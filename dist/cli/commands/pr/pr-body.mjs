/** `devkit pr-body` — replace a PR's description without deleting ship's evidence block. */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { LockHeldError } from '../../../gate-engine/judge/process/process-lock.mjs';
import { prIn } from '../../lib/ship/evidence/attach.mjs';
import { readPull, replaceCallerText } from '../../lib/ship/evidence/pr-body.mjs';
import { withPrEvidenceLock } from '../../lib/ship/evidence/publish-media.mjs';
import { errorMessage } from '../../lib/ship/review/shared/common.mjs';
import { originRepo } from '../../lib/ship/ship-intent-codec.mjs';
const USAGE = 'usage: devkit pr-body <pr-number|pr-url> --body-file <file|->';
const NOT_CHANGED = 'the PR description was not changed';
const say = (line) => console.error(`devkit pr-body: ${line}`);
export const meta = {
    name: 'pr-body',
    agentFacing: true,
    summary: "Replace a PR's description, keeping the evidence block devkit ship wrote.",
    valueFlags: ['--body-file'],
    help: `devkit pr-body — replace a PR's description without deleting ship's evidence block.

Usage:
  devkit pr-body <pr-number|pr-url> --body-file <file|->

The new text replaces everything you wrote. The PR's <!-- devkit:evidence:begin --> … end block is
carried below it unchanged, a block pasted into the new text is dropped, and anything else below the
block (a bot summary) is not carried. No commit, push or gate runs. While a devkit ship on this
machine is still writing the PR's evidence it refuses and changes nothing; a writer elsewhere can
still race it, because GitHub has no compare-and-set on a PR body.

\`gh pr edit --body-file\` replaces the whole description and deletes the evidence block.

Exit codes:
  0  the description was written, or already matched
  1  usage error, or gh failed — the message says whether the description may have changed`,
};
/** Write under the PR's evidence lock, so a ship still publishing that PR is refused, never raced. */
function publish(cwd, repo, pr, caller) {
    let result;
    try {
        result = withPrEvidenceLock(cwd, { repo, pr }, () => replaceCallerText(repo, pr, caller), 0);
    }
    catch (error) {
        if (error instanceof LockHeldError) {
            say(`a devkit ship is publishing #${pr}'s evidence; ${NOT_CHANGED}, so rerun once it finishes`);
            return 1;
        }
        result = errorMessage(error);
    }
    if (result === 'written' || result === 'unchanged') {
        console.log(`PR #${pr} description ${result}; any devkit evidence block was kept`);
        return 0;
    }
    const why = result === 'contended' ? 'another writer kept changing the description' : result;
    say(`${why}; the PR description may have changed, so re-run devkit pr-body`);
    return 1;
}
export default function prBody(args, cwd) {
    let target;
    let file;
    try {
        const { values, positionals } = parseArgs({
            args,
            options: { 'body-file': { type: 'string' } },
            allowPositionals: true,
        });
        [target] = positionals;
        file = values['body-file'];
        if (!target || !file || positionals.length > 1)
            throw new Error('one PR and --body-file are required');
    }
    catch (error) {
        console.error(`devkit pr-body: ${errorMessage(error)}\n${USAGE}`);
        return 1;
    }
    const repo = originRepo(cwd);
    if (!repo) {
        say(`origin is not a GitHub remote; ${NOT_CHANGED}`);
        return 1;
    }
    const picked = prIn(repo, target);
    if ('reason' in picked) {
        say(`${picked.reason}; ${NOT_CHANGED}`);
        return 1;
    }
    let caller;
    try {
        caller = readFileSync(file === '-' ? 0 : file, 'utf8');
        readPull(repo, picked.pr); // a PR that cannot be read is refused before any write
    }
    catch (error) {
        say(`${errorMessage(error)}; ${NOT_CHANGED}`);
        return 1;
    }
    return publish(cwd, repo, picked.pr, caller);
}
