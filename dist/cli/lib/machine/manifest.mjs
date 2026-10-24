/** The evidence a machine captured: files under the worktree's own git dir (never committed, never
 * shared with another worktree), listed in manifest.json, which is all `devkit ship` reads. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { withIndexCopy } from '../../../gate-engine/ratchets/commit-index.mjs';
import { withProcessLock } from '../../../gate-engine/judge/process/process-lock.mjs';
import { writeFileAtomic } from '../atomic-write.mjs';
const entrySchema = z.strictObject({
    file: z.string().min(1),
    kind: z.enum(['video', 'screenshot']),
    flow: z.string().min(1),
    passed: z.boolean(),
    sourceHead: z.string(),
    dirty: z.boolean(),
    tree: z.string().nullable(),
    sha256: z.string(),
    bytes: z.number().int().nonnegative(),
    capturedAt: z.string(),
});
const manifestSchema = z.strictObject({ entries: z.array(entrySchema) });
const gitText = (root, args, env) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
/** `<git-dir>/devkit/machine/evidence`: per worktree, so a linked worktree gets its own. */
export function evidenceDir(root) {
    return join(resolve(root, gitText(root, ['rev-parse', '--git-dir'])), 'devkit', 'machine', 'evidence');
}
const withManifestLock = (dir, fn) => withProcessLock(join(dir, 'manifest.lock'), fn, { label: 'machine evidence' });
const manifestFile = (dir) => join(dir, 'manifest.json');
export function readManifest(dir) {
    if (!existsSync(manifestFile(dir)))
        return [];
    return manifestSchema.parse(JSON.parse(readFileSync(manifestFile(dir), 'utf8'))).entries;
}
/** The one place a flow's screenshot file is named, so every reader looks for the file it wrote. */
export const shotFile = (flow, name) => `${flow}.${name}.png`;
/** Replace `flow`'s entries (and delete its old files) with entries for those of `files` still on
 * disk, built under the manifest lock so neither a second run nor a `clear` leaves a dangling entry. */
export function recordFlow(dir, flow, files, facts) {
    mkdirSync(dir, { recursive: true });
    return withManifestLock(dir, () => {
        const entries = files
            .filter(({ file }) => existsSync(join(dir, file)))
            .map(({ file, kind }) => entryFor(dir, file, { ...facts, kind, flow }));
        const previous = readManifest(dir);
        const current = new Set(entries.map((entry) => entry.file));
        for (const old of previous)
            if (old.flow === flow && !current.has(old.file))
                rmSync(join(dir, old.file), { force: true });
        const next = { entries: [...previous.filter((entry) => entry.flow !== flow), ...entries] };
        writeFileAtomic(manifestFile(dir), `${JSON.stringify(next, null, 2)}\n`);
        return entries;
    });
}
/** Forget every capture of this worktree, so nothing of it can reach a PR. Runs under the manifest
 * lock, so a `run` finishing meanwhile cannot list files that are gone. */
export function clearEvidence(dir) {
    if (!existsSync(dir))
        return;
    withManifestLock(dir, () => {
        for (const name of readdirSync(dir))
            if (!name.startsWith('manifest.lock'))
                rmSync(join(dir, name), { recursive: true, force: true });
    });
}
/** The working tree's content as a tree id (tracked and untracked, ignores honoured), hashed in a
 * private index copy so the real index is never touched; null when git cannot say. */
export function workingTree(root) {
    try {
        return withIndexCopy(root, (env) => {
            gitText(root, ['add', '-A'], env);
            return gitText(root, ['write-tree'], env);
        });
    }
    catch {
        return null;
    }
}
export function provenance(root) {
    return {
        sourceHead: gitText(root, ['rev-parse', 'HEAD']),
        dirty: gitText(root, ['status', '--porcelain']) !== '',
        tree: workingTree(root),
    };
}
/** One manifest entry for a file this run wrote into `dir`. */
export function entryFor(dir, file, facts) {
    const bytes = readFileSync(join(dir, file));
    return {
        file,
        ...facts,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
        capturedAt: new Date().toISOString(),
    };
}
