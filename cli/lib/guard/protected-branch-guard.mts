/**
 * Protected-branch guard — core logic for the `devkit guard-branch` PreToolUse hook.
 *
 * When an agent runs a direct `git commit` whose TARGET repo is on a protected branch (main / any
 * X.Y.Z release branch), this DENIES it — but instead of a generic "use the ship script", it hands
 * back a COPY-PASTE-READY `devkit ship …` command (auto branch, the agent's own `-m` title, the
 * staged paths). So the agent never has to KNOW the ceremony: it just `git commit`s, gets the exact
 * command, and runs it. `git commit --pr <branch>` is translated to a re-push (`devkit ship … --pr`).
 *
 * Why DENY (not a silent rewrite): a PreToolUse `updatedInput` rewrite is honoured only by CC builds
 * that support it — an older one silently runs the RAW commit on the protected branch. DENY is
 * unconditionally effective and composes with the other deny-hooks. (Decision: parallel-commit-isolation.)
 *
 * FAIL-OPEN on every internal error (we parse JSON natively; a git error, detached/unborn HEAD, or
 * anything unexpected → allow). The deny is carried in the returned reason, never an exit code, so a
 * guard bug can never wedge the agent's Bash.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DEFAULT_SHIP = 'devkit ship'; // a consuming repo overrides via .devkit/config.json → { ship: { command, extraArgs } }
const RELEASE_BRANCH = /^\d+\.\d+\.\d+$/; // X.Y.Z — a release branch is protected alongside main
const SLUG_MAX = 32;

// `git … commit` detection, ported from the bash guard: `git` must start a command segment (line
// start or after a shell separator), global flags + their args are skipped, and `commit` is the
// FIRST non-flag positional (so `commit-tree` / `git log --grep commit` don't false-match).
const FLAG = '-\\S+';
const ARG = `("[^"]*"|'[^']*'|[^-]\\S*)`;
const UNIT = `${FLAG}\\s+(${ARG}\\s+)?`;
const COMMIT_RE = new RegExp(`(^|[\\s;|&()\`])\\s*git\\s+(${UNIT})*commit([\\s]|$|[;|&"'\`])`);

// Hoisted parsing regexes (biome useTopLevelRegex).
const COMMIT_WORD_RE = /\bcommit\b/;
const STAGE_ALL_RE = /^-[a-zA-Z]*a[a-zA-Z]*$/; // a short-flag bundle containing `a` (-a, -am, -na…)
const ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const UNSAFE_CD_VALUE_RE = /[`*?[]/;
const WHITESPACE_RE = /\s/;
const BRACED_VAR_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/;
const PLAIN_VAR_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)/;
type ShellQuote = "'" | '"' | '`' | 'escaped-double' | null;

/** Run git in <dir>; trimmed stdout, or null on any failure (never throws). */
function git(dir: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Short branch of HEAD in <dir>, or null for unborn / detached / not-a-repo / any error (→ allow). */
function currentBranch(dir: string): string | null {
  if (git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']) === null) return null; // unborn → allow
  return git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']) || null; // detached → '' → null
}

const isProtected = (branch: string): boolean => branch === 'main' || RELEASE_BRANCH.test(branch);

/**
 * Split a shell command only at UNQUOTED control operators. A plain regex split corrupts commit
 * messages containing `;`, `&&`, or `|`, which in turn truncates a multi-`-m` PR body.
 */
function shellSegments(command: string): string[] | null {
  const segments: string[] = [];
  let start = 0;
  let quote: ShellQuote = null;
  let escaped = false;
  let active = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote === 'escaped-double') {
      if (ch === '\\' && command[i + 1] === '"') {
        quote = null;
        i += 1;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      if (!quote && !active && command[i + 1] === '"') {
        quote = 'escaped-double';
        active = true;
        i += 1;
        continue;
      }
      escaped = true;
      active = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      active = true;
      continue;
    }
    if (WHITESPACE_RE.test(ch)) {
      active = false;
      continue;
    }
    const doubled = (ch === '&' || ch === '|') && command[i + 1] === ch;
    const redirectsFd = ch === '&' && command[i - 1] === '>';
    if (ch === ';' || ch === '|' || (ch === '&' && !redirectsFd)) {
      segments.push(command.slice(start, i).trim());
      if (doubled) i += 1;
      start = i + 1;
      active = false;
      continue;
    }
    active = true;
  }
  if (quote || escaped) return null;
  segments.push(command.slice(start).trim());
  return segments.filter(Boolean);
}

/**
 * Shell words with quote removal. When `variables` is provided, expand only variables established
 * by earlier assignment-only segments; an unknown/command expansion is unsafe to guess.
 */
function shellWords(input: string, variables?: ReadonlyMap<string, string>): string[] | null {
  const words: string[] = [];
  let word = '';
  let active = false;
  let quote: ShellQuote = null;
  const finish = () => {
    if (!active) return;
    words.push(word);
    word = '';
    active = false;
  };
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote === 'escaped-double' && ch === '\\' && input[i + 1] === '"') {
      quote = null;
      i += 1;
      continue;
    }
    if (!quote && WHITESPACE_RE.test(ch)) {
      finish();
      continue;
    }
    if (!quote && !active && ch === '\\' && input[i + 1] === '"') {
      active = true;
      quote = 'escaped-double';
      i += 1;
      continue;
    }
    if (ch === "'" && quote !== '"' && quote !== '`' && quote !== 'escaped-double') {
      active = true;
      quote = quote === "'" ? null : "'";
      continue;
    }
    if (ch === '"' && quote !== "'" && quote !== '`' && quote !== 'escaped-double') {
      active = true;
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (ch === '`' && quote !== "'") {
      if (variables) return null;
      active = true;
      quote = quote === '`' ? null : '`';
      word += ch;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      const next = input[i + 1];
      if (next === undefined) return null;
      active = true;
      if (
        (quote === '"' || quote === 'escaped-double') &&
        !['$', '`', '"', '\\', '\n'].includes(next)
      ) {
        word += '\\';
        continue;
      }
      if (next === '\n') {
        i += 1;
        continue;
      }
      word += next;
      i += 1;
      continue;
    }
    if (ch === '$' && quote !== "'" && variables) {
      if (input[i + 1] === '(') return null;
      const braced = input.slice(i).match(BRACED_VAR_RE);
      const plain = input.slice(i).match(PLAIN_VAR_RE);
      const match = braced ?? plain;
      if (!match) return null;
      const value = variables.get(match[1]);
      if (value === undefined) return null;
      active = true;
      word += value;
      i += match[0].length - 1;
      continue;
    }
    active = true;
    word += ch;
  }
  if (quote) return null;
  finish();
  return words;
}

