/**
 * The runs that can answer for a branch: its GitHub head's first-parent commits, looked up by sha.
 *
 * Distance from the head is then a fact about git, not about how fresh GitHub's run listing is.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gitRunner, line, ok } from '../ship/base-drift/git-run.mts';
import { GhUnavailable, type RunRef, branchHead, runsForCommit } from './gh.mts';

/** A run, and how many first-parent commits its commit sits behind the branch head. */
export interface WalkedRun {
  run: RunRef;
  behind: number;
}

/** git's stdout, or null when it failed; the runner is bounded by a timeout and never prompts. */
function git(cwd: string, args: string[]): string | null {
  const result = gitRunner(cwd)(args);
  return ok(result) ? line(result).trim() : null;
}

/** `at` anchors the walk at a local commit (a PR's base) instead of the branch's GitHub head. */
interface WalkOptions {
  cwd: string;
  workflow: string;
  ref: string;
  maxCommits: number;
  at?: string;
}

/** `at` as a full commit sha; a revspec this checkout cannot resolve is a history fact, not a guess. */
function anchor(cwd: string, at: string): string {
  const sha = git(cwd, ['rev-parse', '--verify', '--quiet', `${at}^{commit}`]);
  if (sha) return sha;
  throw new GhUnavailable('history-unavailable', `--at ${at} is not a commit in this checkout`);
}

/** Runs newest-first across the head's first-parent history, looked up one commit at a time. */
export class BranchWalk {
  readonly head: string;
  readonly commitsWithoutRun: string[] = [];
  /** null when the head is not in this checkout; the first lookup then reports it. */
  private readonly commits: string[] | null;
  private readonly runs: WalkedRun[] = [];
  private readonly opts: WalkOptions;
  private looked = 0;

  constructor(opts: WalkOptions) {
    this.opts = opts;
    this.head = opts.at ? anchor(opts.cwd, opts.at) : branchHead({ cwd: opts.cwd, ref: opts.ref });
    const list = git(opts.cwd, [
      'rev-list',
      '--first-parent',
      `--max-count=${opts.maxCommits}`,
      this.head,
    ]);
    this.commits = list === null ? null : list.split('\n').filter(Boolean);
  }

  /** The i-th run, fetching the next commit's runs only once every earlier run has been consumed. */
  at(i: number): WalkedRun | undefined {
    if (this.commits === null) {
      throw new GhUnavailable(
        'history-unavailable',
        `${this.opts.ref} head ${this.head.slice(0, 8)} is not in this checkout`,
      );
    }
    while (this.runs.length <= i && this.looked < this.commits.length) {
      const behind = this.looked;
      const sha = this.commits[behind] ?? '';
      const found = runsForCommit({ ...this.opts, sha });
      this.looked++;
      if (found.length === 0) this.commitsWithoutRun.push(sha);
      for (const run of found) this.runs.push({ run, behind });
    }
    return this.runs[i];
  }

  /** How many commits have been looked up so far. */
  get commitsLooked(): number {
    return this.looked;
  }

  /** The walk ran out before --max-runs at a shallow cut of THIS history, not a shallow elsewhere. */
  endedAtShallowBoundary(): boolean {
    const last = this.commits?.at(-1);
    const path = git(this.opts.cwd, ['rev-parse', '--git-path', 'shallow']);
    if (!last || (this.commits?.length ?? 0) >= this.opts.maxCommits || !path) return false;
    try {
      return readFileSync(resolve(this.opts.cwd, path), 'utf8').split('\n').includes(last);
    } catch {
      return false; // no shallow file: the clone is complete
    }
  }
}
