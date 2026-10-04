import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Label } from './arms.mts';
import type { JudgedComment } from './request.mts';

const CORPUS_PATH = new URL('./corpus.json', import.meta.url);

export type EvalItem = JudgedComment & { id: string; label: Label };

const label = z.enum([
  'load_bearing',
  'workaround_justification',
  'change_narration',
  'restates_code',
  'internal_reference',
]);
const located = { id: z.string(), repo: z.string(), sha: z.string(), file: z.string() };
const corpusSchema = z.object({
  items: z.array(
    z.object({
      ...located,
      comment: z.string(),
      codeBefore: z.string(),
      codeAfter: z.string(),
      provisionalLabel: label,
    }),
  ),
  external: z.array(
    z.object({
      ...located,
      startLine: z.number().int().positive(),
      commentLines: z.number().int().positive(),
      commentSha256: z.string(),
      provisionalLabel: label,
    }),
  ),
});

type Corpus = z.infer<typeof corpusSchema>;
type External = Corpus['external'][number];

function parseCorpus(raw: string): Corpus {
  return corpusSchema.parse(JSON.parse(raw));
}

/** Committed items carry only a window around the comment, so their lines are window-relative. */
function committedItem(item: Corpus['items'][number]): EvalItem {
  const before = item.codeBefore ? item.codeBefore.replace(/\n$/, '').split('\n') : [];
  const commentLines = item.comment.split('\n');
  const startLine = before.length + 1;
  return {
    id: item.id,
    label: item.provisionalLabel,
    path: item.file,
    comment: item.comment,
    source: [...before, ...commentLines, item.codeAfter].join('\n'),
    startLine,
    endLine: startLine + commentLines.length - 1,
  };
}

function gitShow(checkout: string, sha: string, file: string): string {
  return execFileSync('git', ['-C', checkout, 'show', `${sha}:${file}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

export type ReadBlob = (checkout: string, sha: string, file: string) => string;

function rebuiltItem(
  entry: External,
  checkout: string | undefined,
  readBlob: ReadBlob,
): { item: EvalItem } | { skip: string } {
  if (!checkout) return { skip: `${entry.id}: no --repo ${entry.repo}=<path> given` };
  let source: string;
  try {
    source = readBlob(checkout, entry.sha, entry.file);
  } catch {
    return {
      skip: `${entry.id}: ${entry.sha.slice(0, 12)}:${entry.file} unreadable in ${checkout}`,
    };
  }
  const endLine = entry.startLine + entry.commentLines - 1;
  const comment = source
    .split('\n')
    .slice(entry.startLine - 1, endLine)
    .join('\n');
  const digest = createHash('sha256').update(comment).digest('hex');
  if (digest !== entry.commentSha256) {
    return { skip: `${entry.id}: comment hash mismatch in ${checkout}` };
  }
  const { id, provisionalLabel, file, startLine } = entry;
  return { item: { id, label: provisionalLabel, path: file, comment, source, startLine, endLine } };
}

/** Rebuilds manifest-only items from local checkouts; an unavailable one is skipped with a warning. */
export function loadCorpus(
  raw: string,
  checkouts: Record<string, string>,
  warn: (message: string) => void,
  readBlob: ReadBlob = gitShow,
): EvalItem[] {
  const corpus = parseCorpus(raw);
  const items = corpus.items.map(committedItem);
  for (const entry of corpus.external) {
    const rebuilt = rebuiltItem(entry, checkouts[entry.repo], readBlob);
    if ('skip' in rebuilt) warn(`skipped ${rebuilt.skip}`);
    else items.push(rebuilt.item);
  }
  return items;
}

export function readCorpusFile(): string {
  return readFileSync(CORPUS_PATH, 'utf8');
}
