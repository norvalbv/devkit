import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type SkillSelection } from '../components.mts';
import { readJson } from '../fs-helpers.mts';
import { readAgentAssetManifest } from '../install/agent-asset-manifest/reader.mts';
import { projectionDrift } from '../install/agent-assets/projection-parity.mts';
import { filesUnder, isDevkitShipRepo } from './integrity-files.mts';

interface SelfHostConfig {
  components?: SkillSelection;
}

export interface SkillProjectionIntegrityReport {
  active: boolean;
  checkedProjections: string[];
  findings: string[];
}

function filesRelativeTo(root: string, relativeDir: string): string[] {
  const prefix = `${relativeDir}/`;
  return filesUnder(root, relativeDir).map((file) => file.slice(prefix.length));
}

function manifestTargets(root: string): string[] {
  const manifest = readAgentAssetManifest(join(root, '.devkit', 'skills-manifest.json'), 'skills');
  if (!manifest) return [];
  return manifest.version === 1
    ? [...manifest.manifest.targets]
    : Object.keys(manifest.manifest.providers).sort();
}

function distDrift(root: string): string[] {
  const sourceFiles = filesRelativeTo(root, 'skills');
  const expected = new Set(sourceFiles);
  const drift: string[] = [];

  for (const rel of sourceFiles) {
    const source = join(root, 'skills', rel);
    const dest = join(root, 'dist', 'skills', rel);
    if (!existsSync(dest)) drift.push(`missing dist/skills/${rel}`);
    else if (!readFileSync(dest).equals(readFileSync(source)))
      drift.push(`stale dist/skills/${rel}`);
  }
  for (const rel of filesRelativeTo(root, 'dist/skills'))
    if (!expected.has(rel)) drift.push(`orphan dist/skills/${rel}`);
  return drift;
}

/** Compare Devkit's canonical skills with its recorded provider projections and packaged dist. */
export function inspectSkillProjectionIntegrity(root: string): SkillProjectionIntegrityReport {
  if (!isDevkitShipRepo(root)) return { active: false, checkedProjections: [], findings: [] };

  const targets = manifestTargets(root);
  const config = readJson<SelfHostConfig>(join(root, '.devkit', 'config.json'));
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

/** Print an advisory only; projection drift never blocks a Devkit ship. */
export function printSkillProjectionWarning(report: SkillProjectionIntegrityReport): number {
  if (!report.active || !report.findings.length) return 0;
  console.error(
    `⚠ devkit ship: skill projection drift detected (advisory) — ${report.findings.length} finding(s)`,
  );
  for (const finding of report.findings) console.error(`  ${finding}`);
  console.error('  Repair missing/stale provider files with `node cli/index.mts sync-skills`.');
  console.error('  Repair dist with `bun run build`; remove orphan files explicitly.');
  return 0;
}

function parseRoot(args: string[]): string {
  const index = args.indexOf('--root');
  if (index === -1 || !args[index + 1])
    throw new Error('usage: skill-projection-integrity --root <root>');
  return args[index + 1];
}

function main(): void {
  try {
    process.exitCode = printSkillProjectionWarning(
      inspectSkillProjectionIntegrity(parseRoot(process.argv.slice(2))),
    );
  } catch (error) {
    console.error(
      `⚠ devkit ship: skill projection integrity check unavailable (advisory) — ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main();
