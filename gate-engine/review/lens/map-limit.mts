// Bounded-concurrency map: at most `limit` fn calls in flight, input order preserved.
// LOAD-BEARING: fn must never reject — the caller pre-wraps the cascade body in .catch. A worker
// rejection here would reject Promise.all and abandon siblings' pending per-completion checkpoints.
// ponytail: static pool. Load-adaptive sizing (os.loadavg / live concurrent-`claude` count) is the
// upgrade path if one fixed cap ever proves too blunt across differently-loaded machines.
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}
