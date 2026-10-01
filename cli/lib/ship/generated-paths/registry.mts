// Generated paths and their generators, so ship's staging abort names the command, never a hand-merge
// (sc-2770). devkit's manifests are defaults; consumers declare the rest in guard.config.json (W-3).
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, win32 } from 'node:path';
import { parseJsonObject } from '../../../../gate-engine/config-json.mts';
import { z } from 'zod';
import { isDevkitRepo } from '../../husky/self-host.mts';

export interface GeneratedEntry {
  glob: string;
  command: string;
}

export interface GeneratedMatch {
  path: string;
  command: string;
}

export interface Classified {
  generated: GeneratedMatch[];
  other: string[];
}

export const SYNC_SKILLS = 'devkit sync-skills';
export const SYNC_AGENTS = 'devkit sync-agents';

/** devkit-owned generated paths, in their consumer-facing command form. */
export const DEVKIT_GENERATED: readonly GeneratedEntry[] = Object.freeze([
  { glob: '.devkit/skills-manifest.json', command: SYNC_SKILLS },
  { glob: '.devkit/agents-manifest.json', command: SYNC_AGENTS },
]);

const LEADING_DOT_SLASH = /^(?:\.\/)+/;
// Controls, format (bidi, zero-width) and line/paragraph separators: invisible or line-breaking.
const UNSAFE_CHAR = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const DEVKIT_RUNNER = /^devkit(?=\s)/;
const NEEDS_QUOTING = /[\s"\\]/;
const UNSUPPORTED_SYNTAX = /[[\]{}]/;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

function isRepoRelativeGlob(glob: string): boolean {
  return !(
    glob === '' ||
    UNSAFE_CHAR.test(glob) ||
    UNSUPPORTED_SYNTAX.test(glob) ||
    glob.includes('\\') ||
    isAbsolute(glob) ||
    win32.isAbsolute(glob) ||
    glob.startsWith('!') ||
    glob.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')
  );
}

const entrySchema = z.strictObject({
  glob: z
    .string()
    // Never trimmed: whitespace is part of the Git path the glob must match.
    .transform((g) => g.replace(LEADING_DOT_SLASH, ''))
    .refine(isRepoRelativeGlob, 'must be a repository-relative glob using only *, ** and ?'),
  command: z
    .string()
    .trim()
    .min(1, 'must be a non-empty string')
    // Printed verbatim in ship's abort: a break or hidden character would let the config forge lines.
    .refine((c) => !UNSAFE_CHAR.test(c), 'must be one line of visible characters'),
});

// Only `generated` is read here; every other guard.config.json key belongs to gate-engine/config.mts.
const configSchema = z.looseObject({ generated: z.array(entrySchema).optional() });

/**
 * Strict boundary for guard.config.json `generated`: the raw file text in, validated entries out.
 * Malformed input throws — never half-applies — so ship can fall back to its built-in text.
 */
export function parseGeneratedConfig(text: string): GeneratedEntry[] {
  const parsed = configSchema.safeParse(parseJsonObject<object>(text, 'guard.config.json'));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `guard.config.json generated${issue.path.length ? `.${issue.path.join('.')}` : ''}: ${issue.message}`,
    );
  }
  return parsed.data.generated ?? [];
}

/**
 * Declared entries first, then devkit's defaults. First match wins, so a consumer re-declaring a
 * default glob overrides its command; the shadowed default is dropped rather than listed twice.
 */
export function generatedPathsFor(root: string): GeneratedEntry[] {
  const file = join(root, 'guard.config.json');
  const declared = existsSync(file) ? parseGeneratedConfig(readFileSync(file, 'utf8')) : [];
  const shadowed = new Set(declared.map((e) => e.glob));
  return [...declared, ...DEVKIT_GENERATED.filter((e) => !shadowed.has(e.glob))];
}

/** A `devkit …` command in the form devkit's own repo types it: its CLI runs from source. */
export const selfHostCommand = (command: string): string =>
  command.replace(DEVKIT_RUNNER, 'node cli/index.mts');

/** The command as the operator must type it at `root`. */
export function renderCommand(command: string, root: string): string {
  return isDevkitRepo(root) ? selfHostCommand(command) : command;
}

// devkit's own glob grammar, so a dot is an ordinary character: `*`/`?` stay within one segment, a
// whole `**` segment spans any depth, everything else is literal. Parsing rejects `[]` and `{}`.
const segmentSource = (seg: string): string =>
  [...seg]
    .map((ch) => (ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : ch.replace(REGEX_SPECIAL, '\\$&')))
    .join('');

function compileGlob(glob: string): RegExp {
  const segs = glob.split('/');
  const source = segs
    .map((seg, i) => {
      const slash = i > 0 && segs[i - 1] !== '**' ? '/' : '';
      if (seg !== '**') return slash + segmentSource(seg);
      return slash + (i === segs.length - 1 ? '.+' : '(?:[^/]+/)*');
    })
    .join('');
  return new RegExp(`^${source}$`, 'su');
}

export function classifyGenerated(
  paths: readonly string[],
  entries: readonly GeneratedEntry[],
): Classified {
  const out: Classified = { generated: [], other: [] };
  const seen = new Set<string>();
  const compiled = entries.map((e) => ({ re: compileGlob(e.glob), command: e.command }));
  // No trimming: a Git path is an exact identity, and ` dist/x` is not `dist/x`.
  for (const path of paths) {
    if (path === '' || seen.has(path)) continue;
    seen.add(path);
    const hit = compiled.find((e) => e.re.test(path));
    if (hit) out.generated.push({ path, command: hit.command });
    else out.other.push(path);
  }
  return out;
}

/** A path that could break a line or read ambiguously is JSON-quoted; ordinary paths stay bare. */
const escapeUnsafe = (ch: string): string => {
  const cp = ch.codePointAt(0) ?? 0;
  return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`;
};
const shown = (path: string): string =>
  NEEDS_QUOTING.test(path) || UNSAFE_CHAR.test(path)
    ? JSON.stringify(path).replace(UNSAFE_CHARS, escapeUnsafe)
    : path;

/** The staging-abort lines for one set of unmerged paths. Commands are expected already rendered. */
export function renderConflictAbort(classified: Classified, baseRef: string): string[] {
  const lines: string[] = [];
  if (classified.generated.length) {
    const byCommand = new Map<string, string[]>();
    for (const { path, command } of classified.generated)
      byCommand.set(command, [...(byCommand.get(command) ?? []), path]);
    lines.push(`ship: origin/${baseRef} and your working tree both changed GENERATED file(s).`);
    lines.push('  Do not hand-merge these — a merged copy matches neither tree. For each group:');
    lines.push(`  merge or rebase origin/${baseRef} into this checkout, take either side of the`);
    lines.push('  file, run its generator, then retry the same ship command.');
    for (const [command, paths] of byCommand) {
      for (const path of paths) lines.push(`    ${shown(path)}`);
      lines.push(`      → regenerate with \`${command}\``);
    }
  }
  if (classified.other.length) {
    lines.push(`ship: origin/${baseRef} and your working tree changed the same region of:`);
    for (const path of classified.other) lines.push(`  ${shown(path)}`);
    lines.push(
      '  ship cannot resolve this for you — the merge has to happen where you can see both sides.',
    );
  }
  return lines;
}