interface CommitInvocation {
  segments: string[];
  index: number;
  segment: string;
}

/** Locate the shell segment that invokes `git commit`, without matching quoted prose. */
function commitInvocation(command: string): CommitInvocation | null {
  const segments = shellSegments(command);
  if (!segments) return null;
  const index = segments.findIndex((segment) => COMMIT_RE.test(segment));
  return index === -1 ? null : { segments, index, segment: segments[index] };
}

/**
 * Resolve the directory at the commit segment. We deliberately interpret only assignment-only
 * segments plus `cd`: if an earlier command could have changed cwd in an unknown way, fail open
 * instead of reading a different checkout and manufacturing an unsafe remediation.
 */
function targetDir(invocation: CommitInvocation, cwd: string): string | null {
  let dir = cwd;
  const variables = new Map<string, string>();
  for (const segment of invocation.segments.slice(0, invocation.index)) {
    const words = shellWords(segment, variables);
    if (!words || words.length === 0) return null;
    const assignments = words[0] === 'export' ? words.slice(1) : words;
    if (assignments.length > 0 && assignments.every((word) => ASSIGNMENT_RE.test(word))) {
      for (const assignment of assignments) {
        const match = assignment.match(ASSIGNMENT_RE);
        if (!match) return null;
        variables.set(match[1], match[2]);
      }
      continue;
    }
    if (words[0] !== 'cd') return null;
    const args = words[1] === '--' ? words.slice(2) : words.slice(1);
    if (args.length !== 1 || args[0].startsWith('~') || UNSAFE_CD_VALUE_RE.test(args[0]))
      return null;
    dir = resolve(dir, args[0]);
  }

  // Resolve every global `git -C <dir>` before the commit subcommand using the same quote-aware
  // words as `cd`. This preserves single-quoted / escaped `$VARS` as literals and applies multiple
  // `-C` flags in Git's left-to-right order.
  const commitMatch = COMMIT_RE.exec(invocation.segment);
  if (!commitMatch) return null;
  const commitOffset = commitMatch.index + commitMatch[0].lastIndexOf('commit');
  const gitWords = shellWords(invocation.segment.slice(0, commitOffset), variables);
  if (!gitWords) return null;
  const gitIndex = gitWords.indexOf('git');
  if (gitIndex === -1) return null;
  for (let i = gitIndex + 1; i < gitWords.length; i += 1) {
    const token = gitWords[i];
    const value = token === '-C' ? gitWords[i + 1] : token.startsWith('-C') ? token.slice(2) : null;
    if (value === null) continue;
    if (!value || value.startsWith('~') || UNSAFE_CD_VALUE_RE.test(value)) return null;
    dir = resolve(dir, value);
    if (token === '-C') i += 1;
  }
  return dir;
}

