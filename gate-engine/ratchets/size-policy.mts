import { sourceMatchers } from '../config.mts';

export { LINES_BASELINE } from './baseline-paths.mts';
export const SIZE_SKIP_DIRS = new Set(['node_modules', 'dist', 'out', '__snapshots__', '_shared']);

/** Matchers for the files the raw-line ratchet governs: source files plus `maxLinesExtensions`. */
export function lineMatchers(cfg: { sourceExtensions: string[]; maxLinesExtensions: string[] }) {
  return sourceMatchers([...cfg.sourceExtensions, ...cfg.maxLinesExtensions]);
}
