// `node readout-cli.mts [--repo owner/name] [--days 14]`: print the shadow readout of every PR whose
// body carries a merge-verdict slot. Reads GitHub only; a failed gh call ends the run non-zero.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { VERDICT_SLOT } from '../../evidence/block.mts';
import {
  ciAt,
  renderReadout,
  scorePulls,
  type CheckRun,
  type Ci,
  type MergedPull,
  type VerdictPull,
} from './readout.mts';

const GH_TIMEOUT_MS = 120_000;
const PAGE = 20;
const MAX_EDITS = 100;
/** GitHub search, behind both reads, returns at most this many results and then reports no next page. */
const SEARCH_CAP = 1000;

const SEARCH = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: ${PAGE}, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number state title body headRefName headRefOid mergedAt mergeCommit { oid }
      files(first: 100) { nodes { path } }
      userContentEdits(first: ${MAX_EDITS}) { totalCount nodes { diff } }
    } }
  }
}`;

const pullNode = z.object({
  number: z.number(),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  title: z.string(),
  body: z.string(),
  headRefName: z.string(),
  headRefOid: z.string(),
  mergedAt: z.string().nullable(),
  mergeCommit: z.object({ oid: z.string() }).nullable(),
  files: z.object({ nodes: z.array(z.object({ path: z.string() })) }).nullable(),
  userContentEdits: z.object({
    totalCount: z.number(),
    nodes: z.array(z.object({ diff: z.string().nullable() })),
  }),
});
const pageSchema = z.object({
  data: z.object({
    search: z.object({
      issueCount: z.number(),
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
      nodes: z.array(z.unknown()),
    }),
  }),
});

export interface SearchPage {
  pulls: VerdictPull[];
  /** The cursor of the next page, null on the last one. */
  next: string | null;
}

/** One search page as scored pulls; GitHub lists edits newest first, and an unedited PR has none. */
export function parseSearchPage(json: string): SearchPage {
  const { search } = pageSchema.parse(JSON.parse(json)).data;
  if (search.issueCount > SEARCH_CAP) {
    throw new Error(
      `${search.issueCount} PRs match, past GitHub search's ${SEARCH_CAP}-result cap`,
    );
  }
  // A search hit that is not a pull request matches no fragment and arrives as {}.
  const pulls = search.nodes.flatMap((node) => {
    if (z.strictObject({}).safeParse(node).success) return [];
    const pull = pullNode.parse(node);
    if (pull.userContentEdits.totalCount > MAX_EDITS) {
      throw new Error(
        `#${pull.number} has more than ${MAX_EDITS} body edits; its first verdict is unreadable`,
      );
    }
    const edits = pull.userContentEdits.nodes.flatMap((edit) => edit.diff ?? []).reverse();
    return [
      {
        number: pull.number,
        state: pull.state,
        title: pull.title,
        headRefName: pull.headRefName,
        headRefOid: pull.headRefOid,
        mergedAt: pull.mergedAt,
        mergeOid: pull.mergeCommit?.oid ?? null,
        files: pull.files?.nodes.map((file) => file.path) ?? [],
        bodies: [...edits, pull.body],
      },
    ];
  });
  const { hasNextPage, endCursor } = search.pageInfo;
  return { pulls, next: hasNextPage ? endCursor : null };
}

const gh = (args: string[]): string =>
  execFileSync('gh', args, {
    encoding: 'utf8',
    timeout: GH_TIMEOUT_MS,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });

function verdictPulls(repo: string): VerdictPull[] {
  const query = `repo:${repo} is:pr in:body "${VERDICT_SLOT.slice(5, -4)}"`;
  const pulls: VerdictPull[] = [];
  let after: string | null = null;
  do {
    const cursor: string[] = after ? ['-f', `after=${after}`] : [];
    const page = parseSearchPage(
      gh(['api', 'graphql', '-f', `query=${SEARCH}`, '-f', `q=${query}`, ...cursor]),
    );
    pulls.push(...page.pulls);
    after = page.next;
  } while (after);
  return pulls;
}

const mergedSchema = z.array(
  z.object({
    number: z.number(),
    title: z.string(),
    body: z.string(),
    mergedAt: z.string(),
    files: z.array(z.object({ path: z.string() })).nullable(),
  }),
);

function mergedSince(repo: string, since: string): MergedPull[] {
  const json = gh([
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'merged',
    '--limit',
    String(SEARCH_CAP),
    '--search',
    `merged:>=${since.slice(0, 10)}`,
    '--json',
    'number,title,body,mergedAt,files',
  ]);
  const list = mergedSchema.parse(JSON.parse(json));
  if (list.length >= SEARCH_CAP)
    throw new Error(`more than ${SEARCH_CAP} merged PRs since ${since}`);
  return list.map((pull) => ({ ...pull, files: pull.files?.map((file) => file.path) ?? [] }));
}

const checkRunsSchema = z.object({
  check_runs: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      completed_at: z.string().nullable(),
    }),
  ),
});

function ciReader(repo: string): (sha: string) => Ci {
  const seen = new Map<string, Ci>();
  return (sha) => {
    const known = seen.get(sha);
    if (known) return known;
    const json = gh(['api', `repos/${repo}/commits/${sha}/check-runs?per_page=100`]);
    const runs: CheckRun[] = checkRunsSchema.parse(JSON.parse(json)).check_runs;
    const ci = ciAt(runs);
    seen.set(sha, ci);
    return ci;
  };
}

function main(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: { repo: { type: 'string' }, days: { type: 'string', default: '14' } },
    strict: true,
  });
  const repo =
    values.repo ?? gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim();
  const days = Number(values.days);
  if (!Number.isInteger(days) || days <= 0) throw new Error('--days must be a positive integer');
  const pulls = verdictPulls(repo);
  const since = pulls.flatMap((pull) => pull.mergedAt ?? []).sort()[0];
  const merged = since ? mergedSince(repo, since) : [];
  process.stdout.write(
    renderReadout(scorePulls(pulls, merged, ciReader(repo), repo, days, Date.now())),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`verdict readout: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
