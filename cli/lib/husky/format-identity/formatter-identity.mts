// sc-2701: the consumer formatter is RENDERED from CONSUMER_FORMATTER into the pre-commit step and the
// package.json scripts; this gate checks the parts that are not rendered, by exact comparison only.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commitIndexEnv } from '../../../../gate-engine/ratchets/commit-index.mts';
import { defaultSelection } from '../../components.mts';
import { OVERLAY_ENTRY_REL, OXFMT_CONFIGS, OXLINT_CONFIGS } from '../../install/oxc/lifecycle.mts';
import { patchPackageJson } from '../../install/package-json.mts';
import { parseJsonc } from './jsonc.mts';
import {
  CONSUMER_FORMATTER,
  type ConsumerFormatter,
  renderAgentHookLines,
} from '../format-fragment.mts';

const FRAGMENT_REL = 'cli/lib/husky/format-fragment.mts';
const SCRIPTS_REL = 'cli/lib/install/package-json.mts';
const PRESET_DIR = 'biome';
export const AGENT_HOOKS = ['agents-hooks/format-after-edit.sh', 'agents-hooks/lint-check.sh'];
// Formatters other than the consumer's; one appearing on a non-comment line of an agent hook is drift.
const OTHER_FORMATTERS = ['biome', 'oxfmt', 'prettier', 'dprint', 'rome', 'deno fmt'];

/** Paths Oxc's lifecycle writes itself, so their presence is never evidence of a consumer choice. */
export const DEVKIT_WRITTEN_CONFIGS: readonly string[] = [
  ...OXFMT_CONFIGS,
  ...OXLINT_CONFIGS,
  OVERLAY_ENTRY_REL,
];

/** The two scripts as a written package.json holds them; any non-string reads as drift. */
export interface WrittenScripts {
  lint?: unknown;
  format?: unknown;
}

/** What patchPackageJson wrote: the two scripts and the formatter package's range. */
interface WrittenConsumer {
  scripts: WrittenScripts;
  devDependency: unknown;
}

/** A written package.json, read only through named keys compared by === (any other shape is drift). */
interface WrittenPackage {
  scripts?: WrittenScripts | null;
  devDependencies?: object | null;
}

/** A shipped preset, read only through `formatter.enabled` compared to true/false. */
interface PresetJson {
  formatter?: { enabled?: unknown } | null;
}

/** The repository's own package.json, read only through `name`. */
interface PackageIdentity {
  name?: unknown;
}

export interface FormatterIdentityInput {
  formatter: ConsumerFormatter;
  /** What patchPackageJson actually writes for a biome selection. */
  writtenScripts: WrittenScripts;
  /** The range patchPackageJson installs for the formatter package. */
  writtenDevDependency: unknown;
  /** `formatterEnabled` undefined = omitted (Biome defaults it ON); null = does not parse. */
  presets: Array<{ path: string; formatterEnabled: boolean | undefined | null }>;
  /** null text = absent from the commit. */
  agentHooks: Array<{ path: string; text: string | null }>;
}

