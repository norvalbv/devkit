import { defineConfig } from 'vitest/config';

// The devkit test surface is the gate engines only. Skills under skills/ may
// carry helper scripts (incl. *.test.mjs) that are repo-coupled and not part of
// devkit's own test run — scope include so a stray skill script can't redden it.
export default defineConfig({
  test: {
    include: ['gate-engine/**/*.test.mjs', 'cli/**/*.test.mjs'],
    // Strip leaked git control vars (GIT_DIR, …) so a hook-launched run can't make the
    // git-integration tests operate on devkit's own repo. See vitest.setup.mjs.
    setupFiles: ['./vitest.setup.mjs'],
    // The git-integration tests spawn real repos in tmp; their afterEach rmSync cleanup can
    // exceed vitest's 10s default hook ceiling on a slow or loaded CI filesystem (false redness
    // that isn't an assertion failure). 30s absorbs that without masking a genuine hang.
    hookTimeout: 30000,
  },
});
