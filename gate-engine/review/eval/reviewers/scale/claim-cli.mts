/** Offline claim census/report. Raw packets remain under ~/.devkit/research. No judge calls. */
import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  managedParentPath,
  managedPath,
  publishImmutable,
} from '../../../../critique/immutable-file.mts';
import { withFileLock } from '../../../../eval/publish-lock.mts';
import {
  blindClaimPackets,
  buildClaimInventory,
  parseResultsEnvelope,
  claimInventorySchema,
  type CensusSource,
  type CensusError,
  sha256,
} from './claim-inventory.mts';
import { judgmentTemplate } from './claim-judgments.mts';
import { claimReport } from './claim-report.mts';
import { readArchivedDiffEvidence } from './labels.mts';

const USAGE = `Offline claim census (historical FAIL-selected replay cohort):
  census --namespace ABS_BANK --out PRIVATE_DIR results-*.json
  report --inventory PRIVATE_DIR/inventory.json --judgments judgments.json --out report.public.json
Raw census artifacts must be under ~/.devkit/research. Report contains counts and hashes only.
Adjudicate phase1.json before consulting phase2.json; mapping.private.json unblinds provenance.`;

function publishJson<Value>(file: string, value: Value): void {
  publishImmutable(
    path.dirname(file),
    path.basename(file),
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
  );
}

/** Cooperative publishers serialize, and readers only see a complete renamed generation.
 * Managed-path checks inherit the shared helper's documented same-uid path-syscall race limit. */
function publishCensus(
  out: string,
  artifacts: ReadonlyMap<string, string>,
  renameDirectory: typeof renameSync,
): void {
  const home = os.homedir();
  const privateRoot = path.join(home, '.devkit', 'research');
  const relative = path.relative(privateRoot, out);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error('Raw claim outputs must remain under ~/.devkit/research in a fresh directory');
  const segments = ['.devkit', 'research', ...relative.split(path.sep)];
  const name = segments.pop()!;
  const parent = managedParentPath(home, segments, true)!;
  const destination = path.join(parent, name);
  const lock = path.join(parent, `.claim-census-${sha256(destination)}.lock`);
  withFileLock(
    lock,
    'claim census publication',
    () => {
      const verifiedParent = managedParentPath(home, segments, false);
      if (verifiedParent !== parent) throw new Error('Census parent changed during publication');
      if (lstatSync(destination, { throwIfNoEntry: false }))
        throw new Error('Census output already exists; choose a fresh directory');
      const pendingName = `.claim-census-${randomUUID()}.pending`;
      const pending = managedPath(parent, [pendingName], true)!;
      for (const [file, content] of artifacts)
        publishImmutable(pending, file, Buffer.from(content));
      if (
        managedParentPath(home, segments, false) !== parent ||
        managedPath(parent, [pendingName], false) !== pending
      )
        throw new Error('Census directory changed during publication');
      if (lstatSync(destination, { throwIfNoEntry: false }))
        throw new Error('Census output already exists; choose a fresh directory');
      renameDirectory(pending, destination);
      if (managedPath(parent, [name], false) !== destination)
        throw new Error('Published census directory disappeared or changed');
    },
    { createParent: false },
  );
}

function readSource(
  file: string,
  namespace: string,
  errors: CensusError[],
): CensusSource | undefined {
  let resultJson: string;
  try {
    resultJson = readFileSync(file, 'utf8');
  } catch {
    errors.push({ source: path.resolve(file), code: 'unreadable-results-file' });
    return undefined;
  }
  const source: CensusSource = {
    source: path.resolve(file),
    namespace,
    resultJson,
    diffText: null,
  };
  let envelope: ReturnType<typeof parseResultsEnvelope>;
  try {
    envelope = parseResultsEnvelope(resultJson);
  } catch {
    // Preserve readable bytes; the census owns invalid-results-file classification.
    return source;
  }
  if (envelope.success) {
    const archive = readArchivedDiffEvidence(envelope.data.diff);
    source.diffText = archive.text;
    source.diffError = archive.error;
    if (archive.error) errors.push({ source: source.source, code: archive.error });
  }
  return source;
}

export function runClaimCli(argv: string[], renameDirectory: typeof renameSync = renameSync): void {
  const [command, ...rest] = argv;
  if (!command || command === '--help') {
    console.log(USAGE);
    return;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      namespace: { type: 'string' },
      out: { type: 'string' },
      inventory: { type: 'string' },
      judgments: { type: 'string' },
    },
  });
  if (!values.out) throw new Error(`Missing --out\n${USAGE}`);
  if (command === 'census') {
    if (!values.namespace || !path.isAbsolute(values.namespace) || !positionals.length)
      throw new Error(`Census requires an absolute --namespace and result files\n${USAGE}`);
    const out = path.resolve(values.out);
    const errors: CensusError[] = [];
    const sources = positionals.flatMap((file) => {
      const source = readSource(file, path.resolve(values.namespace!), errors);
      return source ? [source] : [];
    });
    const inventory = buildClaimInventory(sources, errors);
    const phase2 = {
      labels: inventory.inputs.map(({ diffSha256, labels }) => ({ diffSha256, labels })),
      occurrences: inventory.occurrences.map(({ occurrenceId, taskId }) => ({
        occurrenceId,
        diffSha256: inventory.tasks.find((task) => task.taskId === taskId)!.diffSha256,
      })),
    };
    const mapping = {
      tasks: inventory.tasks,
      occurrenceTasks: inventory.occurrences.map(({ occurrenceId, taskId }) => ({
        occurrenceId,
        taskId,
      })),
    };
    const artifacts = {
      'inventory.json': inventory,
      'phase1.json': blindClaimPackets(inventory),
      'judgments.template.json': inventory.occurrences.map(judgmentTemplate),
      'phase2.json': phase2,
      'mapping.private.json': mapping,
    };
    publishCensus(
      out,
      new Map(
        Object.entries(artifacts).map(([name, value]) => [
          name,
          `${JSON.stringify(value, null, 2)}\n`,
        ]),
      ),
      renameDirectory,
    );
    console.log(
      JSON.stringify({
        tasks: inventory.tasks.length,
        claims: inventory.occurrences.length,
        errors: inventory.errors.length,
      }),
    );
  } else if (command === 'report') {
    if (!values.inventory || !values.judgments || positionals.length)
      throw new Error(`Report requires --inventory and --judgments\n${USAGE}`);
    const inventory = claimInventorySchema.parse(
      JSON.parse(readFileSync(values.inventory, 'utf8')),
    );
    const report = claimReport(inventory, readFileSync(values.judgments, 'utf8'));
    publishJson(path.resolve(values.out), report);
    console.log(JSON.stringify(report.counts));
  } else throw new Error(`Unknown command\n${USAGE}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runClaimCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
