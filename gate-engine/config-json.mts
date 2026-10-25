import { visit } from 'jsonc-parser';

interface DuplicateKey {
  path: string;
  lines: [number, number];
}

/** The first key one object declares twice; `//` comment keys may repeat. */
function duplicateKey(contents: string): DuplicateKey | null {
  const seen: Map<string, number>[] = [];
  let found: DuplicateKey | null = null;
  visit(contents, {
    onObjectBegin: () => {
      seen.push(new Map());
    },
    onObjectEnd: () => {
      seen.pop();
    },
    onObjectProperty: (key, _offset, _length, line, _column, pathSupplier) => {
      const keys = seen.at(-1);
      if (found || !keys || key.startsWith('//')) return;
      const first = keys.get(key);
      if (first === undefined) keys.set(key, line + 1);
      else found = { path: [...pathSupplier(), key].join('.'), lines: [first, line + 1] };
    },
  });
  return found;
}

/** Parse a config snapshot into one named object contract; malformed input never weakens a gate. */
export function parseJsonObject<T extends object>(contents: string, label: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error: unknown) {
    throw new Error(`${label} is not valid JSON: ${String(error)}`);
  }
  if (Object.prototype.toString.call(parsed) !== '[object Object]')
    throw new Error(`${label} must be a JSON object.`);
  const dup = duplicateKey(contents);
  if (dup)
    throw new Error(
      `${label} declares "${dup.path}" twice (lines ${dup.lines[0]} and ${dup.lines[1]}); JSON keeps only the last, so merge them.`,
    );
  // SAFETY: the object-tag check proves a non-null, non-array JSON object; callers provide the
  // named raw contract, and the config resolver validates every field before using it.
  return parsed as T;
}
