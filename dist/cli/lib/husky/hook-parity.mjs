/**
 * The single generator-parity comparison: does a hook's marker-delimited guard block equal what the
 * self-host generator produces? `devkit doctor`, `devkit review` and the committed-hook parity test
 * all answer that question through here, so they cannot disagree about the expected block — which
 * they previously did, building it from different selections.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { envFlag } from '../../../gate-engine/config.mjs';
import { repositorySource } from '../../../gate-engine/eval/source.mjs';
import { stagedTouchedSet } from '../../../gate-engine/ratchets/git-index.mjs';
import { emitGateBypass } from '../../../gate-engine/judge/gate-events.mjs';
import { detectGitRoot } from '../detect-git-root.mjs';
import { readJson } from '../fs-helpers.mjs';
import { extractGuardBlock } from './husky-block.mjs';
import { buildSelfHostBlock, isDevkitRepo, SELF_HOST_EXTRAS, SELF_HOST_STRUCTURE_CMD, selfHostSelection, } from './self-host.mjs';
/** The hook devkit's guard block lives in, relative to the git root. */
export const HOOK_REL = '.husky/pre-commit';
/**
 * `null` block (no markers) is NOT a match: an unmarked hook has no guard block at all, which is a
 * different failure from a stale one and must never read as parity.
 */
export function guardBlockMatches(hookContent, expectedBlock, pkgRel = '') {
    const current = extractGuardBlock(hookContent, pkgRel);
    return current !== null && current.trim() === expectedBlock.trim();
}
function readComponents(gitRoot, source) {
    const rel = '.devkit/config.json';
    if (source === 'worktree')
        return readJson(join(gitRoot, rel))?.components;
    const text = repositorySource(gitRoot, 'staged').read(rel);
    if (text === null)
        return undefined;
    try {
        const parsed = JSON.parse(text);
        return parsed.components;
    }
    catch {
        return undefined;
    }
}
/**
 * Read the hook and compare it to the self-host generator's current output.
 *
 * `source: 'staged'` reads the INDEX blob rather than the working-tree file. At commit time that is
 * the honest subject: it makes "regenerated but forgot to `git add`" a caught case, and makes a
 * bystander whose worktree copy is mid-edit a pass. Never throws on a missing hook — an absent file
 * and an absent blob both surface as `status: 'missing'`.
 */
export function selfHostHookParity(cwd, opts = {}) {
    const { gitRoot, pkgRel } = detectGitRoot(cwd);
    const hookPath = join(gitRoot, HOOK_REL);
    const source = opts.source ?? 'worktree';
    // The recorded selection is a generator INPUT, so it must come from the same snapshot as the hook
    // it is compared against. Reading the index hook against a worktree config lets a staged
    // selection change read as parity (or a staged-clean pair read as drift).
    const components = opts.components ?? readComponents(gitRoot, source) ?? {};
    const base = { gitRoot, pkgRel, hookRel: HOOK_REL, hookPath, source };
    // Read BEFORE building: see the `expectedBlock` doc above — the missing branch must not run the
    // generator.
    const content = source === 'staged'
        ? repositorySource(gitRoot, 'staged').read(HOOK_REL)
        : existsSync(hookPath)
            ? readFileSync(hookPath, 'utf8')
            : null;
    if (content === null)
        return {
            ...base,
            status: 'missing',
            currentBlock: null,
            expectedBlock: '',
            reason: 'missing .husky/pre-commit',
        };
    const expectedBlock = buildSelfHostBlock({
        ...selfHostSelection(components),
        structureCmd: SELF_HOST_STRUCTURE_CMD,
        extras: SELF_HOST_EXTRAS,
    }, pkgRel, cwd);
    const currentBlock = extractGuardBlock(content, pkgRel);
    if (currentBlock === null)
        return {
            ...base,
            status: 'unmarked',
            currentBlock: null,
            expectedBlock,
            reason: 'pre-commit gate block differs from the current generator',
        };
    return currentBlock.trim() === expectedBlock.trim()
        ? { ...base, status: 'ok', currentBlock, expectedBlock, reason: null }
        : {
            ...base,
            status: 'stale',
            currentBlock,
            expectedBlock,
            reason: 'pre-commit gate block differs from the current generator',
        };
}
/*
 * `--gate`: the pre-commit half.
 *
 * `--extra` gates run with failOpen2:false in the deterministic orchestrator, so EVERY non-zero exit
 * blocks the commit. Non-zero is therefore reserved for a hook that is genuinely absent, or drifted
 * because of this change; every environmental condition returns 0.
 */
