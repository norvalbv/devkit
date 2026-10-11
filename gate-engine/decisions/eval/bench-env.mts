/** The env reset a bench runs before any judge: inherited gate policy and git control vars go, and
 * the run is cut off from production telemetry. */
import { isolateBenchTelemetry } from '../../judge/run-context.mts';

// GUARD_*/FRINK_* reach the judges through resolveGuardConfig; inherited GIT_* control vars point
// fixture `git init/commit` at the HOST repo. Bench knobs are all BENCH_*, so both strip wholesale.
const GUARD_ENV_RE = /^(GUARD|FRINK)_/;
const GIT_CONTROL_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
];

export function cleanBenchEnv(env = process.env) {
  const stripped = [];
  for (const key of Object.keys(env)) {
    if (GUARD_ENV_RE.test(key) || GIT_CONTROL_VARS.includes(key)) {
      delete env[key];
      stripped.push(key);
    }
  }
  isolateBenchTelemetry(env);
  return stripped;
}
