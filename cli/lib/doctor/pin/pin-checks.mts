/**
 * The two halves of devkit dependency-pin health, together because they read the same two files:
 * `checkPin` reads what package.json ASKS for, `checkLockPin` reads what bun.lock RECORDED for that
 * request — the object a fresh `bun install` will actually try to fetch.
 *
 * Why the second exists. Re-pointing a published git tag (or rewriting the history under it)
 * orphans the object a consumer's lockfile already recorded. Every environment that lacks that
 * object locally — a fresh clone, CI — then fails to install, naming neither devkit's pin nor the
 * repair:
 *
 *   error: no commit matching "590bae24…" found for "@norvalbv/devkit" (but repository exists)
 *   error: GET https://codeload.github.com/norvalbv/devkit/legacy.tar.gz/590bae2 - 404
 *
 * Two shapes, one fault: bun clones for a `git+ssh`/`git+https` ref and pulls a codeload tarball for
 * the `github:owner/repo` shorthand. Note the recorded object differs by form too — the shorthand
 * records the ANNOTATED TAG object, the URL forms record the PEELED COMMIT — which is why matching
 * runs against every object `ls-remote` reports, tag lines and `^{}` peels alike.
 *
 * The machine running this check is typically fine: its node_modules already exist. That is the
 * point. Catch the dead pin while a working install still exists, because once the install fails
 * there is no `node_modules/.bin/devkit` left to run `devkit doctor` with.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmpSemver, DEP, latestTag, lsRemote, pinnedVersion } from '../../../commands/update.mts';
import { detectGitRoot } from '../../detect-git-root.mts';
import { readJson } from '../../fs-helpers.mts';
import { type CheckResult, check } from '../check-result.mts';

// A devkit dep ref counts as "pinned" when it ends in a #v<digit> tag.
const PINNED_TAG = /#v\d/;

const DEP_IN_RE = DEP.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');
// bun.lock is JSONC — real lockfiles carry trailing commas, so JSON.parse throws on them. Every
// `packages` entry is exactly one line, so read it line-anchored instead. Requiring `[` after the
// key is the discriminator that excludes BOTH the `workspaces` block's requested-range line (key →
// string) and devkit's own `"name": "@norvalbv/devkit"` (the dep name as a VALUE). The optional
// path prefix matches a workspace-scoped duplicate key ("apps/web/@norvalbv/devkit").
const LOCK_ENTRY_RE = new RegExp(`^\\s*"(?:[^"]*/)?${DEP_IN_RE}"\\s*:\\s*\\[\\s*"([^"]+)"`, 'gm');
// The same key followed by a STRING — bun's record of what package.json asked for at install time.
const LOCK_REQUEST_RE = new RegExp(`^\\s*"(?:[^"]*/)?${DEP_IN_RE}"\\s*:\\s*"([^"]+)"`, 'm');
const RESOLVED_SHA_RE = /#([0-9a-f]{7,40})$/i;
const LS_REF_RE = /^([0-9a-f]{40})\s+(\S+?)(\^\{\})?$/gm;
// devkit executes inside repos it does not own, and package.json is consumer-controlled. git's
// `ext::` transport RUNS A COMMAND, so a remote is only ever spawned when it looks like a plain
// fetch URL: https/ssh/git scheme, or scp-style user@host:owner/repo.
const SAFE_REMOTE_RE = /^(?:https:\/\/|ssh:\/\/|git:\/\/|[\w.-]+@[\w.-]+:)/;
// Consumers that redirect devkit elsewhere put the recorded object in a different ref space.
const REDIRECT_FIELDS = ['overrides', 'resolutions', 'patchedDependencies'] as const;
const GIT_PREFIX_RE = /^git\+/; // git wants a bare URL, not package.json's `git+` prefix

/** The devkit dep ref declared in a repo's package.json (devDeps first, then deps), or undefined. */
export function devkitDepRef(cwd: string): string | undefined {
  const pkg = readJson(join(cwd, 'package.json')) as {
    devDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  } | null;
  return pkg?.devDependencies?.[DEP] ?? pkg?.dependencies?.[DEP];
}

export function checkPin(cwd: string): CheckResult {
  const ref = devkitDepRef(cwd);
  if (!ref) return check('devkit pin', 'MISSING', 'not a dependency', 'run `devkit init`', true);
  if (PINNED_TAG.test(ref)) return check('devkit pin', 'OK', `pinned ${ref.split('#').pop()}`);
  return check(
    'devkit pin',
    'DRIFT',
    'not pinned to a #v* tag (bare SHA/branch)',
    'pin to #v<version> for reproducible installs',
  );
}

/** Whether package.json redirects devkit through overrides/resolutions/patchedDependencies. */
function hasRedirect(cwd: string): boolean {
  const pkg = readJson(join(cwd, 'package.json')) as Record<string, unknown> | null;
  return REDIRECT_FIELDS.some((f) => {
    const v = pkg?.[f];
    return !!v && typeof v === 'object' && DEP in (v as Record<string, unknown>);
  });
}

/** The nearest bun.lock: this dir, else the git root (a monorepo package installs from there). */
function findLock(cwd: string): string | null {
  const here = join(cwd, 'bun.lock');
  if (existsSync(here)) return here;
  // detectGitRoot falls back to cwd when no .git exists anywhere up-tree — that is the file we
  // just found absent, so don't re-read it.
  const { gitRoot } = detectGitRoot(cwd);
  const atRoot = join(gitRoot, 'bun.lock');
  return gitRoot !== cwd && existsSync(atRoot) ? atRoot : null;
}

/** Every object name `git ls-remote` reported, grouped by ref name with `^{}` peels folded in. */
function refsFrom(lsOutput: string): Map<string, string[]> {
  const byRef = new Map<string, string[]>();
  for (const [, sha, ref] of lsOutput.matchAll(LS_REF_RE)) {
    byRef.set(ref, [...(byRef.get(ref) ?? []), sha.toLowerCase()]);
  }
  return byRef;
}

// bun abbreviates to 7 chars for the `github:` shorthand and records all 40 for the URL forms, so
// the recorded value is always a PREFIX of the full object name — never the other way round.
const matches = (remote: string[], lockSha: string) => remote.some((s) => s.startsWith(lockSha));

/**
 * Verify the devkit object recorded in the consumer's bun.lock still resolves on the remote it was
 * resolved from. Returns null when there is nothing to verify — which is also what keeps doctor off
 * the network for every repo that isn't a bun consumer of a tagged devkit.
 *
 * Every local gate runs BEFORE the single `ls-remote`, and an unreachable remote is reported OK, not
 * DRIFT: doctor must stay usable offline, and any non-OK result here would exit 1.
 */
export function checkLockPin(cwd: string, env = process.env): CheckResult | null {
  if (env.DEVKIT_SKIP_REMOTE_CHECKS) return null;

  const ref = devkitDepRef(cwd);
  if (!ref) return null; // checkPin already reports a missing dep
  const version = pinnedVersion(ref);
  if (!version) return null; // a branch/SHA pin has no stable ref tip; checkPin reports it
  if (hasRedirect(cwd)) return null;

  const lockPath = findLock(cwd);
  if (!lockPath) return null; // bun.lockb, another package manager, or no lockfile at all
  const lock = readFileSync(lockPath, 'utf8');

  // A lockfile whose recorded REQUEST disagrees with package.json is merely stale: bun re-resolves
  // on the next install because the request changed, so its recorded object proves nothing.
  const requested = lock.match(LOCK_REQUEST_RE)?.[1];
  if (requested && requested !== ref) return null;

  const shas = new Set(
    [...lock.matchAll(LOCK_ENTRY_RE)]
      .map((m) => m[1].match(RESOLVED_SHA_RE)?.[1]?.toLowerCase())
      .filter((s): s is string => !!s),
  );
  if (shas.size !== 1) return null; // no git resolution (link:/file:), or entries that disagree
  const lockSha = [...shas][0];

  const url = ref.split('#')[0].replace(GIT_PREFIX_RE, '');
  if (!SAFE_REMOTE_RE.test(url)) return null;

  const { output, error } = lsRemote(url, ['--tags', '--heads']);
  if (error) return check('devkit lock', 'OK', `${lockSha} not verified — remote unreachable`);
  const byRef = refsFrom(output ?? '');
  if (!byRef.size)
    return check('devkit lock', 'OK', `${lockSha} not verified — remote has no refs`);

  const pinned = byRef.get(`refs/tags/v${version}`);
  if (!pinned) {
    return check(
      'devkit lock',
      'DRIFT',
      `package.json pins v${version}, which no longer exists on the remote`,
      're-pin package.json to a published tag (`devkit update`)',
    );
  }
  if (matches(pinned, lockSha))
    return check('devkit lock', 'OK', `${lockSha} resolves v${version}`);

  // Everything below is a lockfile that will not install anywhere the object isn't already cached.
  // Which repair to name depends on whether a newer tag exists, and the ref list already answers it:
  //  - newer tag → `devkit update`. Re-pinning changes the REQUEST, and a changed request is what
  //    bun re-resolves from; it also leaves the consumer current, which they wanted anyway.
  //  - already newest → `devkit update` is a NO-OP that prints "up to date" (update.mts:186-189), so
  //    naming it would send the user away believing they had fixed it. `bun update <dep>` re-resolves
  //    in place (verified on bun 1.3.1 against both recorded forms); deleting the entry is the
  //    guaranteed fallback. `bun install --force` does NOT re-resolve, and clearing bun's cache is
  //    both unnecessary and destructive — it drops the one local copy of the orphaned object.
  const latest = latestTag(output ?? '');
  const repair =
    latest && cmpSemver(latest, version) > 0
      ? `devkit update (re-pins v${version} → v${latest}, which re-resolves the dead entry)`
      : `bun update ${DEP} (NOT \`devkit update\` — it reports "up to date" while v${version} is the newest tag). If it persists, delete the "${DEP}" lines from bun.lock and re-run \`bun install\``;
  const elsewhere = [...byRef].find(([, s]) => matches(s, lockSha))?.[0];
  return check(
    'devkit lock',
    'DRIFT',
    elsewhere
      ? `bun.lock resolves v${version} to ${lockSha}, which is ${elsewhere} — not the pinned tag`
      : `bun.lock records ${lockSha} for v${version}, which no longer matches any ref on the remote — a fresh clone or CI install will fail`,
    repair,
  );
}
