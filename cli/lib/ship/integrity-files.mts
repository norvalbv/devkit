import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { isDevkitRepo } from '../husky/self-host.mts';

/** Ship preflights are inert when package identity is absent or unreadable. */
export function isDevkitShipRepo(root: string): boolean {
  try {
    return isDevkitRepo(root);
  } catch {
    return false;
  }
}

export function repoPath(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/');
}

/** Return every regular file below a repository-relative directory. */
export function filesUnder(root: string, relativeDir: string): string[] {
  const dir = path.join(root, relativeDir);
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  const walk = (absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = path.join(absolute, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.push(repoPath(root, child));
    }
  };
  walk(dir);
  return files.sort();
}
