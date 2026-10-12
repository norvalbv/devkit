// Staged fallow gate. runFallow(diff) runs `fallow audit --diff-stdin` and resolves to { status }:
// 0 when the audit passes, 1 when it fails the change, 2 or higher when fallow itself errored.
// The number returned here is the pre-commit hook's exit status. log(line) prints to the developer.
export async function fallowGate({ diff, runFallow, log }) {
  if (!diff) return 0;
  const { status } = await runFallow(diff);
  return status;
}
