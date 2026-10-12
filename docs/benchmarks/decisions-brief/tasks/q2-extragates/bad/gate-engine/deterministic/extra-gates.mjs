// extraGates in guard.config.json is a label-to-command map, e.g. { "lint": "bun run lint" }.
// run(argv) executes one command without a shell and resolves to its exit status.
// Resolves to { blocked, results }: blocked is true when the commit must not proceed.
export async function runExtraGates(extraGates, run) {
  const results = [];
  for (const [label, command] of Object.entries(extraGates ?? {})) {
    if (typeof command !== 'string' || !command.trim()) continue;
    const status = await run(command.split(/\s+/));
    results.push({ label, status });
  }
  return { blocked: results.some((r) => r.status !== 0), results };
}
