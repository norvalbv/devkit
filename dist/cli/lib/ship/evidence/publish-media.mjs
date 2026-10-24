/** Ship's QA-capture step, run after the PR exists: attach the apt part of the source checkout's
 * `devkit machine` capture to the PR. A capture goes to one PR only, and only if it ran that PR's code. */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { z } from 'zod';
import { resolveGuardConfig } from '../../../../gate-engine/config.mjs';
import { uiPathReason } from '../../../../gate-engine/ui-evidence/check.mjs';
import { sha256 } from '../../fs-helpers.mjs';
import { readMachineConfig } from '../../machine/config.mjs';
import { evidenceDir, readManifest } from '../../machine/manifest.mjs';
import { withProcessLock } from '../../../../gate-engine/judge/process/process-lock.mjs';
import { planMedia, renderQaSection, shortSha, uploadedMedia, withQaSection, } from './media.mjs';
import { readPull, writeBody, writeBodyAttaching } from './pr-body.mjs';
const uploadsSchema = z.record(z.string(), z.string());
const uploadsFile = (dir) => join(dir, 'uploads.json');
/** Which PR each capture (by sha256) was attached to; captures belong to one PR only. */
function readUploads(dir) {
    try {
        return uploadsSchema.parse(JSON.parse(readFileSync(uploadsFile(dir), 'utf8')));
    }
    catch {
        return {};
    }
}
function recordUploads(dir, entries, pr) {
    const record = () => {
        const next = { ...readUploads(dir), ...Object.fromEntries(entries.map((e) => [e.sha256, pr])) };
        writeFileSync(uploadsFile(dir), `${JSON.stringify(next, null, 2)}\n`);
    };
    withProcessLock(join(dir, 'uploads.lock'), record, { label: 'evidence uploads' });
}
function changedPaths(root, base, head) {
    const out = execFileSync('git', ['diff', '--name-only', '-z', base, head], {
        cwd: root,
        encoding: 'utf8',
    });
    return out.split('\0').filter(Boolean);
}
/** True when the captured working tree holds the shipped commit's content at every path the PR
 * changes, so the recording shows this PR's code and not an earlier or later state. */
function ranShippedCode(root, tree, head, paths) {
    if (!tree || paths.length === 0)
        return false;
    const specs = paths.map((path) => `:(literal)${path}`);
    return (spawnSync('git', ['diff', '--quiet', tree, head, '--', ...specs], { cwd: root }).status === 0);
}
/** A manifest is a local file anyone can edit: only a plain file name inside the evidence dir, and a
 * hex tree id (never an option git would parse), may reach the copy, the git call and the upload. */
const SAFE_FILE = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;
const SAFE_TREE = /^[0-9a-f]{40,64}$/;
function eligibility(root, head, paths, pr, dir) {
    const uploads = readUploads(dir);
    const ran = new Map();
    return (entry) => {
        if (!SAFE_FILE.test(entry.file) || (entry.tree !== null && !SAFE_TREE.test(entry.tree)))
            return 'its manifest entry is not one `devkit machine run` writes';
        if (!existsSync(join(dir, entry.file)) || sha256(join(dir, entry.file)) !== entry.sha256)
            return 'its file changed or went missing after it was captured; rerun the flow';
        const elsewhere = uploads[entry.sha256];
        if (elsewhere && elsewhere !== pr)
            return `it is already attached to ${elsewhere}`;
        if (!ran.has(entry.tree))
            ran.set(entry.tree, ranShippedCode(root, entry.tree, head, paths));
        return ran.get(entry.tree)
            ? null
            : 'it ran different code than this PR ships; rerun `devkit machine run`';
    };
}
const ghCanAttach = () => (spawnSync('gh', ['pr', 'edit', '--help'], { encoding: 'utf8' }).stdout ?? '').includes('--attach');
function captures(dir) {
    try {
        return readManifest(dir);
    }
    catch {
        return [];
    }
}
/** Copy each new capture into `staging` under a space-free name and point its ref there. */
function stage(dir, staging, fresh, refs) {
    return fresh.map((entry) => {
        const name = `${shortSha(entry)}${extname(entry.file)}`;
        copyFileSync(join(dir, entry.file), join(staging, name));
        if (sha256(join(staging, name)) !== entry.sha256)
            throw new Error(`${entry.file} changed while it was being staged; rerun the flow`);
        refs.set(shortSha(entry), `./${name}`);
        return name;
    });
}
/** One gh call attaches every new file; the section is then settled from what GitHub holds, so a
 * failed upload is named rather than left as a dead link. */
