// Staged structure attribution: a violation in a file the change only edits already existed at
// HEAD when nothing staged could have changed its verdict, so it is reported, not blocked.
import { headSha } from '../coverage/failures.mts';
import { preExisting, type StructureGateResult } from './verdict.mts';

type Lint = (cwd: string, targets: string[]) => Promise<StructureGateResult>;

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