/**
 * Exact repo-relative files whose staged presence makes hook drift THIS change's fault.
 *
 * The first three are CONFIG inputs (the hook itself, the recorded selection, and the bin map
 * sourceBinFor rewrites against). The rest are the generator's own transitive import closure
 * outside cli/lib/husky/ — kept honest by the import-graph test in hook-parity.test.mts rather than
 * by anyone remembering to update this list.
 */
export const HOOK_GENERATOR_FILES = [
    '.husky/pre-commit',
    '.devkit/config.json',
    'package.json',
    'cli/lib/components.mts',
    'cli/lib/fs-helpers.mts',
    'cli/lib/install/agent-assets/agent-providers.mts',
    'gate-engine/judge/judge-isolation.mts',
];
/** Directory prefixes with the same effect. */
export const HOOK_GENERATOR_PREFIXES = ['cli/lib/husky/'];
/**
 * Is this staged path an input to the generated hook?
 *
 * The list is deliberately minimal in BOTH directions, because each has a real cost. An entry that
 * does not actually feed the generator can block a developer for drift they did not cause — the
 * printed GUARD_HOOK_PARITY_OK release exists for exactly that case. A missing entry silently
 * downgrades a real drift to an advisory, which nobody notices because the gate still reads as
 * passing. The import-graph test in hook-parity.test.mts keeps the second direction honest; the
 * first is why nothing broader than the generator's own closure belongs here.
 */
export function isHookGeneratorPath(rel) {
    const p = rel.replaceAll('\\', '/');
    return (HOOK_GENERATOR_FILES.some((file) => file === p) ||
        HOOK_GENERATOR_PREFIXES.some((prefix) => p.startsWith(prefix)));
}
/**
 * NUL-delimited on purpose. Without `-z`, git C-quotes any path containing non-ASCII or special
 * bytes (`"cli/lib/husky/caf\303\251.mts"`), and a quoted path fails the prefix match — so a
 * generator input would slip past the classifier and produce a clean pass. `-z` also removes the
 * need to trim, since no path can contain a NUL.
 */
function gitPaths(cwd, args) {
    // Callers place -z themselves: appending it here would land AFTER a `--` separator, where git
    // reads it as a pathspec rather than a flag.
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0)
        return null;
    return result.stdout.split('\0').filter(Boolean);
}
/**
 * The expected block is generated by importing the WORKTREE generator, while the hook it is compared
 * against comes from the index. That is sound only while the generator's inputs are identical in
 * both — a partially-staged generator input would compare two different trees and could report
 * either verdict wrongly. Rather than guess, say so and stand down; the normal case, where you
 * staged exactly what you edited, is unaffected.
 *
 * UNTRACKED inputs count too, and are the subtler half: an author who adds a new module under
 * cli/lib/husky/, imports it from the generator and regenerates the hook gets a passing comparison
 * — the worktree generator loads the new module, so the expected block already reflects it — while
 * the commit itself does not contain the file. A clean checkout of that commit cannot load the
 * generator at all.
 */
