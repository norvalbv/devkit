// Shell `source` edges of a shipped .sh, resolved to repo paths for the dist-integrity walk.
// Targets under the script's own directory resolve, system and $HOME-rooted ones are skipped, the rest block.
import path from 'node:path';
import { assignedNames, ownDirVars, scanShellScript } from '../../doctor/hook-gate-scan.mjs';
/** The literal inline spelling of "my own directory", used without a variable. */
const SCRIPT_DIR_LITERAL = '$(dirname "${BASH_SOURCE[0]}")';
/** A leading underscore is real here — review/submodules.sh uses `_REVIEW_SUBMODULE_LIB_DIR`. */
const VAR_EXPANSION = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;
/** Rooted outside the package tree: a real runtime dependency, but never on a dist artifact. */
const EXTERNAL_ROOT = /^\$\{?(?:HOME|TMPDIR|XDG_[A-Z_]+)\}?$/;
const BARE_VAR = /^\$[A-Za-z_][A-Za-z0-9_]*/;
/** `$( )` and `${ }` nest, so a scan to the FIRST closer takes the wrong span for `$(x "$(y)")`. */
function expansionEnd(operand) {
    const open = operand[1];
    if (open !== '(' && open !== '{') {
        return operand.startsWith('$') ? (BARE_VAR.exec(operand)?.[0].length ?? -1) : -1;
    }
    const close = open === '(' ? ')' : '}';
    let depth = 0;
    for (let i = 1; i < operand.length; i++) {
        if (operand[i] === open)
            depth++;
        else if (operand[i] === close && --depth === 0)
            return i + 1;
    }
    return -1;
}
function unwrapQuotes(operand) {
    const quoted = operand.startsWith('"') && operand.length > 1 && operand.endsWith('"');
    return quoted ? operand.slice(1, -1) : operand;
}
/** Repo path, `null` when deliberately outside the dist closure, `undefined` when opaque. */
function shellTarget(importer, operand, dirVars, assigned) {
    const bare = unwrapQuotes(operand);
    // An absolute system path (`. /etc/os-release`) is a real dependency, never a dist artifact.
    if (bare.startsWith('/'))
        return null;
    const end = expansionEnd(bare);
    if (end === -1)
        return undefined;
    const expansion = bare.slice(0, end);
    const tail = bare.slice(end);
    if (!tail.startsWith('/'))
        return undefined;
    const named = VAR_EXPANSION.exec(expansion);
    if (!(named ? dirVars.has(named[1]) : expansion === SCRIPT_DIR_LITERAL)) {
        // External root only for a name this script never assigns: a reassigned `HOME` is not $HOME,
        // whatever it now holds, so it cannot be waved through as living outside the package.
        const inherited = named === null || !assigned.has(named[1]);
        return inherited && EXTERNAL_ROOT.test(expansion) ? null : undefined;
    }
    // Returned even when it climbs out of dist/: `willShip` then names the exact edge, which is
    // what an .mjs import above dist already gets. The requeue guard keeps the WALK inside dist.
    return path.posix.normalize(path.posix.join(path.posix.dirname(importer), tail));
}
/** Shell `source` edges of ONE shipped script, in moduleImportEdges' shape: `undefined` means
 *  unverified, and every caller blocks on it. */
export async function shellSourceEdges(importer, source) {
    // Dev-only: installed consumer copies short-circuit before this runs.
    const { parse } = await import('unbash');
    const scan = scanShellScript(source, parse);
    if (scan === undefined)
        return undefined;
    const edges = [];
    for (const { text, at } of scan.operands) {
        // Only the nearest preceding assignment counts: `DIR=<own>; DIR=/tmp; . "$DIR/x"` is untrusted.
        const target = shellTarget(importer, text, ownDirVars(scan, at), assignedNames(scan));
        if (target === null)
            continue;
        if (target === undefined)
            return undefined;
        edges.push({ importer, specifier: text, target });
    }
    return edges;
}
