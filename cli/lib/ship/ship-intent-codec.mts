/** Persisted intent shapes and binary-safe field/path codecs used by the ship-intent boundary. */
import { isUtf8 } from 'node:buffer';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fail, parseArgs } from './ship-intent-args.mts';

export interface ShipIntent {
  version: number;
  mode: 'ship' | 'reship';
  /** Absent on legacy records; readers normalize it to explicit. */
  sourceMode?: 'explicit' | 'branch';
  branch: string;
  title: string;
  base: string | null;
  links: string[];
  paths: string[];
  noQavisPublish: boolean;
  updatePrBody: boolean;
  bodyB64: string;
  repo: string;
  createdAt: string;
  generation: string;
  /** Stable across retries of one branch-source attempt; absent from explicit records. */
  sourceAttemptId?: string;
  devkitVersion: string;
}

export interface StoredIntent {
  version?: number;
  mode?: string;
  sourceMode?: string;
  branch?: string;
  title?: string;
  base?: string | null;
  links?: string[];
  paths?: string[];
  noQavisPublish?: boolean;
  updatePrBody?: boolean;
  bodyB64?: string;
  repo?: string;
  createdAt?: string;
  generation?: string;
  sourceAttemptId?: string;
  devkitVersion?: string;
}

export interface SourceMembership {
  sourceAttemptId: string;
  paths: string[];
}

const membershipKey = (value: string) => createHash('sha256').update(value).digest('hex');
const sourceMembershipPrefix = (branch: string) =>
  `refs/devkit/ship-source-memberships/${membershipKey(branch)}/`;
export const sourceMembershipRef = (branch: string, sourceAttemptId: string) =>
  `${sourceMembershipPrefix(branch)}${membershipKey(sourceAttemptId)}`;

export function sourceMembershipOid(root: string, membership: SourceMembership, write = false) {
  const input = Buffer.from(`${[membership.sourceAttemptId, ...membership.paths].join('\0')}\0`);
  return execFileSync('git', ['-C', root, 'hash-object', ...(write ? ['-w'] : []), '--stdin'], {
    input,
    encoding: 'utf8',
  }).trim();
}

export function bindSourceMembership(
  root: string,
  branch: string,
  membership: SourceMembership,
): string {
  const oid = sourceMembershipOid(root, membership, true);
  const ref = sourceMembershipRef(branch, membership.sourceAttemptId);
  const bound = spawnSync('git', ['-C', root, 'update-ref', '--stdin'], {
    input: `create ${ref} ${oid}\n`,
    encoding: 'utf8',
  });
  if (bound.error) throw bound.error;
  if (bound.status !== 0)
    throw new Error(
      `source-membership ref ${ref} could not be bound: ${
        bound.stderr.trim() || `git update-ref exited ${bound.status}`
      }`,
    );
  return oid;
}

export function unbindSourceMembership(
  root: string,
  branch: string,
  membership: SourceMembership,
): void {
  execFileSync(
    'git',
    [
      '-C',
      root,
      'update-ref',
      '-d',
      sourceMembershipRef(branch, membership.sourceAttemptId),
      sourceMembershipOid(root, membership),
    ],
    { stdio: 'ignore' },
  );
}

