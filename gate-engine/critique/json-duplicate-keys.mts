/** Return the first decoded object key repeated within the same JSON object. */
export function firstDuplicateJsonKey(raw: string): string | null {
  const containers: Array<Set<string> | null> = [];
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === '{') {
      containers.push(new Set());
      continue;
    }
    if (character === '[') {
      containers.push(null);
      continue;
    }
    if (character === '}' || character === ']') {
      containers.pop();
      continue;
    }
    if (character !== '"') continue;

    const start = index;
    index += 1;
    while (index < raw.length && raw[index] !== '"') {
      if (raw[index] === '\\') index += 1;
      index += 1;
    }
    if (index >= raw.length) return null;
    let cursor = index + 1;
    while (' \t\r\n'.includes(raw[cursor] ?? '')) cursor += 1;
    const keys = containers.at(-1);
    if (raw[cursor] !== ':' || !(keys instanceof Set)) continue;
    let key: string;
    try {
      key = JSON.parse(raw.slice(start, index + 1)) as string;
    } catch {
      return null;
    }
    if (keys.has(key)) return key;
    keys.add(key);
  }
  return null;
}
