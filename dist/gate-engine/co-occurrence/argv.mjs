/**
 * The `--name value` reader both co-occurrence CLIs (matcher, clone-detector) parse their knob
 * flags with. Shared so the two gates can never drift on how a threshold override is read — a
 * silent divergence there would make the same command line mean different things to each gate.
 */
/**
 * Bind a flag reader to one argv slice. `flag('--min-loc', 15)` returns the following token, or
 * the default when the flag is absent OR is the last token with nothing after it. That second
 * case matters: callers coerce with `Number(...)`, so returning `undefined` for a trailing
 * `--min-loc` would silently set the threshold to NaN and let every comparison against it fail.
 * Values stay strings; callers coerce.
 */
export const flagReader = (argv) => (name, def) => {
    const i = argv.indexOf(name);
    return (i === -1 ? undefined : argv[i + 1]) ?? def;
};
