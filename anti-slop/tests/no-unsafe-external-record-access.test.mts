import { RuleTester } from 'oxlint/plugins-dev';
import { describe, it } from 'vitest';
import { noUnsafeExternalRecordAccessRule } from '../src/devkit/rules/no-unsafe-external-record-access.ts';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } });
const error = { messageId: 'unsafeAccess' };

tester.run('anti-slop/no-unsafe-external-record-access', noUnsafeExternalRecordAccessRule, {
  valid: [
    'const files = { own: true }; const key = "own"; files[key];',
    'const JSON = { parse: () => ({}) }; const files = JSON.parse(raw); files[key];',
    'const parsed = JSON.parse(raw); parsed[0]; parsed["https://api.openai.com/profile"];',
    'const parsed = JSON.parse(raw); parsed[-1];',
    'const parsed = JSON.parse(raw); parsed[+1];',
    'const parsed = JSON.parse(raw); parsed[-0];',
    'const parsed = JSON.parse(raw); parsed[-1n];',
    'const parsed = JSON.parse(raw); parsed["name"]; parsed["apply"]; parsed["call"];',
    'const parsed = JSON.parse(raw); parsed[`safe`];',
    'const parsed = JSON.parse(raw, null); parsed["safe"];',
    'const parsed = JSON.parse(raw, void 0); parsed["safe"];',
    'const parsed = JSON.parse(raw, undefined); parsed["safe"];',
    'const parsed = JSON.parse(raw, {}); parsed["safe"];',
    'const parsed = JSON.parse(raw, []); parsed["safe"];',
    'const parsed = JSON.parse(raw, `ignored`); parsed["safe"];',
    'const parsed = JSON.parse(raw, NaN); parsed["safe"];',
    'const parsed = JSON.parse(raw, Infinity); parsed["safe"];',
    'const parsed = JSON.parse(raw, false || 0); parsed["safe"];',
    'const parsed = JSON.parse(raw, null, () => new Date()); parsed["safe"];',
    'const extras = [() => new Date()]; const parsed = JSON.parse(raw, null, ...extras); parsed["safe"];',
    'const parsed = JSON.parse(raw); parsed.items[0];',
    'const parsed = JSON.parse(raw); const key = "own"; if (Object.hasOwn(parsed, key)) parsed[key];',
    'const parsed = JSON.parse(raw); if (Object.hasOwn(parsed, 1)) parsed["1"];',
    'const parsed = JSON["parse"](raw); if (Object["hasOwn"](parsed, "own")) parsed["own"];',
    'const parsed = JSON.parse(raw); const key = "own"; Object.hasOwn(parsed, key) && parsed[key];',
    'const parsed = JSON.parse(raw); const key = "own"; const ready = true; Object.hasOwn(parsed, key) && ready && parsed[key];',
    'function read(raw: string, key: string) { const parsed = JSON.parse(raw); if (!Object.hasOwn(parsed, key)) return; return parsed[key]; }',
    'function read(raw: string, key: string) { const parsed = JSON.parse(raw); if (!Object.hasOwn(parsed, key)) { cleanup(); return; } return parsed[key]; }',
    'function read(raw: string, key: string) { const parsed = JSON.parse(raw); if (!Object.hasOwn(parsed, key)) return missing(); else return parsed[key]; }',
    'function read(raw: string, key: string) { const parsed = JSON.parse(raw); for (; Object.hasOwn(parsed, key); ) { parsed[key]; break; } }',
    'const files = JSON.parse(raw).files; if (Object.hasOwn(files, "constructor")) files["constructor"];',
    'const files: Record<string, string> = Object.create(null); files[key];',
    'const files = new Map<string, string>(); files.get(key);',
    'function read(files: Record<string, string>, key: string) { return files[key]; }',
  ],
  invalid: [
    { code: 'const files = JSON.parse(raw).files; files["constructor"];', errors: [error] },
    { code: 'const files = JSON.parse(raw).files; files["toString"];', errors: [error] },
    { code: 'const files = JSON.parse(raw).files; files["__proto__"];', errors: [error] },
    { code: 'const files = JSON.parse(raw).files; files["prototype"];', errors: [error] },
    { code: 'const parsed = JSON.parse(raw); parsed["map"];', errors: [error] },
    { code: 'const parsed = JSON.parse(raw); parsed["trim"];', errors: [error] },
    { code: 'const parsed = JSON.parse(raw); parsed["toFixed"];', errors: [error] },
    { code: 'const parsed = JSON.parse(raw); parsed[`constructor`];', errors: [error] },
    { code: 'const parsed = JSON.parse(raw); parsed[`safe-${suffix}`];', errors: [error] },
    { code: 'const parsed = JSON.parse(raw, null); parsed["constructor"];', errors: [error] },
    { code: 'const parsed = JSON.parse(raw, void 0); parsed["constructor"];', errors: [error] },
    { code: 'const parsed = JSON.parse(raw, undefined); parsed["constructor"];', errors: [error] },
    { code: 'const parsed = JSON.parse(raw, {}); parsed["constructor"];', errors: [error] },
    {
      code: 'const parsed = JSON.parse(raw, null, () => new Date()); parsed["constructor"];',
      errors: [error],
    },
    {
      code: 'const undefined = () => new Date(); const parsed = JSON.parse(raw, undefined); parsed["safe"];',
      errors: [error],
    },
    {
      code: 'const NaN = () => new Date(); const parsed = JSON.parse(raw, NaN); parsed["safe"];',
      errors: [error],
    },
    {
      code: 'const args = [raw, () => new Date()]; const parsed = JSON.parse(...args, null); parsed["getTime"];',
      errors: [error],
    },
    {
      code: 'const parsed = JSON.parse(raw); parsed["constructor"]["apply"];',
      errors: [error],
    },
    {
      code: 'const parsed = JSON.parse(raw, () => new Date()); parsed["getTime"];',
      errors: [error],
    },
    {
      code: 'const parsed = JSON.parse(raw, () => function callable() {}); parsed["call"];',
      errors: [error],
    },
    {
      code: 'const args = [raw, () => new Date()] as const; const parsed = JSON.parse(...args); parsed["getTime"];',
      errors: [error],
    },
    { code: 'const files = JSON["parse"](raw).files; files["constructor"];', errors: [error] },
    {
      code: 'const parsed = JSON.parse(raw) as Record<string, string>; const alias = parsed; alias[key];',
      errors: [error],
    },
    {
      code: 'const parsed = JSON.parse(raw); if (Object.hasOwn(other, key)) parsed[key];',
      errors: [error],
    },
    {
      code: 'const parsed = JSON.parse(raw); if (Object.hasOwn(parsed, otherKey)) parsed[key];',
      errors: [error],
    },
    {
      code: 'const parsed = JSON.parse(raw); parsed[key]; if (Object.hasOwn(parsed, key)) use(parsed);',
      errors: [error],
    },
    {
      code: 'const parsed = JSON.parse(raw); const key = "outer"; if (Object.hasOwn(parsed, key)) { const key = "inner"; parsed[key]; }',
      errors: [error],
    },
    {
      code: 'if (Object.hasOwn(JSON.parse(next()).files, key)) JSON.parse(next()).files[key];',
      errors: [error],
    },
    {
      code: 'const parsed = JSON.parse(raw); let key = "own"; if (Object.hasOwn(parsed, key)) { key = "constructor"; parsed[key]; }',
      errors: [error],
    },
    {
      code: 'const parsed = JSON.parse(raw); const key = "own"; Object.hasOwn(parsed, key) && delete parsed[key] && parsed[key];',
      errors: [error],
    },
    {
      code: 'const parsed = JSON.parse(raw); const key = "own"; if (Object.hasOwn(parsed, key)) { delete parsed[key]; parsed[key]; }',
      errors: [error],
    },
    {
      code: 'const parsed = JSON.parse(raw); const key = "own"; if (Object.hasOwn(parsed, key)) { mutate(parsed); parsed[key]; }',
      errors: [error],
    },
    {
      code: 'const parsed = JSON.parse(raw); const key = "own"; if (Object.hasOwn(parsed, key)) { const later = () => parsed[key]; later(); }',
      errors: [error],
    },
    {
      code: 'const parsed = JSON.parse(raw); Object.defineProperty(parsed, "files", { get: () => flip() ? { own: 1 } : Object.prototype }); const key = "own"; if (Object.hasOwn(parsed.files, key)) parsed.files[key];',
      errors: [error],
    },
    {
      code: 'const parsed = JSON.parse(raw); const key = "own"; do { parsed[key]; } while (Object.hasOwn(parsed, key));',
      errors: [error],
    },
    {
      code: 'const parsed = JSON.parse(raw); const Object = { hasOwn: () => true }; if (Object.hasOwn(parsed, key)) parsed[key];',
      errors: [error],
    },
    {
      code: 'function read(files: Record<string, string>, key: string) { return files[key]; }',
      options: [{ includeRecordParameters: true }],
      errors: [error],
    },
    {
      code: 'function read(files: Record<string, string>) { return files["fixed"]; }',
      options: [{ includeRecordParameters: true }],
      errors: [error],
    },
  ],
});
