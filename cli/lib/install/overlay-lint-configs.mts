/** The ours-extends-theirs lint configs an overlay writes beside the repo's own (git-ignored). The
 * eslint caps never widen what the repo lints or loosen its rules (overlay-self-heal). */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { packageDir } from '../fs-helpers.mts';

export const ESLINT_OVERLAY_FILE = 'eslint.config.devkit.mjs';
const REPO_CONFIGS = ['eslint.config.mjs', 'eslint.config.js'];

/** The repo's flat eslint config to extend (overlay supports flat ESM/JS configs only). */
export function repoEslintConfig(cwd: string) {
  for (const f of REPO_CONFIGS) {
    if (existsSync(join(cwd, f))) return f;
  }
  return null;
}

/** The overlay config devkit writes today, extending `./${repo}`. */
export function eslintOverlayContent(repo: string) {
  return `// devkit OVERLAY eslint config (LOCAL, git-ignored) — extends the repo's own config and adds
// devkit's size caps ONLY for rules the repo leaves unset, ONLY on files the repo's config scopes, so
// they never widen what the repo lints. The overlay hook runs THIS over staged files.
import repoConfig from './${repo}';

const resolved = await repoConfig;
const base = Array.isArray(resolved) ? resolved : [resolved];

const CAPS = {
  'max-lines': ['error', { max: 500, skipBlankLines: false, skipComments: false }],
  'max-lines-per-function': [
    'error',
    { max: 300, skipBlankLines: false, skipComments: false, IIFEs: true },
  ],
};
const repoSets = (rule) =>
  base.some((c) => c && typeof c.rules === 'object' && c.rules && Object.hasOwn(c.rules, rule));
const rules = Object.fromEntries(Object.entries(CAPS).filter(([rule]) => !repoSets(rule)));
// When every repo object is scoped (files, or ignores-only), cap each object's own files and ignores:
// ESLint's defaults also match **/*.js the repo never configured. A global repo object needs no scope.
const TESTS = '**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}';
const ignoresOnly = (c) =>
  'ignores' in c && Object.keys(c).every((k) => ['ignores', 'name', 'basePath'].includes(k));
const scopedObjects = base.filter((c) => c && c.files);
const scoped =
  scopedObjects.length > 0 && base.every((c) => !c || c.files || ignoresOnly(c));
const caps = scoped
  ? scopedObjects.map(({ basePath, files, ignores = [] }) => ({
      ...(basePath ? { basePath } : {}),
      files,
      ignores: [...ignores, TESTS],
      rules,
    }))
  : [{ ignores: [TESTS], rules }];

export default [
  ...(Object.keys(rules).length > 0 ? caps : []),
  ...base,
];
`;
}

// The exact bytes earlier devkit versions wrote: a byte-identical file is devkit's stale output, safe
// to refresh; anything else is the consumer's and is preserved.
export function legacyEslintOverlayContent(repo: string) {
  return `// devkit OVERLAY eslint config (LOCAL, git-ignored) — extends the repo's own config and
// adds devkit's built-in size caps (no plugin). The overlay hook runs THIS over staged files.
import repoConfig from './${repo}';

const base = Array.isArray(repoConfig) ? repoConfig : [repoConfig];

export default [
  ...base,
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    ignores: ['**/*.{test,spec}.{ts,tsx,js,jsx}'],
    rules: {
      'max-lines': ['error', { max: 500, skipBlankLines: false, skipComments: false }],
      'max-lines-per-function': [
        'error',
        { max: 300, skipBlankLines: false, skipComments: false, IIFEs: true },
      ],
    },
  },
];
`;
}

// Any template devkit has written, for either repo config name — including a current template that
// still imports a renamed-away `eslint.config.mjs`.
function isDevkitWrittenOverlay(existing: string) {
  return REPO_CONFIGS.some(
    (repo) =>
      existing === legacyEslintOverlayContent(repo) || existing === eslintOverlayContent(repo),
  );
}

// What init/upgrade report for an overlay that already existed (and was left untouched).
function existingOverlayStatus(dest: string, content: string) {
  let existing: string;
  try {
    existing = readFileSync(dest, 'utf8');
  } catch {
    return `! ${ESLINT_OVERLAY_FILE} is unreadable (a broken link?) — delete it and re-run`;
  }
  if (existing === content) return `• ${ESLINT_OVERLAY_FILE} is current`;
  if (isDevkitWrittenOverlay(existing))
    return `! ${ESLINT_OVERLAY_FILE} is an outdated devkit template — delete it and re-run`;
  return `• ${ESLINT_OVERLAY_FILE} exists (use --force to refresh)`;
}

/** Write the overlay config if absent (or with --force); false when the repo has no flat config. */
export function writeEslintOverlay(cwd: string, force: boolean, dryRun: boolean) {
  const repo = repoEslintConfig(cwd);
  if (!repo) {
    console.log('  • no flat eslint.config.{mjs,js} found — skipping eslint overlay');
    return false;
  }
  const dest = join(cwd, ESLINT_OVERLAY_FILE);
  const content = eslintOverlayContent(repo);
  if (dryRun) {
    console.log(`  [dry-run] write ${ESLINT_OVERLAY_FILE} (extends ./${repo} + size caps)`);
    return true;
  }
  // Exclusive create unless --force: an existing file is never overwritten, even one appearing now.
  try {
    writeFileSync(dest, content, force ? {} : { flag: 'wx' });
  } catch (e) {
    if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) throw e;
    console.log(`  ${existingOverlayStatus(dest, content)}`);
    return true;
  }
  console.log(`  ✓ wrote ${ESLINT_OVERLAY_FILE} (extends ./${repo} + size caps)`);
  return true;
}

export function writeBiomeOverlay(cwd: string, stack: string, force: boolean, dryRun: boolean) {
  if (!existsSync(join(cwd, 'biome.jsonc')) && !existsSync(join(cwd, 'biome.json'))) {
    console.log('  • no repo biome config — skipping biome overlay');
    return false;
  }
  const repoBiome = existsSync(join(cwd, 'biome.jsonc')) ? './biome.jsonc' : './biome.json';
  const variant = ['electron', 'react-app', 'next'].includes(stack) ? 'react' : 'base';
  if (dryRun) {
    console.log('  [dry-run] vendor biome base + write biome.devkit.jsonc (extends repo biome)');
    return true;
  }
  // Vendor devkit's biome bases so the overlay can extend them by relative path (no package).
  const destDir = join(cwd, '.devkit', 'biome');
  mkdirSync(destDir, { recursive: true });
  for (const f of readdirSync(join(packageDir(), 'biome'))) {
    copyFileSync(join(packageDir(), 'biome', f), join(destDir, f));
  }
  const content = `${JSON.stringify(
    { extends: [repoBiome, `./.devkit/biome/${variant}.jsonc`] },
    null,
    2,
  )}\n`;
  const dest = join(cwd, 'biome.devkit.jsonc');
  if (existsSync(dest) && !force) {
    console.log('  • biome.devkit.jsonc exists (use --force to refresh)');
    return true;
  }
  writeFileSync(dest, content);
  console.log(`  ✓ wrote biome.devkit.jsonc (extends ${repoBiome} + devkit ${variant})`);
  return true;
}
