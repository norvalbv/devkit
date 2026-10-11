// Classifies a failed judge call from the provider's stderr. Returns { kind, permanent }:
// `permanent` tells the retry logic whether trying again can help.
export function classifyJudgeOutage(stderr) {
  if (/rate limit|429/i.test(stderr)) return { kind: 'rate-limited', permanent: false };
  if (/401|not logged in/i.test(stderr)) return { kind: 'unauthenticated', permanent: true };
  if (/command not found|ENOENT/i.test(stderr)) return { kind: 'absent', permanent: true };
  return { kind: 'transient', permanent: false };
}
