/**
 * Overlay (local-only) install — use devkit on a repo you CAN'T modify (a shared work repo
 * whose team wouldn't accept a devkit PR). Everything is INVISIBLE to git and NON-INVASIVE:
 *
 *   - every devkit file is added to `.git/info/exclude` (per-clone, uncommitted) — never to
 *     `.gitignore` (which the team would review). `git status` stays clean.
 *   - the repo's committed pre-commit (husky) is NOT edited. Instead `core.hooksPath` (a LOCAL
 *     git config, never committed) points at a git-ignored `.devkit/hooks/` whose hook runs
 *     devkit's gates then `exec`s the repo's own hook unchanged.
 *   - eslint/biome run LOCAL configs that EXTEND the repo's committed ones (ours-extends-theirs)
 *     over STAGED files only — your new changes are checked without flooding on existing code.
 *   - package.json is untouched.
 *
 * Caveat: husky's `prepare` re-claims `core.hooksPath` on the next `bun install`; re-run
 * `devkit init --overlay` to re-apply (idempotent).
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { packageDir, writeIfAbsent } from './fs-helpers.mjs';
import { buildOverlayHook } from './husky-block.mjs';

const firstLine = (e) => (e.stderr || e.message || '').toString().trim().split('\n')[0];
const LOCAL_HOOKS = '.devkit/hooks';
// husky sets core.hooksPath to `.husky/_`; the real committed script is the parent's hook.
const HUSKY_UNDERSCORE_RE = /\/_$/;
const EXCLUDE_HEADER = '# devkit overlay (local-only) — not committed';

// Append paths to .git/info/exclude (per-clone, uncommitted), skipping any already present.
function addToGitExclude(gitRoot, relPaths, dryRun) {
  const file = join(gitRoot, '.git', 'info', 'exclude');
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = existing.split('\n');
  const missing = relPaths.filter((p) => !lines.includes(p));
  if (!missing.length) {
    console.log('  • .git/info/exclude already covers devkit files');
    return;
  }
  if (dryRun) {
    console.log(`  [dry-run] add to .git/info/exclude: ${missing.join(', ')}`);
    return;
  }
  const header = existing.includes(EXCLUDE_HEADER) ? '' : `\n${EXCLUDE_HEADER}\n`;
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  writeFileSync(file, `${existing}${sep}${header}${missing.join('\n')}\n`);
  console.log(`  ✓ git-ignored locally (.git/info/exclude): ${missing.join(', ')}`);
}

// The repo's existing committed hook to chain to. husky sets core.hooksPath=.husky/_ → the real
// script is .husky/pre-commit. Falls back to .husky/pre-commit, then .git/hooks/pre-commit.
function detectChainTarget(gitRoot) {
  let hp = '';
  try {
    hp = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd: gitRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    // unset
  }
  if (hp && hp !== LOCAL_HOOKS) return `${hp.replace(HUSKY_UNDERSCORE_RE, '')}/pre-commit`;
  if (existsSync(join(gitRoot, '.husky', 'pre-commit'))) return '.husky/pre-commit';
  return '.git/hooks/pre-commit';
}

// Detect the repo's flat eslint config to extend (overlay only supports flat ESM/JS configs).
function repoEslintConfig(cwd) {
  for (const f of ['eslint.config.mjs', 'eslint.config.js']) {
    if (existsSync(join(cwd, f))) return f;
  }
  return null;
}

function writeEslintOverlay(cwd, force, dryRun) {
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

function writeBiomeOverlay(cwd, stack, force, dryRun) {
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

// Point core.hooksPath at the local hooks dir + write the overlay hook that chains to the repo's.
function installOverlayHook(gitRoot, sel, chainTarget, dryRun) {
  if (dryRun) {
    console.log(
      `  [dry-run] git config core.hooksPath ${LOCAL_HOOKS} + write ${LOCAL_HOOKS}/pre-commit (chains → ${chainTarget})`,
    );
    return;
  }
  const dir = join(gitRoot, LOCAL_HOOKS);
  mkdirSync(dir, { recursive: true });
  const hookPath = join(dir, 'pre-commit');
  writeFileSync(hookPath, buildOverlayHook(sel, chainTarget));
  chmodSync(hookPath, 0o755);
  try {
    execFileSync('git', ['config', 'core.hooksPath', LOCAL_HOOKS], { cwd: gitRoot });
    console.log(`  ✓ core.hooksPath → ${LOCAL_HOOKS} (local config) — chains to ${chainTarget}`);
  } catch (e) {
    console.log(`  ! could not set core.hooksPath: ${firstLine(e)}`);
  }
}

/**
 * Install the overlay. Returns the chainTarget (recorded in config for re-apply/restore).
 * @param {string} cwd repo root
 * @param {{guards?:string[], biome?:boolean, tsconfig?:boolean}} sel
 * @param {string} stack
 */
export function installOverlay(cwd, sel, stack, force, dryRun) {
  const chainTarget = detectChainTarget(cwd);
  const excludes = ['.devkit/', 'guard.config.json', 'eslint/baselines/'];

  // guard.config.json (data) — generic template.
  console.log('  guard.config.json');
  if (sel.guards?.length) {
    const src = join(packageDir(), 'templates', 'generic', 'guard.config.json');
    if (dryRun) {
      console.log('  [dry-run] write guard.config.json');
    } else {
      writeIfAbsent(join(cwd, 'guard.config.json'), readFileSync(src, 'utf8'), { force });
      console.log('  ✓ guard.config.json');
    }
  }

  // ours-extends-theirs lint overlays.
  console.log('  lint overlays (extend the repo config)');
  if (sel.biome && writeBiomeOverlay(cwd, stack, force, dryRun))
    excludes.push('biome.devkit.jsonc');
  if (writeEslintOverlay(cwd, force, dryRun)) excludes.push('eslint.config.devkit.mjs');

  // local hook (core.hooksPath override) + chain.
  console.log('  local hook');
  installOverlayHook(cwd, sel, chainTarget, dryRun);

  // make it all invisible to git.
  console.log('  git-ignore (local)');
  addToGitExclude(cwd, excludes, dryRun);

  return chainTarget;
}
