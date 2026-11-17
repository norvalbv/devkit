import { sourceMatchers } from '../config.mjs';
export { LINES_BASELINE } from './baseline-paths.mjs';
export const SIZE_SKIP_DIRS = new Set(['node_modules', 'dist', 'out', '__snapshots__', '_shared']);
/** Matchers for the files the raw-line ratchet governs: source files plus `maxLinesExtensions`. */
export function lineMatchers(cfg) {
    return sourceMatchers([...cfg.sourceExtensions, ...cfg.maxLinesExtensions]);
}