function splitGeneratorInputs(cwd) {
    const unstaged = gitPaths(cwd, ['diff', '--name-only', '-z']);
    // No --exclude-standard: an IGNORED module imported by a staged generator file is still loaded
    // from the worktree and still absent from the commit, so excluding it reopens the false pass.
    // Bounded by pathspec instead, which keeps the walk off node_modules and dist entirely.
    const untracked = gitPaths(cwd, [
        'ls-files',
        '--others',
        '-z',
        '--',
        ...HOOK_GENERATOR_FILES,
        ...HOOK_GENERATOR_PREFIXES,
    ]);
    // A failed git inspection is not "nothing differs": treat it as unknown and stand down, rather
    // than judging on a set we know is incomplete.
    if (unstaged === null || untracked === null)
        return [UNKNOWN_SPLIT];
    return [...new Set([...unstaged, ...untracked])].filter(isHookGeneratorPath).sort();
}
/** Sentinel for "git could not tell us", distinguishable from a real path in the inert message. */
const UNKNOWN_SPLIT = '(git could not list working-tree state)';
/** Pure verdict — no printing, so the block/advisory partition is directly assertable. */
export function judgeHookParity(cwd = process.cwd(), stagedOverride) {
    const inert = (reason) => ({
        code: 0,
        parity: null,
        blamed: [],
        inert: reason,
    });
    // Consumers generate their hook from THEIR devkit version, so comparing it against this
    // generator is meaningless. Silence, not an advisory: there is nothing for them to act on.
    if (!isDevkitRepo(cwd))
        return inert(null);
    const staged = stagedOverride === undefined ? stagedTouchedSet(cwd) : stagedOverride;
    // No staged set means git could not answer. There is no change to attribute, and blaming the
    // tree is what `ratchets-blame-the-change-not-the-tree` exists to forbid.
    const parity = selfHostHookParity(cwd, { source: staged === null ? 'worktree' : 'staged' });
    // A hook that exists nowhere is decisive whatever the generator's state.
    if (parity.status === 'missing')
        return { code: 2, parity, blamed: [], inert: null };
    // BEFORE trusting the comparison in either direction. The expected block was built by importing
    // the worktree generator, so if any generator input differs from what the commit will contain,
    // `ok` is as untrustworthy as `stale` — and `ok` is the dangerous one, because it is the silent
    // false pass an untracked new module produces.
    const split = splitGeneratorInputs(cwd);
    if (split.length)
        return {
            ...inert(`cannot compare — these generator inputs differ between the index and the worktree: ${split.join(', ')}`),
            parity,
        };
    if (parity.status === 'ok')
        return { code: 0, parity, blamed: [], inert: null };
    if (staged === null)
        return { ...inert('could not attribute this change (git unavailable)'), parity };
    const blamed = [...staged].filter(isHookGeneratorPath).sort();
    return { code: blamed.length ? 1 : 0, parity, blamed, inert: null };
}
// envFlag prepends GUARD_/FRINK_, so it takes the bare suffix; every message prints the full
// canonical name, which is the only spelling a remedy line may show.
const BYPASS_SUFFIX = 'HOOK_PARITY_OK';
const BYPASS_FLAG = `GUARD_${BYPASS_SUFFIX}`;
/** Print the verdict and return the exit code the hook propagates. */
export function runHookParityGate(cwd = process.cwd()) {
    if (envFlag(BYPASS_SUFFIX)) {
        emitGateBypass('hook-parity', BYPASS_FLAG);
        console.log(`⚠️  Hook parity gate BYPASSED for this run (${BYPASS_FLAG}=1).`);
        console.log('   The committed hook was NOT verified against the generator for this commit.');
        return 0;
    }
    let verdict;
    try {
        verdict = judgeHookParity(cwd);
    }
    catch (e) {
        console.log(`⚠ Hook parity did not run (${e instanceof Error ? e.message : String(e)}) — nothing was judged.`);
        return 0;
    }
    if (verdict.inert) {
        console.log(`⚠ Hook parity ${verdict.inert} — nothing was judged.`);
        return 0;
    }
    if (!verdict.parity)
        return 0;
    if (verdict.parity.status === 'ok') {
        console.log('✓ Hook parity passed (staged .husky/pre-commit === generator output).');
        return 0;
    }
    if (verdict.parity.status === 'missing') {
        console.error('🚫 .husky/pre-commit is missing — this commit would run no gates at all.');
        console.error('   Reinstall it, then commit:\n     node cli/index.mts doctor --fix');
        return 2;
    }
    if (verdict.code === 0) {
        console.log('ℹ .husky/pre-commit is out of parity with the generator (not this change).');
        console.log('   No hook-generator input is staged, so this drift predates your commit.');
        console.log('   Refresh with `node cli/index.mts doctor --fix` — this commit is not blocked by it.');
        return 0;
    }
    console.error('🚫 Hook parity broken — the staged .husky/pre-commit no longer matches the generator.');
    for (const file of verdict.blamed)
        console.error(`   staged input:  ${file}`);
    console.error('   The committed hook is what every future commit runs; a generator change that is not\n' +
        '   regenerated into it lands on main and only the 11-minute pre-push suite catches it.\n' +
        '   Regenerate and stage it, then commit once:\n' +
        '     node cli/index.mts doctor --fix && git add .husky/pre-commit');
    console.error('   Base-branch drift your diff did not cause? Assert it for THIS run only:\n' +
        `     export ${BYPASS_FLAG}=1`);
    return 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    // Never throw out of the gate: `--extra` blocks on every non-zero code, so an unhandled error
    // here would block a commit for a reason that has nothing to do with the hook.
    try {
        process.exitCode = runHookParityGate();
    }
    catch (e) {
        console.log(`⚠ Hook parity did not run (${e instanceof Error ? e.message : String(e)}) — nothing was judged.`);
        process.exitCode = 0;
    }
}