/** A shell line without its comment: an unquoted `#` opening a word or after ;&|( runs to EOL. */
export function withoutComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && quote !== "'") i++;
    else if (quote) {
      if (c === quote) quote = '';
    } else if (c === "'" || c === '"') quote = c;
    else if (c === '#' && (i === 0 || /[\s;&|()]/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/** Physical lines with backslash continuations joined, so a split command is judged whole. */
function logicalLines(lines: string[]): string[] {
  const out: string[] = [];
  let pending = '';
  for (const line of lines) {
    if (line.endsWith('\\')) pending += `${line.slice(0, -1)} `;
    else {
      out.push(pending + line);
      pending = '';
    }
  }
  if (pending) out.push(pending);
  return out;
}

/** Every disagreement between CONSUMER_FORMATTER and what devkit ships; empty = agreement. */
export function checkFormatterIdentity(input: FormatterIdentityInput): string[] {
  const { formatter: f } = input;
  const out: string[] = [];
  for (const p of f.configProbes.filter((p) => DEVKIT_WRITTEN_CONFIGS.includes(posix.normalize(p))))
    out.push(
      `CONSUMER_FORMATTER gates on ${p}, which devkit init writes itself (sc-1964) — not a consumer choice`,
    );
  if (input.writtenDevDependency !== f.package.range)
    out.push(
      `${SCRIPTS_REL} installs ${f.package.name}@${JSON.stringify(input.writtenDevDependency)}, not CONSUMER_FORMATTER's ${f.package.range}`,
    );
  for (const name of ['lint', 'format'] as const)
    if (input.writtenScripts[name] !== f.scripts[name])
      out.push(
        `${SCRIPTS_REL} writes ${name}: ${JSON.stringify(input.writtenScripts[name])}, not CONSUMER_FORMATTER's \`${f.scripts[name]}\``,
      );
  const rendered = renderAgentHookLines(f);
  const others = OTHER_FORMATTERS.filter((t) => t !== f.tool);
  // Any code line naming the formatter must be one the descriptor renders, verbatim — so a bare
  // `biome check`, a `command biome` or a backslash-continued invocation cannot slip past.
  const names = new RegExp(`(?<![\\w-])${f.tool}(?![\\w-])`);
  for (const { path, text } of input.agentHooks) {
    if (text === null) {
      out.push(`${path} is missing from the commit — a governed formatter input was removed`);
      continue;
    }
    const lines = text.split('\n');
    const expected = Object.entries(rendered).flatMap(([p, ls]) => (p === path ? ls : []));
    for (const line of expected.filter((line) => !lines.includes(line)))
      out.push(`${path} no longer carries \`${line.trim()}\`, which ${FRAGMENT_REL} renders`);
    for (const line of logicalLines(lines).filter(
      (l) => names.test(withoutComment(l)) && !expected.includes(l),
    ))
      out.push(
        `${path} runs ${f.tool} in a line the descriptor does not render: \`${line.trim()}\``,
      );
    const code = lines.map(withoutComment).join('\n');
    for (const t of others.filter((t) => new RegExp(`\\b${t}\\b`).test(code)))
      out.push(`${path} names ${t} outside a comment while the consumer formatter is ${f.tool}`);
  }
  if (!input.presets.some((p) => p.path === `${PRESET_DIR}/base.jsonc`))
    out.push(
      `${PRESET_DIR}/base.jsonc is missing from the commit — the shipped preset is governed`,
    );
  for (const p of input.presets) {
    if (p.formatterEnabled === null) out.push(`${p.path} does not parse as jsonc`);
    else if (f.tool !== 'biome' && p.formatterEnabled !== false)
      out.push(
        `${p.path} leaves the biome formatter on while ${FRAGMENT_REL} formats with ${f.tool}`,
      );
  }
  return out;
}

function git(root: string, args: string[]): string | null {
  const r = spawnSync('git', args, { cwd: root, env: commitIndexEnv(root), encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

/** What patchPackageJson writes into a fresh consumer with biome selected. */
function writtenConsumer(): WrittenConsumer {
  const dir = mkdtempSync(join(tmpdir(), 'devkit-fmt-identity-'));
  const log = console.log;
  try {
    writeFileSync(join(dir, 'package.json'), '{"name":"probe"}\n');
    console.log = () => {};
    const sel = { ...defaultSelection(), biome: true };
    patchPackageJson(dir, 'probe', 'probe', sel, false, false, 'generic');
    const pkg = parseJsonc<WrittenPackage>(readFileSync(join(dir, 'package.json'), 'utf8'));
    const deps = Object.entries(pkg?.devDependencies ?? {});
    return {
      scripts: { lint: pkg?.scripts?.lint, format: pkg?.scripts?.format },
      devDependency: deps.find(([name]) => name === CONSUMER_FORMATTER.package.name)?.[1],
    };
  } finally {
    console.log = log;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The live input: presets and agent hooks as ONE immutable snapshot of the commit's index holds them. */
export function currentFormatterIdentityInput(root: string, tree: string): FormatterIdentityInput {
  const listed = git(root, [
    'ls-tree',
    '-r',
    '-z',
    '--name-only',
    tree,
    '--',
    `${PRESET_DIR}/`,
    ...AGENT_HOOKS,
  ]);
  if (listed === null) throw new Error('git could not list the index snapshot');
  const inIndex = listed.split('\0').filter(Boolean);
  const read = (path: string) =>
    inIndex.includes(path) ? git(root, ['show', `${tree}:${path}`]) : null;
  const presets = inIndex
    .filter((path) => path.startsWith(`${PRESET_DIR}/`) && /\.jsonc?$/.test(path))
    .map((path) => {
      const json = parseJsonc<PresetJson>(read(path) ?? '');
      const enabled = json?.formatter?.enabled;
      return {
        path,
        formatterEnabled: json
          ? enabled === false
            ? false
            : enabled === true
              ? true
              : undefined
          : null,
      };
    });
  return {
    formatter: CONSUMER_FORMATTER,
    ...(({ scripts, devDependency }) => ({
      writtenScripts: scripts,
      writtenDevDependency: devDependency,
    }))(writtenConsumer()),
    presets,
    agentHooks: AGENT_HOOKS.map((path) => ({ path, text: read(path) })),
  };
}

/** Staged paths that make a disagreement THIS change's fault. */
export function isFormatterIdentityPath(rel: string): boolean {
  return (
    rel === FRAGMENT_REL ||
    rel === SCRIPTS_REL ||
    rel === 'cli/lib/install/oxc/lifecycle.mts' ||
    rel === 'cli/lib/components.mts' ||
    rel === 'cli/commands/init.mts' ||
    AGENT_HOOKS.includes(rel) ||
    rel.startsWith(`${PRESET_DIR}/`) ||
    rel.startsWith('cli/lib/husky/format-identity/')
  );
}

/** Gate-source paths the worktree holds differently from the index: unstaged edits and untracked
 *  files (staged edits are the commit itself). null when git cannot tell. */
export function sourceSplit(cwd: string): string[] | null {
  const unstaged = git(cwd, ['diff', '--name-only', '-z', '--', 'cli', 'gate-engine']);
  const untracked = git(cwd, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    'cli',
    'gate-engine',
  ]);
  if (unstaged === null || untracked === null) return null;
  return [...unstaged.split('\0'), ...untracked.split('\0')].filter(Boolean);
}

/** Files under cli/ and gate-engine/ whose inode changed at or after `sinceMs`. */
export function sourceChangedSince(cwd: string, sinceMs: number): string[] {
  const out: string[] = [];
  for (const top of ['cli', 'gate-engine'].filter((t) => existsSync(join(cwd, t))))
    for (const rel of readdirSync(join(cwd, top), { recursive: true, encoding: 'utf8' }))
      if (statSync(join(cwd, top, rel)).ctimeMs >= sinceMs) out.push(`${top}/${rel}`);
  return out;
}

export interface FormatterIdentityVerdict {
  code: 0 | 1;
  findings: string[];
  inert: string | null;
}

/**
 * The gate imports its descriptor and renderers from the worktree (hook-parity's precedent), so a
 * source tree that differs from the index cannot be judged: stand down and say so rather than guess.
 */
/** Paths the snapshot changes against HEAD (every path on an unborn branch); null if git cannot tell. */
export function touchedIn(cwd: string, tree: string): Set<string> | null {
  const head = git(cwd, ['rev-parse', '-q', '--verify', 'HEAD^{tree}'])?.trim();
  const out = head
    ? git(cwd, ['diff-tree', '-r', '--no-renames', '--name-only', '-z', head, tree])
    : git(cwd, ['ls-tree', '-r', '-z', '--name-only', tree]);
  return out === null ? null : new Set(out.split('\0').filter(Boolean));
}

export interface JudgeSeams {
  split?: string[] | null;
  touched?: (tree: string) => Set<string> | null;
  check?: (tree: string) => string[];
  changedSince?: (cwd: string, sinceMs: number) => string[];
  indexTree?: () => string | null;
}

/** Judge ONE snapshot: identity, findings and attribution all read the same tree id. */
function judgeTree(cwd: string, tree: string, seams: JudgeSeams): FormatterIdentityVerdict {
  const inert = (reason: string | null): FormatterIdentityVerdict => ({
    code: 0,
    findings: [],
    inert: reason,
  });
  const pkgText = git(cwd, ['show', `${tree}:package.json`]);
  const pkg = pkgText === null ? null : parseJsonc<PackageIdentity>(pkgText);
  if (pkg === null)
    return {
      code: 1,
      findings: ['package.json is missing from the commit or does not parse'],
      inert: null,
    };
  if (pkg.name !== '@norvalbv/devkit') return inert(null);
  const split = seams.split !== undefined ? seams.split : sourceSplit(cwd);
  if (split === null) return inert('could not read working-tree state');
  if (split.length)
    return inert(
      `cannot judge — the gate's source differs between the index and the worktree (${split.length} path(s))`,
    );
  const findings = (
    seams.check ?? ((t) => checkFormatterIdentity(currentFormatterIdentityInput(cwd, t)))
  )(tree);
  if (!findings.length) return { code: 0, findings, inert: null };
  const touched = (seams.touched ?? ((t) => touchedIn(cwd, t)))(tree);
  const attributable = touched === null || [...touched].some(isFormatterIdentityPath);
  return { code: attributable ? 1 : 0, findings, inert: null };
}

export function judgeFormatterIdentity(
  cwd: string,
  seams: JudgeSeams = {},
): FormatterIdentityVerdict {
  const fail = (finding: string): FormatterIdentityVerdict => ({
    code: 1,
    findings: [finding],
    inert: null,
  });
  const indexTree = seams.indexTree ?? (() => git(cwd, ['write-tree'])?.trim() ?? null);
  const before = indexTree();
  if (before === null) return fail('git could not snapshot the commit index');
  const verdict = judgeTree(cwd, before, seams);
  // Checked after EVERY path, the inert ones included: a verdict about a tree the commit no longer
  // holds is no verdict at all.
  if (indexTree() !== before)
    return fail('the index changed while formatter identity was judged — re-run the commit');
  // Worktree source imported after this process began must not change under the verdict; a
  // restore bumps ctime too, so a transient rewrite is caught.
  const moved = (seams.changedSince ?? sourceChangedSince)(cwd, performance.timeOrigin);
  if (moved.length)
    return fail(
      `gate source changed while it was being judged — re-run the commit (${moved.join(', ')})`,
    );
  return verdict;
}

export function runFormatterIdentityGate(cwd = process.cwd()): number {
  const v = judgeFormatterIdentity(cwd);
  if (v.inert) console.log(`⚠ Formatter identity ${v.inert} — nothing was judged.`);
  if (!v.findings.length) return 0;
  const head = v.code
    ? '🚫 Formatter identity disagrees with CONSUMER_FORMATTER:'
    : 'ℹ Formatter identity disagrees, but no governed input is staged (predates this change):';
  (v.code ? console.error : console.log)(head);
  for (const f of v.findings) (v.code ? console.error : console.log)(`   • ${f}`);
  return v.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.exitCode = runFormatterIdentityGate();
  } catch (e: unknown) {
    // Fail closed: a gate that could not run has not judged this commit.
    console.error(
      `🚫 Formatter identity could not run (${e instanceof Error ? e.message : String(e)}).`,
    );
    process.exitCode = 1;
  }
}
