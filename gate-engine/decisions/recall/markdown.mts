/**
 * Structural reads of a decision file, backed by a real markdown parser.
 *
 * Every boundary in a decision record — where a ruling's block starts, where it ends, which dated
 * bullets belong to it — used to be string arithmetic: `lastIndexOf('\n## ')`, slice-to-next-heading,
 * scan-until-first-note. That produced six consecutive correctness-review rejections on sc-1236, each
 * a different end of the same problem: notes running past the file, an `## [archived …]` heading
 * trailing the current block, a legacy file's superseded blocks folded into its current ruling.
 *
 * `mdast-util-from-markdown` answers those questions directly. A section is "this heading until the
 * next heading of the same or shallower depth", read off node offsets rather than inferred, so the
 * boundary cannot be half-right. This module is the only place allowed to know markdown structure.
 */

import { fromMarkdown } from 'mdast-util-from-markdown';

/** A heading and everything under it, up to the next heading at the same or shallower depth. */
export interface MdSection {
  /** The heading line itself, e.g. `## Target · 2026-01-01 — foo`. */
  heading: string;
  depth: number;
  /** Prose under the heading, excluding its list items — the block's own body text. */
  prose: string;
  /** Top-level list-item texts under the heading, in document order. */
  items: string[];
}

const HEADING = 'heading';
const LIST = 'list';

/**
 * Split a decision body into heading-rooted sections.
 *
 * Content before the first heading is dropped: a decision file opens with `# <slug>`, so anything
 * above it is frontmatter residue, never a ruling.
 */
export function sections(body: string): MdSection[] {
  const tree = fromMarkdown(body);
  const out: MdSection[] = [];
  for (const node of tree.children) {
    if (node.type === HEADING) {
      const { start, end } = node.position ?? {};
      out.push({
        heading: start && end ? body.slice(start.offset ?? 0, end.offset ?? 0) : '',
        depth: (node as { depth: number }).depth,
        prose: '',
        items: [],
      });
      continue;
    }
    const current = out.at(-1);
    if (!current) continue; // pre-heading content
    if (node.type === LIST) {
      for (const item of (node as { children?: unknown[] }).children ?? []) {
        const pos = (
          item as { position?: { start?: { offset?: number }; end?: { offset?: number } } }
        ).position;
        if (pos?.start?.offset != null && pos.end?.offset != null)
          current.items.push(body.slice(pos.start.offset, pos.end.offset).trim());
      }
      continue;
    }
    const pos = node.position;
    if (pos?.start?.offset != null && pos.end?.offset != null) {
      const text = body.slice(pos.start.offset, pos.end.offset);
      current.prose = current.prose ? `${current.prose}\n${text}` : text;
    }
  }
  return out;
}
