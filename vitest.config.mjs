import { defineConfig } from 'vitest/config';

// The devkit test surface is the gate engines only. Skills under skills/ may
// carry helper scripts (incl. *.test.mjs) that are repo-coupled and not part of
// devkit's own test run — scope include so a stray skill script can't redden it.
export default defineConfig({
  test: {
    // `e2e/lib/**/*.unit.test.mts` = FAST pure-logic tests of the harness helpers (no build); the
    // slow build+pack+install `*.e2e.test.mts` suites live in the separate vitest.e2e.config.mjs.
    include: ['gate-engine/**/*.test.mts', 'cli/**/*.test.mts', 'e2e/lib/**/*.unit.test.mts'],
    // Strip leaked git control vars (GIT_DIR, …) so a hook-launched run can't make the
    // git-integration tests operate on devkit's own repo. See vitest.setup.mjs.
    setupFiles: ['./vitest.setup.mjs'],
    // The git-integration tests spawn real repos in tmp; their afterEach rmSync cleanup can
    // exceed vitest's 10s default hook ceiling on a slow or loaded CI filesystem (false redness
    // that isn't an assertion failure). 120s absorbs that without masking a genuine hang.
    hookTimeout: 120000,
    // Same false-redness class for the tests themselves: the spawn-heavy tests (devkit
    // init/upgrade runs, git fixture repos, agentic eval-bench rows) take 5-40s wall-clock on a
    // loaded dev box, and vitest's 5s default fails them with no assertion failing. Observed:
    // on a box at load ~50-70 (many parallel worktrees + a fallow audit) the `devkit release`
    // full suite clipped 2-4 DIFFERENT tests each run at the old 30s ceiling — always a timeout,
    // never an assertion, and every one passes in isolation. A ceiling, not a delay: passing
    // tests stay fast; only the load-slow ones use more budget. 120s absorbs the load; a genuine
    // hang still dies, just slower — assertions untouched.
    testTimeout: 120000,
  },
});
