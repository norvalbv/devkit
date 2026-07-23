import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from "./atomic-write.mjs";
import { currentTarget, hasTargetFields, parseDecision, parseIndex, renderDecision, renderIndex, renderNote, renderTarget, sanitizeCell, today, whyHook, } from "./decision-format.mjs";
const TRAILING_WS_RE = /\s*$/;
const TIMELINE_ENTRY_RE = /^(?:## Target · \d{4}-\d{2}-\d{2}\b.*|- \d{4}-\d{2}-\d{2}\s+—\s+.*)$/gm;
const ENTRY_DATE_RE = /^(?:## Target · |- )(\d{4}-\d{2}-\d{2})\b/;
const TARGET_DATE_RE = /^## Target · (\d{4}-\d{2}-\d{2})\b/;
function timeline(body) {
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
function committedDecision(file, cwd) {
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
    const head = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root });
    if (head.status === 1)
        return null;
    if (head.status !== 0)
        throw new Error('could not resolve HEAD; refusing to amend decision history');
    const listed = spawnSync('git', ['ls-tree', '--name-only', '-z', 'HEAD', '--', relative], {
        cwd: root,
        encoding: 'utf8',
    });
    if (listed.status !== 0)
        throw new Error('could not inspect HEAD; refusing to amend decision history');
    if (!listed.stdout)
        return null;
    const shown = spawnSync('git', ['show', `HEAD:${relative}`], {
        cwd: root,
        encoding: 'utf8',
    });
    if (shown.status !== 0)
        throw new Error('could not read the committed decision; refusing to amend');
    return shown.stdout;
}
function validateAmendment(current, committed, requested) {
    const workingParsed = parseDecision(current);
    const working = timeline(workingParsed.body);
    if (!working.entries.length)
        throw new Error('axis has no Target or note to amend');
    const latest = working.entries.at(-1);
    if (!latest || latest.kind !== requested) {
        throw new Error(`newest entry is a ${latest?.kind ?? 'different type'}, not a ${requested}`);
    }
    const baseline = committed ? parseDecision(committed) : null;
    const head = timeline(baseline?.body ?? '');
    if (baseline && JSON.stringify(workingParsed.fm) !== JSON.stringify(baseline.fm)) {
        throw new Error('frontmatter differs from HEAD; restore committed history before amending');
    }
    if (baseline && working.prefix !== head.prefix) {
        throw new Error('history before the first entry differs from HEAD; restore it before amending');
    }
    if (working.entries.length <= head.entries.length) {
        throw new Error('newest entry is already committed; append a new entry instead');
    }
    if (working.entries.length !== head.entries.length + 1) {
        throw new Error('more than one entry is absent from HEAD; only the newest draft may be amended');
    }
    for (let index = 0; index < head.entries.length; index += 1) {
        if (working.entries[index].kind !== head.entries[index].kind ||
            working.entries[index].text !== head.entries[index].text) {
            throw new Error('earlier decision history differs from HEAD; restore it before amending');
        }
    }
    return { workingParsed, latest };
}
function regenerateIndex(paths) {
    const previous = existsSync(paths.indexPath)
        ? parseIndex(readFileSync(paths.indexPath, 'utf8'))
        : [];
    const prior = new Map(previous.map((row) => [row.slug, row]));
    const rows = [];
    for (const name of readdirSync(paths.decisionsDir).filter((entry) => entry.endsWith('.md') && entry !== 'INDEX.md')) {
        const slug = name.slice(0, -3);
        const parsed = parseDecision(readFileSync(path.join(paths.decisionsDir, name), 'utf8'));
        const target = currentTarget(parsed.body);
        if (!target) {
            const legacy = prior.get(slug);
            if (legacy)
                rows.push(legacy);
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
/** Replace the single newest draft entry after proving all earlier history equals HEAD. */
export function amendDecision(slug, options, paths) {
    if (!slug || Boolean(options.isTarget) === Boolean(options.note)) {
        throw new Error('Usage: guard-decisions amend <slug> --target … | --note "…"');
    }
    if (options.isTarget && !hasTargetFields(options)) {
        throw new Error('amend --target requires --context, --ruling, --consequences, --tradeoff, and --vision-fit');
    }
    const file = path.join(paths.decisionsDir, `${slug}.md`);
    if (!existsSync(file))
        throw new Error(`No decision axis "${slug}".`);
    const current = readFileSync(file, 'utf8');
    const committed = committedDecision(file, paths.cwd);
    const kind = options.isTarget ? 'target' : 'note';
    const { workingParsed, latest } = validateAmendment(current, committed, kind);
    const date = latest.text.match(ENTRY_DATE_RE)?.[1] ?? today();
    if (options.isTarget &&
        committed &&
        currentTarget(parseDecision(committed).body) &&
        !options.evidenceChange) {
        throw new Error('amending an appended Target requires --evidence-change "<what shifted>"');
    }
    const replacement = options.isTarget && hasTargetFields(options)
        ? renderTarget(date, options)
        : renderNote(date, options.note ?? '');
    const before = workingParsed.body.slice(0, latest.start).replace(TRAILING_WS_RE, '');
    const separator = options.isTarget ? '\n\n' : '\n';
    const body = `${before}${separator}${replacement}\n`;
    writeFileAtomic(file, renderDecision({ slug, created: workingParsed.fm.created || date }, body));
    if (options.isTarget)
        regenerateIndex(paths);
    console.log(`Amended draft ${kind} on "${slug}" (${date}).`);
}
