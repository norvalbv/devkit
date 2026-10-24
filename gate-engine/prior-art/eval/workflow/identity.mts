// prior-art workflow tier: per-case execution identity. Any input that shapes the agent call changes
// it; the scorer hash stays separate so a scoring change rescores banked streams without a call.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashLocalModuleClosure } from '../../../review/eval/module-closure-hash.mts';
import type { AgentSource } from '../../../review/reviewers.mts';
import type { Member } from './families.mts';
import { buildArgs, type Condition } from './run.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const PLACEHOLDER_WORKSPACE = { consumer: '<workspace>/consumer', refs: '<workspace>/refs' };

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** The installed Claude Code version, e.g. `2.1.302`; throws when the CLI is absent. */
export function claudeVersion(): string {
  const out = execFileSync('claude', ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const version = out.trim().split(/\s+/)[0];
  if (!version) throw new Error('claude --version printed nothing');
  return version;
}

/** User-scope instructions are a per-machine input the run cannot pin, so identity records them. */
export function userInstructionsHash(file = path.join(homedir(), '.claude', 'CLAUDE.md')): string {
  return existsSync(file) ? sha256(readFileSync(file, 'utf8')) : 'absent';
}

export function runnerClosureHash(): string {
  return hashLocalModuleClosure([path.join(here, 'run.mts')]);
}

/** Everything that turns a banked stream into numbers, the decoy matcher included. */
export function scorerHash(): string {
  return hashLocalModuleClosure(
    ['score.mts', 'summary.mts', '../matcher.mts'].map((file) => path.join(here, file)),
  );
}

export interface IdentityInputs {
  agent: AgentSource;
  member: Member;
  condition: Condition;
  request: string;
  version: string;
  userInstructions: string;
  runnerClosure: string;
}

export function executionId(inputs: IdentityInputs): string {
  const { agent, member, condition } = inputs;
  return sha256(
    JSON.stringify({
      argv: buildArgs(agent, condition, PLACEHOLDER_WORKSPACE),
      version: inputs.version,
      agent: sha256(agent.raw),
      request: sha256(inputs.request),
      consumer: member.consumer,
      refs: member.refs,
      userInstructions: inputs.userInstructions,
      runner: inputs.runnerClosure,
    }),
  );
}
