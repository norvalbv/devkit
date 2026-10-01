// `node slot.mts register|note-log|release <slot-dir> <token> [<pgid>|<log>]` — the Bash half.
// Retried past the slot lock's 60s dead-holder reap, so a crashed locker cannot stall either step.
import { dirname } from 'node:path';
import { noteGateLog, registerGroup, releaseSlot, retryBudgetMs } from './ship-queue.mjs';
const [command = '', slot = '', token = '', value = ''] = process.argv.slice(2);
const root = dirname(slot);
const deadline = Date.now() + retryBudgetMs(process.env.DEVKIT_SHIP_SLOT_RELEASE_WAIT_MS);
function run() {
    if (command === 'register')
        return registerGroup(root, token, Number(value)) ? 0 : 3;
    if (command === 'note-log')
        return noteGateLog(root, token, value) ? 0 : 3;
    if (command === 'release') {
        const outcome = releaseSlot(root, token, { handOff: true });
        return outcome === 'released' ? 0 : outcome === 'not-held' ? 4 : 5;
    }
    console.error(`slot.mts: unknown command '${command}'`);
    return 2;
}
for (;;) {
    try {
        process.exit(run());
    }
    catch (cause) {
        // Back off between attempts: a filesystem fault must not become a 75-second hot loop.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
        if (Date.now() > deadline) {
            console.error(`ship: queue slot ${command} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
            process.exit(1);
        }
    }
}
