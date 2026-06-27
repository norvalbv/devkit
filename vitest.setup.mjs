// Git exports control vars (GIT_DIR, GIT_WORK_TREE, …) into every hook's environment. devkit's
// git-integration tests spawn `git init` / commits in throwaway temp repos via the INHERITED env;
// an inherited GIT_DIR makes those gits operate on devkit's OWN .git instead of the temp repo —
// and under parallel vitest workers that races on .git/config.lock and corrupts the repo (flips
// core.bare, leaks the test identity). That is why `bun run test:run` is safe run directly but was
// NOT under a git hook (a `devkit ship` worktree commit or a push), where the hook had set GIT_DIR.
//
// Stripping the repo-location vars here — setupFiles runs per worker BEFORE any test module loads,
// so even a top-level `{...process.env}` captures the cleaned env — makes every spawned git resolve
// its repo from cwd, as the tests intend, regardless of how the suite was launched.
for (const k of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
]) {
  delete process.env[k];
}
