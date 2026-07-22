/**
 * The `--name value` reader both co-occurrence CLIs (matcher, clone-detector) parse their knob
 * flags with. Shared so the two gates can never drift on how a threshold override is read — a
 * silent divergence there would make the same command line mean different things to each gate.
 */

/**
 * Bind a flag reader to one argv slice. `flag('--min-loc', 15)` returns the following token, or
 * the default when the flag is absent. Values stay strings; callers coerce.
 */
export const flagReader =
  (argv: string[]) =>
  <T,>(name: string, def: T): string | T => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : def;
  };
