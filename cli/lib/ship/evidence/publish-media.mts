/** Ship's QA-capture step, run after the PR exists: attach the apt part of the source checkout's
 * `devkit machine` capture to the PR. A capture goes to one PR only, and only if it ran that PR's code. */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { z } from 'zod';
import { resolveGuardConfig } from '../../../../gate-engine/config.mts';
import { uiPathReason } from '../../../../gate-engine/ui-evidence/check.mts';
import { sha256 } from '../../fs-helpers.mts';
import { readMachineConfig } from '../../machine/config.mts';
import { type EvidenceEntry, evidenceDir, readManifest } from '../../machine/manifest.mts';
import { withProcessLock } from '../../../../gate-engine/judge/process/process-lock.mts';
import {
  type Ineligible,
  type MediaPlan,
  planMedia,
  renderQaSection,
  shortSha,
  uploadedMedia,
  withQaSection,
} from './media.mts';
import { readPull, writeBody, writeBodyAttaching } from './pr-body.mts';

export interface MediaArgs {
  source: string;
  repo: string;
  pr: string;
  head: string;
}

/** What a publish did: files uploaded now, already in the PR, or apt but still not in it (not sent,
 * or the upload failed), plus every note it recorded. */
export interface MediaResult {
  attached: string[];
  present: string[];
  missing: string[];
  notes: string[];
}

export interface PublishOptions {
  /** Write the PR only when a capture would be in it, never a section of notes alone. */
  picksOnly?: boolean;
}

/** Ship's evidence step and `devkit machine attach` both rewrite a PR's body and uploads.json; one
 * lock per PR, in the repo's common git dir, serializes them. */
export function withPrEvidenceLock<T>(
  checkout: string,
  target: Pick<MediaArgs, 'repo' | 'pr'>,
  fn: () => T,
  waitMs: number,
): T {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: checkout,
    encoding: 'utf8',
  }).trim();
  const lock = join(
    common,
    'devkit',
    'pr-evidence',
    `${target.repo.replace('/', '--')}-${target.pr}`,
  );
  mkdirSync(dirname(lock), { recursive: true });
  return withProcessLock(lock, fn, { label: `PR #${target.pr} evidence`, waitMs });
}

const uploadsSchema = z.record(z.string(), z.string());
const uploadsFile = (dir: string) => join(dir, 'uploads.json');

/** Which PR each capture (by sha256) was attached to; captures belong to one PR only. */
function readUploads(dir: string): Record<string, string> {
  try {
    return uploadsSchema.parse(JSON.parse(readFileSync(uploadsFile(dir), 'utf8')));
  } catch {
    return {};
  }
}

function recordUploads(dir: string, entries: EvidenceEntry[], pr: string): void {
  const record = () => {
    const next = { ...readUploads(dir), ...Object.fromEntries(entries.map((e) => [e.sha256, pr])) };
    writeFileSync(uploadsFile(dir), `${JSON.stringify(next, null, 2)}\n`);
  };
  withProcessLock(join(dir, 'uploads.lock'), record, { label: 'evidence uploads' });
}

function changedPaths(root: string, base: string, head: string): string[] {
  const out = execFileSync('git', ['diff', '--name-only', '-z', `${base}...${head}`], {
    cwd: root,
    encoding: 'utf8',
  });
  return out.split('\0').filter(Boolean);
}

/** The PR's paths where the captured working tree differs from the shipped commit (none: the
 * recording shows this PR's code), or null when that cannot be read. */
function drifted(
  root: string,
  tree: string | null,
  head: string,
  paths: string[],
): string[] | null {
  if (!tree || paths.length === 0) return null;
  const specs = paths.map((path) => `:(literal)${path}`);
  const diff = ['diff', '--name-only', '-z', tree, head, '--', ...specs];
  const out = spawnSync('git', diff, { cwd: root, encoding: 'utf8' });
  return out.status === 0 ? out.stdout.split('\0').filter(Boolean) : null;
}

