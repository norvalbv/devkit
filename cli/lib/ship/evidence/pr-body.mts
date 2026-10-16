// The PR-body boundary: one bounded gh read and write each. GitHub has no compare-and-set on a body,
// so an edit re-reads after writing and, given a head, refuses once the PR head has moved past it.
import { execFileSync } from 'node:child_process';
import { z } from 'zod';

const GH_TIMEOUT_MS = 60_000;
const ATTEMPTS = 3;

const pullSchema = z.object({
  title: z.string().optional(),
  body: z.string(),
  headRefOid: z.string(),
  baseRefOid: z.string(),
});
export type PullState = z.infer<typeof pullSchema>;

export type PublishResult = 'written' | 'unchanged' | 'head-moved' | 'contended';

export function readPull(repo: string, pr: string): PullState {
  const json = execFileSync(
    'gh',
    ['pr', 'view', pr, '--repo', repo, '--json', 'title,body,headRefOid,baseRefOid'],
    { encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
  );
  return pullSchema.parse(JSON.parse(json));
}

function writeBody(repo: string, pr: string, body: string): void {
  execFileSync('gh', ['pr', 'edit', pr, '--repo', repo, '--body-file', '-'], {
    input: body,
    timeout: GH_TIMEOUT_MS,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
}

/** Apply `edit` to the PR body while its head is still `head` (null: any head); retried, bounded. */
export function publishBody(
  repo: string,
  pr: string,
  head: string | null,
  edit: (body: string) => string,
): PublishResult {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const pull = readPull(repo, pr);
    if (head !== null && pull.headRefOid !== head) return 'head-moved';
    const next = edit(pull.body);
    if (next === pull.body) return 'unchanged';
    writeBody(repo, pr, next);
    if (readPull(repo, pr).body.trimEnd() === next.trimEnd()) return 'written';
  }
  return 'contended';
}
