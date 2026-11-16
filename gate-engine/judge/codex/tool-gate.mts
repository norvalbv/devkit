// codex exec has no command allowlist, so each codex judge gets a PreToolUse hook that does the allowing.
// It is trusted via `hooks.state`; --dangerously-bypass-hook-trust would also wake ~/.codex/hooks.json.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { shellWord } from '../../review/valve/shell-word.mts';

const SELF_EXT = import.meta.url.endsWith('.mts') ? '.mts' : '.mjs';
const HOOK = fileURLToPath(new URL(`./tool-gate-hook${SELF_EXT}`, import.meta.url));
// Where codex keys a `-c` hook's trust state (codex-rs hooks discovery: SessionFlags layer).
const SESSION_FLAGS_SOURCE = '/<session-flags>/config.toml';
const SESSION_ID = /^[\w-]+$/;
const STALE_LEDGER_MS = 24 * 60 * 60 * 1000;

const tokenSchema = z.object({
  grants: z.array(z.string()),
  ledgerDir: z.string(),
  repoRoot: z.string().optional(),
});
export type ToolGateToken = z.infer<typeof tokenSchema>;

const ledgerEntrySchema = z.object({ decision: z.enum(['allow', 'deny']), line: z.string() });
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

export const toolGateLedgerDir = (): string =>
  join(tmpdir(), `devkit-tool-gate-${process.getuid?.() ?? 'user'}`);

/**
 * The `trusted_hash` codex compares against: sha256 over the key-sorted JSON of the normalized
 * handler identity (codex-rs config fingerprint `version_for_toml`). Keys below are already sorted.
 */
export function codexHookTrustHash(
  eventLabel: string,
  matcher: string | undefined,
  command: string,
): string {
  const hooks = [{ async: false, command, timeout: 600, type: 'command' }];
  const identity =
    matcher === undefined
      ? { event_name: eventLabel, hooks }
      : { event_name: eventLabel, hooks, matcher };
  return `sha256:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

/** The checklist script paths a claude `--allowedTools` grant names (`Bash(node <path>:*)`). */
export function nodeGrants(allowedTools: string[] | null): string[] {
  return (allowedTools ?? []).flatMap((t) => t.match(/^Bash\(node (.+):\*\)$/)?.[1] ?? []);
}

/** `-c` overrides installing the trusted hook; its data rides as one base64url argv token. */
export function toolGateArgs(
  parts: { allowedTools: string[] | null },
  confined?: { repoRoot: string } | null,
): string[] {
  const token: ToolGateToken = {
    grants: nodeGrants(parts.allowedTools),
    ledgerDir: toolGateLedgerDir(),
    repoRoot: confined?.repoRoot,
  };
  const encoded = Buffer.from(JSON.stringify(token)).toString('base64url');
  const command = `${shellWord(process.execPath)} ${shellWord(HOOK)} ${encoded}`;
  const key = JSON.stringify(`${SESSION_FLAGS_SOURCE}:pre_tool_use:0:0`);
  const hash = JSON.stringify(codexHookTrustHash('pre_tool_use', '*', command));
  return [
    '-c',
    `hooks.PreToolUse=[{matcher="*",hooks=[{type="command",command=${JSON.stringify(command)}}]}]`,
    '-c',
    `hooks.state={${key}={trusted_hash=${hash}}}`,
  ];
}

export function decodeToolGateToken(encoded: string | undefined): ToolGateToken {
  return tokenSchema.parse(JSON.parse(Buffer.from(encoded ?? '', 'base64url').toString('utf8')));
}

/** One codex session's ledger file; null for an id that is not a plain file name. */
export function ledgerFile(dir: string, sessionId: string): string | null {
  return SESSION_ID.test(sessionId) ? join(dir, `${sessionId}.jsonl`) : null;
}

/** Create the ledger dir private to this user; false when it is a link or someone else's. */
export function ensureLedgerDir(dir: string): boolean {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  return st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid?.();
}

/** Read and delete one session's ledger, pruning day-old files a killed run left behind. */
export function takeLedger(dir: string, sessionId: string): LedgerEntry[] {
  const file = ledgerFile(dir, sessionId);
  if (!file) return [];
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  } finally {
    pruneLedgers(dir, file);
  }
  return text.split('\n').flatMap(parseLedgerLine);
}

function parseLedgerLine(line: string): LedgerEntry[] {
  try {
    return [ledgerEntrySchema.parse(JSON.parse(line))];
  } catch {
    return [];
  }
}

function pruneLedgers(dir: string, taken: string): void {
  try {
    rmSync(taken, { force: true });
    const cutoff = Date.now() - STALE_LEDGER_MS;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (lstatSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
    }
  } catch {
    // Housekeeping only: the OS reaps its temp dir.
  }
}
