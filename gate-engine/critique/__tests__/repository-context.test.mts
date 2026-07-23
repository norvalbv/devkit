import { describe, expect, it } from 'vitest';
import { getPlanCritiqueRepositoryContext } from '../repository-context.mts';
import {
  commit,
  context,
  createRepository,
  git,
  withGitRace,
} from './repository-context-fixture.mts';

describe('plan critique repository context', () => {
  it('retries when branch and HEAD change during repository context sampling', () => {
    const repository = createRepository();
    git(repository, 'checkout', '-q', '-b', 'context-changed');
    commit(repository, 'changed branch tip');
    const changedHead = git(repository, 'rev-parse', 'HEAD');
    git(repository, 'checkout', '-q', 'main');

    const result = withGitRace(repository, 'first_status', () =>
      getPlanCritiqueRepositoryContext(repository),
    );
    expect(result).toMatchObject({
      status: 'available',
      context: { branch: 'context-changed', head: changedHead },
    });
  });

  it('strips origin credentials from the canonical repository fingerprint', () => {
    const credentialed = createRepository(
      'https://token-user:super-secret@example.com/Org/Repo.git',
    );
    const clean = createRepository('https://example.com/Org/Repo.git');
    const first = context(credentialed);
    const second = context(clean);
    expect(first.fingerprint).toBe(second.fingerprint);

    const scp = createRepository('git@host.example:/repo.git');
    const absolute = context(scp);
    git(scp, 'remote', 'set-url', 'origin', 'deploy@host.example:/repo.git');
    expect(context(scp).fingerprint).toBe(absolute.fingerprint);
    git(scp, 'remote', 'set-url', 'origin', 'ssh://git@host.example/repo.git');
    expect(context(scp).fingerprint).toBe(absolute.fingerprint);
    git(scp, 'remote', 'set-url', 'origin', 'ssh://git@host.example/absolute/repo.git');
    expect(context(scp).fingerprint).not.toBe(absolute.fingerprint);
    git(scp, 'remote', 'set-url', 'origin', 'git@host.example:repo.git');
    expect(context(scp).fingerprint).not.toBe(absolute.fingerprint);
  });

  it('keeps local path forms distinct from network origins', () => {
    const repository = createRepository('/srv/origin.git');
    const absolute = context(repository);
    git(repository, 'remote', 'set-url', 'origin', 'srv/origin.git');
    const relative = context(repository);
    git(repository, 'remote', 'set-url', 'origin', './srv/../srv/origin.git');
    const normalizedRelative = context(repository);

    expect(relative.fingerprint).not.toBe(absolute.fingerprint);
    expect(normalizedRelative.fingerprint).toBe(relative.fingerprint);
    git(repository, 'remote', 'set-url', 'origin', 'c:/srv/repo.git');
    const unixScp = context(repository, 'linux');
    git(repository, 'remote', 'set-url', 'origin', 'ssh://c/srv/repo.git');
    expect(context(repository, 'linux').fingerprint).toBe(unixScp.fingerprint);
    git(repository, 'remote', 'set-url', 'origin', 'C:\\srv\\repo.git');
    const windowsDrive = context(repository, 'win32');
    git(repository, 'remote', 'set-url', 'origin', 'git@c:srv/repo.git');
    expect(context(repository, 'win32').fingerprint).not.toBe(windowsDrive.fingerprint);
    git(repository, 'remote', 'set-url', 'origin', '\\\\server\\share\\repo.git');
    const windowsUnc = context(repository, 'win32');
    git(repository, 'remote', 'set-url', 'origin', 'git@server:share/repo.git');
    expect(context(repository, 'win32').fingerprint).not.toBe(windowsUnc.fingerprint);
  });

  it('falls back to the local Git path when origin is configured as an empty value', () => {
    const repository = createRepository();
    const local = context(repository);
    git(repository, 'config', 'remote.origin.url', '');
    expect(context(repository)).toMatchObject({
      fingerprint: local.fingerprint,
      fingerprintSource: 'local_path',
    });
  });
});
