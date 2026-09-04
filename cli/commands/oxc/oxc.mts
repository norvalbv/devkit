/** `devkit oxc` — run Devkit's pinned Oxlint/Oxfmt packages against the consumer cwd. */

import { type OxcTool, runOxcRuntime } from '../../lib/install/oxc/runtime.mts';

export const meta = {
  name: 'oxc',
  agentFacing: false,
  notRoutedBecause:
    "Passthrough runner for devkit's pinned oxlint/oxfmt binaries, invoked by the package" +
    "scripts init wires. Agents run the repo's own lint/format scripts, not the wrapper" +
    'beneath them.',
  summary: "Run Devkit's pinned native Oxlint or Oxfmt (no consumer install).",
  help: `devkit oxc — run Devkit's pinned Oxc tools.

Usage:
  devkit oxc lint [oxlint arguments...]
  devkit oxc fmt  [oxfmt arguments...]

Arguments and exit status pass through to the underlying tool. The lint command keeps the complete
repository Oxlint policy but reserves Devkit anti-slop execution for the baseline-aware
\`devkit anti-slop\` command. Runtime resolution is relative to Devkit's own package and never falls
back to PATH, a global install, or consumer node_modules/.bin.`,
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
