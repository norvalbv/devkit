/** guard.config.json `comments`: which references a changed comment may not cite. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CONFIG_FILENAME, resolveGuardConfigJson } from '../config.mjs';
import { parseJsonObject } from '../config-json.mjs';
import { commitIndexEnv } from '../ratchets/commit-index.mjs';
import { gitIgnores, indexFile } from '../review/evidence/staged-git.mjs';
const commentsSchema = z.looseObject({
    comments: z
        .object({
        forbiddenRefs: z.array(z.string()).optional(),
        forbidDecisionRefs: z.boolean().optional(),
    })
        .optional(),
});
const ESCAPE = /[.*+?^${}()|[\]\\]/g;
const escape = (value) => value.replace(ESCAPE, '\\$&');
function compile(source, index) {
    try {
        return new RegExp(source, 'g');
    }
    catch (cause) {
        throw new Error(`${CONFIG_FILENAME} comments.forbiddenRefs[${index}]: ${cause instanceof Error ? cause.message : cause}`);
    }
}
/** Record names come from the commit index, so an unstaged record never changes the verdict.
 * Single-word names are skipped: they collide with ordinary prose. */
function decisionPattern(cwd, decisionsDir) {
    const dir = path.relative(cwd, path.resolve(cwd, decisionsDir)).split(path.sep).join('/') || '.';
    const listed = execFileSync('git', ['ls-files', '-z', '--', dir], {
        cwd,
        env: commitIndexEnv(cwd),
        encoding: 'utf8',
    });
    const names = listed
        .split('\0')
        .filter((file) => path.posix.dirname(file) === dir && file.endsWith('.md'))
        .map((file) => path.posix.basename(file, '.md'))
        .filter((name) => name.includes('-'));
    const alternatives = [...(dir === '.' ? [] : [escape(dir)]), ...names.map(escape)];
    if (alternatives.length === 0)
        return null;
    return new RegExp(`(?<![\\w-])(?:${alternatives.join('|')})(?![\\w-])`, 'g');
}
/** The staged config, so an unstaged edit cannot change the verdict; a git-ignored local config
 * has no staged copy and is read from the working tree. */
function stagedConfig(cwd) {
    const indexed = indexFile(cwd, CONFIG_FILENAME);
    if (indexed !== null)
        return indexed;
    const file = path.join(cwd, CONFIG_FILENAME);
    return gitIgnores(cwd, CONFIG_FILENAME) && existsSync(file) ? readFileSync(file, 'utf8') : null;
}
/** Absent key or file: no reference patterns, so a consumer that never opted in sees no change. */
export function loadCommentPolicy(cwd) {
    const contents = stagedConfig(cwd);
    if (contents === null)
        return { refs: [] };
    const parsed = commentsSchema.safeParse(parseJsonObject(contents, CONFIG_FILENAME));
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`${CONFIG_FILENAME} ${issue?.path.join('.')}: ${issue?.message}`);
    }
    const comments = parsed.data.comments ?? {};
    const refs = (comments.forbiddenRefs ?? []).map(compile);
    const decisions = comments.forbidDecisionRefs
        ? decisionPattern(cwd, resolveGuardConfigJson(contents, cwd).decisionsDir)
        : null;
    if (decisions)
        refs.push(decisions);
    return { refs };
}