export function unbindSourceMembershipRefs(root: string, branch: string): void {
  const prefix = sourceMembershipPrefix(branch);
  const refs = execFileSync('git', ['-C', root, 'for-each-ref', '--format=%(refname)', prefix], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean);
  if (refs.length === 0) return;
  execFileSync('git', ['-C', root, 'update-ref', '--stdin'], {
    input: `${refs.map((ref) => `delete ${ref}`).join('\n')}\n`,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
}

export function cleanupDeletedSourceMembershipRefs(root: string, branch: string): void {
  try {
    unbindSourceMembershipRefs(root, branch);
  } catch {
    process.stderr.write(
      `ship: recorded invocation for '${branch}' was deleted; inert source-membership ref cleanup deferred\n`,
    );
  }
}

export function sourceMembershipMatches(
  root: string,
  branch: string,
  membership: SourceMembership,
): boolean {
  try {
    const oid = execFileSync(
      'git',
      [
        '-C',
        root,
        'rev-parse',
        '-q',
        '--verify',
        `${sourceMembershipRef(branch, membership.sourceAttemptId)}^{blob}`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return oid === sourceMembershipOid(root, membership);
  } catch {
    return false;
  }
}

export function bindSourceMembershipForWrite(
  root: string,
  intent: ShipIntent,
  resumed: boolean,
  prior: StoredIntent | null,
): void {
  const membership = { sourceAttemptId: intent.sourceAttemptId!, paths: intent.paths };
  const priorAttempt = prior && provenString(prior.sourceAttemptId);
  if (resumed && priorAttempt === membership.sourceAttemptId) {
    if (!sourceMembershipMatches(root, intent.branch, membership))
      throw new Error('recorded branch-source membership changed within one source attempt');
    return;
  }
  bindSourceMembership(root, intent.branch, membership);
}

export function cleanupReplacedSourceMembership(
  root: string,
  intent: ShipIntent,
  prior: StoredIntent | null,
): void {
  const priorAttempt = provenString(prior?.sourceAttemptId);
  const priorPaths = provenStrings(prior?.paths);
  if (!priorAttempt || !priorPaths || priorAttempt === intent.sourceAttemptId) return;
  try {
    unbindSourceMembership(root, intent.branch, {
      sourceAttemptId: priorAttempt,
      paths: priorPaths,
    });
  } catch {
    process.stderr.write('ship-intent: prior source-membership ref cleanup deferred\n');
  }
}

export function cleanupFailedSourceMembership(
  root: string,
  branch: string,
  membership: SourceMembership,
): void {
  try {
    unbindSourceMembership(root, branch, membership);
  } catch {
    process.stderr.write('ship-intent: failed source-membership binding cleanup deferred\n');
  }
}

/** The value when it really is a NUL-free string primitive, else null. */
export function provenString(v: string | null | undefined): string | null {
  return v != null && String(v) === v && !v.includes('\0') ? v : null;
}

/** Every element a proven string primitive → the array; anything else → null. */
export function provenStrings(v: string[] | undefined): string[] | null {
  if (!Array.isArray(v)) return null;
  for (const e of v) if (provenString(e) === null) return null;
  return v;
}

/** Emit the NUL-delimited field order consumed by the Bash resume readers. */
export function emitFields(intent: ShipIntent): void {
  const out: (string | Buffer)[] = [
    intent.mode,
    intent.sourceMode ?? 'explicit',
    intent.title,
    intent.base ?? '',
    intent.noQavisPublish ? '1' : '0',
    intent.updatePrBody ? '1' : '0',
    intent.createdAt,
    intent.generation,
    intent.sourceAttemptId ?? '',
    String(intent.links.length),
    ...intent.links,
    Buffer.from(intent.bodyB64, 'base64'),
    ...intent.paths,
  ];
  for (const f of out) {
    process.stdout.write(f);
    process.stdout.write('\0');
  }
}

/** Validate Git's raw `-z` pathname stream before Bash arrays, argv, JSON, or telemetry. */
export function pathStreamError(raw: Buffer): string | null {
  if (raw.length > 0 && raw[raw.length - 1] !== 0)
    return '--from-branch path stream is not NUL-terminated';
  if (!isUtf8(raw))
    return '--from-branch cannot safely represent a non-UTF-8 Git pathname in resume/telemetry';
  return null;
}

/** Prove Git did not recursively widen a concrete member that became a directory. */
export function membershipStreamError(selected: Buffer, members: Buffer): string | null {
  const selectedReason = pathStreamError(selected);
  if (selectedReason) return selectedReason;
  const membersReason = pathStreamError(members);
  if (membersReason) return `--from-branch recorded membership is invalid: ${membersReason}`;
  const decode = (raw: Buffer): string[] =>
    raw.length === 0 ? [] : raw.toString('utf8').slice(0, -1).split('\0');
  const allowed = new Set(decode(members));
  for (const p of decode(selected))
    if (!allowed.has(p))
      return `--from-branch frozen path membership would expand to unrecorded path ${JSON.stringify(p)}; run a fresh full --from-branch invocation`;
  return null;
}

/** Keep only byte-exact frozen identities from a recursively selected overlay stream. */
export function filterMembershipStream(
  selected: Buffer,
  members: Buffer,
): { raw: Buffer } | { reason: string } {
  if (selected.length > 0 && selected[selected.length - 1] !== 0)
    return { reason: '--from-branch overlay path stream is not NUL-terminated' };
  const membersReason = pathStreamError(members);
  if (membersReason)
    return { reason: `--from-branch recorded membership is invalid: ${membersReason}` };
  const splitRaw = (raw: Buffer): Buffer[] => {
    const entries: Buffer[] = [];
    let start = 0;
    for (let i = 0; i < raw.length; i++)
      if (raw[i] === 0) {
        entries.push(raw.subarray(start, i));
        start = i + 1;
      }
    return entries;
  };
  // A recursively selected unrelated descendant may itself be non-UTF-8. Compare raw bytes first;
  // every retained entry equals a validated UTF-8 member by construction.
  const allowed = new Set(splitRaw(members).map((p) => p.toString('hex')));
  const kept = splitRaw(selected).filter((p) => allowed.has(p.toString('hex')));
  return {
    raw:
      kept.length === 0
        ? Buffer.alloc(0)
        : Buffer.concat(kept.flatMap((p) => [p, Buffer.from([0])])),
  };
}

/** Handle the path-codec-only CLI subcommands; null means the caller owns this subcommand. */
export function handlePathCodecCommand(sub: string | undefined, rest: string[]): number | null {
  if (sub === 'validate-paths') {
    const raw = readFileSync(0);
    const reason = pathStreamError(raw);
    if (reason) return fail(reason);
    process.stdout.write(raw);
    return 0;
  }
  if (sub !== 'validate-membership' && sub !== 'filter-membership') return null;
  const { values } = parseArgs(rest);
  const membersFile = values.get('members-file');
  if (!membersFile) return fail(`${sub}: missing --members-file`);
  let members: Buffer;
  try {
    members = readFileSync(membersFile);
  } catch {
    return fail(`${sub}: cannot read members file (${membersFile})`);
  }
  const selected = readFileSync(0);
  if (sub === 'validate-membership') {
    const reason = membershipStreamError(selected, members);
    if (reason) return fail(reason);
  } else {
    const filtered = filterMembershipStream(selected, members);
    if ('reason' in filtered) return fail(filtered.reason);
    process.stdout.write(filtered.raw);
  }
  return 0;
}
