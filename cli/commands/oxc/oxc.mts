/** `devkit oxc` — run Devkit's pinned Oxlint/Oxfmt packages against the consumer cwd. */

import { type OxcTool, runOxcRuntime } from '../../lib/install/oxc/runtime.mts';

export const meta = {
  name: 'oxc',
  summary: "Run Devkit's pinned Oxlint or Oxfmt (no global/direct consumer install).",
  help: `devkit oxc — run Devkit's pinned Oxc tools.

Usage:
  devkit oxc lint [oxlint arguments...]
  devkit oxc fmt  [oxfmt arguments...]

Arguments and exit status pass through to the underlying tool. Runtime resolution is relative to
Devkit's own package and never falls back to PATH, a global install, or consumer node_modules/.bin.`,
};

export default function run(args: string[], cwd: string): number {
  const [requested, ...toolArgs] = args;
  const tool: OxcTool | null =
    requested === 'lint' ? 'lint' : requested === 'fmt' || requested === 'format' ? 'fmt' : null;
  if (!tool) {
    console.error('devkit oxc: expected `lint` or `fmt`');
    return 2;
  }
  return runOxcRuntime(tool, toolArgs, cwd);
}
