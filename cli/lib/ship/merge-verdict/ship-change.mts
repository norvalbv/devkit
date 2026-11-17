// The merge verdict for a published PR head, from facts ship holds when it writes the evidence
// block. Advisory only. Never throws: a fact it cannot read leaves the verdict unavailable, and why.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILENAME } from '../../../../gate-engine/config.mts';
import { telemetrySink } from '../../../../gate-engine/judge/run-context.mts';
import { type PrintedVerdict, VERDICT_LABEL, verdictUnavailable } from '../evidence/block.mts';
import type { EvidenceOutcome } from '../evidence/outcome.mts';
import { prBase } from '../evidence/red-ref.mts';
import { errorMessage, gitEnvironment } from '../review/shared/common.mts';
import { type PrCommit, shipBypasses } from './bypasses.mts';
import {
  type ChangedPath,
  mergeVerdict,
  VERDICT_MARK,
  verdictEnabled,
  verdictReasons,
} from './verdict.mts';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: gitEnvironment(),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const count = (field: string | undefined): number | null =>
  field === '-' || field === undefined ? null : Number(field);

/** One `added<TAB>deleted<TAB>path` record per NUL; a binary file counts `-`, read as null. */
export function numstat(cwd: string, base: string, head: string): ChangedPath[] {
  const out = git(cwd, ['diff', '--numstat', '-z', '--no-renames', base, head]);
  return out
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const [added, deleted, ...path] = record.split('\t');
      return { path: path.join('\t'), added: count(added), deleted: count(deleted) };
    });
}

/** The commits since the PR base, each with its committer time in ms. */
function prCommits(cwd: string, base: string, head: string): PrCommit[] {
  return git(cwd, ['log', '--format=%H %ct', `${base}..${head}`])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', seconds] = line.split(' ');
      return { sha, committedMs: Number(seconds) * 1000 };
    });
}

/** The base tree's policy, so a PR cannot loosen its own verdict. The checkout's copy stands in only
 * when base has none: a PR that adds or edits the file reads as policy whatever it says. */
function policyText(cwd: string, base: string): string | null {
  try {
    return git(cwd, ['show', `${base}:./${CONFIG_FILENAME}`]);
  } catch {
    try {
      return readFileSync(join(cwd, CONFIG_FILENAME), 'utf8');
    } catch {
      return null;
    }
  }
}

export interface VerdictInput {
  cwd: string;
  head: string;
  baseRefOid: string;
  title: string | undefined;
  outcome: EvidenceOutcome;
  /** Ship's environment, taken before the evidence run clears DEVKIT_* from process.env. */
  env: NodeJS.ProcessEnv;
}

/** Undefined when the policy sets `mergeVerdict.enabled: false`: the block then has no verdict line. */
export function printVerdict(input: VerdictInput): PrintedVerdict | undefined {
  const { cwd, head, baseRefOid, title, outcome, env } = input;
  try {
    const base = prBase(cwd, baseRefOid, head);
    const policy = policyText(cwd, base);
    if (!verdictEnabled(policy)) return undefined;
    if (title === undefined) throw new Error('the PR title was not read');
    const change = {
      headSha: head,
      subject: title,
      paths: numstat(cwd, base, head),
      bypasses: shipBypasses(telemetrySink(env), prCommits(cwd, base, head)),
      evidence: outcome,
    };
    const verdict = mergeVerdict(change, policy);
    const mark = `${VERDICT_MARK[verdict.verdict]} ${verdict.verdict}`;
    const line = `${VERDICT_LABEL} ${mark} · advisory, at \`${head.slice(0, 12)}\``;
    return { line, reasons: verdictReasons(verdict), verdict };
  } catch (error) {
    return verdictUnavailable(errorMessage(error));
  }
}
