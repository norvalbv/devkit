import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.mts';
import {
  type AddOptions,
  assertNoLineAnchors,
  currentTarget,
  firstClause,
  hasTargetFields,
  parseDecision,
  parseIndex,
  parseTargetFields,
  renderDecision,
  renderIndex,
  renderNote,
  renderTarget,
  foldLines,
  sanitizeCell,
  today,
  upsertRow,
  warnIfFolded,
  whyHook,
} from './decision-format.mts';
import { noteTextWithRelation, validateTargetSupersedes } from './recall/note-relations.mts';
import { validateCategory } from './recall/categories.mts';
import { effectiveScope } from './recall/retrieval.mts';

export interface DecisionPaths {
  cwd: string;
  decisionsDir: string;
  indexPath: string;
}

const TRAILING_WS_RE = /\s*$/;
const LEADING_WS_RE = /^\s+/;
const TIMELINE_ENTRY_RE = /^(?:## Target · \d{4}-\d{2}-\d{2}\b.*|- \d{4}-\d{2}-\d{2}\s+—\s+.*)$/gm;
const ENTRY_DATE_RE = /^(?:## Target · |- )(\d{4}-\d{2}-\d{2})\b/;
const NOTE_PREFIX_RE = /^- \d{4}-\d{2}-\d{2}\s+—\s+/;
const LINE_END_RE = /\r?\n/;
const LINE_LABEL_RE = /^[ \t]*(?:\*\*[^:\r\n]+:\*\*|- (?:Positive|Negative):)/;

interface Timeline {
  entries: Array<{ kind: 'target' | 'note'; text: string; start: number; end: number }>;
}

// A note is one line (the CLI folds it); a Target runs to its first note or the next `##` heading.
function timeline(body: string): Timeline {
  const matches = [...body.matchAll(TIMELINE_ENTRY_RE)];
  return {
    entries: matches.map((match, index) => {
      const start = match.index ?? 0;
      const kind = match[0].startsWith('## Target') ? 'target' : 'note';
      const heading = body.indexOf('\n## ', start + 1);
      const end =
        kind === 'note'
          ? start + match[0].length
          : Math.min(
              matches[index + 1]?.index ?? body.length,
              heading === -1 ? body.length : heading + 1,
            );
      return { kind, text: body.slice(start, end).trim(), start, end };
    }),
  };
}

const contentLines = (text: string) =>
  text
    .split(LINE_END_RE)
    .map((line) => line.trimEnd())
    .filter(Boolean);

/** Indices of entries absent from HEAD. Throws unless removing them leaves HEAD's content intact. */
function draftIndices(body: string, working: Timeline, committedBody: string | null): number[] {
  if (committedBody === null) return working.entries.map((_, index) => index);
  const head = timeline(committedBody).entries;
  const drafts: number[] = [];
  let matched = 0;
  for (const [index, entry] of working.entries.entries()) {
    const want = head[matched];
    if (want?.kind === entry.kind && want.text === entry.text) matched += 1;
    else drafts.push(index);
  }
  const twin = drafts.find((d) =>
    working.entries.some(
      (e, i) => i < d && !drafts.includes(i) && e.text === working.entries[d].text,
    ),
  );
  if (twin !== undefined) {
    throw new Error(
      `"${working.entries[twin].text.split('\n')[0]}" appears twice and only one is committed; ` +
        'amend cannot tell the draft apart, so nothing was written',
    );
  }
  let kept = body;
  for (const index of [...drafts].reverse()) {
    const { start, end } = working.entries[index];
    kept = kept.slice(0, start) + kept.slice(end);
  }
  const [have, want] = [contentLines(kept), contentLines(committedBody)];
  const at = want.findIndex((line, index) => line !== have[index]);
  const differs =
    matched < head.length ? head[matched].text.split('\n')[0] : (want[at] ?? have[want.length]);
  if (differs !== undefined) {
    throw new Error(
      `earlier decision history differs from HEAD at "${differs}"; undo that edit (drafts are kept), then amend`,
    );
  }
  return drafts;
}

function committedDecision(file: string, cwd: string): string | null {
  const rootResult = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
  });
  if (rootResult.status !== 0) {
    throw new Error('guard-decisions amend requires a Git worktree to verify committed history');
  }
  const root = realpathSync(rootResult.stdout.trim());
  const relative = path.relative(root, realpathSync(file)).split(path.sep).join('/');
  if (!relative || relative === '..' || relative.startsWith('../')) {
    throw new Error('decision file is outside the Git worktree and cannot be amended safely');
  }
  const head = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], {
    cwd: root,
  });
  if (head.status === 1) return null;
  if (head.status !== 0)
    throw new Error('could not resolve HEAD; refusing to amend decision history');
  const listed = spawnSync('git', ['ls-tree', '--name-only', '-z', 'HEAD', '--', relative], {
    cwd: root,
    encoding: 'utf8',
  });
  if (listed.status !== 0)
    throw new Error('could not inspect HEAD; refusing to amend decision history');
  if (!listed.stdout) return null;
  const shown = spawnSync('git', ['show', `HEAD:${relative}`], {
    cwd: root,
    encoding: 'utf8',
  });
  if (shown.status !== 0)
    throw new Error('could not read the committed decision; refusing to amend');
  return shown.stdout;
}

