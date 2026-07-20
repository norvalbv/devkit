import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

interface PackagedScriptOptions {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/** Run one of Devkit's packaged ship/review shell entrypoints with inherited stdio. */
export function runPackagedScript(
  scriptName: string,
  args: string[],
  { command, cwd, env }: PackagedScriptOptions,
): number {
  const script = fileURLToPath(new URL(`./${scriptName}`, import.meta.url));
  const result = spawnSync('bash', [script, ...args], { cwd, env, stdio: 'inherit' });
  if (result.error) {
    console.error(`${command}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}
