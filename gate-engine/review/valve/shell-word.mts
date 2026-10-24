import { z } from 'zod';

// Paths and lenses may hold spaces or shell metacharacters. `#` is always quoted: zsh's
// extendedglob reads a bare mid-word `#` as a glob operator.
const SHELL_SAFE_WORD_RE = /^[\w@%+=:,./-]+$/;

/** POSIX single-quoted, always: for a word that must be quoted, or a list quoted uniformly. */
export const shellQuote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

/** One shell word for a pasteable command: a plain word stays byte-identical, anything else is
 * single-quoted. */
export const shellWord = (word: string): string =>
  SHELL_SAFE_WORD_RE.test(word) ? word : shellQuote(word);

/** The rationale a printed waive command carries; waive rejects it unedited, by design. */
export const WAIVE_RATIONALE_PLACEHOLDER = 'why this finding is waived';

/** What a waiver says about its finding, chosen by the author at waive time (`--kind`). */
const waiverKindSchema = z.enum(['false-positive', 'deferred', 'pre-existing', 'accepted']);
export type WaiverKind = z.infer<typeof waiverKindSchema>;
export const WAIVER_KINDS = {
  'false-positive': 'The finding is wrong. The code does not have this defect.',
  deferred: 'The defect is real and this change introduced it. It is tracked to fix later.',
  'pre-existing':
    'The defect is real, but it exists on the base. This change did not introduce it.',
  accepted: 'The behaviour is real and deliberate. The author accepts it as a known residual.',
} as const satisfies Record<WaiverKind, string>;
/** A recorded or typed kind, or null when it is none of the four (absent, misspelt, hand-edited). */
export const parseWaiverKind = (kind: string | null | undefined): WaiverKind | null =>
  waiverKindSchema.safeParse(kind).data ?? null;
/** Names every kind and is itself no kind, so waive rejects it unedited, like the rationale. */
export const WAIVE_KIND_PLACEHOLDER = Object.keys(WAIVER_KINDS).join('|');

/** The `--base` shape the waive CLI accepts. */
export const WAIVE_BASE_RE = /^[0-9a-f]{7,40}$/;

/** Controls, format characters (bidi overrides) and line separators: never printed raw. */
export const UNSAFE_TEXT_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** The one pasteable waive command, or null when the lens cannot be printed and pasted back
 * byte-identical. A base the CLI would refuse is omitted rather than printed. */
export function waiveCommand(w: {
  reviewer: string;
  lens: string;
  fp: string;
  base?: string | null;
}): string | null {
  if (!w.lens || w.lens.search(UNSAFE_TEXT_RE) !== -1) return null;
  const base = w.base && WAIVE_BASE_RE.test(w.base) ? ` --base ${w.base}` : '';
  const target = shellWord(`${w.reviewer}:${w.lens}`);
  const kind = shellWord(WAIVE_KIND_PLACEHOLDER);
  return `guard-review waive ${target} ${w.fp}${base} --kind ${kind} "${WAIVE_RATIONALE_PLACEHOLDER}"`;
}
