// The electron preset leg: the consumer's pinned eslint and config, whose content rules an edit can
// break, so an edited file's errors are matched against its HEAD content, linted in place.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ESLint } from 'eslint'; // devkit's OWN eslint, used only for its stylish formatter
import { z } from 'zod';
import { headSha } from '../coverage/failures.mts';
import {
  eslintNodeFlags,
  LINKED_ISOLATED_STORE,
  linkedIsolatedStore,
} from './eslint-node-flags.mts';
import {
  clean,
  couldNotRun,
  preExisting,
  type StructureGateResult,
  violations,
} from './verdict.mts';

const FAILED = 'guard-structure: local eslint failed';
// The json formatter embeds each failing file's source; an overflow must not read as could-not-run.
const MAX_OUTPUT = 64 * 1024 * 1024;

// Only the fields guard-structure reads; a message missing one makes the output unparseable (blocks).
const messageSchema = z.object({
  ruleId: z.string().nullable(),
  severity: z.literal([1, 2]),
  message: z.string(),
  line: z.number(),
  column: z.number(),
  endLine: z.number().optional(),
  endColumn: z.number().optional(),
});
const resultsSchema = z.array(z.object({ filePath: z.string(), messages: z.array(messageSchema) }));
type LintMessage = z.infer<typeof messageSchema>;
type ParsedResult = z.infer<typeof resultsSchema>[number];
type PresetRun = { results: ParsedResult[] } | { failed: StructureGateResult };

const isError = (message: LintMessage) => message.severity === 2;
const errorTotal = (results: ParsedResult[]) =>
  results.reduce((n, result) => n + result.messages.filter(isError).length, 0);

interface EslintExit {
  status: 0 | 1;
  stdout: string;
}

