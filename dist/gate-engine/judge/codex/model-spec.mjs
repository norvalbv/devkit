/** Reasoning efforts codex accepts for `model_reasoning_effort` (codex-rs config). */
const REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
/**
 * `gpt-5.6-terra@high` → `{ model: 'gpt-5.6-terra', effort: 'high' }`; a bare id carries no
 * effort. Judges run `--ignore-user-config`, so a configured effort never applies — the suffix is
 * the ONLY way a spec reaches `-c model_reasoning_effort`. An unknown effort throws rather than
 * spawning at the wrong effort: the spec is config-owned (guard.config.json / GUARD_* envs), and a
 * silently-dropped suffix would make the judge look like the benched condition while not being it.
 */
export function parseModelSpec(spec) {
    const at = spec.lastIndexOf('@');
    if (at < 0)
        return { model: spec, effort: null };
    const model = spec.slice(0, at);
    const effort = spec.slice(at + 1);
    if (model === '' || model.includes('@') || !REASONING_EFFORTS.has(effort))
        throw new Error(`codex judge: unknown reasoning effort ${JSON.stringify(effort)} in model spec ${JSON.stringify(spec)} — expected <model>@${[...REASONING_EFFORTS].join('|')}`);
    return { model, effort };
}
