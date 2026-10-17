// `guard-structure preflight -- <path...>`: would the folder-structure gate reject these paths, even
// before they exist? Uses the gate's own config. Exit 0 none blocks, 1 any blocks, 2 could not run.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { ESLint } from 'eslint';
import { buildStructureConfigs } from './eslint-config.mjs';
import { couldNotRun } from './verdict.mjs';
const NO_GRAMMAR = 'no structure.trees[].grammar declared (preset-only consumer); the electron preset leg runs only for an electron stack (recorded, else detected)';
/**
 * Run `lint` with an ESLint over the repo's grammar trees; null when no tree declares a grammar.
 * The plugin's error cache lives in a throwaway dir: persisted in the repo it silences later runs.
 */
export async function withStructureLinter(cwd, lint) {
    const baseConfig = await buildStructureConfigs(cwd);
    if (!baseConfig.length)
        return null;
    const cacheDir = mkdtempSync(join(tmpdir(), 'devkit-structure-cache-'));
    try {
        const eslint = new ESLint({
            cwd,
            overrideConfigFile: true,
            baseConfig: [...baseConfig, { settings: { 'project-structure/cache-location': cacheDir } }],
        });
        return await lint(eslint);
    }
    finally {
        rmSync(cacheDir, { recursive: true, force: true });
    }
}
export function noGrammarResult() {
    return couldNotRun(NO_GRAMMAR);
}
// One linter per path: the plugin drops a message it already cached for another filename, so two
// files in one invalid new folder would otherwise report the second as ok.
async function judgePath(cwd, file) {
    return withStructureLinter(cwd, async (eslint) => {
        if (await eslint.isPathIgnored(file))
            return { verdict: 'not judged' };
        const [result] = await eslint.lintText('', { filePath: file });
        if (!result?.errorCount)
            return { verdict: 'ok' };
        const errors = result.messages.filter((message) => message.severity === 2);
        return { verdict: 'blocks', message: errors.map((error) => error.message.trim()).join('\n') };
    });
}
/** Print the judged paths in the gate's style and return the exit code. */
function report(judged) {
    console.log('guard-structure preflight — folder-structure grammar');
    for (const { shown, placement } of judged) {
        if (placement.verdict === 'ok')
            console.log(`   ${shown} — ok`);
        if (placement.verdict === 'blocks')
            console.log(`   ${shown} — blocks: ${placement.message}`);
    }
    const notJudged = judged.filter(({ placement }) => placement.verdict === 'not judged');
    if (notJudged.length) {
        const shown = notJudged.map((path) => path.shown).join(', ');
        console.log(`   not judged (outside every structure tree, or ignored): ${shown}`);
    }
    const blocked = judged.some(({ placement }) => placement.verdict === 'blocks');
    if (blocked) {
        console.log('Rename or relocate the file to match the grammar, or register a new domain folder in guard.config.json structure.trees[].libDomains.');
    }
    return blocked ? 1 : 0;
}
/** Judge each path against the grammar, print the verdicts and return the exit code. */
export async function preflightStructure(cwd, paths) {
    try {
        const judged = [];
        for (const path of paths) {
            const file = resolve(cwd, path);
            const placement = await judgePath(cwd, file);
            if (!placement) {
                console.error(noGrammarResult().text);
                return 2;
            }
            judged.push({ shown: relative(cwd, file) || path, placement });
        }
        return report(judged);
    }
    catch (error) {
        console.error(couldNotRun(error instanceof Error ? error.message : String(error)).text);
        return 2;
    }
}
