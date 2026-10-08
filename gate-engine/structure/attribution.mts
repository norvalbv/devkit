// Staged structure attribution: a violation in a file the change only edits already existed at
// HEAD when nothing staged could have changed its verdict, so it is reported, not blocked.
import { execFileSync } from 'node:child_process';
import { preExisting, type StructureGateResult } from './verdict.mts';

type Lint = (cwd: string, targets: string[]) => Promise<StructureGateResult>;

// Short HEAD sha, or null on an unborn HEAD, where nothing can pre-exist.
function headSha(cwd: string): string | null {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return sha || null;
  } catch {
    return null;
  }
}

/** Added and edited files lint in separate runs: the plugin reports a repeated message once per
 * run, so an added file in a broken folder could otherwise hide behind an edited one. */
export async function lintAttributed(
  cwd: string,
  files: string[],
  added: ReadonlySet<string>,
  stable: boolean,
  lint: Lint,
): Promise<StructureGateResult[]> {
  const fresh = files.filter((file) => added.has(file));
  const edited = files.filter((file) => !added.has(file));
  const results: StructureGateResult[] = [];
  if (fresh.length) results.push(await lint(cwd, fresh));
  if (edited.length) {
    const result = await lint(cwd, edited);
    const sha = stable ? headSha(cwd) : null;
    results.push(sha ? preExisting(result, sha) : result);
  }
  return results;
}
