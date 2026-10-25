/**
 * JSON.parse keeps the last of two repeated keys, so a config that declares a block twice loses the
 * first one silently. The shared config reader rejects the duplicate, and the gate blocks on it.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseJsonObject } from '../../config-json.mts';
import { configExtraGates } from '../command-gates.mts';

const REPO = join(import.meta.dirname, '../../..');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const parse = (text: string) => parseJsonObject<object>(text, 'guard.config.json');

describe('duplicate keys in guard.config.json', () => {
  it('blocks the deterministic gate on a second top-level extraGates, naming both lines', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = mkdtempSync(join(tmpdir(), 'dup-keys-'));
    dirs.push(d);
    writeFileSync(
      join(d, 'guard.config.json'),
      '{\n  "extraGates": { "git-pathspec": "true" },\n  "fanoutCap": 12,\n  "extraGates": { "related-tests": "true" }\n}\n',
    );
    expect(configExtraGates(d)).toEqual([{ label: 'guard.config.json(unreadable)' }]);
    expect(err.mock.calls.flat().join('\n')).toContain(
      'declares "extraGates" twice (lines 2 and 4); JSON keeps only the last, so merge them.',
    );
  });

  it('rejects a nested duplicate by its key path', () => {
    const text =
      '{\n  "comments": {\n    "forbiddenRefs": ["a"],\n    "forbiddenRefs": ["b"]\n  }\n}';
    expect(() => parse(text)).toThrow('declares "comments.forbiddenRefs" twice (lines 3 and 4)');
  });

  it('compares decoded names, so an escaped spelling is still a duplicate', () => {
    expect(() => parse('{"a": 1, "\\u0061": 2}')).toThrow('declares "a" twice');
  });

  it('allows one name in sibling objects and array elements', () => {
    const text = '{"x": {"k": 1}, "y": {"k": 2}, "l": [{"n": 1}, {"n": 2}]}';
    expect(parse(text)).toEqual(JSON.parse(text));
  });

  it('lets // comment keys repeat, since the loader ignores them', () => {
    const text = '{"//": "first note", "//": "second note", "fanoutCap": 12}';
    expect(parse(text)).toEqual(JSON.parse(text));
  });

  it('keeps JSON.parse’s syntax error for invalid JSON', () => {
    expect(() => parse('{"a": 1,}')).toThrow(/^guard\.config\.json is not valid JSON: SyntaxError/);
  });

  it('reads devkit’s own config, the example and every template exactly as JSON.parse does', () => {
    const files = [
      'guard.config.json',
      'guard.config.example.json',
      ...readdirSync(join(REPO, 'templates'), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join('templates', e.name, 'guard.config.json'))
        .filter((f) => existsSync(join(REPO, f))),
    ];
    expect(files.length).toBeGreaterThan(4);
    for (const f of files) {
      const text = readFileSync(join(REPO, f), 'utf8');
      expect(parse(text), f).toEqual(JSON.parse(text));
    }
  });
});
