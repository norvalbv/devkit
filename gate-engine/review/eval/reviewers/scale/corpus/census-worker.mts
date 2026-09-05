import { readFileSync } from 'node:fs';
import { censusSource, privateSourceRoot } from './census.mts';

// Invoked by census-cli with stdout/stderr captured, including native Git diagnostics.
const [manifest, id, source] = process.argv.slice(2);
const report = censusSource(readFileSync(privateSourceRoot(manifest), 'utf8'), id, source);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
