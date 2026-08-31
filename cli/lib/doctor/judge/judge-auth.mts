/**
 * Auth-liveness advisory for the judge runtimes. Binary resolvability alone cannot catch an
 * installed-but-logged-out CLI: every judge goes inconclusive at commit time while doctor
 * reports healthy.
 *
 * ADVISORY, not drift — see CheckResult.advisory. Neither CLI documents its auth-status output as
 * a stable contract, and a wrong DRIFT exits 1 on every doctor run in every repo. Only a POSITIVE
 * logged-out signal in the OUTPUT becomes a row — exit codes are ignored entirely (a logged-out
 * codex exits non-zero WITH its signal); a timeout, a missing binary, or output carrying no
 * recognisable signal is "unknown" and silent.
 */

import { spawnSync } from 'node:child_process';
import { type CheckResult, check } from '../check-result.mts';
import { type JudgeModelConfig, requiredJudgeProviders } from './judge-family.mts';

export const JUDGE_AUTH_CHECK = 'judge auth';

const PROBE_TIMEOUT_MS = 5000;

export interface ProbeOutput {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type ProbeExec = (bin: string, args: string[]) => ProbeOutput | null;

const runProbe: ProbeExec = (bin, args) => {
  try {
    // SIGKILL, not SIGTERM: a trapping child survives SIGTERM (sc-1317) and would hang doctor.
    const r = spawnSync(bin, args, {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    if (r.error) return null;
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } catch {
    return null;
  }
};

/** `claude auth status` prints JSON with a boolean `loggedIn`; only a parsed literal false is a
 * finding — unparseable output is unknown, never logged-out. */
export function claudeLoggedOut(exec: ProbeExec = runProbe): boolean {
  const r = exec('claude', ['auth', 'status']);
  if (!r) return false;
  try {
    // SAFETY: the parse result is immediately range-checked — only a literal boolean false on the
    // loggedIn key flips the probe; every other shape falls through to unknown and stays silent.
    const parsed = JSON.parse(r.stdout) as { loggedIn?: unknown };
    return parsed !== null && parsed.loggedIn === false;
  } catch {
    return false;
  }
}

/** `codex login status` prints "Logged in using …" / "Not logged in"; only the latter, as a whole
 * line, is a finding — a mid-sentence mention in diagnostic text is not status evidence. */
export function codexLoggedOut(exec: ProbeExec = runProbe): boolean {
  const r = exec(process.env.GUARD_CODEX_BIN || 'codex', ['login', 'status']);
  if (!r) return false;
  return /^\s*not logged in\s*\.?\s*$/im.test(`${r.stdout}\n${r.stderr}`);
}

export function judgeAuthResult(
  cfg: JudgeModelConfig,
  exec: ProbeExec = runProbe,
): CheckResult | null {
  const providers = requiredJudgeProviders(cfg);
  const dead: string[] = [];
  if (providers.has('codex') && codexLoggedOut(exec)) dead.push('codex');
  if (providers.has('claude') && claudeLoggedOut(exec)) dead.push('claude');
  if (dead.length === 0) return null;
  return check(
    JUDGE_AUTH_CHECK,
    'DRIFT',
    `${dead.join(' + ')} CLI reports logged OUT — its judges will go inconclusive at commit time while the binary looks healthy`,
    dead
      .map((bin) => (bin === 'codex' ? '`codex login`' : '`claude` (interactive login)'))
      .join(', '),
    false,
    true,
  );
}
