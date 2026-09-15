import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.mts';
import {
  type AddOptions,
  currentTarget,
  hasTargetFields,
  parseDecision,
  parseIndex,
  parseTargetFields,
  renderDecision,
  renderIndex,
  renderNote,
  renderTarget,
  sanitizeCell,
  today,
  whyHook,
} from './decision-format.mts';
import { effectiveScope } from './recall/retrieval.mts';

export interface DecisionPaths {
  cwd: string;
  decisionsDir: string;
  indexPath: string;
}

const TRAILING_WS_RE = /\s*$/;
const TIMELINE_ENTRY_RE = /^(?:## Target · \d{4}-\d{2}-\d{2}\b.*|- \d{4}-\d{2}-\d{2}\s+—\s+.*)$/gm;
const ENTRY_DATE_RE = /^(?:## Target · |- )(\d{4}-\d{2}-\d{2})\b/;
const TARGET_DATE_RE = /^## Target · (\d{4}-\d{2}-\d{2})\b/;
const NOTE_PREFIX_RE = /^- \d{4}-\d{2}-\d{2}\s+—\s+/;

interface Timeline {
  prefix: string;
  entries: Array<{ kind: 'target' | 'note'; text: string; start: number }>;
}

function timeline(body: string): Timeline {
  const matches = [...body.matchAll(TIMELINE_ENTRY_RE)];
  return {
    prefix: body.slice(0, matches[0]?.index ?? body.length).replace(TRAILING_WS_RE, ''),
    entries: matches.map((match, index) => {
      const start = match.index ?? 0;
      const end = matches[index + 1]?.index ?? body.length;
      return {
        kind: match[0].startsWith('## Target') ? 'target' : 'note',
        text: body.slice(start, end).trim(),
        start,
      };
    }),
  };
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

// Select the newest note (--note) or newest Target (--target) and prove it is absent from HEAD;
// HEAD's entries are a contiguous prefix, so every entry after an uncommitted one is a draft too.
function validateAmendment(
  slug: string,
  current: string,
  committed: string | null,
  requested: 'target' | 'note',
) {
  const workingParsed = parseDecision(current);
  const working = timeline(workingParsed.body);
  let selectedIndex = working.entries.length - 1;
  if (requested === 'target') {
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

  const baseline = committed ? parseDecision(committed) : null;
  const head = timeline(baseline?.body ?? '');
  if (baseline && JSON.stringify(workingParsed.fm) !== JSON.stringify(baseline.fm)) {
    throw new Error('frontmatter differs from HEAD; restore committed history before amending');
  }
  if (baseline && working.prefix !== head.prefix) {
    throw new Error('history before the first entry differs from HEAD; restore it before amending');
  }
  if (selectedIndex < head.entries.length) {
    throw new Error(
      requested === 'target'
        ? `newest Target (${date}) is already committed; re-target with: ` +
            `guard-decisions add ${slug} --target … --evidence-change "<what shifted>"`
        : `newest note (${date}) is already committed; append with: guard-decisions add ${slug} --note "…"`,
    );
  }
  for (let index = 0; index < head.entries.length; index += 1) {
    if (
      working.entries[index].kind !== head.entries[index].kind ||
      working.entries[index].text !== head.entries[index].text
    ) {
      throw new Error('earlier decision history differs from HEAD; restore it before amending');
    }
  }
  return {
    workingParsed,
    selected,
    date,
    trailing: working.entries.slice(selectedIndex + 1),
  };
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

function regenerateIndex(paths: DecisionPaths) {
  const previous = existsSync(paths.indexPath)
    ? parseIndex(readFileSync(paths.indexPath, 'utf8'))
    : [];
  const prior = new Map(previous.map((row) => [row.slug, row]));
  const rows = [];
  for (const name of readdirSync(paths.decisionsDir).filter(
    (entry) => entry.endsWith('.md') && entry !== 'INDEX.md',
  )) {
    const slug = name.slice(0, -3);
    const parsed = parseDecision(readFileSync(path.join(paths.decisionsDir, name), 'utf8'));
    const target = currentTarget(parsed.body);
    if (!target) {
      const legacy = prior.get(slug);
      if (legacy) rows.push(legacy);
      continue;
    }
    rows.push({
      slug,
      ruling: sanitizeCell(target.ruling),
      why: whyHook(target.fields.context ?? ''),
      updated: target.block.match(TARGET_DATE_RE)?.[1] ?? today(),
    });
  }
  writeFileAtomic(paths.indexPath, renderIndex(rows));
}

/**
 * Replace a draft entry after proving committed history equals HEAD: the newest note, or the newest
 * Target with its trailing draft notes kept byte-identical.
 */
export function amendDecision(slug: string, options: AddOptions, paths: DecisionPaths) {
  const modeCount =
    Number(Boolean(options.isTarget)) +
    Number(options.note !== undefined) +
    Number(options.noteReplace !== undefined);
  if (!slug || modeCount !== 1) {
    throw new Error(
      'Usage: guard-decisions amend <slug> --target … | --note "…" | --note-replace "<old>" "<new>"',
    );
  }
  if (
    options.noteReplace &&
    (options.noteReplace[0] === undefined || options.noteReplace[1] === undefined)
  ) {
    throw new Error('amend --note-replace requires both "<old>" and "<new>" arguments');
  }
  if (options.noteReplace?.[0] === '') {
    throw new Error('amend --note-replace requires a non-empty "<old>" substring');
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
  const kind = options.isTarget ? 'target' : 'note';
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
  if (options.noteReplace) {
    const [oldText, newText] = options.noteReplace as [string, string];
    const prefix = selected.text.match(NOTE_PREFIX_RE)?.[0];
    if (!prefix) throw new Error('newest draft note has an invalid date prefix');
    const noteText = selected.text.slice(prefix.length);
    const matches = [];
    for (
      let index = noteText.indexOf(oldText);
      index !== -1;
      index = noteText.indexOf(oldText, index + 1)
    ) {
      matches.push(index);
    }
    if (matches.length === 0) {
      throw new Error(`"${oldText}" does not occur in the newest draft note`);
    }
    if (matches.length > 1) {
      throw new Error(`"${oldText}" occurs ${matches.length} times in the newest draft note`);
    }
    const bodyOffset = current.length - workingParsed.body.length;
    const start = bodyOffset + selected.start + prefix.length + matches[0];
    const replacement = sanitizeCell(newText);
    writeFileAtomic(
      file,
      `${current.slice(0, start)}${replacement}${current.slice(start + oldText.length)}`,
    );
    console.log(`Amended draft note on "${slug}" (${date}).`);
    return;
  }
  const source = workingParsed.body;
  const before = source.slice(0, selected.start).replace(TRAILING_WS_RE, '');
  if (!(options.isTarget && hasTargetFields(options))) {
    const body = `${before}\n${renderNote(date, options.note ?? '')}\n`;
    writeFileAtomic(
      file,
      renderDecision({ slug, created: workingParsed.fm.created || date }, body),
    );
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
  const body = `${before}\n\n${renderTarget(date, options)}${gap}${source.slice(end)}`;
  writeFileAtomic(file, renderDecision({ slug, created: workingParsed.fm.created || date }, body));
  regenerateIndex(paths);
  warnTargetReplacement(selected.text, body, trailing.length > 0, options);
  const kept = trailing.length
    ? `; kept ${trailing.length} trailing entr${trailing.length === 1 ? 'y' : 'ies'} unchanged`
    : '';
  console.log(`Amended draft target on "${slug}" (${date})${kept}.`);
}
