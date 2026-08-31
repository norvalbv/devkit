import { sourceMatchers } from '../config.mjs';
export { LINES_BASELINE } from './baseline-paths.mjs';
export const SIZE_SKIP_DIRS = new Set(['node_modules', 'dist', 'out', '__snapshots__', '_shared']);
export function governedSourceFile(file, config) {
    if (file.startsWith('/') ||
        file.split('/').some((part) => !part || part === '..' || SIZE_SKIP_DIRS.has(part))) {
        return false;
    }
    const match = sourceMatchers(config.sourceExtensions);
    return (match.isSource(file) &&
        config.scanRoots.some((root) => file === root || file.startsWith(`${root}/`)));
}
