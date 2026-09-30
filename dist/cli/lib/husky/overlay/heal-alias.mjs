// Per-clone `git ci`: re-points a husky-reclaimed core.hooksPath at the overlay right before a commit.
// Fail-open `;` (never `&&`): a re-point hiccup must never block the commit.
import { execFileSync } from 'node:child_process';
import { shQuote } from '../../ship/redact-secrets.mjs';
import { firstLine } from '../../standalone.mjs';
import { LOCAL_HOOKS } from './overlay-home.mjs';
export const HEAL_ALIAS_NAME = 'ci';
const KEY = `alias.${HEAL_ALIAS_NAME}`;
const HEAL_ALIAS_RE = /^!git config --local core\.hooksPath (.+); git commit$/;
const QUOTED_RE = /^'(.*)'$/s;
/** The alias body for an overlay whose absolute hooks dir is `hooksDir` (sc-4157: never relative). */
export const healAliasCmd = (hooksDir) => `!git config --local core.hooksPath ${shQuote(hooksDir)}; git commit`;
/** Ours only if it is exactly an alias devkit generates — the older relative one included. */
export function isHealAlias(v) {
    const arg = HEAL_ALIAS_RE.exec(v)?.[1];
    if (!arg)
        return false;
    const quoted = QUOTED_RE.exec(arg);
    const dir = quoted ? quoted[1].replaceAll(`'\\''`, `'`) : arg;
    const named = dir === LOCAL_HOOKS || dir.endsWith(`/${LOCAL_HOOKS}`);
    return named && healAliasCmd(dir) === v;
}
const gitConfig = (gitRoot, args) => execFileSync('git', ['config', ...args], { cwd: gitRoot, encoding: 'utf8' }).trim();
const read = (gitRoot, args) => {
    try {
        return gitConfig(gitRoot, args);
    }
    catch {
        return ''; // unset
    }
};
// git config has no compare-and-set: write, then withdraw ours if a concurrent writer got in too.
function writeAlias(gitRoot, next, previous) {
    gitConfig(gitRoot, [
        '--local',
        ...(previous ? ['--fixed-value', KEY, next, previous] : ['--add', KEY, next]),
    ]);
    const now = read(gitRoot, ['--local', '--get-all', KEY]).split('\n');
    if (now.every((value) => value === next)) {
        if (now.length > 1)
            gitConfig(gitRoot, ['--local', '--replace-all', KEY, next]); // two of ours
        return true;
    }
    read(gitRoot, ['--local', '--fixed-value', '--unset-all', KEY, next]);
    return false;
}
// The collision check reads the RESOLVED value (all scopes), so a user's GLOBAL `ci` is never clobbered.
export function installHealAlias(gitRoot, hooksDir, dryRun) {
    const current = read(gitRoot, ['--get', KEY]);
    if (current && !isHealAlias(current)) {
        console.log(`  • git alias '${HEAL_ALIAS_NAME}' already set — skipping self-heal. Re-point at commit time with: git config core.hooksPath ${shQuote(hooksDir)}`);
        return;
    }
    if (dryRun) {
        console.log(`  [dry-run] git config --local ${KEY} (self-heal core.hooksPath)`);
        return;
    }
    try {
        if (writeAlias(gitRoot, healAliasCmd(hooksDir), read(gitRoot, ['--local', '--get', KEY])))
            console.log(`  ✓ git ${HEAL_ALIAS_NAME} self-heal alias (re-points core.hooksPath before commit)`);
        else
            console.log(`  • git alias '${HEAL_ALIAS_NAME}' changed meanwhile — left it alone`);
    }
    catch (e) {
        console.log(`  ! could not set ${KEY}: ${firstLine(e)}`);
    }
}
// Remove it on `clean` only when ours and only at --local scope; the user's GLOBAL `ci` is never read.
export function removeHealAlias(gitRoot, dryRun) {
    const current = read(gitRoot, ['--local', '--get', KEY]);
    if (!current || !isHealAlias(current))
        return; // absent, or the user's own — leave it
    if (dryRun) {
        console.log(`  [dry-run] unset local ${KEY}`);
        return;
    }
    try {
        // --fixed-value: removes exactly the value judged ours; a concurrent replacement survives.
        gitConfig(gitRoot, ['--local', '--fixed-value', '--unset', KEY, current]);
        console.log(`  ✓ removed git ${HEAL_ALIAS_NAME} self-heal alias`);
    }
    catch (e) {
        console.log(`  ! could not unset ${KEY}: ${firstLine(e)}`);
    }
}
