// CLAUDE.md ancestor-walk for conventions-reviewer — collects the CLAUDE.md files that govern a
// changed file (repo root down to the file's own directory, every level, never a sibling
// directory's file) and renders them as capped, omission-accounted evidence for a judge with no
// Bash of its own to go looking.
//
// GATE-MODE SCOPING (deliberate): this module reads only REPO-TRACKED CLAUDE.md files — it never
// reads `~/.claude/CLAUDE.md` or any other $HOME path. A user-global file would make the SAME
// commit block for one developer and pass for another based on a personal home-directory file
// that isn't part of the repo, which contradicts both "the reviewer checks the consumer repo's
// conventions" and this codebase's own portability model (resolve consumer-cwd-relative, never
// $HOME, for anything that affects a shared/team-visible verdict). The agent brief may still tell
// an INTERACTIVE (Task-tool-dispatched) run to check `~/.claude/CLAUDE.md` itself via its own
// Read tool — that's prose guidance to the LLM, not something this deterministic module does.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { renderCappedSegments } from "./diff-evidence.mjs";
// A CLAUDE.md's own size rarely needs deep truncation, but one huge file must not crowd out every
// other governing file's rules from the budget.
const CLAUDE_MD_TOTAL_CAP = 60000;
const CLAUDE_MD_SEGMENT_CAP = 12000;
const OMITTED_LIST_MAX = 40;
const LEADING_SLASHES_RE = /^\/+/;
/**
 * Pure: ordered directories to probe for a CLAUDE.md, repo root FIRST ('' — least specific) down
 * to the changed file's OWN directory LAST (most specific) — every level returned, never just the
 * nearest one, so root + nested rules both apply.
 */
export function ancestorDirs(fileRelPath) {
    // Staged paths are always POSIX (git's own `--name-only` output, even on Windows) — no
    // backslash handling needed here; a leading slash is stripped defensively.
    const norm = String(fileRelPath).replace(LEADING_SLASHES_RE, '');
    const parts = norm.split('/').filter(Boolean).slice(0, -1); // drop the filename itself
    const dirs = [''];
    for (let i = 0; i < parts.length; i++)
        dirs.push(parts.slice(0, i + 1).join('/'));
    return dirs;
}
/** Case-SENSITIVE existence check via a directory listing, never `existsSync`. macOS/Windows
 * filesystems are case-insensitive by default — `existsSync(".../CLAUDE.md")` returns true even
 * when the only file on disk is `claude.md`, silently matching on those platforms but not on
 * case-sensitive Linux (most CI runners, most prod containers). Listing the directory and
 * comparing the exact string makes the match identical on every OS regardless of the underlying
 * filesystem's case sensitivity — the canonical name is `CLAUDE.md`, exactly, everywhere. */
function hasExactCase(dirAbs, filename) {
    try {
        return readdirSync(dirAbs).includes(filename);
    }
    catch {
        return false; // directory unreadable/absent — never block on a dir we can't even list
    }
}
/**
 * Every governing CLAUDE.md for ONE file, repo-tracked only (see module note — no $HOME). A
 * CLAUDE.md at `packages/foo/` is included only when `fileRelPath` is under `packages/foo/` —
 * walking PER FILE (not a repo-wide glob) is what makes a sibling `packages/bar/` file never see
 * it, which is the scoping the AC requires.
 */
export function collectGoverningClaudeMd(cwd, fileRelPath) {
    const out = [];
    for (const dir of ancestorDirs(fileRelPath)) {
        const dirAbs = dir ? path.join(cwd, dir) : cwd;
        if (!hasExactCase(dirAbs, 'CLAUDE.md'))
            continue;
        let content;
        try {
            content = readFileSync(path.join(dirAbs, 'CLAUDE.md'), 'utf8');
        }
        catch {
            continue; // unreadable (permissions, race, or a directory literally named CLAUDE.md) — skip
        }
        out.push({ path: dir ? `${dir}/CLAUDE.md` : 'CLAUDE.md', scope: dir, content });
    }
    return out;
}
/**
 * Dedupe the governing CLAUDE.md set across every file selected for this reviewer (most staged
 * files under one commit share a governing set) and render one capped, omission-accounted block
 * per unique file, its scope stated explicitly so the judge can see per-file which rules apply.
 */
export function renderGoverningClaudeMd(cwd, files) {
    const byPath = new Map();
    for (const f of files)
        for (const gov of collectGoverningClaudeMd(cwd, f))
            if (!byPath.has(gov.path))
                byPath.set(gov.path, gov);
    const governing = [...byPath.values()];
    if (governing.length === 0)
        return ('GOVERNING CLAUDE.md FILES: none found for the staged files under review. There is nothing ' +
            'to check a violation against — NO_VIOLATIONS is expected unless the brief states otherwise.');
    const segments = governing.map((g) => ({
        label: g.path,
        content: `───── ${g.path} (scope: ${g.scope || '(repo root — governs everything)'}) ─────\n${g.content}`,
    }));
    const body = renderCappedSegments(segments, {
        totalCap: CLAUDE_MD_TOTAL_CAP,
        segmentCap: CLAUDE_MD_SEGMENT_CAP,
        omittedListMax: OMITTED_LIST_MAX,
        hint: (label) => `Read \`${label}\` directly`,
        omittedFooterHint: 'read each omitted file directly before any PASS verdict',
    });
    return `GOVERNING CLAUDE.md FILES (${governing.length}) — each applies only to files at or below its scope:\n${body}`;
}
