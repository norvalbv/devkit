/**
 * Which CI workflow and artifact `devkit baseline-status` reads (sc-3445): the CONSUMER's
 * guard.config.json `baselineStatus` (W-3), else devkit's own gate.yml defaults.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { CONFIG_FILENAME } from '../../../gate-engine/config.mjs';
import { parseJsonObject } from '../../../gate-engine/config-json.mjs';
import { detectGitRoot } from '../detect-git-root.mjs';
import { DEFAULT_ARTIFACT, DEFAULT_WORKFLOW, workflowSelector } from './query.mjs';
/**
 * The nearest guard.config.json up to the git root — an agent's shell may sit in a package or
 * subfolder, and reading only `cwd` would silently query the default workflow instead.
 */
function configDir(cwd) {
    const { gitRoot } = detectGitRoot(cwd);
    for (let dir = cwd;; dir = dirname(dir)) {
        if (existsSync(join(dir, CONFIG_FILENAME)))
            return dir;
        if (dir === gitRoot || relative(gitRoot, dir).startsWith('..') || dirname(dir) === dir) {
            return null;
        }
    }
}
/**
 * A non-blank string, trimmed; anything else takes the default rather than reaching gh argv.
 * Compared by round-trip rather than a representation check, as config.mts's `str` does.
 */
function named(value, fallback) {
    return value != null && `${value}` === value && value.trim() !== '' ? value.trim() : fallback;
}
/**
 * The configured source for `cwd`. Throws on a corrupt guard.config.json — the same loud failure
 * resolveGuardConfig gives, because a typo'd config must not quietly query the wrong workflow.
 */
export function configuredSource(cwd) {
    const dir = configDir(cwd);
    if (dir === null)
        return { workflow: DEFAULT_WORKFLOW, artifact: DEFAULT_ARTIFACT };
    const path = join(dir, CONFIG_FILENAME);
    const block = parseJsonObject(readFileSync(path, 'utf8'), `${CONFIG_FILENAME} at ${path}`).baselineStatus;
    // Normalised HERE, like the --workflow flag: a path that names no file is a typo, not a default.
    const workflow = workflowSelector(named(block?.workflow, DEFAULT_WORKFLOW));
    if (!workflow) {
        throw new Error(`${CONFIG_FILENAME} at ${path}: baselineStatus.workflow names no workflow file`);
    }
    return { workflow, artifact: named(block?.artifact, DEFAULT_ARTIFACT) };
}
