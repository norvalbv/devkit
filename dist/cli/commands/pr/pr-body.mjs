/** `devkit pr-body` — replace a PR's description without deleting ship's evidence block. */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { readPull, replaceCallerText } from '../../lib/ship/evidence/pr-body.mjs';
import { errorMessage } from '../../lib/ship/review/shared/common.mjs';
import { originRepo } from '../../lib/ship/ship-intent-codec.mjs';
const USAGE = 'usage: devkit pr-body <pr|branch|url> --body-file <file|->';
export const meta = {
    name: 'pr-body',
    agentFacing: true,
    summary: "Replace a PR's description, keeping the evidence block devkit ship wrote.",
    valueFlags: ['--body-file'],
    help: `devkit pr-body — replace a PR's description without deleting ship's evidence block.

Usage:
  devkit pr-body <pr|branch|url> --body-file <file|->

The new text replaces everything you wrote. The PR's <!-- devkit:evidence:begin --> … end block is
carried below it unchanged, a block pasted into the new text is dropped, and anything else below the
block (a bot summary) is not carried. No commit, push or gate runs. Run it after devkit ship returns:
an evidence step still running can write over an edit made while it runs.

\`gh pr edit --body-file\` replaces the whole description and deletes the evidence block.

Exit codes:
  0  the description was written, or already matched
  1  usage error, or gh failed — the message says whether the description may have changed`,
};
export default function prBody(args, cwd) {
    let pr;
    let file;
    try {
        const { values, positionals } = parseArgs({
            args,
            options: { 'body-file': { type: 'string' } },
            allowPositionals: true,
        });
        [pr] = positionals;
        file = values['body-file'];
        if (!pr || !file || positionals.length > 1)
            throw new Error('one PR and --body-file are required');
    }
    catch (error) {
        console.error(`devkit pr-body: ${errorMessage(error)}\n${USAGE}`);
        return 1;
    }
    const repo = originRepo(cwd);
    if (!repo) {
        console.error('devkit pr-body: origin is not a GitHub remote; the description was not changed');
        return 1;
    }
    let caller;
    try {
        caller = readFileSync(file === '-' ? 0 : file, 'utf8');
        readPull(repo, pr); // a PR that cannot be read is refused before any write
    }
    catch (error) {
        console.error(`devkit pr-body: ${errorMessage(error)}; the PR description was not changed`);
        return 1;
    }
    let result;
    try {
        result = replaceCallerText(repo, pr, caller);
    }
    catch (error) {
        result = errorMessage(error);
    }
    if (result === 'written' || result === 'unchanged') {
        console.log(`PR ${pr} description ${result}; any devkit evidence block was kept`);
        return 0;
    }
    console.error(`devkit pr-body: ${result === 'contended' ? 'another writer kept changing the description' : result}; the PR description may have changed, so re-run devkit pr-body`);
    return 1;
}