const listed = (paths: string[]): string =>
  `${paths
    .slice(0, 3)
    .map((path) => `\`${path}\``)
    .join(', ')}${paths.length > 3 ? ` +${paths.length - 3} more` : ''}`;

function driftNote(off: string[] | null): string | null {
  if (off === null) return 'it ran different code than this PR ships; rerun `devkit machine run`';
  if (off.length === 0) return null;
  return `it ran different code than this PR ships at ${listed(off)}; bring those to the PR head, then rerun the flow`;
}

/** A manifest is a local file anyone can edit: only a plain file name inside the evidence dir, and a
 * hex tree id (never an option git would parse), may reach the copy, the git call and the upload. */
const SAFE_FILE = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;
const SAFE_TREE = /^[0-9a-f]{40,64}$/;

function eligibility(
  root: string,
  head: string,
  paths: string[],
  pr: string,
  dir: string,
): Ineligible {
  const uploads = readUploads(dir);
  const ran = new Map<string | null, string | null>();
  return (entry) => {
    if (!SAFE_FILE.test(entry.file) || (entry.tree !== null && !SAFE_TREE.test(entry.tree)))
      return 'its manifest entry is not one `devkit machine run` writes';
    if (!existsSync(join(dir, entry.file)) || sha256(join(dir, entry.file)) !== entry.sha256)
      return 'its file changed or went missing after it was captured; rerun the flow';
    const elsewhere = uploads[entry.sha256];
    if (elsewhere && elsewhere !== pr) return `it is already attached to ${elsewhere}`;
    if (!ran.has(entry.tree))
      ran.set(entry.tree, driftNote(drifted(root, entry.tree, head, paths)));
    return ran.get(entry.tree) ?? null;
  };
}

const ghCanAttach = (): boolean =>
  (spawnSync('gh', ['pr', 'edit', '--help'], { encoding: 'utf8' }).stdout ?? '').includes(
    '--attach',
  );

function captures(dir: string): EvidenceEntry[] {
  try {
    return readManifest(dir);
  } catch {
    return [];
  }
}

/** Copy each new capture into `staging` under a space-free name and point its ref there. */
function stage(
  dir: string,
  staging: string,
  fresh: EvidenceEntry[],
  refs: Map<string, string>,
): string[] {
  return fresh.map((entry) => {
    const name = `${shortSha(entry)}${extname(entry.file)}`;
    copyFileSync(join(dir, entry.file), join(staging, name));
    if (sha256(join(staging, name)) !== entry.sha256)
      throw new Error(`${entry.file} changed while it was being staged; rerun the flow`);
    refs.set(shortSha(entry), `./${name}`);
    return name;
  });
}

const uploadFailed = (entry: EvidenceEntry): string => `\`${entry.file}\`: upload failed`;

/** One gh call attaches every new file; the section is then settled from what GitHub holds, so a
 * failed upload is named rather than left as a dead link. Returns the captures that failed. */
function attachFresh(
  args: MediaArgs,
  body: string,
  staging: string,
  files: string[],
  plan: MediaPlan,
): EvidenceEntry[] {
  const { repo, pr } = args;
  writeFileSync(join(staging, 'body.md'), body);
  writeBodyAttaching(repo, pr, staging, files);
  const after = readPull(repo, pr);
  const urls = uploadedMedia(after.body);
  const failed = plan.picks.filter((entry) => !urls.has(shortSha(entry)));
  const notes = [...plan.notes, ...failed.map(uploadFailed)];
  const settled = withQaSection(after.body, renderQaSection({ picks: plan.picks, notes }, urls));
  if (settled !== after.body) writeBody(repo, pr, settled);
  console.error(
    `evidence: QA capture attached${failed.length ? ` (${failed.length} upload(s) failed)` : ''}`,
  );
  return failed;
}

/** A capture already sent to this PR but missing from its body failed then. Uploads are public and
 * irreversible, so it is named and never sent again. */
