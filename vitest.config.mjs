import { defineConfig } from 'vitest/config';

// The devkit test surface is the gate engines only. Skills under skills/ may
// carry helper scripts (incl. *.test.mjs) that are repo-coupled and not part of
// devkit's own test run — scope include so a stray skill script can't redden it.
export default defineConfig({
  test: {
    include: ['gate-engine/**/*.test.mjs', 'cli/**/*.test.mjs'],
  },
});
