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
 *
 * The claude runtime is probed whenever review is selected regardless of the configured trio — the
 * completeness judge is pinned to a claude model, so every review install needs claude auth even
 * when all three configured models are codex-family.
 */
import { spawnSync } from 'node:child_process';
import { correctnessModel, resolveEscalationModel, resolveReviewModel } from '../../../gate-engine/review/reviewers.mjs';
import { check } from './check-result.mjs';
export const JUDGE_AUTH_CHECK = 'judge auth';
const PROBE_TIMEOUT_MS = 5000;
const runProbe = (bin, args) => {
    try {
        // SIGKILL, not SIGTERM: a trapping child survives SIGTERM (sc-1317) and would hang doctor.
        const r = spawnSync(bin, args, {
            encoding: 'utf8',
            timeout: PROBE_TIMEOUT_MS,
            killSignal: 'SIGKILL',
        });
        if (r.error)
            return null;
        return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }
    catch {
        return null;
    }
};
/** `claude auth status` prints JSON with a boolean `loggedIn`; only a parsed literal false is a
 * finding — unparseable output is unknown, never logged-out. */
export function claudeLoggedOut(exec = runProbe) {
    const r = exec('claude', ['auth', 'status']);
    if (!r)
        return false;
    try {
        // SAFETY: the parse result is immediately range-checked — only a literal boolean false on the
        // loggedIn key flips the probe; every other shape falls through to unknown and stays silent.
        const parsed = JSON.parse(r.stdout);
        return parsed !== null && parsed.loggedIn === false;
    }
    catch {
        return false;
    }
}
/** `codex login status` prints "Logged in using …" / "Not logged in"; only the latter, as a whole
 * line, is a finding — a mid-sentence mention in diagnostic text is not status evidence. */
export function codexLoggedOut(exec = runProbe) {
    const r = exec(process.env.GUARD_CODEX_BIN || 'codex', ['login', 'status']);
    if (!r)
        return false;
    return /^\s*not logged in\s*\.?\s*$/im.test(`${r.stdout}\n${r.stderr}`);
}
export function judgeAuthResult(cfg, exec = runProbe) {
    const models = [resolveReviewModel(cfg), resolveEscalationModel(cfg), correctnessModel(cfg)];
    const dead = [];
    if (models.some((m) => m.startsWith('gpt-')) && codexLoggedOut(exec))
        dead.push('codex');
    if (claudeLoggedOut(exec))
        dead.push('claude');
    if (dead.length === 0)
        return null;
    return check(JUDGE_AUTH_CHECK, 'DRIFT', `${dead.join(' + ')} CLI reports logged OUT — its judges will go inconclusive at commit time while the binary looks healthy`, dead
        .map((bin) => (bin === 'codex' ? '`codex login`' : '`claude` (interactive login)'))
        .join(', '), false, true);
}