function attachFresh(args, body, staging, files, plan) {
    const { repo, pr } = args;
    writeFileSync(join(staging, 'body.md'), body);
    writeBodyAttaching(repo, pr, staging, files);
    const after = readPull(repo, pr);
    const urls = uploadedMedia(after.body);
    const failed = plan.picks.filter((entry) => !urls.has(shortSha(entry)));
    const notes = [...plan.notes, ...failed.map((entry) => `\`${entry.file}\`: upload failed`)];
    const settled = withQaSection(after.body, renderQaSection({ picks: plan.picks, notes }, urls));
    if (settled !== after.body)
        writeBody(repo, pr, settled);
    console.error(`evidence: QA capture attached${failed.length ? ` (${failed.length} upload(s) failed)` : ''}`);
}
/** A capture already sent to this PR but missing from its body failed then. Uploads are public and
 * irreversible, so it is named and never sent again. */
function withoutRetries(plan, refs, uploads, pr) {
    const failed = plan.picks.filter((e) => !refs.has(shortSha(e)) && uploads[e.sha256] === pr);
    const note = (e) => `\`${e.file}\`: its upload failed on an earlier ship and is never retried; rerun the flow`;
    const picks = plan.picks.filter((entry) => !failed.includes(entry));
    return { picks, notes: [...plan.notes, ...failed.map(note)] };
}
/** What this PR should show, or null when the PR moved on or there is nothing to say. */
function planFor({ source, repo, pr, head }) {
    const pull = readPull(repo, pr);
    const dir = evidenceDir(source);
    const entries = captures(dir);
    const recipe = readMachineConfig(source).command !== undefined;
    if (pull.headRefOid !== head || (entries.length === 0 && !recipe))
        return null;
    const prUrl = `https://github.com/${repo}/pull/${pr}`;
    const paths = changedPaths(source, pull.baseRefOid, head);
    const reason = recipe ? uiPathReason(paths, resolveGuardConfig(source).uiEvidence.paths) : null;
    const plan = planMedia(entries, eligibility(source, head, paths, prUrl, dir), reason);
    const empty = plan.picks.length === 0 && plan.notes.length === 0;
    return empty ? null : { body: pull.body, dir, prUrl, plan };
}
export function publishMedia(args) {
    const planned = planFor(args);
    if (!planned)
        return;
    const { body: current, dir, prUrl } = planned;
    const refs = uploadedMedia(current);
    const plan = withoutRetries(planned.plan, refs, readUploads(dir), prUrl);
    const fresh = plan.picks.filter((entry) => !refs.has(shortSha(entry)));
    if (fresh.length === 0) {
        const body = withQaSection(current, renderQaSection(plan, refs));
        if (body !== current)
            writeBody(args.repo, args.pr, body);
        recordUploads(dir, plan.picks, prUrl);
        return;
    }
    if (!ghCanAttach()) {
        console.error('evidence: the QA capture needs gh 2.99 or newer (`gh pr edit --attach`); upgrade gh');
        return;
    }
    const staging = mkdtempSync(join(tmpdir(), 'devkit-qa-'));
    try {
        const files = stage(dir, staging, fresh, refs);
        console.error(`evidence: attaching ${files.length} QA capture file(s): ${fresh.map((e) => e.file).join(', ')}`);
        const body = withQaSection(current, renderQaSection(plan, refs));
        // Recorded before the upload, so a failed or interrupted one is never sent twice.
        recordUploads(dir, fresh, prUrl);
        attachFresh(args, body, staging, files, plan);
    }
    finally {
        rmSync(staging, { recursive: true, force: true });
    }
}