// Select the newest note (--note) or newest Target (--target) and prove it is absent from HEAD.
// Drafts may sit mid-file (a note lands at the end of the live ruling's section, not at EOF).
function validateAmendment(
  slug: string,
  current: string,
  committed: string | null,
  requested: 'target' | 'note',
) {
  const workingParsed = parseDecision(current);
  const working = timeline(workingParsed.body);
  const baseline = committed ? parseDecision(committed) : null;
  if (baseline && JSON.stringify(workingParsed.fm) !== JSON.stringify(baseline.fm)) {
    throw new Error('frontmatter differs from HEAD; restore committed history before amending');
  }
  const drafts = draftIndices(workingParsed.body, working, baseline?.body ?? null);
  let selectedIndex = drafts.at(-1) ?? working.entries.length - 1;
  if (requested === 'target') {
    selectedIndex = working.entries.length - 1;
    while (selectedIndex >= 0 && working.entries[selectedIndex].kind !== 'target') {
      selectedIndex -= 1;
    }
  }
  const selected = working.entries[selectedIndex];
  if (!selected) {
    throw new Error(
      requested === 'target'
        ? `axis has no Target to amend; record one with: guard-decisions add ${slug} --target …`
        : 'axis has no Target or note to amend',
    );
  }
  const date = selected.text.match(ENTRY_DATE_RE)?.[1] ?? 'undated';
  if (selected.kind !== requested) {
    throw new Error(
      `newest entry is the ${date} Target, not a note; correct it with: ` +
        `guard-decisions amend ${slug} --target …, or append with: guard-decisions add ${slug} --note "…"`,
    );
  }
  if (!drafts.includes(selectedIndex)) {
    throw new Error(
      requested === 'target'
        ? `newest Target (${date}) is already committed; re-target with: ` +
            `guard-decisions add ${slug} --target … --evidence-change "<what shifted>"`
        : `newest note (${date}) is already committed; append with: guard-decisions add ${slug} --note "…"`,
    );
  }
  return { workingParsed, selected, date, trailing: working.entries.slice(selectedIndex + 1) };
}

/** Optional Target fields an amendment must re-pass, keyed by the field name parseTargetFields reads. */
const OPTIONAL_TARGET_FIELDS = [
  ['researched', 'Researched', 'researched'],
  ['rejected', 'Rejected', 'rejected'],
  ['anchored-bet', 'Anchored-bet', 'anchoredBet'],
  ['revisit-when', 'Revisit-when', 'revisitWhen'],
  ['scope', 'Scope', 'scope'],
  ['category', 'Category', 'category'],
  ['supersedes', 'Supersedes', 'supersedes'],
] as const;

/** Name what the replacement silently changes: omitted optional fields, and a Scope a note overrides. */
function warnTargetReplacement(
  replacedText: string,
  body: string,
  hasTrailing: boolean,
  options: AddOptions,
) {
  const replaced = parseTargetFields(replacedText);
  const dropped = OPTIONAL_TARGET_FIELDS.filter(
    ([field, , option]) => replaced[field] && !String(options[option] ?? '').trim(),
  ).map(([, label]) => `**${label}:**`);
  if (dropped.length) {
    console.error(
      `warning: the replaced Target carried ${dropped.join(', ')} and this amendment omits it; ` +
        'pass the flag again to keep it.',
    );
  }
  const scope = options.scope?.trim();
  const effective = effectiveScope(body);
  if (hasTrailing && scope && effective !== scope) {
    console.error(
      `warning: a later rescope note still sets Scope to ${effective}, overriding --scope ${scope}; ` +
        'append a new rescope note if the amended Scope should govern.',
    );
  }
}

/** Name the declared supersession a note amendment drops by not re-passing --supersedes. */
function warnDroppedAmends(replacedText: string, supersedes: string | undefined) {
  if (supersedes?.trim() || !replacedText.replace(NOTE_PREFIX_RE, '').startsWith('**Amends:**')) {
    return;
  }
  console.error(
    'warning: the replaced note carried **Amends:** and this amendment omits --supersedes; ' +
      'pass the flag again to keep it.',
  );
}

