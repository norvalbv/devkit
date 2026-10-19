// A confined codex judge's filesystem: read everywhere, write only its scratch cwd, the temp dirs
// and the one checklist state file the gate reads back. Never `.claude/` as a whole (settings, hooks).
const PROFILE = 'devkit_judge';

/** The judge's writable paths, both absolute and symlink-free (codex refuses symlinked roots). */
export interface CodexWritablePaths {
  scratch: string;
  stateFile?: string;
}

/** `-c` overrides selecting the profile. `--sandbox` must not ride along: it silently wins. */
export function codexPermissionArgs({ scratch, stateFile }: CodexWritablePaths): string[] {
  const writable = [':tmpdir', ':slash_tmp', scratch, ...(stateFile ? [stateFile] : [])];
  const entries = [`":root"="read"`, ...writable.map((p) => `${JSON.stringify(p)}="write"`)];
  return [
    '-c',
    `default_permissions="${PROFILE}"`,
    '-c',
    `permissions.${PROFILE}.filesystem={${entries.join(',')}}`,
  ];
}
