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
import { detectGitRoot } from './detect-git-root.mjs';
import { packageDir, readJson, writeIfAbsent } from './fs-helpers.mjs';
import { buildOverlayHook, buildPassthroughHook } from './husky-block.mjs';

const firstLine = (e) => (e.stderr || e.message || '').toString().trim().split('\n')[0];
const LOCAL_HOOKS = '.devkit/hooks';
// husky sets core.hooksPath to `.husky/_`; the real committed script is the parent's hook.
const HUSKY_UNDERSCORE_RE = /\/_$/;
const EXCLUDE_HEADER = '# devkit overlay (local-only) — not committed';

// Append paths to .git/info/exclude (per-clone, uncommitted), skipping any already present.
// `gitRoot` is the dir that holds `.git` — NOT necessarily cwd (a monorepo package is a subdir).
function addToGitExclude(gitRoot, relPaths, dryRun) {
  const infoDir = join(gitRoot, '.git', 'info');
  const file = join(infoDir, 'exclude');
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
  mkdirSync(infoDir, { recursive: true }); // a fresh/odd clone may lack .git/info
  writeFileSync(file, `${existing}${sep}${header}${missing.join('\n')}\n`);
  console.log(`  ✓ git-ignored locally (.git/info/exclude): ${missing.join(', ')}`);
}

// Standard git hook names — used to pick the repo's real hooks out of a hooks dir (ignoring
// husky internals / .sample files / stray entries).
const GIT_HOOKS = new Set([
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'post-rewrite',
  'post-update',
  'pre-auto-gc',
]);

