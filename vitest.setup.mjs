import os from 'node:os';
import path from 'node:path';

// Git exports control vars (GIT_DIR, GIT_WORK_TREE, …) into every hook's environment. devkit's
// git-integration tests spawn `git init` / commits in throwaway temp repos via the INHERITED env;
// an inherited GIT_DIR makes those gits operate on devkit's OWN .git instead of the temp repo —
// and under parallel vitest workers that races on .git/config.lock and corrupts the repo (flips
// core.bare, leaks the test identity). That is why `bun run test:run` is safe run directly but was
// NOT under a git hook (a `devkit ship` worktree commit or a push), where the hook had set GIT_DIR.
//
// Stripping the repo-location vars here — setupFiles runs per worker BEFORE any test module loads,
// so even a top-level `{...process.env}` captures the cleaned env — makes every spawned git resolve
// its repo from cwd, as the tests intend, regardless of how the suite was launched.
for (const k of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
]) {
  delete process.env[k];
}

// JSCPD_BIN: a dev's globally-installed jscpd (e.g. ~/.bun/bin/jscpd) exported into the shell leaks
// into the clone-detector subprocesses the tests spawn, so the suite validates THAT binary instead of
// the jscpd devkit vendors + ships (node_modules/.bin/jscpd). Across a jscpd major bump the reported
// clone-path base changed — 5.x reports bare basenames (`a.ts`), 4.x reports src/-prefixed
// (`src/a.ts`) — which flips the relPath/normalisation assertions red purely on the ambient env.
// Strip it so the module-level `JSCPD_BIN` const falls back to the vendored binary; tests that need a
// specific bin still pass it per-spawn (execFileSync env), and resolveJscpdBin's unit tests inject env
// directly, so both are unaffected.
delete process.env.JSCPD_BIN;

// devkit's own ship exports its gate policy into the whole gate process tree —
// run-gates-with-capture.sh (DEVKIT_SHIP=1 GUARD_AI_STRICT=1) and ship-branch.sh (DEVKIT_RUN_MODE=ship)
// — and further down that same tree pre-push-validation.sh runs `bun run test:run`. So devkit's OWN
// suite is launched inside devkit's OWN ship's environment, and any test that asserts a gate's exit
// code silently answers to the launcher: a judge outage that fail-opens at 2 returns 3 under strict.
// It is invisible in the diff — green under `bun run test:run`, red inside a ship, or the reverse.
//
// The names are the set cli/lib/ship/review-target.sh unsets (its reason is different — it stops a
// review inheriting a FOREIGN run's authority — but the vocabulary is the same, and a parity test
// binds the two lists). SHIP_COMMIT_TIMEOUT and DEVKIT_PREFLIGHT_TIMEOUT stay: they are deliberate
// invocation inputs, not inherited policy. The guarantee is that no test INHERITS a policy var from
// the launching process — setupFiles runs once per worker, so a test that sets one mid-file and
// never restores it still leaks to later files in that worker.
export const INHERITED_RUN_ENV = [
  'DEVKIT_COMMIT_MSG_FILE',
  'DEVKIT_GATE_ARCHIVE_LOG',
  'DEVKIT_GATE_EVENTS',
  'DEVKIT_REVIEW_ASSET_ROOT',
  'DEVKIT_REVIEW_BASELINE_DIR',
  'DEVKIT_REVIEW_BRANCH',
  'DEVKIT_REVIEW_DATA_ROOT',
  'DEVKIT_REVIEW_DEPENDENCY_MANIFEST',
  'DEVKIT_REVIEW_DEPENDENCY_TOOL',
  'DEVKIT_REVIEW_GUARDS',
  'DEVKIT_REVIEW_ID',
  'DEVKIT_REVIEW_MERGE_BASE',
  'DEVKIT_REVIEW_PACKAGE_ROOT',
  'DEVKIT_REVIEW_PROGRESS',
  'DEVKIT_REVIEW_PROJECTION_MANIFEST',
  'DEVKIT_REVIEW_PROJECTION_TOOL',
  'DEVKIT_REVIEW_REPO',
  'DEVKIT_REVIEW_RUNTIME_FINGERPRINT',
  'DEVKIT_REVIEW_SUPERVISOR_OWNER_TOKEN',
  'DEVKIT_REVIEW_TEMP_ROOT',
  'DEVKIT_RUN_MODE',
  'DEVKIT_SHIP',
  'DEVKIT_SHIP_BASE_SHA',
  'DEVKIT_SHIP_ID',
  'DEVKIT_SHIP_MODE',
  'DEVKIT_SHIP_SOURCE_HEAD',
  'GUARD_AI_STRICT',
  'GUARD_DECISIONS_DIR',
];

// review-target.sh guards a review ENTRYPOINT, so its list is NOT a superset of what a ship exports
// downstream — these eight reach the suite unscrubbed by it. They are not inert: qavis-advisory's
// shipMode() branches on DEVKIT_SHIP_ROOT and then runs git against that path, and completeness's
// verdictBranch() scopes a sticky verdict to DEVKIT_SHIP_BRANCH, so an inherited pair makes a test
// answer for the OUTER ship's repository. A parity test derives this set from the ship scripts.
export const SHIP_EXPORTED_ENV = [
  'DEVKIT_SHIP_BRANCH',
  'DEVKIT_SHIP_DRY_GATES',
  'DEVKIT_SHIP_FROM_BRANCH',
  'DEVKIT_SHIP_INTENT_RECORDED',
  'DEVKIT_SHIP_PATHS',
  'DEVKIT_SHIP_REPO',
  'DEVKIT_SHIP_RESUMED',
  'DEVKIT_SHIP_ROOT',
];

// FRINK_AI_STRICT is the legacy alias gate-engine reads alongside GUARD_AI_STRICT; no devkit path
// exports it, so it belongs to neither parity list and is scrubbed on its own merit.
export const TEST_ONLY_ADDITIONS = ['FRINK_AI_STRICT'];

export const SCRUBBED_ENV = [...INHERITED_RUN_ENV, ...SHIP_EXPORTED_ENV, ...TEST_ONLY_ADDITIONS];

// Ordering is load-bearing: DEVKIT_GATE_EVENTS is scrubbed here and reassigned below, so a scrub
// placed after that assignment would delete the per-worker redirect and let test ships write to the
// developer's real telemetry sink.
for (const k of SCRUBBED_ENV) {
  delete process.env[k];
}

// The ship-path tests (ship-branch / reship / reconcile / …) spawn a REAL commit-with-gate-capture.sh
// whose gate-events emitter defaults its sink to ~/.devkit/telemetry/gate-events.jsonl — the
// developer's real ship telemetry. Redirect it to a throwaway per-worker temp file so test ships
// (fixture branches, forced SHIP_COMMIT_TIMEOUT expiries) can never pollute real data. The emitter
// no-ops only when the var is UNSET, so a value here is safe; emitter tests override it per-test.
process.env.DEVKIT_GATE_EVENTS = path.join(
  os.tmpdir(),
  `devkit-test-gate-events-${process.pid}.jsonl`,
);

// Every-commit telemetry capture is ON by default (run-context.mts) — but an OFF-ship gate spawned
// by a test must not auto-capture (git write-tree + transcript writes it never asked for). Disable it
// suite-wide; a ship test sets DEVKIT_SHIP_ID (unaffected), and run-context's own test toggles this.
process.env.DEVKIT_NO_TELEMETRY = '1';
