/** Is one of `names` passed as an option? A declared value flag's next token is opaque, and only an
 *  unconsumed `--` ends the scan — ship's route-scan rule (sc-2485); `=` forms are not parsed. */
export function findsFlag(
  args: readonly string[],
  names: readonly string[],
  valueFlags: readonly string[] = [],
): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (valueFlags.includes(arg)) {
      i++;
      continue;
    }
    if (arg === '--') return false;
    if (names.includes(arg)) return true;
  }
  return false;
}

/** Does `devkit <cmd> …args` ask for that command's help? */
export function wantsCommandHelp(args: readonly string[], valueFlags: readonly string[] = []) {
  return findsFlag(args, ['--help', '-h'], valueFlags);
}
