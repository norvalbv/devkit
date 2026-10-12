// Answers whether origin/<base> has moved since this checkout was cut.
// fetchBase() refreshes the remote ref and resolves to its sha; it rejects when the network is down.
// warn(line) prints to the user. Resolves to the freshness value callers print: 'fresh' or 'stale'.
export async function freshness({ localSha, fetchBase, warn }) {
  const remoteSha = await fetchBase();
  return remoteSha === localSha ? 'fresh' : 'stale';
}
