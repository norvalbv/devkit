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

// The ship-path tests (ship-branch / reship / reconcile / …) spawn a REAL commit-with-gate-capture.sh
// whose gate-events emitter defaults its sink to ~/.devkit/telemetry/gate-events.jsonl — the
// developer's real ship telemetry. Redirect it to a throwaway per-worker temp file so test ships
// (fixture branches, forced SHIP_COMMIT_TIMEOUT expiries) can never pollute real data. The emitter
// no-ops only when the var is UNSET, so a value here is safe; emitter tests override it per-test.
process.env.DEVKIT_GATE_EVENTS = path.join(
  os.tmpdir(),
  `devkit-test-gate-events-${process.pid}.jsonl`,
);
delete process.env.DEVKIT_SHIP_ID;