// ESLint exits 1 for lint errors only; a crash, a broken config or a failed spawn did not lint.
function spawnPreset(
  cwd: string,
  args: string[],
  input?: string,
): EslintExit | StructureGateResult {
  const eslintBin = join(cwd, 'node_modules', 'eslint', 'bin', 'eslint.js');
  if (!existsSync(eslintBin)) {
    return couldNotRun('electron structure lint needs the locally pinned eslint binary');
  }
  if (linkedIsolatedStore(cwd)) return couldNotRun(LINKED_ISOLATED_STORE);
  // An empty root is clean, not ESLint's exit-2 "no files matching".
  const argv = [...eslintNodeFlags(cwd), eslintBin, '--no-error-on-unmatched-pattern'];
  try {
    const stdout = execFileSync(process.execPath, [...argv, '--format', 'json', ...args], {
      cwd,
      input,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    return { status: 0, stdout };
  } catch (e: unknown) {
    const exited = e instanceof Error && 'status' in e ? e.status : undefined;
    const stdout = e instanceof Error && 'stdout' in e ? String(e.stdout) : '';
    if (exited === 1) return { status: 1, stdout };
    return couldNotRun(`local eslint exited abnormally (status ${String(exited ?? 'unknown')})`);
  }
}

function parseResults(stdout: string): ParsedResult[] | null {
  try {
    const parsed = resultsSchema.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** One `eslint --format json` run. An exit 1 whose output names no error or is not ESLint's json
 * still blocks; exit 0 is clean whatever it printed, as eslint's own exit code says. */
function presetJson(cwd: string, args: string[], input?: string): PresetRun {
  const exit = spawnPreset(cwd, args, input);
  if ('code' in exit) return { failed: exit };
  const results = parseResults(exit.stdout);
  if (exit.status === 1 && !(results && errorTotal(results))) {
    return { failed: violations(0, [exit.stdout.trim(), FAILED].filter(Boolean).join('\n')) };
  }
  return { results: results ?? [] };
}

/** Results narrowed to the kept messages, with the counts the stylish formatter totals recomputed. */
function keepMessages(
  results: ParsedResult[],
  keep: (message: LintMessage) => boolean,
): ESLint.LintResult[] {
  return results.flatMap(({ filePath, messages: all }) => {
    const messages = all.filter(keep);
    if (!messages.length) return [];
    const errorCount = messages.filter(isError).length;
    const counts = { errorCount, warningCount: messages.length - errorCount, fatalErrorCount: 0 };
    const fixable = { fixableErrorCount: 0, fixableWarningCount: 0 };
    return [
      {
        filePath,
        messages,
        ...counts,
        ...fixable,
        suppressedMessages: [],
        usedDeprecatedRules: [],
      },
    ];
  });
}

const all = () => true;

/** Errors block; warnings alone still print on a pass, as the inherited eslint output did. */
async function report(
  cwd: string,
  results: ESLint.LintResult[],
  trailer?: string,
): Promise<StructureGateResult> {
  if (!results.length) return clean();
  const count = results.reduce((n, result) => n + result.errorCount, 0);
  const formatter = await new ESLint({ cwd, overrideConfigFile: true }).loadFormatter('stylish');
  const text = (await formatter.format(results)).trim();
  if (!count) return { code: 0, errorCount: 0, text };
  return violations(count, [text, trailer].filter(Boolean).join('\n'));
}

export async function runPresetLint(cwd: string, targets: string[]): Promise<StructureGateResult> {
  const run = presetJson(cwd, ['--', ...targets]);
  if ('failed' in run) return run.failed;
  return report(cwd, keepMessages(run.results, all), FAILED);
}

/** Same rule and message (counts masked), and the report's last line up to its end: an import
 * wall's message is fixed per wall, so only the import's source tells two crossings apart. */
function messageKey(message: LintMessage, lines: string[]): string {
  const { line, column, endLine, endColumn } = message;
  // Only the last line: a size rule's span runs over the file's tail, which every edit moves.
  const from = endLine === line ? column - 1 : 0;
  const text = endLine && endColumn ? (lines[endLine - 1] ?? '').slice(from, endColumn - 1) : '';
  return [message.ruleId ?? '', message.message.replace(/\d+/g, '#'), text].join('\0');
}

// ESLint reports realpaths (macOS tmp dirs live under /private), so compare like with like.
function cwdRelative(cwd: string, file: string): string {
  try {
    return relative(realpathSync(cwd), realpathSync(file));
  } catch {
    return relative(cwd, file);
  }
}

function readLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n');
  } catch {
    return [];
  }
}

function headBlob(cwd: string, file: string): string | null {
  try {
    return execFileSync('git', ['cat-file', 'blob', `HEAD:./${file}`], {
      cwd,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/** Error keys of `file`'s HEAD content, linted in place under the same config and tree. */
function headKeys(cwd: string, file: string): Map<string, number> | null {
  const blob = headBlob(cwd, file);
  if (blob === null) return null;
  const run = presetJson(cwd, ['--stdin', '--stdin-filename', file], blob);
  if ('failed' in run) return null;
  const keys = new Map<string, number>();
  const lines = blob.split('\n');
  for (const message of run.results.flatMap((result) => result.messages).filter(isError)) {
    const key = messageKey(message, lines);
    keys.set(key, (keys.get(key) ?? 0) + 1);
  }
  return keys;
}

/** Edited files' errors that HEAD's copy already had, as a multiset; the rest are this change's. */
function debtAtHead(cwd: string, results: ESLint.LintResult[]) {
  const debt = new Set<LintMessage>();
  const unread: string[] = [];
  // One file at a time: the plugin's error cache is a single file the runs would share.
  for (const result of results.filter((r) => r.errorCount)) {
    const file = cwdRelative(cwd, result.filePath);
    const keys = headKeys(cwd, file);
    if (!keys) unread.push(file);
    const lines = readLines(result.filePath);
    for (const message of result.messages.filter(isError)) {
      const key = messageKey(message, lines);
      const left = keys?.get(key) ?? 0;
      if (left) debt.add(message);
      if (left) keys?.set(key, left - 1);
    }
  }
  return { debt, unread };
}

/** Added files lint alone, so one cannot hide behind an edited file; an edited file's errors are
 * pre-existing only when nothing staged could change its verdict and HEAD's copy has them too. */
export async function runPresetAttributed(
  cwd: string,
  files: string[],
  added: ReadonlySet<string>,
  stable: boolean,
): Promise<StructureGateResult[]> {
  const fresh = files.filter((file) => added.has(file));
  const edited = files.filter((file) => !added.has(file));
  const out: StructureGateResult[] = [];
  if (fresh.length) out.push(await runPresetLint(cwd, fresh));
  if (!edited.length) return out;
  const run = presetJson(cwd, ['--', ...edited]);
  if ('failed' in run) return [...out, run.failed];
  const staged = keepMessages(run.results, all);
  const sha = stable && staged.some((result) => result.errorCount) ? headSha(cwd) : null;
  if (!sha) return [...out, await report(cwd, staged, FAILED)];
  const { debt, unread } = debtAtHead(cwd, staged);
  out.push(
    await report(
      cwd,
      keepMessages(staged, (m) => !debt.has(m)),
      FAILED,
    ),
  );
  out.push(
    preExisting(
      await report(
        cwd,
        keepMessages(staged, (m) => debt.has(m)),
      ),
      sha,
    ),
  );
  if (unread.length)
    out.push(couldNotRun(`HEAD comparison could not run for ${unread.join(', ')}`));
  return out;
}
