import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  normalizeLineEndings,
  parseReviewVerdict,
} from '../../gate-engine/review/contracts/response.mts';
import { stripFrontmatter, wrapConventionsPrompt } from '../../gate-engine/review/reviewers.mts';

// sc-3729: no Bash, so Task dispatch must carry the diff inline; the gate embeds the same body,
// so the no-diff reply must stay scoped to the Task-dispatch paragraph.

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, '../../agents/conventions-reviewer.md');
const TASK_PARAGRAPH_START = 'Interactively (dispatched by name via the Task tool';
const TASK_PARAGRAPH_END = '</architecture_context>';
const NO_DIFF_TOKEN = 'NO_DIFF_SUPPLIED';

// A Windows checkout with core.autocrlf yields CRLF; every assertion below reads LF.
const md = normalizeLineEndings(readFileSync(SOURCE, 'utf8'));
const frontmatter = md.slice(0, md.indexOf('\n---', 3));
const body = stripFrontmatter(md);

function frontmatterLine(key: string): string {
  const line = frontmatter.split('\n').find((l) => l.startsWith(`${key}:`));
  if (line === undefined) throw new Error(`frontmatter has no ${key}: line`);
  return line;
}

function taskParagraph(text: string) {
  const start = text.indexOf(TASK_PARAGRAPH_START);
  const end = text.indexOf(TASK_PARAGRAPH_END, start);
  if (start < 0 || end < 0) throw new Error('Task-dispatch paragraph not found');
  return { start, end, text: text.slice(start, end) };
}

function indicesOf(text: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/** The exact line the brief tells the agent to print when no diff is supplied. */
function noDiffReplyLine(): string {
  const line = taskParagraph(body)
    .text.split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith(NO_DIFF_TOKEN));
  if (line === undefined) throw new Error(`no line starting with ${NO_DIFF_TOKEN}`);
  return line;
}

describe('conventions-reviewer brief: Task dispatch needs the diff inline (sc-3729)', () => {
  it('keeps Bash out of the toolset — option (a) stays rejected', () => {
    expect(frontmatterLine('tools')).not.toMatch(/\bBash\b/);
  });

  it('tells Task callers in the description that the diff must be passed inline', () => {
    expect(frontmatterLine('description')).toContain(
      'Pass the diff inline — this agent cannot run git.',
    );
  });

  it('keeps the description a single well-formed double-quoted scalar', () => {
    // An unescaped quote in a new example would end the scalar early, and the agent would fail to load.
    expect(frontmatterLine('description')).toMatch(/^description: "(?:[^"\\]|\\.)*"$/);
  });

  it('shows at least one description example that pastes the diff into the dispatch', () => {
    const examples = frontmatterLine('description').match(/<example>.*?<\/example>/g) ?? [];
    expect(examples.length).toBeGreaterThan(0);
    expect(examples.some((e) => /assistant: \\"[^"]*\bdiff\b[^"]*\binline\b/i.test(e))).toBe(true);
  });

  it('states the no-Bash, paste-the-diff and no-reconstruction rules on the Task path', () => {
    const { text } = taskParagraph(body);
    expect(text).toMatch(/no Bash/i);
    expect(text).toMatch(/git diff/);
    expect(text).toMatch(/untracked/);
    expect(text).toMatch(/do not (?:try to )?(?:rebuild|reconstruct)/i);
    expect(text).toContain(NO_DIFF_TOKEN);
  });

  it('confines the no-diff reply to the Task-dispatch paragraph of the source body', () => {
    const { start, end } = taskParagraph(body);
    const hits = indicesOf(body, NO_DIFF_TOKEN);
    expect(hits.length).toBeGreaterThan(0);
    for (const i of hits) expect(i > start && i < end).toBe(true);
  });

  it('keeps the no-diff reply scoped to Task dispatch inside the rendered gate prompt', () => {
    const prompt = wrapConventionsPrompt(md, ['src/a.ts'], '<claude-md>rule</claude-md>');
    const { start, end } = taskParagraph(prompt);
    const hits = indicesOf(prompt, NO_DIFF_TOKEN);
    expect(hits.length).toBeGreaterThan(0);
    for (const i of hits) expect(i > start && i < end).toBe(true);
  });

  it('makes the no-diff reply fail closed: never a PASS, never a clean-review closer', () => {
    const line = noDiffReplyLine();
    expect(parseReviewVerdict(line).verdict).toBeNull();
    expect(line).not.toMatch(/NO_VIOLATIONS|VERDICT/);
    expect(line).toMatch(/devkit review/);
  });
});
