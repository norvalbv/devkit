import { RuleTester } from 'oxlint/plugins-dev';
import { describe, it } from 'vitest';
import { noUnsafeExternalRecordEnumerationRule } from '../src/devkit/rules/no-unsafe-external-record-enumeration.ts';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } });
const error = { messageId: 'unsafeEnumeration' };

tester.run(
  'anti-slop/no-unsafe-external-record-enumeration',
  noUnsafeExternalRecordEnumerationRule,
  {
    valid: [
      'const files = { a: 1 }; Object.entries(files);',
      'const JSON = { parse: () => ({}) }; const files = JSON.parse(raw); Object.entries(files);',
      'const parsed = JSON.parse(raw); const Object = { entries: () => [] }; Object.entries(parsed);',
      'const parsed = JSON.parse(raw); if (Object(parsed) === parsed && !Array.isArray(parsed)) Object.entries(parsed);',
      'const parsed = JSON.parse(raw); if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) Object.entries(parsed);',
      'const parsed = JSON.parse(raw, (_key, value) => value); if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) Object.entries(parsed);',
      'const parsed = JSON.parse(raw); if (typeof parsed === "object" && mutate(parsed) && typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) Object.entries(parsed);',
      'const parsed = JSON["parse"](raw); if (Object(parsed) === parsed && !Array["isArray"](parsed)) Object["entries"](parsed);',
      'const parsed = JSON.parse(raw); if (Object(parsed) !== parsed || Array.isArray(parsed)) reject(); else Object.entries(parsed);',
      'const parsed = JSON.parse(raw); if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) reject(); else Object.entries(parsed);',
      'function read(raw: string) { const parsed = JSON.parse(raw); if (Object(parsed) !== parsed || Array.isArray(parsed)) throw new Error(); return Object.keys(parsed); }',
      'function read(raw: string) { const parsed = JSON.parse(raw); if (typeof parsed !== "object") return []; if (parsed === null) return []; if (Array.isArray(parsed)) return []; return Object.entries(parsed); }',
      'function read(raw: string) { const parsed = JSON.parse(raw); if (Object(parsed) !== parsed) return []; if (Array.isArray(parsed)) return []; return Object.entries(parsed); }',
      'function read(raw: string) { const parsed = JSON.parse(raw); if (typeof parsed !== "object") return []; mutate(parsed); if (typeof parsed !== "object") return []; if (parsed === null) return []; if (Array.isArray(parsed)) return []; return Object.entries(parsed); }',
      'function read(raw: string) { const parsed = JSON.parse(raw); if (typeof parsed !== "object") { mutate(parsed); return []; } if (parsed === null) return []; if (Array.isArray(parsed)) return []; return Object.entries(parsed); }',
      'function read(raw: string, ready: boolean) { const parsed = JSON.parse(raw); if (Object(parsed) !== parsed) return []; if (ready) { if (Array.isArray(parsed)) return []; return Object.entries(parsed); } return []; }',
      'function read(raw: string) { const parsed = JSON.parse(raw); for (; Object(parsed) === parsed && !Array.isArray(parsed); ) { Object.keys(parsed); break; } }',
    ],
    invalid: [
      { code: 'Object.entries(JSON.parse(raw));', errors: [error] },
      { code: 'Object.entries(JSON.parse(raw, (_key, value) => value));', errors: [error] },
      {
        code: 'const parsed = JSON.parse(raw, () => function callable() {}); if (Object(parsed) === parsed && !Array.isArray(parsed)) Object.entries(parsed);',
        errors: [error],
      },
      { code: 'Object["entries"](JSON["parse"](raw));', errors: [error] },
      {
        code: 'const parsed = JSON.parse(raw); const files = parsed.files; Object.keys(files);',
        errors: [error],
      },
      {
        code: 'function read(raw: string) { const parsed = JSON.parse(raw); if (!parsed || Array.isArray(parsed)) throw new Error(); return Object.entries(parsed); }',
        errors: [error],
      },
      {
        code: 'const parsed = JSON.parse(raw); if (typeof parsed === "object" && !Array.isArray(parsed)) Object.entries(parsed);',
        errors: [error],
      },
      {
        code: 'const parsed = JSON.parse(raw); if (parsed !== null && !Array.isArray(parsed)) Object.entries(parsed);',
        errors: [error],
      },
      {
        code: 'const parsed = JSON.parse(raw); if (typeof parsed === "object" && parsed !== null) Object.entries(parsed);',
        errors: [error],
      },
      {
        code: 'const parsed = JSON.parse(raw); if (typeof parsed === "object" && mutate(parsed) && parsed !== null && !Array.isArray(parsed)) Object.entries(parsed);',
        errors: [error],
      },
      {
        code: 'const parsed = JSON.parse(raw); if (typeof parsed !== "object" || mutate(parsed) || parsed === null || Array.isArray(parsed)) reject(); else Object.entries(parsed);',
        errors: [error],
      },
      {
        code: 'function read() { const parsed = JSON.parse(raw); const other = JSON.parse(raw); if (Object(other) !== other || Array.isArray(other)) return; Object.entries(parsed); }',
        errors: [error],
      },
      {
        code: 'const parsed = JSON.parse(raw); Object.keys(parsed); if (Object(parsed) !== parsed || Array.isArray(parsed)) reject();',
        errors: [error],
      },
      {
        code: 'const parsed = JSON.parse(raw); const Array = { isArray: () => false }; if (Object(parsed) === parsed && !Array.isArray(parsed)) Object.entries(parsed);',
        errors: [error],
      },
      {
        code: 'const parsed = JSON.parse(raw); if (Object(parsed.files) === parsed.files && !Array.isArray(parsed.files) && (parsed.files = [], true)) Object.keys(parsed.files);',
        errors: [error],
      },
      {
        code: 'if (Object(JSON.parse(next())) === JSON.parse(next()) && !Array.isArray(JSON.parse(next()))) Object.entries(JSON.parse(next()));',
        errors: [error],
      },
      {
        code: 'function read(raw: string) { const parsed = JSON.parse(raw); if (typeof parsed !== "object") return []; mutate(parsed); if (parsed === null) return []; if (Array.isArray(parsed)) return []; return Object.entries(parsed); }',
        errors: [error],
      },
      {
        code: 'function read(raw: string) { const parsed = JSON.parse(raw); if (typeof parsed !== "object") return []; if (parsed === null) return []; if (Array.isArray(parsed)) return []; mutate(parsed); return Object.entries(parsed); }',
        errors: [error],
      },
      {
        code: 'function read(raw: string) { const parsed = JSON.parse(raw); if (typeof parsed !== "object" || mutate(parsed)) return []; if (parsed === null) return []; if (Array.isArray(parsed)) return []; return Object.entries(parsed); }',
        errors: [error],
      },
      {
        code: 'function read(raw: string) { const parsed = JSON.parse(raw); if (typeof parsed !== "object") return []; sideEffect.value; if (parsed === null) return []; if (Array.isArray(parsed)) return []; return Object.entries(parsed); }',
        errors: [error],
      },
      {
        code: 'function read(raw: string) { const parsed = JSON.parse(raw); if (typeof parsed !== "object") return []; if (parsed === null) return []; if (Array.isArray(parsed)) return []; sideEffect.value = parsed; return Object.entries(parsed); }',
        errors: [error],
      },
    ],
  },
);
