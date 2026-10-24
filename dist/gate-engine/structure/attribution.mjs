// Staged structure attribution: a violation in a file the change only edits already existed at
// HEAD when nothing staged could have changed its verdict, so it is reported, not blocked.
import { headSha } from '../coverage/failures.mjs';
import { preExisting } from './verdict.mjs';
/** Added and edited files lint in separate runs: the plugin reports a repeated message once per
 * run, so an added file in a broken folder could otherwise hide behind an edited one. */
export async function lintAttributed(cwd, files, added, stable, lint) {
    const fresh = files.filter((file) => added.has(file));
    const edited = files.filter((file) => !added.has(file));
    const results = [];
    if (fresh.length)
        results.push(await lint(cwd, fresh));
    if (edited.length) {
        const result = await lint(cwd, edited);
        const sha = stable ? headSha(cwd) : null;
        results.push(sha ? preExisting(result, sha) : result);
    }
    return results;
}
