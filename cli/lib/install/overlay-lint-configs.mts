/** The ours-extends-theirs lint configs an overlay writes beside the repo's own (git-ignored). */

import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageDir } from '../fs-helpers.mts';

// Detect the repo's flat eslint config to extend (overlay only supports flat ESM/JS configs).
function repoEslintConfig(cwd: string) {
  for (const f of ['eslint.config.mjs', 'eslint.config.js']) {
    if (existsSync(join(cwd, f))) return f;
  }
  return null;
}

export function writeEslintOverlay(cwd: string, force: boolean, dryRun: boolean) {
  const repo = repoEslintConfig(cwd);
  if (!repo) {
    console.log('  • no flat eslint.config.{mjs,js} found — skipping eslint overlay');
    return false;
  }
  const dest = join(cwd, 'eslint.config.devkit.mjs');
  const content = `// devkit OVERLAY eslint config (LOCAL, git-ignored) — extends the repo's own config and
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
  if (dryRun) {
    console.log(`  [dry-run] write eslint.config.devkit.mjs (extends ./${repo} + size caps)`);
    return true;
  }
  if (existsSync(dest) && !force) {
    console.log('  • eslint.config.devkit.mjs exists (use --force to refresh)');
    return true;
  }
  writeFileSync(dest, content);
  console.log(`  ✓ wrote eslint.config.devkit.mjs (extends ./${repo} + size caps)`);
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
