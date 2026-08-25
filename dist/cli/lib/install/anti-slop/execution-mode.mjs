/** Install the managed entry shim that separates native lint from baseline-aware rule execution. */
import { existsSync, renameSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { writeFileAtomic } from '../../atomic-write.mjs';
import { ANTI_SLOP_EXECUTION_MODE_ENV, ANTI_SLOP_NATIVE_MODE } from './constants.mjs';
export function installExecutionModeWrapper(plugin, entry) {
    const entryName = basename(entry);
    const extension = extname(entryName);
    const activeName = `${entryName.slice(0, -extension.length)}.devkit-active${extension}`;
    if (existsSync(join(plugin, activeName))) {
        throw new Error(`anti-slop source collides with managed execution wrapper: ${activeName}`);
    }
    renameSync(join(plugin, entryName), join(plugin, activeName));
    writeFileAtomic(join(plugin, entryName), `const activePlugin = (await import(${JSON.stringify(`./${activeName}`)})).default;
const nativeOnly = process.env.${ANTI_SLOP_EXECUTION_MODE_ENV} === ${JSON.stringify(ANTI_SLOP_NATIVE_MODE)};
const plugin = nativeOnly
  ? {
      ...activePlugin,
      rules: Object.fromEntries(
        Object.entries(activePlugin.rules).map(([name, rule]) => [
          name,
          { ...rule, createOnce() { return {}; } },
        ]),
      ),
    }
  : activePlugin;

export default plugin;
`);
}