/** Offset of the one occurrence of oldText in text; overlapping repeats count as ambiguous. */
function uniqueOffset(text: string, oldText: string, where: string) {
  const matches = [];
  for (let index = text.indexOf(oldText); index !== -1; index = text.indexOf(oldText, index + 1)) {
    matches.push(index);
  }
  if (matches.length === 0) throw new Error(`"${oldText}" does not occur in ${where}`);
  if (matches.length > 1)
    throw new Error(`"${oldText}" occurs ${matches.length} times in ${where}`);
  return matches[0];
}

/** Replace one substring in a Target's fields; an auto-derived heading title follows the Ruling. */
function replaceInTarget(block: string, oldText: string, newText: string) {
  const headingEnd = block.search(LINE_END_RE);
  const heading = headingEnd === -1 ? block : block.slice(0, headingEnd);
  const fields = headingEnd === -1 ? '' : block.slice(headingEnd);
  const at = uniqueOffset(fields, oldText, 'the newest draft Target');
  const lineStart = fields.lastIndexOf('\n', at) + 1;
  const next = fields.indexOf('\n', at);
  const lineEnd = next === -1 ? fields.length : next;
  const line = fields.slice(lineStart, lineEnd);
  const offset = at - lineStart;
  const editedLine = `${line.slice(0, offset)}${foldLines(newText)}${line.slice(offset + oldText.length)}`;
  const label = line.match(LINE_LABEL_RE)?.[0] ?? '';
  if (
    (editedLine.match(LINE_LABEL_RE)?.[0] ?? '') !== label ||
    (line.slice(label.length).trim() && !editedLine.slice(label.length).trim())
  ) {
    throw new Error(
      `replacing "${oldText}" would change a **Field:** label or empty a field; ` +
        'replace text inside a single field value',
    );
  }
  const categoryError = label.endsWith('**Category:**')
    ? validateCategory(editedLine.slice(label.length))
    : null;
  if (categoryError) throw new Error(categoryError);
  const edited = `${fields.slice(0, lineStart)}${editedLine}${fields.slice(lineEnd)}`;
  const before = parseTargetFields(fields);
  const after = parseTargetFields(edited);
  const autoTitle = ` — ${foldLines(firstClause(before.ruling ?? ''))}`;
  const title = heading.endsWith(autoTitle)
    ? `${heading.slice(0, -autoTitle.length)} — ${foldLines(firstClause(after.ruling ?? ''))}`
    : heading;
  const result = `${title}${edited}`;
  if (currentTarget(result)?.block !== result.trim()) {
    throw new Error(
      `replacing "${oldText}" would start a new heading or note line inside the Target`,
    );
  }
  return result;
}

// Only the amended axis's row is rewritten: every other row stays byte-identical, so an amend can
// never flip another axis to a different ruling or rewrite a hand-kept cell.
function upsertIndexRow(paths: DecisionPaths, slug: string, file: string) {
  const target = currentTarget(parseDecision(readFileSync(file, 'utf8')).body);
  if (!target) return;
  const rows = existsSync(paths.indexPath) ? parseIndex(readFileSync(paths.indexPath, 'utf8')) : [];
  const row = {
    slug,
    ruling: sanitizeCell(target.ruling),
    why: whyHook(target.fields.context ?? ''),
    updated: target.date || today(),
  };
  writeFileAtomic(paths.indexPath, renderIndex(upsertRow(rows, row)));
}

/**
 * Replace a draft entry after proving committed history equals HEAD: the newest note, or the newest
 * Target with its trailing draft notes kept byte-identical.
 */
