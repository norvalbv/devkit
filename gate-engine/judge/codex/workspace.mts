// A workspace-write codex judge's cwd is always writable, so it runs in a throwaway dir rather than
// the consumer's checkout, where it could overwrite unstaged edits made during a long review.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { type CodexWorkspace, needsCodexWorkspace } from './result.mts';

export interface CodexSandbox {
  codexReadOnly: boolean;
  workspace?: CodexWorkspace;
  /** Never throws: a judge's verdict must not turn into an outage over a leftover temp dir. */
  cleanup: () => void;
}

/** Create the workspace when this argv routes to a workspace-write codex judge; a no-op otherwise. */
export function prepareCodexSandbox(
  args: string[],
  codexReadOnly: boolean,
  cwd: string,
): CodexSandbox {
  if (!needsCodexWorkspace(args, codexReadOnly)) return { codexReadOnly, cleanup: () => {} };
  const repoRoot = resolve(cwd);
  assertClaudeDirConfined(repoRoot);
  const scratch = mkdtempSync(join(tmpdir(), 'devkit-judge-'));
  return { codexReadOnly, workspace: { scratch, repoRoot }, cleanup: () => removeScratch(scratch) };
}

function removeScratch(scratch: string): void {
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // A killed judge's grandchild may still hold a file; the OS reaps its temp dir.
  }
}

const isWithin = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** `--add-dir <repo>/.claude` must not widen to the checkout: a symlinked `.claude` may resolve
 * anywhere outside it (a worktree's projected copy), never onto or around it. */
function assertClaudeDirConfined(repoRoot: string): void {
  const dir = join(repoRoot, '.claude');
  mkdirSync(dir, { recursive: true });
  const real = realpathSync(dir);
  const realRepo = realpathSync(repoRoot);
  if (real === join(realRepo, '.claude')) return;
  if (!isWithin(real, realRepo) && !isWithin(realRepo, real)) return;
  throw new Error(
    `codex judge: ${dir} resolves to ${real}, so granting it would make the checkout writable — make .claude a directory, or a link outside the checkout`,
  );
}
