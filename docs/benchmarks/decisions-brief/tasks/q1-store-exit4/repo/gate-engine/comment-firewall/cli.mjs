#!/usr/bin/env node
import { record, seen } from './store.mjs';

/**
 * guard-comments <anchor>…  — each anchor names a long comment paragraph found in the staged diff.
 * A paragraph blocks the first time it is shown and passes afterwards.
 * Exit 0 = pass, 1 = blocked on a paragraph.
 */
let blocked = false;
for (const anchor of process.argv.slice(2)) {
  if (seen(anchor)) continue;
  console.error(`BLOCK comment paragraph ${anchor}: shorten it, or retry unchanged to keep it.`);
  record(anchor);
  blocked = true;
}
process.exit(blocked ? 1 : 0);
