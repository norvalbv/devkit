import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { walk } from "../../commands/sync/sync-skills.mjs";
import { readJson } from "../fs-helpers.mjs";
import { readAgentAssetManifest } from "../install/agent-asset-manifest/reader.mjs";
import { projectionDrift } from "../install/agent-assets/projection-parity.mjs";
import { isDevkitRepo } from "./self-host.mjs";
function manifestTargets(root) {
    const manifest = readAgentAssetManifest(join(root, '.devkit', 'skills-manifest.json'), 'skills');
    if (!manifest)
        return [];
    return manifest.version === 1
        ? [...manifest.manifest.targets]
        : Object.keys(manifest.manifest.providers).sort();
}
function distDrift(root) {
    const sourceRoot = join(root, 'skills');
    const distRoot = join(root, 'dist', 'skills');
    const sourceFiles = walk(sourceRoot);
    const expected = new Set(sourceFiles);
    const drift = [];
    for (const rel of sourceFiles) {
        const dest = join(distRoot, rel);
        if (!existsSync(dest))
            drift.push(`missing dist/skills/${rel}`);
        else if (!readFileSync(dest).equals(readFileSync(join(sourceRoot, rel))))
            drift.push(`stale dist/skills/${rel}`);
    }
    for (const rel of existsSync(distRoot) ? walk(distRoot) : [])
        if (!expected.has(rel))
            drift.push(`orphan dist/skills/${rel}`);
    return drift;
}
/** Compare Devkit's canonical skills with its recorded provider projections and packaged dist. */
export function inspectSkillProjectionIntegrity(root) {
    try {
        if (!isDevkitRepo(root))
            return { active: false, checkedProjections: [], findings: [] };
    }
    catch {
        return { active: false, checkedProjections: [], findings: [] };
    }
    const targets = manifestTargets(root);
    if (!existsSync(join(root, 'skills'))) {
        return {
            active: true,
            checkedProjections: [...targets, 'dist'],
            findings: ['unchecked skills/ — canonical skills directory missing'],
        };
    }
    const config = readJson(join(root, '.devkit', 'config.json'));
    const findings = [
        ...projectionDrift({
            root,
            kind: 'skills',
            srcDir: 'skills',
            targets,
            selection: config?.components,
        }),
        ...distDrift(root),
    ];
    return { active: true, checkedProjections: [...targets, 'dist'], findings };
}
/** Print an internal Husky advisory only; projection drift never blocks a commit. */
export function printSkillProjectionWarning(report) {
    if (!report.active || !report.findings.length)
        return 0;
    console.error(`⚠ devkit self-host: skill projection drift detected (advisory) — ${report.findings.length} finding(s)`);
    for (const finding of report.findings)
        console.error(`  ${finding}`);
    console.error('  Repair missing/stale provider files with `node cli/index.mts sync-skills`.');
    console.error('  Repair dist with `bun run build`; remove orphan files explicitly.');
    return 0;
}
function parseRoot(args) {
    const index = args.indexOf('--root');
    if (index === -1 || !args[index + 1])
        throw new Error('usage: skill-projection-integrity --root <root>');
    return args[index + 1];
}
function main() {
    try {
        process.exitCode = printSkillProjectionWarning(inspectSkillProjectionIntegrity(parseRoot(process.argv.slice(2))));
    }
    catch (error) {
        console.error(`⚠ devkit self-host: skill projection integrity check unavailable (advisory) — ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 0;
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
    main();
