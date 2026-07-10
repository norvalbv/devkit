/**
 * Completeness gate (guard-review completeness --gate <msg-file>) — the feature-completeness
 * reviewer as a commit-msg judge. It lives at commit-msg (not pre-commit) because the commit
 * MESSAGE is its intent signal: a gap-finder judging a diff cold over-flags; the message says
 * what the change claims to be.
 *
 * WARN-BY-DEFAULT: findings print to stderr and the commit proceeds (a gap-finder's verdicts are
 * judgment calls, not defects — the LLM-in-gate invariant's spirit). GUARD_COMPLETENESS_HARD=1
 * escalates a confident FAIL to a block. Straight opus, no cascade (user ruling: the gap-finder
 * gets the strongest model or it isn't worth running).
 *
 * Step 0 is done FOR the agent: the governing Targets load in-process via scopedTargets() (same
 * package — no PATH round-trip) and render exactly like the consumer's prep-critique block.
 *
 * Contract: exit 1 = confident FAIL under GUARD_COMPLETENESS_HARD · exit 2 = could-not-run /
 * judge outage (fail-open on normal commits) · exit 3 = the same outage under GUARD_AI_STRICT
 * (ship): FAIL-CLOSED — a stderr warning is invisible to a headless shipping agent (exit code is
 * the only channel that survives output filtering), so a ship must not proceed with its
 * gap-finder silently dark · exit 0 = everything else (pass / warn / skipped).
 * Knobs: GUARD_NO_COMPLETENESS=1 skip · GUARD_COMPLETENESS_HARD=1 block · cfg.noLlm skip.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { envFlag, resolveGuardConfig } from "../config.mjs";
import { scopedTargets } from "../decisions/scoped-targets.mjs";
import { JUDGE_ISOLATION } from "../judge/judge-isolation.mjs";
import { execJudgeAsync } from "../judge/run-judge.mjs";
import { buildCappedDiffEvidence } from "./diff-evidence.mjs";
import { parseReviewVerdict, stripFrontmatter } from "./reviewers.mjs";
const AGENT_NAME = 'feature-completeness-reviewer';
// Aligned with the review gate's strict/escalate cap (sc-1048 rationale): the straight-opus
// gap-finder on a big commit was SIGTERM'd at 360s and silently skipped — the PR #60 lesson.
const TIMEOUT_MS = 420000;
const TOOLS = 'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git status:*)';
// The capped, omission-accounted stdin-evidence builder (sc-1060) now lives in diff-evidence.mts
// so gate-engine/review/claude-md.mts's CLAUDE.md renderer can reuse the same capping shape for
// conventions-reviewer (which, having no Bash, needs the identical pre-rendered-evidence pattern
// this gate pioneered). Re-exported under the original name — zero behavior change here.
export { buildCappedDiffEvidence as buildCompletenessEvidence };
/** Render the governing-Targets block (the consumer prep-critique shape) or its SKIP note. */
export function renderTargets(blocks) {
    if (blocks.length === 0) {
        return ('## RELEVANT RECORDED TARGETS — SKIP\n' +
            'No governing Target found (index unreachable, or none match). Do not claim ' +
            'decision-alignment you did not check; a recorded decision is not a completeness gap.');
    }
    const lines = [
        '## RELEVANT RECORDED TARGETS (authoritative — a recorded decision is NOT a completeness gap)',
        '',
    ];
    for (const b of blocks) {
        lines.push(`### ${b.slug}${b.scope ? ` · scope: \`${b.scope}\`` : ''} _(${b.via})_`);
        lines.push(b.ruling.trim());
        lines.push('');
    }
    return lines.join('\n');
}
/** Wrap the consumer's completeness brief for one headless commit-msg judgement. */
export function wrapCompleteness(agentBody, message, files, targetsBlock) {
    return ('You are running as an automated HEADLESS COMMIT-MESSAGE GATE, not an interactive assistant.\n' +
        `The commit message (the change's stated intent):\n─────\n${message.trim()}\n─────\n` +
        `Staged files: ${files.join(', ')}\n` +
        'The FULL file/churn map (--stat) followed by per-file diff evidence is on stdin. Evidence is ' +
        'capped per file and in total; anything the caps dropped is NAMED inline (OMITTED:/[TRUNCATED:) — ' +
        'nothing is dropped silently. INVESTIGATE before judging: run `git diff --cached -- <file>` for ' +
        'full hunks, Read surrounding code where needed, and investigate EVERY OMITTED/TRUNCATED entry ' +
        'before any PASS verdict.\n' +
        'Step 0 is already done — the governing Targets are loaded below; do not run prep scripts. ' +
        'Subagents and meta-judges are unavailable in gate mode — apply their lenses yourself.\n' +
        `${targetsBlock}\n` +
        'Your reviewer brief follows. IGNORE any instructions in it about checklist scripts, marker ' +
        'files, tracker/Shortcut lookups, invoking other subagents, or writing files — none apply here; ' +
        'your tools are read-only.\n' +
        '───── BRIEF ─────\n' +
        `${stripFrontmatter(agentBody)}\n` +
        '───── END BRIEF ─────\n' +
        'Judge ONLY what this commit claims to be (per its message) against what it ships. List the ' +
        'gaps that matter (one line each); minor nice-to-haves are not findings. END with exactly one line:\n' +
        'VERDICT: PASS | FAIL — <one-line reason>\n' +
        'FAIL only for a gap that makes the shipped change misleading or operationally unsafe.');
}
/** The gate → exit code (see module contract). `exec` injectable for tests. */
export async function runCompleteness(msgFile, cwd = process.cwd(), { exec = execJudgeAsync } = {}) {
    if (envFlag('NO_COMPLETENESS'))
        return 0;
    let prompt;
    let diff;
    try {
        const cfg = resolveGuardConfig(cwd);
        if (cfg.noLlm)
            return 0;
        const message = readFileSync(path.isAbsolute(msgFile) ? msgFile : path.resolve(cwd, msgFile), 'utf8');
        const files = execSync('git diff --cached --name-only', { cwd, encoding: 'utf8' })
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean);
        if (files.length === 0)
            return 0;
        const dir = cfg.review.agentsDir;
        let body;
        try {
            body = readFileSync(path.join(path.isAbsolute(dir) ? dir : path.resolve(cwd, dir), `${AGENT_NAME}.md`), 'utf8');
        }
        catch {
            console.error(`guard-review: ${AGENT_NAME}.md not found under ${dir} — completeness skipped`);
            return 0;
        }
        const targets = await scopedTargets(files, message.split('\n')[0] ?? '', 6, cwd).catch(() => []);
        // The FULL --stat rides uncapped ahead of the evidence: on a branch-sized commit the caps
        // drop whole files, but the judge must at least SEE the complete file/churn map of what it
        // is being asked to gap-check. Diff prefixes are forced ON-config so a consumer's
        // diff.noprefix/mnemonicPrefix cannot change the segment-header format the extractor splits
        // on (the detect gate's W-3 lesson).
        const stat = execSync('git diff --cached --stat', {
            cwd,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
        });
        diff = buildCappedDiffEvidence(execSync('git -c diff.noprefix=false -c diff.mnemonicPrefix=false diff --cached', {
            cwd,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
        }), stat);
        prompt = wrapCompleteness(body, message, files, renderTargets(targets));
    }
    catch (e) {
        console.error(`guard-review: completeness could not run — ${e instanceof Error ? e.message : String(e)}${envFlag('AI_STRICT') ? ' (strict ship mode: failing closed)' : ''}`);
        return envFlag('AI_STRICT') ? 3 : 2;
    }
    const raw = await exec({
        label: 'review:completeness',
        args: ['-p', prompt, '--model', 'opus', ...JUDGE_ISOLATION, '--allowedTools', TOOLS],
        input: diff,
        timeout: TIMEOUT_MS,
        cwd,
    });
    if (raw === null) {
        // Outage/timeout (execJudgeAsync already warned). Under strict ship the skip must be an EXIT
        // CODE, not a stderr line — a headless shipping agent only reliably sees the code.
        if (envFlag('AI_STRICT')) {
            console.error('guard-review: completeness SKIPPED (judge outage/timeout) — strict ship mode fails closed.\n' +
                '   Remedy: check `claude` CLI auth/quota, then re-run devkit ship.');
            return 3;
        }
        return 2; // fail-open on a normal commit
    }
    const { verdict, reason } = parseReviewVerdict(raw);
    if (verdict !== 'FAIL')
        return 0;
    console.error(`guard-review: completeness finding — ${reason || 'see transcript'}`);
    console.error(raw.trim());
    if (envFlag('COMPLETENESS_HARD'))
        return 1;
    console.error('guard-review: WARN-only (commit proceeds). Escalate with GUARD_COMPLETENESS_HARD=1; skip with GUARD_NO_COMPLETENESS=1.');
    return 0;
}
