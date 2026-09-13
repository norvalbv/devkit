/** The judge-family escape hatch: the four-key set that moves every judge to the other provider, and
 *  the ONE sentence each outage surface renders it from. */
// Here rather than in cli/lib/doctor because strictRemedy needs it and gate-engine never imports
// cli; judge-family.mts re-exports the set so the binder keeps a single definition.
import { judgeProviderOfBin } from '../codex/result.mjs';
/** The complete claude family, chunking off included: cap 400 is benched for gpt-5.6-sol, not
 *  sonnet, so a partial move runs the correctness reviewer at an un-benched cap (sc-2193). */
export const CLAUDE_FAMILY_SET = {
    model: 'haiku',
    escalationModel: 'opus',
    correctnessModel: 'sonnet',
    correctnessChunkLoc: 0,
};
/** env spelling, config key and claude value in ONE table, so the remedy, the doctor's refusal and
 *  the binder cannot drift apart. */
// envValue differs from the config value for the chunk cap alone: the env parser takes 'off', the
// file takes 0 (review/lens/chunk-tasks.mts).
export const FAMILY_ENV_KEYS = [
    {
        env: 'GUARD_REVIEW_MODEL',
        alias: 'FRINK_REVIEW_MODEL',
        key: 'model',
        envValue: CLAUDE_FAMILY_SET.model,
    },
    {
        env: 'GUARD_REVIEW_ESCALATION_MODEL',
        alias: undefined,
        key: 'escalationModel',
        envValue: CLAUDE_FAMILY_SET.escalationModel,
    },
    {
        env: 'GUARD_CORRECTNESS_MODEL',
        alias: undefined,
        key: 'correctnessModel',
        envValue: CLAUDE_FAMILY_SET.correctnessModel,
    },
    {
        env: 'GUARD_CORRECTNESS_CHUNK',
        alias: undefined,
        key: 'correctnessChunkLoc',
        envValue: 'off',
    },
];
/** The sentry judge's own knob. It has no config key: unset, it resolves review.model, so the family
 *  switch already carries it (sc-2190's one-knob rule). */
export const SENTRY_MODEL_ENVS = ['GUARD_SENTRY_MODEL', 'FRINK_SENTRY_MODEL'];
const familyEnvNames = () => FAMILY_ENV_KEYS.flatMap((k) => (k.alias ? [k.env, k.alias] : [k.env]));
/** Every env that selects a judging model — the authoritative surface the docs, the doctor and the
 *  coupling test read, so a new knob cannot ship without joining it. */
export const JUDGE_MODEL_ENVS = Object.freeze([
    ...familyEnvNames(),
    ...SENTRY_MODEL_ENVS,
]);
/** The one-run lever as ONE runnable command that moves every judge, the sentry judge included.
 *  EXPORTED, never an inline prefix: a shell hook can strip `VAR=x devkit ship` (see SHIP_COMMIT_TIMEOUT). */
// Clearing both sentry spellings sends that judge to GUARD_REVIEW_MODEL, which this same line sets.
export const claudeFamilyEnvLine = () => `export ${FAMILY_ENV_KEYS.map((k) => `${k.env}=${k.envValue}`).join(' ')}; unset ${SENTRY_MODEL_ENVS.join(' ')}`;
/** The way back, as a runnable command: every env that can pin a judge, sentry included. */
export const judgeEnvUnsetLine = () => `unset ${JUDGE_MODEL_ENVS.join(' ')}`;
/** The same set in the voice guard.config.json speaks. */
export const claudeFamilyKeyLine = () => FAMILY_ENV_KEYS.map((k) => `review.${k.key}=${CLAUDE_FAMILY_SET[k.key]}`).join(', ');
/** The redirect an outage prints. The caller names the bin that went dark; nothing here probes PATH
 *  (gate-engine cannot reach binResolvable), so the seam stays testable with GUARD_CODEX_BIN alone. */
// The provider comes from judgeProviderOfBin, so a GUARD_CODEX_BIN path still reads as codex; a
// compound bin has none — either family may be dark — so it names no move, like preflight's both-dark.
export function familyOverrideRemedy(dark) {
    const provider = judgeProviderOfBin(dark);
    if (provider === null)
        return ('this judge spans both families, so the dark one is unknown and no family move is safe yet: ' +
            'find which CLI is dark (`devkit doctor`, or the ship preflight), then move the judges off that one');
    if (provider === 'claude')
        return (`move the judges back to the packaged codex family: run \`${judgeEnvUnsetLine()}\` in the ` +
            'shell that ships AND delete any review.model / escalationModel / correctnessModel / ' +
            'correctnessChunkLoc keys from guard.config.json (unsetting alone reveals a bound claude ' +
            'family), then resume ' +
            'the ship. The codex CLI has to resolve (or GUARD_CODEX_BIN point at it), and the move ' +
            'discards every cached PASS');
    return (`move the judges to the claude family: run \`${claudeFamilyEnvLine()}\` in the shell that ` +
        `ships, then resume the ship. Set all ${FAMILY_ENV_KEYS.length} — the correctness chunk cap is ` +
        'benched for gpt-5.6-sol only, so a partial move runs sonnet at an un-benched cap; the command ' +
        'also clears any sentry pin, so that judge follows GUARD_REVIEW_MODEL rather than staying ' +
        'behind. `devkit doctor --fix` writes the same keys into guard.config.json instead, which ' +
        'a ship reads only once that file is committed. Either way every cached PASS is discarded, ' +
        'because a verdict is keyed on its judging model, and remaining claude headroom cannot be ' +
        `queried ahead of time. Once the outage clears, \`${judgeEnvUnsetLine()}\` returns to the default`);
}