function withoutRetries(
  plan: MediaPlan,
  refs: ReadonlyMap<string, string>,
  uploads: Record<string, string>,
  pr: string,
): MediaPlan {
  const failed = plan.picks.filter((e) => !refs.has(shortSha(e)) && uploads[e.sha256] === pr);
  const note = (e: EvidenceEntry) =>
    `\`${e.file}\`: its upload failed on an earlier ship and is never retried; rerun the flow`;
  const picks = plan.picks.filter((entry) => !failed.includes(entry));
  return { picks, notes: [...plan.notes, ...failed.map(note)] };
}

interface Planned {
  body: string;
  dir: string;
  prUrl: string;
  plan: MediaPlan;
}

/** What this PR should show, or null when the PR moved on or there is nothing to say. */
function planFor({ source, repo, pr, head }: MediaArgs): Planned | null {
  const pull = readPull(repo, pr);
  const dir = evidenceDir(source);
  const entries = captures(dir);
  const recipe = readMachineConfig(source).command !== undefined;
  if (pull.headRefOid !== head || (entries.length === 0 && !recipe)) return null;
  const prUrl = `https://github.com/${repo}/pull/${pr}`;
  const paths = changedPaths(source, pull.baseRefOid, head);
  const reason = recipe ? uiPathReason(paths, resolveGuardConfig(source).uiEvidence.paths) : null;
  const plan = planMedia(entries, eligibility(source, head, paths, prUrl, dir), reason);
  const empty = plan.picks.length === 0 && plan.notes.length === 0;
  return empty ? null : { body: pull.body, dir, prUrl, plan };
}

/** Attach the apt capture to the PR; null when the PR moved on or there was nothing to say. */
export function publishMedia(args: MediaArgs, options: PublishOptions = {}): MediaResult | null {
  const planned = planFor(args);
  if (!planned) return null;
  const { body: current, dir, prUrl } = planned;
  const refs = uploadedMedia(current);
  const plan = withoutRetries(planned.plan, refs, readUploads(dir), prUrl);
  const fresh = plan.picks.filter((entry) => !refs.has(shortSha(entry)));
  const present = plan.picks.filter((entry) => refs.has(shortSha(entry))).map((e) => e.file);
  // A capture whose upload failed earlier is still apt, and still not in the PR.
  const dropped = planned.plan.picks.filter((entry) => !plan.picks.includes(entry));
  const result: MediaResult = { attached: [], present, missing: [], notes: plan.notes };
  result.missing = dropped.map((entry) => entry.file);
  const unsent = [...result.missing, ...fresh.map((entry) => entry.file)];
  if (options.picksOnly && plan.picks.length === 0) return result;
  if (fresh.length === 0) {
    const body = withQaSection(current, renderQaSection(plan, refs));
    if (body !== current) writeBody(args.repo, args.pr, body);
    recordUploads(dir, plan.picks, prUrl);
    return result;
  }
  if (!ghCanAttach()) {
    const note = 'the QA capture needs gh 2.99 or newer (`gh pr edit --attach`); upgrade gh';
    console.error(`evidence: ${note}`);
    return { ...result, missing: unsent, notes: [...plan.notes, note] };
  }
  const staging = mkdtempSync(join(tmpdir(), 'devkit-qa-'));
  try {
    const files = stage(dir, staging, fresh, refs);
    // Read again just before the upload: the PATCH replaces whatever a reviewer or bot wrote since.
    const latest = readPull(args.repo, args.pr);
    if (latest.headRefOid !== args.head)
      return { ...result, missing: unsent, notes: [...plan.notes, 'the PR head moved; rerun'] };
    console.error(
      `evidence: attaching ${files.length} QA capture file(s): ${fresh.map((e) => e.file).join(', ')}`,
    );
    const body = withQaSection(latest.body, renderQaSection(plan, refs));
    // Recorded before the upload, so a failed or interrupted one is never sent twice.
    recordUploads(dir, fresh, prUrl);
    const failed = attachFresh(args, body, staging, files, plan);
    const attached = fresh.filter((entry) => !failed.includes(entry)).map((e) => e.file);
    const notes = [...plan.notes, ...failed.map(uploadFailed)];
    return { attached, present, missing: [...result.missing, ...failed.map((e) => e.file)], notes };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
