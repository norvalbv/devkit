/** A committed repository with an origin remote-tracking ref, shared by the repository-state suites. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RepositoryFixture {
  env: NodeJS.ProcessEnv;
  parent: string;
  root: string;
  manifest: string;
  git: (...args: string[]) => string;
}

export function repositoryStateFixture(
  mkTmp: (prefix: string) => string,
  name = 'devkit-review-repository-state-',
): RepositoryFixture {
  const parent = mkTmp(name);
  const root = join(parent, 'target');
  const home = join(parent, 'home');
  mkdirSync(root);
  mkdirSync(home);
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
  };
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Repository State Test');
  git('config', 'user.email', 'repository-state@test.invalid');
  writeFileSync(join(root, 'tracked.txt'), 'base\n');
  git('add', 'tracked.txt');
  git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git('config', 'branch.main.remote', 'origin');
  git('config', 'branch.main.merge', 'refs/heads/main');
  git('config', 'remote.origin.url', 'https://example.invalid/owner/repository.git');
  return { env, parent, root, manifest: join(parent, 'repository-state.json'), git };
}
