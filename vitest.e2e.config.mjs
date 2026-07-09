import { defineConfig } from 'vitest/config';

// Opt-in E2E project: builds devkit, packs it, installs the tarball into an isolated prefix, and
// drives the REAL installed bins against throwaway git repos. Kept OUT of the default `vitest` run
// (vitest.config.mjs scopes include to gate-engine/** + cli/**) because build+pack+install is slow
// (10-60s cold) and must not run on every watch cycle. Run explicitly: `bun run test:e2e`.
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.test.mts'],
    // Same GIT_DIR-family + JSCPD_BIN stripping the unit suite relies on — mandatory here because
    // the fixtures spawn a real `git commit` that fires the installed hook.
    setupFiles: ['./vitest.setup.mjs'],
    // Build + pack + install happens once before workers start; a build failure aborts the run.
    globalSetup: ['./e2e/lib/global-setup.mts'],
    // Real subprocess chains (git commit → sh hook → bunx → guard-*) are slow under load; match the
    // unit suite's generous ceiling rather than vitest's 5s default.
    hookTimeout: 120000,
    testTimeout: 120000,
  },
});
