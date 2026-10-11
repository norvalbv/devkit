#!/usr/bin/env node
/**
 * guard-decisions enforce: `link` a Target to one deterministic Check, report which axes have one,
 * and run the links as guard-deterministic's decision-checks `gate`, reading HEAD and the index.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { matchesRepoGlob } from '../../../skills/_devkit/review-roots.mjs';
import { envFlag, resolveFromCwd, resolveGuardConfig } from '../../config.mjs';
import { failLine, GATE_REASON_ENV } from '../../deterministic/reason.mjs';
import { emitGateBypass } from '../../judge/gate-events.mjs';
import { git } from '../git-io.mjs';
const GATE = 'decision-checks';
const CHECK_TAG = '**Check:**';
// A Check NOTE line, never prose that merely mentions the tag: one pattern for git grep, one for JS.
const NOTE_LINE = '^- [0-9]{4}-[0-9]{2}-[0-9]{2} — \\*\\*Check:\\*\\*';
const NOTE_LINE_RE = /^- \d{4}-\d{2}-\d{2} — \*\*Check:\*\*/m;
const BYPASS = 'DECISION_CHECKS_OK';
const TIMEOUT_MS = 120_000;
const RULING_CAP = 2000;
const WS_RE = /\s+/;
const DOT_SLASH_RE = /^(?:\.\/)+/;
const HEAD_PREFIX_RE = /^HEAD:/;
const USAGE = 'usage: guard-decisions enforce [link <slug> --check "<cmd>|none" --reason "<why>"]';
function decisionsDir(cwd) {
    const dir = resolveFromCwd(resolveGuardConfig(cwd), 'decisionsDir');
    if (!dir)
        throw new Error('decisionsDir did not resolve — check guard config');
    return dir;
}
const argvOf = (cmd) => cmd.split(WS_RE).filter(Boolean);
const keyOf = (l) => `${l.slug}\0${l.cmd}`;
const inScope = (files, globs) => files.filter((f) => globs.some((g) => matchesRepoGlob(f, g)));
const isRecord = (rel, p) => path.posix.dirname(p) === rel && p.endsWith('.md') && path.posix.basename(p) !== 'INDEX.md';
const capped = (s) => (s.length > RULING_CAP ? `${s.slice(0, RULING_CAP - 1)}…` : s);
// Paths relative to cwd, as the Scope and the Check's argv are. Without renames, a moved record or
// scoped file still lists its old path, so a move cannot hide what it took away.
function changedFiles(cwd, args) {
    return git(cwd, ['diff', ...args, '--name-only', '--relative', '-z'])
        .split('\0')
        .filter(Boolean);
}
function hasHead(cwd) {
    try {
        git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
        return true;
    }
    catch {
        return false;
    }
}
// `git grep` exits 1 when nothing matches.
function grepLinked(cwd, source, paths) {
    try {
        return git(cwd, ['grep', '-lz', '-E', '-e', NOTE_LINE, source, '--', ...paths])
            .split('\0')
            .filter(Boolean)
            .map((p) => p.replace(HEAD_PREFIX_RE, ''));
    }
    catch (e) {
        if (e instanceof Error && 'status' in e && e.status === 1)
            return [];
        throw e;
    }
}
function readLink(cwd, rev, file, parse) {
    const link = parse(git(cwd, ['cat-file', 'blob', `${rev}:./${file}`]));
    return link?.cmd
        ? [{ ...link, slug: path.posix.basename(file, '.md'), head: rev === 'HEAD' }]
        : [];
}
/** Every live link in the commit index, plus HEAD's link for each record this commit stages. */
export async function linkedChecks(cwd, staged) {
    const rel = path.relative(cwd, decisionsDir(cwd)).split(path.sep).join('/') || '.';
    const indexHits = grepLinked(cwd, '--cached', [rel]).filter((p) => isRecord(rel, p));
    const stagedRecords = staged.filter((p) => isRecord(rel, p));
    // An unborn HEAD has no tree, so it links nothing.
    const headHits = stagedRecords.length && hasHead(cwd) ? grepLinked(cwd, 'HEAD', stagedRecords) : [];
    if (indexHits.length + headHits.length === 0)
        return [];
    const { liveLink } = await import('./links.mjs');
    return [
        ...indexHits.flatMap((p) => readLink(cwd, '', p, liveLink)),
        ...headHits.flatMap((p) => readLink(cwd, 'HEAD', p, liveLink)),
    ];
}
/** Why one Check failed, or null when it passed: argv-split, no shell, no stdin, bounded. */
function runCheck(cwd, cmd, spawn) {
    const [bin, ...args] = argvOf(cmd);
    // The Check's own children must not write into this gate's failure reason.
    const env = { ...process.env, [GATE_REASON_ENV]: '' };
    const r = spawn(bin, args, {
        cwd,
        env,
        stdio: ['ignore', 'inherit', 'inherit'],
        timeout: TIMEOUT_MS,
    });
    const code = r.error && 'code' in r.error ? r.error.code : undefined;
    if (code === 'ENOENT')
        return 'could not run: command not found';
    if (code === 'ETIMEDOUT')
        return `could not run: no exit within ${TIMEOUT_MS / 1000}s`;
    if (r.error)
        return `could not run: ${r.error.message}`;
    if (r.status === 0)
        return null;
    return r.status === null ? 'could not run: killed by a signal' : `exited ${r.status}`;
}
/** Links whose Scope matches a staged file or whose argv names one, one per slug and command. */
function dueChecks(links, staged) {
    const stagedSet = new Set(staged);
    const due = new Map();
    for (const l of links) {
        const tokens = argvOf(l.cmd).slice(1);
        const named = tokens.map((t) => t.replace(DOT_SLASH_RE, '')).filter((t) => stagedSet.has(t));
        if (!named.length && !inScope(staged, l.globs).length)
            continue;
        const prev = due.get(keyOf(l));
        due.set(keyOf(l), { ...l, named, globs: [...(prev?.globs ?? []), ...l.globs] });
    }
    return due;
}
function printRemedy() {
    console.error('   Fix the code, do not weaken the check.');
    console.error('   If the ruling changed, commit the new Target or the unlink on its own first:');
    console.error('     guard-decisions enforce link <slug> --check none --reason "<why>"');
    console.error("   If the check's path moved, re-link it with the new command:");
    console.error('     guard-decisions enforce link <slug> --check "<cmd>" --reason "<why>"');
}
/** The decision-checks gate: 0 when every Check this commit touches passes, else 1. */
export async function runGate(cwd = process.cwd(), spawn = spawnSync) {
    if (envFlag(BYPASS)) {
        emitGateBypass(GATE, `GUARD_${BYPASS}`);
        console.log(`⚠️  Decision checks BYPASSED for this run (GUARD_${BYPASS}=1): no Check ran.`);
        return 0;
    }
    const staged = changedFiles(cwd, ['--cached', '--no-renames']);
    const links = await linkedChecks(cwd, staged);
    const fromIndex = links.filter((l) => !l.head);
    const indexKeys = new Set(fromIndex.map(keyOf));
    const indexLinks = new Set(fromIndex.map((l) => `${keyOf(l)}\0${l.globs.join(',')}`));
    for (const l of links) {
        if (!l.head || indexLinks.has(`${keyOf(l)}\0${l.globs.join(',')}`))
            continue;
        console.error(`⚠ ${GATE}: this commit unlinks or changes the Check on ${l.slug}; HEAD's Check still governs it.`);
    }
    const due = dueChecks(links, staged);
    const unstaged = due.size ? changedFiles(cwd, []) : [];
    let failed = false;
    for (const [key, l] of due) {
        if (l.named.length) {
            console.error(`⚠ ${GATE}: this commit edits ${l.named.join(', ')}, which the ${l.slug} Check runs.`);
        }
        const dirty = inScope(unstaged, l.globs);
        if (dirty.length) {
            console.error(`⚠ ${GATE}: unstaged edits in ${l.slug}'s Scope (${dirty.join(', ')}); the Check judged the working tree.`);
        }
        console.log(`▶ ${GATE}: ${l.slug} — ${l.cmd}`);
        const why = runCheck(cwd, l.cmd, spawn);
        if (why === null)
            continue;
        failed = true;
        const unlinked = indexKeys.has(key) ? '' : ' (unlinked in this commit)';
        failLine(`${l.slug}${unlinked}: \`${l.cmd}\` ${why}`);
        failLine(`Ruling (${l.slug}): ${capped(l.ruling)}`);
    }
    if (failed)
        printRemedy();
    return failed ? 1 : 0;
}
function refuse(why) {
    console.error(`✗ guard-decisions enforce: ${why}`);
    return 1;
}
/** Link `cmd` under the live Target of `slug`, refusing (writing nothing) when it could not run. */
export async function linkCheck(slug = '', cmd = '', reason = '', cwd = process.cwd(), spawn = spawnSync) {
    const check = cmd.trim();
    if (!slug || !check || !reason.trim())
        return refuse(USAGE);
    // The note's reason starts at its first spaced em-dash, so a bare `—` argument would be cut from
    // the command the gate reads back: the argv linked here and the argv run at commit would differ.
    if (argvOf(check).includes('—')) {
        return refuse(`\`${check}\` has a bare "—" argument; the Check note reads it as the reason.`);
    }
    const file = path.join(decisionsDir(cwd), `${slug}.md`);
    if (!existsSync(file))
        return refuse(`no decision axis "${slug}".`);
    const { liveLink } = await import('./links.mjs');
    const link = liveLink(readFileSync(file, 'utf8'));
    if (!link)
        return refuse(`"${slug}" has no Target to link a Check under.`);
    if (check !== 'none') {
        if (!link.globs.length) {
            return refuse(`"${slug}" has no Scope, so its Check would never run; rescope it first.`);
        }
        console.log(`▶ running \`${check}\` before linking it`);
        const why = runCheck(cwd, check, spawn);
        if (why !== null)
            return refuse(`\`${check}\` ${why}; a Check must pass before it is linked.`);
    }
    const { cmdAdd } = await import('../decisions.mjs');
    cmdAdd(slug, { note: `${CHECK_TAG} ${check} — ${reason.trim()}` }, cwd);
    return 0;
}
/** Enforced vs prose-only for every scoped axis, plus links that never run. Always exits 0. */
export async function report(cwd = process.cwd()) {
    const dir = decisionsDir(cwd);
    const { liveLink } = await import('./links.mjs');
    const enforced = [];
    const prose = [];
    const dropped = [];
    const unscoped = [];
    for (const file of existsSync(dir) ? readdirSync(dir).sort() : []) {
        if (!file.endsWith('.md') || file === 'INDEX.md')
            continue;
        const text = readFileSync(path.join(dir, file), 'utf8');
        const link = liveLink(text);
        const slug = file.slice(0, -3);
        if (!link)
            continue;
        if (!link.cmd && NOTE_LINE_RE.test(text))
            dropped.push(slug);
        if (link.cmd && !link.globs.length)
            unscoped.push(slug);
        else if (link.cmd)
            enforced.push(`  enforced    ${slug} — ${link.cmd}`);
        else if (link.globs.length)
            prose.push(`  prose-only  ${slug}`);
    }
    const scoped = enforced.length + prose.length;
    console.log(`Decision checks: ${enforced.length} enforced, ${prose.length} prose-only, of ${scoped} scoped axes.`);
    for (const row of [...enforced, ...prose])
        console.log(row);
    if (dropped.length) {
        console.log(`⚠ Check note but no live link (re-Targeted or unlinked): ${dropped.join(', ')}`);
    }
    if (unscoped.length)
        console.log(`⚠ Linked but never run, no Scope: ${unscoped.join(', ')}`);
    return 0;
}
function flag(args, name) {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
}
export async function main(argv) {
    const [sub, ...rest] = argv;
    if (sub === 'gate')
        process.exitCode = await runGate();
    else if (sub === 'link') {
        process.exitCode = await linkCheck(rest[0], flag(rest, '--check'), flag(rest, '--reason'));
    }
    else if (sub === undefined)
        process.exitCode = await report();
    else
        process.exitCode = refuse(USAGE);
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    main(process.argv.slice(2)).catch((error) => {
        failLine(`${GATE}: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
