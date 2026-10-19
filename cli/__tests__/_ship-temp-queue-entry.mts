// Test-only: the real `ship()` dispatcher and queue code, but on a private queue root, so a spawned
// ship test never takes a machine-wide slot. Usage: <queueRoot> <ship args…>
import ship, { type ShipDependencies } from '../commands/ship.mts';
import { enterShipQueue } from '../lib/ship/queue/enter.mts';
import { formatShipQueue, readShipQueue } from '../lib/ship/queue/status.mts';
import { runManagedPackagedScript } from '../lib/ship/run-packaged-script.mts';
import { reportShipRuntimeProvenance } from '../lib/ship/runtime-provenance.mts';

const [root = '', ...args] = process.argv.slice(2);
// Field by field, never a spread of ship's defaults: a dependency ship gains later is missing here
// and fails loudly, instead of silently reaching the real queue.
const dependencies: ShipDependencies = {
  reportRuntimeProvenance: reportShipRuntimeProvenance,
  runManagedScript: runManagedPackagedScript,
  enterQueue: (options) => enterShipQueue({ ...options, root }),
  showQueue: () => formatShipQueue(readShipQueue(root)),
};
process.exit(await ship(args, process.cwd(), dependencies));
