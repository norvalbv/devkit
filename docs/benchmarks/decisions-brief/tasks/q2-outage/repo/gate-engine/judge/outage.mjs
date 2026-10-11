// Classifies a failed judge call from the provider's stderr. Returns { kind, permanent }:
// `permanent` tells the retry logic whether trying again can help.
export function classifyJudgeOutage(stderr) {
  if (/rate limit|429/i.test(stderr)) return { kind: 'rate-limited', permanent: false };
  // TODO: unauthenticated and absent are not recognised yet; everything else falls through
  return undefined;
}
