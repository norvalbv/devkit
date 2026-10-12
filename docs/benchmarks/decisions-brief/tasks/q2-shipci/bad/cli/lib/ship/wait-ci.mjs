// Polls the PR's checks after `devkit ship` has opened the PR.
// pollChecks() resolves to { failed, passed, pending } (counts).
// The number returned here becomes the exit status of `devkit ship`.
export async function waitCi({ pollChecks }) {
  const tally = await pollChecks();
  if (tally.failed > 0) {
    console.error(`CI failed: ${tally.failed} check(s)`);
    return 1;
  }
  return 0;
}
