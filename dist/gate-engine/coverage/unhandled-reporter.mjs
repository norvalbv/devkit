// Names the unhandled errors vitest's frozen json reporter omits (vitest-dev/vitest#8669).
// Never throws: it runs inside the consumer's vitest.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
/** Written beside the json report, in the run directory only this run may touch. */
export const UNHANDLED_NAME = 'unhandled.json';
export default class UnhandledReporter {
    out = null;
    onInit(vitest) {
        try {
            const { outputFile } = vitest.config;
            const json = outputFile instanceof Object ? outputFile.json : undefined;
            if (json)
                this.out = join(dirname(json), UNHANDLED_NAME);
        }
        catch {
            this.out = null;
        }
    }
    onTestRunEnd(_modules, errors) {
        if (!this.out || errors.length === 0)
            return;
        try {
            const entries = errors.map((e) => ({
                file: e.VITEST_TEST_PATH ?? null,
                message: `${e.name ?? 'Error'}: ${e.message ?? ''}`.split('\n')[0],
            }));
            writeFileSync(this.out, JSON.stringify(entries));
        }
        catch {
            /* diagnosis is a courtesy, not a guarantee */
        }
    }
}
