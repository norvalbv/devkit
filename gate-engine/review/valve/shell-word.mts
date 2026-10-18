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
export const WAIVE_RATIONALE_PLACEHOLDER = 'why this is not a real defect';

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
  return `guard-review waive ${target} ${w.fp}${base} "${WAIVE_RATIONALE_PLACEHOLDER}"`;
}
