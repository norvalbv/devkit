// Paths and lenses may hold spaces or shell metacharacters. `#` is safe mid-word, never leading.
const SHELL_SAFE_WORD_RE = /^[\w@%+=:,./-][\w@%+=:,./#-]*$/;
/** One shell word for a pasteable command: a plain word stays byte-identical, anything else is
 * single-quoted. Shared by blockingNote, the ship digest and the diff-evidence hint. */
export const shellWord = (word) => SHELL_SAFE_WORD_RE.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
