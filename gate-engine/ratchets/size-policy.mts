import { type resolveGuardConfig, sourceMatchers } from '../config.mts';

export { LINES_BASELINE } from './baseline-paths.mts';
export const SIZE_SKIP_DIRS = new Set(['node_modules', 'dist', 'out', '__snapshots__', '_shared']);

type GuardConfig = ReturnType<typeof resolveGuardConfig>;

export function governedSourceFile(file: string, config: GuardConfig): boolean {
  if (
    file.startsWith('/') ||
    file.split('/').some((part) => !part || part === '..' || SIZE_SKIP_DIRS.has(part))
  ) {
    return false;
  }
  const match = sourceMatchers(config.sourceExtensions);
  return (
    match.isSource(file) &&
    config.scanRoots.some((root: string) => file === root || file.startsWith(`${root}/`))
  );
}
