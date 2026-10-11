/** Shared fixtures for the `devkit baseline-status` suites: a real git branch and a per-commit gh stub. */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunRef } from '../lib/baseline-status/gh.mts';

/** Turn `dir` into a repo on `main` whose `origin` is itself, so `git ls-remote origin` is offline. */
export function seedBranch(dir: string): string {
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-b', 'main');
  // Fixtures set their own identity — an inherited-identity fixture is exactly what reddens CI.
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  git('commit', '--allow-empty', '-m', 'seed');
  git('remote', 'add', 'origin', dir);
  return headOf(dir);
}

/** Add an empty commit on top of `dir`'s branch and return its sha. */
export function addCommit(dir: string): string {
  execFileSync('git', ['commit', '--allow-empty', '-m', 'next'], { cwd: dir, stdio: 'ignore' });
  return headOf(dir);
}

export function headOf(dir: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

/** Inline JS that prints the runs.json entries whose headSha is the queried commit. */
const FILTER =
  'const fs=require("fs");const [f,c]=process.argv.slice(1);const raw=fs.readFileSync(f,"utf8");' +
  'let r;try{r=JSON.parse(raw)}catch{r=null}' +
  'process.stdout.write(Array.isArray(r)?JSON.stringify(r.filter((x)=>typeof x?.headSha!=="string"||x.headSha===c)):raw)';

/** The stub's `gh run list --commit <sha>` arm: logs the sha, then answers from runs.json. */
export const RUN_LIST_BY_COMMIT = `commit=""; prev=""
  for a in "$@"; do if [ "$prev" = "--commit" ]; then commit="$a"; fi; prev="$a"; done
  echo "$*" >> "$DEVKIT_TEST_FIXTURE/list.log"
  exec node -e '${FILTER}' "$DEVKIT_TEST_FIXTURE/runs.json" "$commit"`;

/** A PATH holding only git, so a test can remove gh without also removing the head lookup. */
export function gitOnlyPath(dir: string): string {
  const bin = join(dir, 'git-only-bin');
  mkdirSync(bin, { recursive: true });
  const git = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  symlinkSync(git, join(bin, 'git'));
  return bin;
}

/** The stub's `gh api …/branches/<ref>` arm: GitHub's head is the stub repo's branch, or `head`. */
export const API_BRANCH_HEAD = `if [ "$1" = "api" ]; then
  echo "$*" >> "$DEVKIT_TEST_FIXTURE/api.log"
  if [ -f "$DEVKIT_TEST_FIXTURE/head" ]; then cat "$DEVKIT_TEST_FIXTURE/head"; exit 0; fi
  branch=$(printf '%s' "\${2#*/branches/}" | sed 's#%2F#/#g')
  git rev-parse --verify -q "refs/heads/$branch" && exit 0
  echo "gh: Branch not found (HTTP 404)" >&2; exit 1
fi`;

/** The head of the newest ghHarness branch; runRef points at it unless told otherwise. */
let harnessHead = '';

/** The stubbed-gh harness on a real one-commit branch, shared by the query and command cases. */
export function ghHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'edge-query-'));
  const fixture = mkdtempSync(join(tmpdir(), 'edge-fixture-'));
  harnessHead = seedBranch(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const stub = join(bin, 'gh');
  writeFileSync(
    stub,
    `#!/bin/sh
if [ -n "$DEVKIT_GH_FAIL" ]; then echo "$DEVKIT_GH_FAIL" >&2; exit 1; fi
${API_BRANCH_HEAD}
if [ "$1" = "run" ] && [ "$2" = "list" ]; then
  ${RUN_LIST_BY_COMMIT}
fi
if [ "$1" = "run" ] && [ "$2" = "download" ]; then
  if [ -n "$DEVKIT_GH_DOWNLOAD_FAIL" ]; then echo "$DEVKIT_GH_DOWNLOAD_FAIL" >&2; exit 1; fi
  id="$3"; out=""
  while [ $# -gt 0 ]; do if [ "$1" = "--dir" ]; then out="$2"; fi; shift; done
  if [ -f "$DEVKIT_TEST_FIXTURE/empty-$id" ]; then exit 0; fi
  if [ -f "$DEVKIT_TEST_FIXTURE/summary-$id.json" ]; then
    mkdir -p "$out/run-$id"; cp "$DEVKIT_TEST_FIXTURE/summary-$id.json" "$out/run-$id/summary.json"; exit 0
  fi
  echo "no artifact matches any of the names or patterns provided" >&2; exit 1
fi
exit 1
`,
  );
  chmodSync(stub, 0o755);
  return { dir, fixture, bin, head: harnessHead };
}

// runId must match the run it is served for; the reader rejects a mismatched artifact by design.
export const summaryFor = (
  files: Record<string, string>,
  testsPassed: boolean,
  runId = 100,
  attempt = 1,
) =>
  JSON.stringify({
    schema: 1,
    sha: 'sha1',
    runId,
    attempt,
    testsPassed,
    files,
    droppedForeignPaths: 0,
  });

export const runRef = (over: Partial<RunRef> = {}): RunRef => ({
  databaseId: 100,
  attempt: 1,
  status: 'completed',
  conclusion: 'failure',
  headSha: harnessHead,
  createdAt: '2026-08-29T00:00:00Z',
  headBranch: 'main',
  event: 'push',
  ...over,
});
