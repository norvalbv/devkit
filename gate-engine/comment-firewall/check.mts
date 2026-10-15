/**
 * Edit-time preview of the commit gate: the unchanged detector, run on a scratch index copy with the
 * named files added. It never reads or records the show-once store, so the commit still shows each block.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commitIndexEnv } from '../ratchets/commit-index.mts';
import { detectChangedComments } from './detect.mts';
import { findingLocation, PARAGRAPH_ADVICE, REF_REMEDY } from './gate.mts';
import type { DetectionResult } from './types.mts';

const SCRATCH_PREFIX = 'devkit-comment-check-';
const STALE_MS = 60 * 60 * 1000;
const WHITESPACE = /\s+/g;
const PARAGRAPH_EDIT_REMEDY = [
  ...PARAGRAPH_ADVICE,
  'If every line states something the code cannot, keep it: the commit gate shows it once.',
].join('\n');

export interface CheckItem {
  key: string;
  line: string;
}

export interface CheckResult {
  items: CheckItem[];
  remedy: string;
  error?: string;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync('git', ['-c', 'core.splitIndex=false', ...args], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** A check killed mid-run skips its own cleanup, so later runs remove what it left behind. */
function sweepStale(): void {
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(SCRATCH_PREFIX)) continue;
    const dir = path.join(tmpdir(), name);
    try {
      if (Date.now() - statSync(dir).mtimeMs > STALE_MS)
        rmSync(dir, { recursive: true, force: true });
    } catch {
      // A concurrent check removed it first.
    }
  }
}

/** `add -u` pairs a plain mv as a rename, exactly as the commit's own `add -A` would. */
function detectAsStaged(cwd: string, files: string[]): DetectionResult {
  const env = commitIndexEnv(cwd);
  const source = git(
    cwd,
    ['rev-parse', '--path-format=absolute', '--git-path', 'index'],
    env,
  ).trim();
  const scratch = mkdtempSync(path.join(tmpdir(), SCRATCH_PREFIX));
  const index = path.join(scratch, 'index');
  const previous = process.env.GIT_INDEX_FILE;
  try {
    if (existsSync(source)) copyFileSync(source, index);
    const scratchEnv = { ...env, GIT_INDEX_FILE: index };
    git(cwd, ['add', '-u'], scratchEnv);
    git(cwd, ['add', '--', ...files.map((file) => `:(literal)${file}`)], scratchEnv);
    process.env.GIT_INDEX_FILE = index;
    return detectChangedComments(cwd, new Set(files));
  } finally {
    if (previous === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previous;
    rmSync(scratch, { recursive: true, force: true });
  }
}

const keyOf = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);

function resultFor({ findings, refFindings }: DetectionResult): CheckResult {
  const items = [
    ...findings.map((finding) => ({
      key: finding.id,
      line: `${findingLocation(finding)} — ${finding.comment.replace(WHITESPACE, ' ').slice(0, 140)}`,
    })),
    ...refFindings.map(({ path: file, line, refs, comment }) => ({
      key: keyOf(JSON.stringify([file, refs, comment])),
      line: `${file}:${line} cites ${refs.join(', ')} — ${comment}`,
    })),
  ];
  const remedy = [
    findings.length > 0 ? PARAGRAPH_EDIT_REMEDY : '',
    refFindings.length > 0 ? REF_REMEDY.trim() : '',
  ];
  return { items, remedy: remedy.filter(Boolean).join('\n\n') };
}

export function commentCheck(files: string[], cwd = process.cwd()): CheckResult {
  sweepStale();
  const relative = files.map((file) =>
    path.relative(cwd, path.resolve(cwd, file)).split(path.sep).join('/'),
  );
  try {
    return resultFor(detectAsStaged(cwd, relative));
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    return { items: [], remedy: '', error };
  }
}