/** Isolate the `git commit …` portion of its already quote-aware shell segment. */
function commitSegment(segment: string): string {
  const i = segment.search(COMMIT_WORD_RE);
  return i === -1 ? segment : segment.slice(i + 'commit'.length);
}

const REJECT_STAGE_ALL =
  '`-a`/`-am` stages all tracked changes — on a shared tree that sweeps in parallel work. Stage your files explicitly (`git add <files>`) and commit with `-m`.';
const REJECT_AMEND =
  '`--amend` rewrites history — not supported on a protected branch. Make a fresh commit with `-m`.';
const REJECT_FILE = 'commit-message-from-file (`-F`) is not supported here — use `-m "<title>"`.';
const REJECT_NO_MSG =
  'commit with `-m "<title>"` on a protected branch (a bare `git commit` would open an editor the agent can\'t drive).';

/** The commit can't be safely translated → deny with this fix-it message instead of guessing. */
interface RejectIntent {
  reject: string;
}
/** A translatable commit: its title, joined body, and the `--pr <branch>` re-push target (if any). */
interface ShipIntent {
  reject?: undefined;
  title: string;
  body: string;
  prBranch: string | null;
}
type CommitIntent = RejectIntent | ShipIntent;

/**
 * Parse the commit flags into a ship intent: { title, body, prBranch } on success, or
 * { reject: <fix-it message> } when the commit can't be safely translated (so the guard denies with
 * guidance rather than guessing). Reject: -a/-am/--all (shared-tree sweep), --amend / -F (out of the
 * ship model), and no -m (would open an editor).
 */
function parseCommit(seg: string): CommitIntent | null {
  const tokens = shellWords(seg);
  if (!tokens) return null;
  const msgs: string[] = [];
  let prBranch: string | null = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '--') break;
    if (STAGE_ALL_RE.test(token) || token === '--all') return { reject: REJECT_STAGE_ALL };
    if (token === '--amend') return { reject: REJECT_AMEND };
    if (
      token === '-F' ||
      token.startsWith('-F') ||
      token === '--file' ||
      token.startsWith('--file=')
    ) {
      return { reject: REJECT_FILE };
    }
    if (token === '-m' || token === '--message') {
      const message = tokens[i + 1];
      if (message === undefined) return null;
      msgs.push(message);
      i += 1;
      continue;
    }
    if (token.startsWith('--message=')) {
      msgs.push(token.slice('--message='.length));
      continue;
    }
    if (token.startsWith('-m') && token.length > 2) {
      msgs.push(token.slice(2));
      continue;
    }
    if (token === '--pr') {
      prBranch = tokens[i + 1] ?? null;
      if (!prBranch) return null;
      i += 1;
      continue;
    }
    if (token.startsWith('--pr=')) {
      prBranch = token.slice('--pr='.length) || null;
      if (!prBranch) return null;
    }
  }
  if (msgs.length === 0) return { reject: REJECT_NO_MSG };
  return { title: msgs[0], body: msgs.slice(1).join('\n\n'), prBranch };
}

/** Files in the index of <dir> (the explicit per-file ship scope), or [] on error. */
function stagedPaths(dir: string): string[] {
  const out = git(dir, ['diff', '--cached', '--name-only']);
  return out ? out.split('\n').filter(Boolean) : [];
}

