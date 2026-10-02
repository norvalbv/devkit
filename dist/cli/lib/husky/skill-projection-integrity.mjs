import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { emitAdvisoryResult } from '../../../gate-engine/judge/advisory/emit.mjs';
import { indexTreeRef, isGitWorktree, treeTextAtRef, } from '../../../gate-engine/ratchets/git-index.mjs';
import { treeBlobsAtRef } from '../../../gate-engine/ratchets/tree-blobs.mjs';
import { decodeAgentAssetManifestBytes } from '../install/agent-asset-manifest/reader.mjs';
import { agentAssetDir } from '../install/agent-assets/agent-assets.mjs';
import { SUPPORTED_AGENT_PROVIDERS } from '../install/agent-assets/agent-providers.mjs';
import { fsReader, projectionDrift, } from '../install/agent-assets/projection-parity.mjs';
import { selfHostCommand, SYNC_SKILLS } from '../ship/generated-paths/registry.mjs';
import { isDevkitPackageJson, isDevkitRepo } from './self-host.mjs';
const MANIFEST = '.devkit/skills-manifest.json';
// A finding is `<kind> <path>`; anchor on the path so a provider file named `x dist/skills/y` is not dist.
const DIST_FINDING_RE = /^\S+ dist\/skills\//;
const CONFIG = '.devkit/config.json';
// Every path the advisory reads. Provider dirs come from the one registry the writers use.
const SNAPSHOT_PATHS = [
    'package.json',
    'skills',
    'dist/skills',
    ...SUPPORTED_AGENT_PROVIDERS.map((provider) => agentAssetDir(provider, 'skills')),
    MANIFEST,
    CONFIG,
];
function manifestTargets(reader) {
    const bytes = reader.read(MANIFEST);
    if (!bytes)
        return [];
    const manifest = decodeAgentAssetManifestBytes(bytes, 'skills');
    return manifest.version === 1
        ? [...manifest.manifest.targets]
        : Object.keys(manifest.manifest.providers).sort();
}
function readConfig(reader) {
    const bytes = reader.read(CONFIG);
    if (!bytes)
        return null;
    try {
        return JSON.parse(bytes.toString('utf8'));
    }
    catch (error) {
        throw new Error(`${CONFIG} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function distDrift(reader) {
    const sourceFiles = reader.list('skills');
    const expected = new Set(sourceFiles);
    const present = new Set(reader.list('dist/skills'));
    const drift = [];
    for (const rel of sourceFiles) {
        const source = reader.read(`skills/${rel}`);
        if (!source)
            continue; // reported once as `unreadable` by projectionDrift
        if (!present.has(rel))
            drift.push(`missing dist/skills/${rel}`);
        else if (!reader.read(`dist/skills/${rel}`)?.equals(source))
            drift.push(`stale dist/skills/${rel}`);
    }
    for (const rel of present)
        if (!expected.has(rel))
            drift.push(`orphan dist/skills/${rel}`);
    return drift;
}
/** A reader over one map of repo-relative paths to bytes (null = present but not a regular file). */
function blobReader(blobs) {
    return {
        list: (dir) => {
            const prefix = `${dir}/`;
            return [...blobs.keys()]
                .filter((path) => path.startsWith(prefix))
                .map((path) => path.slice(prefix.length));
        },
        read: (rel) => blobs.get(rel) ?? null,
    };
}
// One source per run (sc-2759): the commit index, because ship refreshes `.claude/` on disk only;
// the working tree only outside git. Never mixed — see gates-judge-commit-index.
function snapshotReader(root) {
    // `.git` on disk, not a git call, decides: a failing git must stand down, not read the disk.
    if (!existsSync(join(root, '.git')) && !isGitWorktree(root))
        return { reader: fsReader(root), source: 'working-tree' };
    const tree = indexTreeRef(root);
    const blobs = tree ? treeBlobsAtRef(root, tree, SNAPSHOT_PATHS) : null;
    return blobs ? { reader: blobReader(blobs), source: 'index' } : null;
}
function isDevkitRepoSafe(root) {
    try {
        return isDevkitRepo(root);
    }
    catch {
        return false;
    }
}
/** Compare Devkit's canonical skills with its recorded provider projections and packaged dist. */
export function inspectSkillProjectionIntegrity(root) {
    const inactive = { active: false, checkedProjections: [], findings: [] };
    const snapshot = snapshotReader(root);
    if (!snapshot) {
        // Identity from the index's stage-0 entry; the disk copy only when git cannot answer at all.
        const staged = treeTextAtRef(root, '', 'package.json');
        if (!(staged === null ? isDevkitRepoSafe(root) : isDevkitPackageJson(staged)))
            return inactive;
        return {
            active: true,
            checkedProjections: [],
            findings: ['unchecked skills/ — the commit index could not be read as one snapshot'],
            source: 'index',
        };
    }
    const { reader, source } = snapshot;
    if (!isDevkitPackageJson(reader.read('package.json')?.toString('utf8')))
        return inactive;
    const targets = manifestTargets(reader);
    if (!reader.list('skills').length) {
        return {
            active: true,
            checkedProjections: [...targets, 'dist'],
            findings: ['unchecked skills/ — canonical skills directory missing'],
            source,
        };
    }
    const config = readConfig(reader);
    const findings = [
        ...projectionDrift({
            root,
            kind: 'skills',
            srcDir: 'skills',
            targets,
            selection: config?.components,
            reader,
        }),
        ...distDrift(reader),
    ];
    return { active: true, checkedProjections: [...targets, 'dist'], findings, source };
}
/** Print an internal Husky advisory only; projection drift never blocks a commit. */
export function printSkillProjectionWarning(report) {
    if (!report.active || !report.findings.length)
        return 0;
    console.error(`⚠ devkit self-host: skill projection drift detected (advisory) — ${report.findings.length} finding(s)`);
    if (report.source)
        console.error(report.source === 'index'
            ? '  Judged: the staged commit index (unstaged working-tree edits are not counted).'
            : '  Judged: the working tree (no git repository).');
    const orphans = report.findings.filter((finding) => finding.startsWith('orphan '));
    const repairs = report.findings.filter((finding) => !finding.startsWith('orphan '));
    for (const finding of repairs)
        console.error(`  ${finding}`);
    const isDist = (finding) => DIST_FINDING_RE.test(finding);
    if (repairs.some((finding) => !isDist(finding))) {
        const stage = report.source === 'index' ? ', then `git add` the result' : '';
        console.error(`  Repair missing/stale provider files with \`${selfHostCommand(SYNC_SKILLS)}\`${stage}.`);
    }
    // Never `git add` a rebuilt tracked dist file: CI refuses a PR that rewrites one (sc-2467).
    if (repairs.some(isDist))
        console.error('  dist/ is release-only: leave stale tracked dist files out of a PR (CI refuses the rewrite); stage only new ones.');
    if (orphans.length) {
        console.error('  Orphans (sync never removes these; remove orphan files explicitly):');
        for (const finding of orphans)
            console.error(`    ${finding}`);
    }
    return 0;
}
function parseRoot(args) {
    const index = args.indexOf('--root');
    if (index === -1 || !args[index + 1])
        throw new Error('usage: skill-projection-integrity --root <root>');
    return args[index + 1];
}
/**
 * Same channel as the fallow advisory (sc-2526), and silent when the projection is intact. Lives
 * here, not in the pure printer several tests call directly, so no telemetry fires on those.
 */
function emitProjectionAdvisory(report) {
    if (!report.active || report.findings.length === 0)
        return;
    emitAdvisoryResult('skill-projection', 'finding', `${report.findings.length} projection drift finding(s) — read the skill-projection section of the log`);
}
function main() {
    try {
        const report = inspectSkillProjectionIntegrity(parseRoot(process.argv.slice(2)));
        process.exitCode = printSkillProjectionWarning(report);
        emitProjectionAdvisory(report);
    }
    catch (error) {
        console.error(`⚠ devkit self-host: skill projection integrity check unavailable (advisory) — ${error instanceof Error ? error.message : String(error)}`);
        emitAdvisoryResult('skill-projection', 'could_not_run', 'skill projection integrity check unavailable — the advisory verified nothing');
        process.exitCode = 0;
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
    main();
