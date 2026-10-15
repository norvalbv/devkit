/** `devkit pr-evidence` — re-capture ship's regression evidence for a PR whose block is inconclusive. */
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { readPull } from '../../lib/ship/evidence/pr-body.mts';
import { publish } from '../../lib/ship/evidence/run.mts';
import { errorMessage } from '../../lib/ship/review/shared/common.mts';
import { originRepo } from '../../lib/ship/ship-intent-codec.mts';

const USAGE = 'usage: devkit pr-evidence <pr|branch|url>';

export const meta = {
  name: 'pr-evidence',
  agentFacing: true,
  summary: "Re-capture an inconclusive regression-evidence block at the PR's current head.",
  help: `devkit pr-evidence — re-capture the evidence block devkit ship wrote, at the same head.

Usage:
  devkit pr-evidence <pr|branch|url>

Run it from a checkout at the PR head, with dependencies installed: it runs guard.config.json's
evidence command on red and green exactly as ship does and rewrites only the PR's
<!-- devkit:evidence:begin --> … end block. Only a block that recorded inconclusive at this head is
replaced; the new detail keeps the previous outcome. A run that is still not captured keeps its
red/green logs and prints their path.

The merge verdict reads human-review: there is no devkit ship gate run to vouch for the head.

Exit codes:
  0  the block was written
  1  usage error, the checkout is not at the PR head, the recorded block is not inconclusive,
     or gh failed`,
};

export default async function prEvidence(args: string[], start: string): Promise<number> {
  const [pr] = args;
  if (!pr || args.length > 1 || pr.startsWith('-')) {
    console.error(`devkit pr-evidence: one PR is required\n${USAGE}`);
    return 1;
  }
  // Ship runs the evidence step from the repository root, where guard.config.json lives.
  const [cwd, head] = execFileSync('git', ['rev-parse', '--show-toplevel', 'HEAD'], {
    cwd: start,
    encoding: 'utf8',
  }).split('\n');
  const repo = originRepo(cwd);
  if (!repo) {
    console.error('devkit pr-evidence: origin is not a GitHub remote; nothing was published');
    return 1;
  }
  try {
    const { headRefOid } = readPull(repo, pr);
    if (head !== headRefOid) {
      console.error(
        `devkit pr-evidence: this checkout is at ${head.slice(0, 12)}, the PR head is ` +
          `${headRefOid.slice(0, 12)}; check out the PR head first (gh pr checkout ${pr})`,
      );
      return 1;
    }
    const written = await publish({ cwd, repo, pr, head, recapture: true, keepIn: tmpdir() });
    return written ? 0 : 1;
  } catch (error) {
    console.error(`devkit pr-evidence: ${errorMessage(error)}; nothing was published`);
    return 1;
  }
}
