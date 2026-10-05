/**
 * The runs that can answer for a branch: its GitHub head's first-parent commits, looked up by sha.
 *
 * Distance from the head is then a fact about git, not about how fresh GitHub's run listing is.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gitRunner, line, ok } from '../ship/base-drift/git-run.mjs';
import { GhUnavailable, branchHead, runsForCommit } from './gh.mjs';
/** git's stdout, or null when it failed; the runner is bounded by a timeout and never prompts. */
function git(cwd, args) {
    const result = gitRunner(cwd)(args);
    return ok(result) ? line(result).trim() : null;
}
/** Runs newest-first across the head's first-parent history, looked up one commit at a time. */
export class BranchWalk {
    head;
    commitsWithoutRun = [];
    /** null when the head is not in this checkout; the first lookup then reports it. */
    commits;
    runs = [];
    opts;
    looked = 0;
    constructor(opts) {
        this.opts = opts;
        this.head = branchHead({ cwd: opts.cwd, ref: opts.ref });
        const list = git(opts.cwd, [
            'rev-list',
            '--first-parent',
            `--max-count=${opts.maxCommits}`,
            this.head,
        ]);
        this.commits = list === null ? null : list.split('\n').filter(Boolean);
    }
    /** The i-th run, fetching the next commit's runs only once every earlier run has been consumed. */
    at(i) {
        if (this.commits === null) {
            throw new GhUnavailable('history-unavailable', `${this.opts.ref} head ${this.head.slice(0, 8)} is not in this checkout`);
        }
        while (this.runs.length <= i && this.looked < this.commits.length) {
            const behind = this.looked;
            const sha = this.commits[behind] ?? '';
            const found = runsForCommit({ ...this.opts, sha });
            this.looked++;
            if (found.length === 0)
                this.commitsWithoutRun.push(sha);
            for (const run of found)
                this.runs.push({ run, behind });
        }
        return this.runs[i];
    }
    /** How many commits have been looked up so far. */
    get commitsLooked() {
        return this.looked;
    }
    /** The walk ran out before --max-runs at a shallow cut of THIS history, not a shallow elsewhere. */
    endedAtShallowBoundary() {
        const last = this.commits?.at(-1);
        const path = git(this.opts.cwd, ['rev-parse', '--git-path', 'shallow']);
        if (!last || (this.commits?.length ?? 0) >= this.opts.maxCommits || !path)
            return false;
        try {
            return readFileSync(resolve(this.opts.cwd, path), 'utf8').split('\n').includes(last);
        }
        catch {
            return false; // no shallow file: the clone is complete
        }
    }
}