/** A repo's resolved ship command + extra args. */
interface ShipCommandConfig {
  command: string;
  extraArgs: string[];
}
/** The relevant slice of `.devkit/config.json` (parsed at the JSON boundary; shape is trusted, not validated). */
interface DevkitConfig {
  ship?: { command?: string; extraArgs?: string[] };
}

/** A repo's ship command + extra args, from .devkit/config.json (default `devkit ship`, no extras). */
function shipConfig(repoRoot: string): ShipCommandConfig {
  try {
    const cfg = JSON.parse(
      readFileSync(join(repoRoot, '.devkit', 'config.json'), 'utf8'),
    ) as DevkitConfig;
    const s = cfg?.ship;
    if (s && typeof s.command === 'string') {
      return { command: s.command, extraArgs: Array.isArray(s.extraArgs) ? s.extraArgs : [] };
    }
  } catch {
    /* absent / malformed → defaults */
  }
  return { command: DEFAULT_SHIP, extraArgs: [] };
}

/** POSIX single-quote a token so it copy-pastes safely (literal, no expansion). */
const q = (s: string): string => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** kebab slug of the title for the auto branch name. */
const slug = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX) || 'change';

/** The PreToolUse Bash payload slice the guard reads (parsed from stdin JSON; may be null). */
interface GuardHookInput {
  tool_input?: { command?: string };
}

/**
 * Decide on a Bash tool input. Returns a deny-reason string (the copy-paste-ready ship command, or a
 * fix-it message) when the commit targets a protected branch, else null (allow / not our concern).
 * `rand` is injectable for deterministic tests; production uses a short random suffix to avoid branch
 * collisions across retries.
 */
export function decide(
  input: GuardHookInput | null | undefined,
  cwd: string,
  rand?: string,
): string | null {
  const command = input?.tool_input?.command;
  if (!command) return null;
  const invocation = commitInvocation(command);
  if (!invocation) return null; // not a safely parsed git commit → allow
  const dir = targetDir(invocation, cwd);
  if (!dir) return null; // unknown shell cwd transition → fail open, never guess another checkout
  const branch = currentBranch(dir);
  if (!branch || !isProtected(branch)) return null; // detached/unborn/feature branch → allow

  const intent = parseCommit(commitSegment(invocation.segment));
  if (!intent) return null; // malformed/unsupported shell quoting → fail open
  const head = `Blocked: direct \`git commit\` on protected branch "${branch}".`;
  const cfg = shipConfig(dir);
  if (intent.reject !== undefined) {
    return `${head}\n${intent.reject}\nThen re-run your commit — the guard will hand you a ready-to-run \`${cfg.command}\` command.`;
  }
  const paths = stagedPaths(dir);
  if (paths.length === 0) {
    return `${head}\nStage the files you mean first (\`git add <files>\`), then commit — the guard reads the staged set as the ship scope.`;
  }

  const pathArgs = paths.map(q).join(' ');
  const extras = cfg.extraArgs.length ? `${cfg.extraArgs.join(' ')} ` : '';
  // A multi-`-m` body is passed via `--body '<body>'` so the agent copy-pastes ONE clean command
  // (no stdin pipe, no temp file) and the body lands on the PR. q() single-quotes it so embedded
  // newlines / quotes / % / $ survive the paste; ship's --body takes precedence over stdin.
  const bodyArg = intent.body ? `--body ${q(intent.body)} ` : '';
  let ship: string;
  let note: string;
  if (intent.prBranch) {
    ship = `${cfg.command} ${q(intent.prBranch)} ${q(intent.title)} --pr ${bodyArg}${extras}-- ${pathArgs}`;
    note = `Adds these changes to the existing PR on \`${intent.prBranch}\` (fast-forward, never --force).`;
  } else {
    const suffix = rand ?? Math.random().toString(36).slice(2, 8);
    ship = `${cfg.command} ${q(`agent/${slug(intent.title)}-${suffix}`)} ${q(intent.title)} ${bodyArg}${extras}-- ${pathArgs}`;
    note =
      'Commits your staged files onto a fresh branch + opens a PR; the shared HEAD never moves. The PR URL is printed; to add more commits later, `git commit --pr <that-branch> -m "…"`.';
  }
  return `${head}\nRun this instead:\n  ${ship}\n${note}`;
}
