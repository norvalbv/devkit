import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type CursorPayloadName = 'write-create' | 'write-edit' | 'delete' | 'after-file-edit';

const DIR = new URL('./fixtures/cursor-hook-payloads/', import.meta.url);
const CAPTURED_FILE = '__WORKSPACE__/notes/a.md';

/** Text spliced into a JSON string literal without breaking it. */
const jsonText = (value: string) => JSON.stringify(value).slice(1, -1);

/**
 * A Cursor hook payload from the fixtures, rooted at `root`, aimed at `file` (relative to `root`)
 * in place of the fixture's own `notes/a.md` when given.
 */
export function cursorPayload(name: CursorPayloadName, root: string, file?: string) {
  let text = readFileSync(new URL(`${name}.json`, DIR), 'utf8');
  if (file) text = text.replaceAll(CAPTURED_FILE, jsonText(join(root, file)));
  return JSON.parse(text.replaceAll('__WORKSPACE__', jsonText(root)));
}
