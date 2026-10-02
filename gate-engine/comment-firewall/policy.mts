/** guard.config.json `comments`: which references a changed comment may not cite. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CONFIG_FILENAME, resolveGuardConfig } from '../config.mts';
import { parseJsonObject } from '../config-json.mts';
import { commitIndexEnv } from '../ratchets/commit-index.mts';

export interface CommentPolicy {
  /** Every configured reference pattern, global so one comment reports each match. */
  refs: RegExp[];
}

const commentsSchema = z.looseObject({
  comments: z
    .object({
      forbiddenRefs: z.array(z.string()).optional(),
      forbidDecisionRefs: z.boolean().optional(),
    })
    .optional(),
});

const ESCAPE = /[.*+?^${}()|[\]\\]/g;
const escape = (value: string) => value.replace(ESCAPE, '\\$&');

function compile(source: string, index: number): RegExp {
  try {
    return new RegExp(source, 'g');
  } catch (cause) {
    throw new Error(
      `${CONFIG_FILENAME} comments.forbiddenRefs[${index}]: ${cause instanceof Error ? cause.message : cause}`,
    );
  }
}

/** Record names come from the commit index, so an unstaged record never changes the verdict.
 * Single-word names are skipped: they collide with ordinary prose. */
function decisionPattern(cwd: string, decisionsDir: string): RegExp | null {
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
  if (alternatives.length === 0) return null;
  return new RegExp(`(?<![\\w-])(?:${alternatives.join('|')})(?![\\w-])`, 'g');
}

/** Absent key or file: no reference patterns, so a consumer that never opted in sees no change. */
export function loadCommentPolicy(cwd: string): CommentPolicy {
  const file = path.join(cwd, CONFIG_FILENAME);
  if (!existsSync(file)) return { refs: [] };
  const parsed = commentsSchema.safeParse(
    parseJsonObject<object>(readFileSync(file, 'utf8'), CONFIG_FILENAME),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${CONFIG_FILENAME} ${issue?.path.join('.')}: ${issue?.message}`);
  }
  const comments = parsed.data.comments ?? {};
  const refs = (comments.forbiddenRefs ?? []).map(compile);
  const decisions = comments.forbidDecisionRefs
    ? decisionPattern(cwd, resolveGuardConfig(cwd).decisionsDir)
    : null;
  if (decisions) refs.push(decisions);
  return { refs };
}