// The raw core.hooksPath (the repo's CURRENT hooks setting), '' if unset. Captured BEFORE we
// override it so `devkit clean` can restore exactly what was there.
function readHooksPath(gitRoot) {
  try {
    return execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd: gitRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

// The TRUE original core.hooksPath to record (so `devkit clean` restores it). CRITICAL: if a
// prior overlay is already in place (current === .devkit/hooks), recording that would make clean
// restore a value devkit itself deleted — so recover the real original from the prior overlay's
// config, else detect husky (.husky/_), else '' (unset). This makes re-running overlay idempotent.
function captureOrigHooksPath(gitRoot, cwd) {
  const current = readHooksPath(gitRoot);
  if (current && current !== LOCAL_HOOKS) return current;
  const prev = readJson(join(cwd, '.devkit', 'config.json'));
  if (prev && typeof prev.origHooksPath === 'string') return prev.origHooksPath;
  return existsSync(join(gitRoot, '.husky', '_')) ? '.husky/_' : '';
}

// Where the repo's hook SCRIPTS live (git-root-relative). husky's .husky/_ → the scripts are the
// parent's .husky/<hook>; a custom hooksPath holds them directly; unset → .git/hooks.
function hookScriptDir(origHooksPath) {
  if (origHooksPath && origHooksPath !== LOCAL_HOOKS) {
    return origHooksPath.replace(HUSKY_UNDERSCORE_RE, '');
  }
  return '.git/hooks';
}

// The repo's existing hooks (names) in `scriptDir` — what we must keep running when we take over
// core.hooksPath.
function detectExistingHooks(gitRoot, scriptDir) {
  const abs = join(gitRoot, scriptDir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).filter((f) => GIT_HOOKS.has(f));
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

// Take over core.hooksPath (at the GIT ROOT — repo-wide) and write our hooks dir. CRITICAL: git
// then runs ONLY our dir, so we wrap EVERY hook the repo already had (pre-push, commit-msg, …) as
// a pass-through, or they'd silently stop. pre-commit additionally runs devkit's gates (cd'd into
// the package for a monorepo) before chaining to the repo's pre-commit.
function installOverlayHook(gitRoot, pkgRel, sel, origHooksPath, dryRun) {
  const scriptDir = hookScriptDir(origHooksPath);
  const existing = detectExistingHooks(gitRoot, scriptDir);
  const preCommitChain = existing.includes('pre-commit') ? `${scriptDir}/pre-commit` : '';
  const passthrough = existing.filter((h) => h !== 'pre-commit');
  if (dryRun) {
    console.log(
      `  [dry-run] git config core.hooksPath ${LOCAL_HOOKS}; pre-commit (gates${preCommitChain ? ` → ${preCommitChain}` : ''})${passthrough.length ? `; pass-through: ${passthrough.join(', ')}` : ''}`,
    );
    return;
  }
  const dir = join(gitRoot, LOCAL_HOOKS);
  mkdirSync(dir, { recursive: true });
  // pre-commit: devkit gates + chain to the repo's pre-commit (if any).
  const pre = join(dir, 'pre-commit');
  writeFileSync(pre, buildOverlayHook(sel, preCommitChain, pkgRel));
  chmodSync(pre, 0o755);
  // every OTHER existing hook → pass-through wrapper so it keeps running unchanged.
  for (const h of passthrough) {
    const p = join(dir, h);
    writeFileSync(p, buildPassthroughHook(`${scriptDir}/${h}`));
    chmodSync(p, 0o755);
  }
  try {
    execFileSync('git', ['config', 'core.hooksPath', LOCAL_HOOKS], { cwd: gitRoot });
    const extra = passthrough.length ? ` (+ pass-through: ${passthrough.join(', ')})` : '';
    console.log(
      `  ✓ core.hooksPath → ${LOCAL_HOOKS} (local) — pre-commit + your hooks preserved${extra}`,
    );
  } catch (e) {
    console.log(`  ! could not set core.hooksPath: ${firstLine(e)}`);
  }
}

/**
 * Install the overlay. Returns { chainTarget, origHooksPath } (recorded in config so `devkit
 * clean` can restore the original core.hooksPath exactly).
 * @param {string} cwd repo (or package) dir
 * @param {{guards?:string[], biome?:boolean, tsconfig?:boolean}} sel
 * @param {string} stack
 */
export function installOverlay(cwd, sel, stack, force, dryRun) {
  // Configs/baselines live in cwd (the package); the hook + git-exclude target the GIT ROOT
  // (a monorepo package is a subdir, so .git is above cwd — this was the .git/info ENOENT).
  const { gitRoot, pkgRel } = detectGitRoot(cwd);
  // The real original hooksPath (never our own .devkit/hooks) — recorded for restore on clean.
  const origHooksPath = captureOrigHooksPath(gitRoot, cwd);
  const pfx = pkgRel ? `${pkgRel}/` : '';
  const excludes = new Set([
    `${LOCAL_HOOKS}/`, // .devkit/hooks at the git root
    `${pfx}.devkit/`, // the package's .devkit (config + vendored biome)
    `${pfx}guard.config.json`,
    `${pfx}eslint/baselines/`,
  ]);
  if (pkgRel) console.log(`  monorepo: package "${pkgRel}" — hook + git-ignore at the git root`);

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

  // ours-extends-theirs lint overlays, in the package.
  console.log('  lint overlays (extend the repo config)');
  if (sel.biome && writeBiomeOverlay(cwd, stack, force, dryRun)) {
    excludes.add(`${pfx}biome.devkit.jsonc`);
  }
  if (writeEslintOverlay(cwd, force, dryRun)) excludes.add(`${pfx}eslint.config.devkit.mjs`);

  // local hook (core.hooksPath override) at the git root + chain + pass-through of all hooks.
  console.log('  local hook');
  installOverlayHook(gitRoot, pkgRel, sel, origHooksPath, dryRun);

  // make it all invisible to git (the git root's .git/info/exclude).
  console.log('  git-ignore (local)');
  addToGitExclude(gitRoot, [...excludes], dryRun);

  // origHooksPath ('' = was unset) lets `devkit clean` restore exactly what was there.
  return { origHooksPath };
}
