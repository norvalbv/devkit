import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const PATH_EXT_RE = /\.(?:md|json|mts|mjs|ts|sh)$/;
const REMOTE_SCHEME_RE = /^(?:[a-z][a-z\d+.-]*:\/\/|mailto:)/i;
const TOKEN_SPLIT_RE = /[\s`() ,;"']+/;

/**
 * Repo-root-relative path candidates named in Markdown prose, links, inline code, or fenced code.
 *
 * This deliberately tokenises informal citations as well as formal Markdown links; it is not a
 * CommonMark link parser. Callers choose the repository root used to resolve the returned paths.
 */
export function referencedRepoPathCandidates(markdown: string): string[] {
  const out = new Set<string>();
  for (const raw of markdown.split(TOKEN_SPLIT_RE)) {
    let token = raw.replace(/[.,;:!?]+$/, '');
    if (token === '') continue;

    // Angle-wrapped Markdown destinations are valid, while a placeholder embedded in a path is
    // not a concrete citation and must not be emitted in fragments.
    const wrapped = token.match(/^<([^<>]+)>$/);
    if (wrapped) token = wrapped[1] ?? '';
    else if (/[<>]/.test(token)) continue;

    if (token.startsWith('//') || REMOTE_SCHEME_RE.test(token)) continue;
    if (/[*[\]{}]/.test(token)) continue;

    // `?` after a concrete file is a query locator. Before an extension or path segment it is a
    // glob wildcard, which must be ignored rather than shortened into a plausible directory.
    const query = token.indexOf('?');
    if (query >= 0 && !PATH_EXT_RE.test(token.slice(0, query))) continue;

    const located = token.replace(/[#?:].*$/, '');
    if (located.startsWith('/')) continue;
    if (!located.includes('/') && !PATH_EXT_RE.test(located)) continue;
    const path = located.replace(/\/+$/, '');
    if (path !== '') out.add(path);
  }
  return [...out];
}

/**
 * Resolve a repo-relative path case-sensitively on every filesystem.
 *
 * Each segment must appear with the exact spelling returned by its parent directory. This is an
 * existence-and-casing check, not root confinement: repository symlinks are followed deliberately.
 */
export function resolvesCaseExact(root: string, relPath: string): boolean {
  if (relPath === '' || relPath.startsWith('/')) return false;
  const segments = relPath.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) return false;

  let dir = root;
  for (const segment of segments) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return false;
    }
    if (!entries.includes(segment)) return false;

    dir = join(dir, segment);
  }
  return true;
}
