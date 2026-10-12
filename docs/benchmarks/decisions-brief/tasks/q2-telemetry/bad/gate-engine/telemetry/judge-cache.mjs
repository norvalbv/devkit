// emit(event) appends one telemetry row. `judge` is the judge's label, e.g. 'detect'.
export async function judgeWithCache({ key, judge, runJudge, cache, emit }) {
  if (cache.has(key)) {
    const verdict = cache.get(key);
    emit({ type: 'judge_exec', judge, verdict, cached: true });
    return verdict;
  }
  const verdict = await runJudge();
  emit({ type: 'judge_exec', judge, verdict, cached: false });
  cache.set(key, verdict);
  return verdict;
}
