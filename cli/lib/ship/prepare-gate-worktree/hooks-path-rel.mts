#!/usr/bin/env node
/** Print the core.hooksPath ship should resolve inside its gate worktree: an absolute value held by a
 * checkout of this repo, as that checkout's relative path. Overlay and external values print as-is. */
import { ownedHooksRel } from '../../doctor/hooks-path.mts';
import { isOverlayHooksValue } from '../../husky/overlay/overlay-home.mts';

const [gitRoot = process.cwd(), value = ''] = process.argv.slice(2);
const rel = isOverlayHooksValue(value, gitRoot) ? null : ownedHooksRel(gitRoot, value);
process.stdout.write(`${rel ?? value}\n`);
