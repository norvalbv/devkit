// A workspace-write codex judge's cwd is always writable, so it runs in a throwaway dir rather than
// the consumer's checkout, where it could overwrite unstaged edits made during a long review.
import {
  closeSync,
  constants,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ensureCodexJudgeHome } from './home.mts';
import type { CodexWritablePaths } from './permissions.mts';
import { isCodexModel, needsCodexWorkspace, parseClaudeArgv } from './result.mts';

/** A workspace-write judge's scratch cwd and state file, plus the repo it reviews read-only. */
export interface CodexWorkspace extends CodexWritablePaths {
  repoRoot: string;
}

export interface CodexSandbox {
  codexReadOnly: boolean;
  workspace?: CodexWorkspace;
  /** Spawn env for every codex judge: its own CODEX_HOME, so the owner's AGENTS.md never loads. */
  env?: { CODEX_HOME: string };
  /** Never throws: a judge's verdict must not turn into an outage over a leftover temp dir. */
  cleanup: () => void;
}

/** What a judge spawn asks of the codex sandbox. */
export interface CodexSandboxOpts {
  /** Tool-equipped, write-free Codex judge; required without staged-tree tamper detection. */
  codexReadOnly?: boolean;
  /** The one repo-relative file a workspace-write codex judge may write: its checklist state. */
  codexWritableFile?: string;
}

/** Any codex judge gets its own home; a workspace-write one also a scratch cwd. Claude: a no-op. */
export function prepareCodexSandbox(
  args: string[],
  { codexReadOnly = false, codexWritableFile }: CodexSandboxOpts,
  cwd: string,
  ownerEnv: NodeJS.ProcessEnv = process.env,
): CodexSandbox {
  if (!isCodexModel(parseClaudeArgv(args).model)) return { codexReadOnly, cleanup: () => {} };
  // Before mkdtemp: a home that cannot be made must not leak a scratch dir.
  const env = { CODEX_HOME: ensureCodexJudgeHome(ownerEnv) };
  if (!needsCodexWorkspace(args, codexReadOnly)) return { codexReadOnly, env, cleanup: () => {} };
  const repoRoot = resolve(cwd);
  const stateFile = codexWritableFile ? writableStateFile(repoRoot, codexWritableFile) : undefined;
  // Real path: macOS's tmpdir sits under the /var symlink, and codex refuses symlinked roots.
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'devkit-judge-')));
  return {
    codexReadOnly,
    env,
    workspace: { scratch, repoRoot, stateFile },
    cleanup: () => removeScratch(scratch),
  };
}

// No-follow: a prior judge may have planted a link here, and the gate must not create its target.
const CREATE_NO_FOLLOW =
  constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW;

/** The state file's symlink-free path, created empty if absent: Linux bwrap drops missing roots. */
function writableStateFile(repoRoot: string, rel: string): string {
  const abs = resolve(repoRoot, rel);
  const inside = relative(repoRoot, abs);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw new Error(`codex judge: state file ${rel} is not a file inside ${repoRoot}`);
  mkdirSync(dirname(abs), { recursive: true });
  const real = join(realpathSync(dirname(abs)), basename(abs));
  closeSync(openSync(real, CREATE_NO_FOLLOW));
  return real;
}

function removeScratch(scratch: string): void {
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // A killed judge's grandchild may still hold a file; the OS reaps its temp dir.
  }
}