export function amendDecision(slug: string, options: AddOptions, paths: DecisionPaths) {
  const modeCount =
    Number(Boolean(options.isTarget)) +
    Number(options.note !== undefined) +
    Number(options.noteReplace !== undefined) +
    Number(options.targetReplace !== undefined);
  if (!slug || modeCount !== 1) {
    throw new Error(
      'Usage: guard-decisions amend <slug> --target … | --note "…" | ' +
        '--note-replace "<old>" "<new>" | --target-replace "<old>" "<new>" ' +
        '(a replace mode ignores field flags)',
    );
  }
  const replaceFlag = options.targetReplace ? '--target-replace' : '--note-replace';
  const replacePair = options.targetReplace ?? options.noteReplace;
  if (replacePair && (replacePair[0] === undefined || replacePair[1] === undefined)) {
    throw new Error(`amend ${replaceFlag} requires both "<old>" and "<new>" arguments`);
  }
  if (replacePair?.[0] === '') {
    throw new Error(`amend ${replaceFlag} requires a non-empty "<old>" substring`);
  }
  if (options.targetReplace && /[\r\n]/.test(options.targetReplace[0] ?? '')) {
    throw new Error('amend --target-replace requires a single-line "<old>" substring');
  }
  if (options.note === '') throw new Error('amend --note requires a non-empty note');
  if (options.isTarget && !hasTargetFields(options)) {
    throw new Error(
      'amend --target requires --context, --ruling, --consequences, --tradeoff, and --vision-fit',
    );
  }
  const file = path.join(paths.decisionsDir, `${slug}.md`);
  if (!existsSync(file)) throw new Error(`No decision axis "${slug}".`);
  const current = readFileSync(file, 'utf8');
  const committed = committedDecision(file, paths.cwd);
  const kind = options.isTarget || options.targetReplace ? 'target' : 'note';
  const { workingParsed, selected, date, trailing } = validateAmendment(
    slug,
    current,
    committed,
    kind,
  );
  const priorTarget = currentTarget(workingParsed.body.slice(0, selected.start));
  if (
    options.isTarget &&
    priorTarget &&
    // Trimmed, matching the add-path guard: whitespace is not an evidence-state change.
    !options.evidenceChange?.trim()
  ) {
    throw new Error('amending an appended Target requires --evidence-change "<what shifted>"');
  }
  const bodyOffset = current.length - workingParsed.body.length;
  if (options.targetReplace) {
    const [oldText = '', newText = ''] = options.targetReplace;
    const block = currentTarget(selected.text)?.block ?? selected.text;
    const start = bodyOffset + selected.start;
    const edited = replaceInTarget(block, oldText, newText);
    writeFileAtomic(
      file,
      `${current.slice(0, start)}${edited}${current.slice(start + block.length)}`,
    );
    upsertIndexRow(paths, slug, file);
    warnIfFolded('--target-replace', newText);
    console.log(`Amended draft target on "${slug}" (${date}).`);
    return;
  }
  if (options.noteReplace) {
    const [oldText, newText] = options.noteReplace as [string, string];
    const prefix = selected.text.match(NOTE_PREFIX_RE)?.[0];
    if (!prefix) throw new Error('newest draft note has an invalid date prefix');
    const noteText = selected.text.slice(prefix.length);
    const at = uniqueOffset(noteText, oldText, 'the newest draft note');
    assertNoLineAnchors(noteText.slice(0, at) + newText + noteText.slice(at + oldText.length));
    const start = bodyOffset + selected.start + prefix.length + at;
    const replacement = foldLines(newText);
    writeFileAtomic(
      file,
      `${current.slice(0, start)}${replacement}${current.slice(start + oldText.length)}`,
    );
    warnIfFolded('--note-replace', newText);
    console.log(`Amended draft note on "${slug}" (${date}).`);
    return;
  }
  const source = workingParsed.body;
  const before = source.slice(0, selected.start).replace(TRAILING_WS_RE, '');
  if (!(options.isTarget && hasTargetFields(options))) {
    const rest = source.slice(selected.end).replace(LEADING_WS_RE, '');
    const note = noteTextWithRelation(
      options.note ?? '',
      options.supersedes,
      `${before}\n${rest}`,
      slug,
    );
    const body = `${before}\n${renderNote(date, note)}\n${rest ? `\n${rest}` : ''}`;
    writeFileAtomic(
      file,
      renderDecision({ slug, created: workingParsed.fm.created || date }, body),
    );
    warnDroppedAmends(selected.text, options.supersedes);
    console.log(`Amended draft note on "${slug}" (${date}).`);
    return;
  }
  // Field values are free text, so only the file's section delimiter (`\n## `, as currentTarget splits)
  // marks content that is not this Target's and would be lost with the old span.
  const end = trailing[0]?.start ?? source.length;
  const span = source.slice(selected.start, end);
  const boundary = span.indexOf('\n## ');
  const stray = boundary === -1 ? '' : span.slice(boundary + 1).split('\n')[0];
  if (stray) {
    throw new Error(
      `cannot amend the ${date} Target: "${stray}" sits between it and the next entry, ` +
        'and replacing the Target would drop it',
    );
  }
  const gap = trailing.length ? span.slice(span.replace(TRAILING_WS_RE, '').length) : '\n';
  validateTargetSupersedes(options.supersedes, before, slug);
  const body = `${before}\n\n${renderTarget(date, options)}${gap}${source.slice(end)}`;
  writeFileAtomic(file, renderDecision({ slug, created: workingParsed.fm.created || date }, body));
  upsertIndexRow(paths, slug, file);
  warnTargetReplacement(selected.text, body, trailing.length > 0, options);
  const kept = trailing.length
    ? `; kept ${trailing.length} trailing entr${trailing.length === 1 ? 'y' : 'ies'} unchanged`
    : '';
  console.log(`Amended draft target on "${slug}" (${date})${kept}.`);
}
