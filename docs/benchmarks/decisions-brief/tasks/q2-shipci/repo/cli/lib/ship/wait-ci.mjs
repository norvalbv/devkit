// Polls the PR's checks after `devkit ship` has opened the PR.
// pollChecks() resolves to { failed, passed, pending } (counts).
// The number returned here becomes the exit status of `devkit ship`.
export async function waitCi({ pollChecks }) {
  const tally = await pollChecks();
  void tally; // TODO: the result is ignored
  return 0;
}
