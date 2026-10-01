import { defineConfig } from 'vitest/config';

const TEST_INCLUDE = [
  'anti-slop/**/*.test.mts',
  'gate-engine/**/*.test.mts',
  'cli/**/*.test.mts',
  'e2e/lib/**/*.unit.test.mts',
];
const GIT_INTEGRATION_TESTS = [
  'cli/__tests__/asset-conflicts.test.mts',
  'cli/__tests__/base-drift.test.mts',
  'cli/__tests__/baseline-status.test.mts',
  'cli/__tests__/baseline-status-config.test.mts',
  'cli/__tests__/baseline-status-edges.test.mts',
  'cli/__tests__/doctor-hookspath-owner.test.mts',
  'cli/__tests__/guard-branch.test.mts',
  'cli/__tests__/hook-parity.test.mts',
  'cli/__tests__/overlay-global-hook.test.mts',
  'cli/__tests__/overlay.test.mts',
  'cli/__tests__/pre-push.test.mts',
  'cli/__tests__/prepare-gate-worktree.test.mts',
  'cli/__tests__/reconcile.test.mts',
  'cli/__tests__/reship-publish-lock.test.mts',
  'cli/__tests__/reship-rewrite-pin.test.mts',
  'cli/__tests__/reship.test.mts',
  'cli/__tests__/review.test.mts',
  'cli/__tests__/review-base-inference.test.mts',
  'cli/__tests__/review-gate-supervisor.test.mts',
  'cli/__tests__/ship-base-ancestry.test.mts',
  'cli/__tests__/ship-branch-resume.test.mts',
  'cli/__tests__/ship-branch.test.mts',
  'cli/__tests__/ship-draft.test.mts',
  'cli/__tests__/ship-fixture.test.mts',
  'cli/__tests__/ship-format-stage.test.mts',
  'cli/__tests__/ship-literal-paths.test.mts',
  'cli/__tests__/ship-manifest.test.mts',
  'cli/__tests__/ship-run-record.test.mts',
  'cli/__tests__/ship-wait-ci.test.mts',
  'cli/__tests__/test-subprocess.test.mts',
  'gate-engine/decisions/__tests__/integrity-staged.test.mts',
  'gate-engine/ratchets/__tests__/git-index.test.mts',
];
const SHARED_TEST_CONFIG = {
  setupFiles: ['./vitest.setup.mjs'],
  hookTimeout: 120_000,
  // This is the last-resort worker ceiling, not the subprocess deadline. Synchronous commands are
  // terminated after 90s and may use up to 30s more to reap their process tree; leave enough margin
  // for that cleanup to finish and report exit 124 instead of racing Vitest's own timeout.
  testTimeout: 150_000,
};
// One value for both projects: vitest throws when one groupOrder mixes maxWorkers.
// Leaves headroom for concurrent local development; VITEST_MAX_WORKERS overrides it per run.
const SUITE_WORKERS = '50%';
// Files proven to fail only when pooled; a later 1-worker group runs them. Empty since the poll fix.
const POOLED_FAILURES = [];

// The devkit test surface is the gate engines only. Skills under skills/ may
// carry helper scripts (incl. *.test.mjs) that are repo-coupled and not part of
// devkit's own test run — scope include so a stray skill script can't redden it.
export default defineConfig({
  test: {
    ...SHARED_TEST_CONFIG,
    projects: [
      {
        test: {
          ...SHARED_TEST_CONFIG,
          name: 'parallel',
          include: TEST_INCLUDE,
          exclude: GIT_INTEGRATION_TESTS,
          maxWorkers: SUITE_WORKERS,
        },
      },
      {
        test: {
          ...SHARED_TEST_CONFIG,
          name: 'git-integration',
          include: GIT_INTEGRATION_TESTS,
          exclude: POOLED_FAILURES,
          // Shares parallel's pool; a 1-worker project became a trailing group that doubled wall time.
          // Spawns here stay supervised (suite-hangs-bound-at-the-spawn-site), not serialised.
          maxWorkers: SUITE_WORKERS,
        },
      },
      // Only when non-empty: an empty include would fall back to vitest's default globs.
      ...(POOLED_FAILURES.length === 0
        ? []
        : [
            {
              test: {
                ...SHARED_TEST_CONFIG,
                name: 'git-serial',
                include: POOLED_FAILURES,
                // Explicit order keeps it solo even when VITEST_MAX_WORKERS lifts maxWorkers above 1.
                maxWorkers: 1,
                sequence: { groupOrder: 1 },
              },
            },
          ]),
    ],
    // `e2e/lib/**/*.unit.test.mts` = FAST pure-logic tests of the harness helpers (no build); the
    // slow build+pack+install `*.e2e.test.mts` suites live in the separate vitest.e2e.config.mjs.
    include: TEST_INCLUDE,
    // Root only, never per project: it stamps machine load once at each end of the run (sc-2785).
    globalSetup: ['./vitest.global-setup.mjs'],
    // Strip leaked git control vars (GIT_DIR, …) so a hook-launched run can't make the
    // git-integration tests operate on devkit's own repo. See vitest.setup.mjs.
    setupFiles: SHARED_TEST_CONFIG.setupFiles,
    // The git-integration tests spawn real repos in tmp; their afterEach rmSync cleanup can
    // exceed vitest's 10s default hook ceiling on a slow or loaded CI filesystem (false redness
    // that isn't an assertion failure). 120s absorbs that without masking a genuine hang.
    hookTimeout: SHARED_TEST_CONFIG.hookTimeout,
    // Same false-redness class for the tests themselves: the spawn-heavy tests (devkit
    // init/upgrade runs, git fixture repos, agentic eval-bench rows) take 5-40s wall-clock on a
    // loaded dev box, and vitest's 5s default fails them with no assertion failing. Observed:
    // on a box at load ~50-70 (many parallel worktrees + a fallow audit) the `devkit release`
    // full suite clipped 2-4 DIFFERENT tests each run at the old 30s ceiling — always a timeout,
    // never an assertion, and every one passes in isolation. A ceiling, not a delay: passing
    // tests stay fast; only the load-slow ones use more budget. 150s absorbs the load; a genuine
    // hang is stopped by the shared subprocess boundary after 90s, with this worker timeout retained
    // as a backstop for non-subprocess test code. Assertions remain untouched.
    testTimeout: SHARED_TEST_CONFIG.testTimeout,
  },
});
