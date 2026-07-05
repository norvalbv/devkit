import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../atomic-write.mts';

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'atomic-write-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('writeFileAtomic', () => {
  it('writes the exact contents', () => {
    const f = join(tmp, 'a.json');
    writeFileAtomic(f, '{"x":1}\n');
    expect(readFileSync(f, 'utf8')).toBe('{"x":1}\n');
  });

  it('overwrites an existing file in place', () => {
    const f = join(tmp, 'b.json');
    writeFileSync(f, 'old');
    writeFileAtomic(f, 'new');
    expect(readFileSync(f, 'utf8')).toBe('new');
  });

  it('leaves no .tmp sibling behind on success', () => {
    const f = join(tmp, 'c.json');
    writeFileAtomic(f, 'data');
    const leftovers = readdirSync(tmp).filter((n) => n.startsWith('c.json.') && n.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    expect(existsSync(f)).toBe(true);
  });
});
