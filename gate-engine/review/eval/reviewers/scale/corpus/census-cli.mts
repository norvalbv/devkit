import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateSourceRoot } from './census.mts';

// Raw manifest and source inputs stay private. Each run owns a new directory; an unsuccessful
// run cannot overwrite a prior census or print a source path in its public diagnostic.
const args = process.argv.slice(2);
if (args.length !== 4) {
  console.error(
    'Usage: census-cli.mts <private-manifest.json> <case-alias> <private-source-worktree> <private-output-parent>',
  );
  process.exitCode = 2;
} else {
  let output: string | undefined;
  try {
    const parent = privateSourceRoot(args[3]);
    output = mkdtempSync(path.join(parent, 'census-'));
    chmodSync(output, 0o700);
    const manifestFile = privateSourceRoot(args[0]);
    const json = execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL('./census-worker.mts', import.meta.url)),
        manifestFile,
        args[1],
        args[2],
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    writeFileSync(path.join(output, 'report.json'), json, { mode: 0o600, flag: 'wx' });
    process.stdout.write(json);
  } catch (error) {
    if (output)
      writeFileSync(path.join(output, 'error.private.txt'), String(error), {
        mode: 0o600,
        flag: 'wx',
      });
    console.error(
      'CENSUS_FAILED: inspect the private run diagnostic; no completed result was produced.',
    );
    process.exitCode = 1;
  }
}
