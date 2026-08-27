import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkLockPin, checkPin } from './pin-checks.mts';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(() => '') }));

// Verbatim `git ls-remote --tags --heads https://github.com/norvalbv/devkit.git` shape: an ANNOTATED
// tag emits the tag object AND its `^{}` peel, a LIGHTWEIGHT tag emits one line holding the commit.
const LS = [
  '4a6d1c0eb1a9e2f7c0d9e8a7b6c5d4e3f2a1b0c9\trefs/heads/main',
  '3084b2586833143d64b79c273d088f783d06b35f\trefs/tags/v0.1.0',
  'ded0c1200000000000000000000000000000beef\trefs/tags/v0.46.0',
  '1218715000000000000000000000000000000dad\trefs/tags/v0.46.0^{}',
  'c68a526896503af8ae7fd3a580fed57336edf909\trefs/tags/v0.47.1',
  '4f8bc48223b6eae26a36d4fca828b75a8f11336d\trefs/tags/v0.47.1^{}',
].join('\n');

const HTTPS_PIN = 'git+https://github.com/norvalbv/devkit.git#v0.47.1';
const SSH_PIN = 'git+ssh://git@github.com/norvalbv/devkit.git#v0.47.1';

/** Real bun.lock text: trailing commas (so JSON.parse would throw), workspaces AND packages blocks. */
function lockText(o: { requested?: string; resolutions?: string[]; extra?: string }): string {
  const req = o.requested ?? HTTPS_PIN;
  const pkgs = (o.resolutions ?? [`@norvalbv/devkit@github:norvalbv/devkit#c68a526`])
    .map(
      (r) =>
        `    "@norvalbv/devkit": ["${r}", { "optionalDependencies": { "jscpd": "^4.2.4" } }, "norvalbv-devkit"],`,
    )
    .join('\n');
  return `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "consumer",
      "dependencies": {
        "@norvalbv/devkit": "${req}",
      },
    },
  },
  "packages": {
${pkgs}
${o.extra ?? ''}
  },
}
`;
}

let dir: string;
const mocked = vi.mocked(execFileSync);

function repo(o: { pin?: string | null; lock?: string | null; pkgExtra?: object } = {}): string {
  const pkg: Record<string, unknown> = { name: 'consumer', version: '1.0.0', ...o.pkgExtra };
  if (o.pin !== null) pkg.devDependencies = { '@norvalbv/devkit': o.pin ?? HTTPS_PIN };
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  if (o.lock !== null) writeFileSync(join(dir, 'bun.lock'), o.lock ?? lockText({}));
  return dir;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'devkit-pin-checks-'));
  mocked.mockReset();
  mocked.mockReturnValue(LS);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('checkPin', () => {
  it('reports a #v tag pin as OK and a branch pin as DRIFT', () => {
    expect(checkPin(repo()).status).toBe('OK');
    expect(checkPin(repo({ pin: 'git+https://github.com/norvalbv/devkit.git#main' })).status).toBe(
      'DRIFT',
    );
    expect(checkPin(repo({ pin: null })).status).toBe('MISSING');
  });
});

// Skipping is the safety property: any non-OK result exits doctor 1, so anything ambiguous must
// return null AND must not have paid for a network call to decide that.
describe('checkLockPin — skips without touching the network', () => {
  const skips: [string, () => string][] = [
    ['no bun.lock at all', () => repo({ lock: null })],
    [
      'bun.lockb (binary) instead — only the text lockfile is readable',
      () => {
        const d = repo({ lock: null });
        writeFileSync(join(d, 'bun.lockb'), Buffer.from([0x62, 0x75, 0x6e, 0x00, 0x01]));
        return d;
      },
    ],
    ['devkit is not a dependency', () => repo({ pin: null })],
    ['pin is a branch, not a #v tag', () => repo({ pin: 'git+https://x/devkit.git#main' })],
    [
      'lockfile requested range disagrees with package.json (stale lock)',
      () => repo({ lock: lockText({ requested: 'git+https://github.com/n/devkit.git#main' }) }),
    ],
    [
      'no packages entry — only the workspaces requested-range line',
      () => repo({ lock: lockText({ resolutions: [] }) }),
    ],
    [
      'resolution is a local link, not a git SHA',
      () => repo({ lock: lockText({ resolutions: ['@norvalbv/devkit@link:../devkit'] }) }),
    ],
    [
      'two recorded resolutions disagree',
      () =>
        repo({
          lock: lockText({
            resolutions: [
              '@norvalbv/devkit@github:norvalbv/devkit#c68a526',
              '@norvalbv/devkit@github:norvalbv/devkit#3084b25',
            ],
          }),
        }),
    ],
    [
      'package.json redirects devkit via overrides',
      () => repo({ pkgExtra: { overrides: { '@norvalbv/devkit': 'link:../devkit' } } }),
    ],
    [
      // Must reach the scheme guard, so the lockfile has to agree with the pin — otherwise this
      // would skip one gate earlier and pass without ever exercising the transport allowlist.
      'dep URL is not a plain fetch URL (git ext:: runs a command)',
      () => {
        const pin = 'git+ext::sh -c whoami#v0.47.1';
        return repo({ pin, lock: lockText({ requested: pin }) });
      },
    ],
  ];

  for (const [name, build] of skips) {
    it(name, () => {
      expect(checkLockPin(build())).toBeNull();
      expect(mocked).not.toHaveBeenCalled();
    });
  }

  it('DEVKIT_SKIP_REMOTE_CHECKS opts out entirely', () => {
    expect(checkLockPin(repo(), { DEVKIT_SKIP_REMOTE_CHECKS: '1' })).toBeNull();
    expect(mocked).not.toHaveBeenCalled();
  });

  it('devkit’s own lockfile shape — the dep name as a VALUE — is not an entry', () => {
    const selfHostLock = `{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "@norvalbv/devkit",\n    },\n  },\n  "packages": {},\n}\n`;
    expect(checkLockPin(repo({ lock: selfHostLock }))).toBeNull();
    expect(mocked).not.toHaveBeenCalled();
  });
});

describe('checkLockPin — a resolvable pin is OK', () => {
  const ok: [string, string, string][] = [
    ['the annotated tag object (github: shorthand, 7 chars)', HTTPS_PIN, '#c68a526'],
    [
      'the peeled commit (git+ssh form records all 40)',
      SSH_PIN,
      '#4f8bc48223b6eae26a36d4fca828b75a8f11336d',
    ],
    ['a full 40-char tag object', HTTPS_PIN, '#c68a526896503af8ae7fd3a580fed57336edf909'],
  ];
  for (const [name, pin, sha] of ok) {
    it(name, () => {
      const r = checkLockPin(
        repo({
          pin,
          lock: lockText({ requested: pin, resolutions: [`@norvalbv/devkit@x${sha}`] }),
        }),
      );
      expect(r?.status).toBe('OK');
      expect(mocked).toHaveBeenCalledOnce();
    });
  }

  it('a lightweight tag, whose ref line holds the commit itself', () => {
    const pin = 'git+https://github.com/norvalbv/devkit.git#v0.1.0';
    const lock = lockText({ requested: pin, resolutions: ['@norvalbv/devkit@x#3084b25'] });
    expect(checkLockPin(repo({ pin, lock }))?.status).toBe('OK');
  });

  it('reads the git-root lockfile from a monorepo package subdir', () => {
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, 'bun.lock'), lockText({}));
    const pkgDir = join(dir, 'packages', 'web');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'web', devDependencies: { '@norvalbv/devkit': HTTPS_PIN } }),
    );
    expect(checkLockPin(pkgDir)?.status).toBe('OK');
  });

  it('matches a workspace-scoped duplicate key', () => {
    const lock = lockText({}).replace('"@norvalbv/devkit": ["', '"apps/web/@norvalbv/devkit": ["');
    expect(checkLockPin(repo({ lock }))?.status).toBe('OK');
  });
});

// Failing OPEN is non-negotiable: doctor must stay usable offline, and a DRIFT here exits 1.
describe('checkLockPin — an unusable remote never DRIFTs', () => {
  it('reports OK when ls-remote fails', () => {
    mocked.mockImplementation(() => {
      throw new Error('Could not resolve host');
    });
    const r = checkLockPin(repo());
    expect(r?.status).toBe('OK');
    expect(r?.detail).toMatch(/remote unreachable/);
  });

  it('reports OK when the remote reports no refs', () => {
    mocked.mockReturnValue('');
    expect(checkLockPin(repo())?.status).toBe('OK');
  });
});

describe('checkLockPin — findings', () => {
  it('DRIFTs on the sc-1449 case: the recorded object is gone from the remote', () => {
    const lock = lockText({
      requested: SSH_PIN,
      resolutions: [
        '@norvalbv/devkit@git+ssh://git@github.com/norvalbv/devkit.git#590bae24f77816d943fa7c4814c4ea833ef0aa33',
      ],
    });
    const r = checkLockPin(repo({ pin: SSH_PIN, lock }));
    expect(r?.status).toBe('DRIFT');
    expect(r?.detail).toContain('590bae24f77816d943fa7c4814c4ea833ef0aa33');
    expect(r?.detail).toMatch(/fresh clone or CI install will fail/);
    // The remediation must be the command that was verified to repair, and must warn off the one
    // that silently reports success.
    expect(r?.remediation).toContain('bun update @norvalbv/devkit');
    expect(r?.remediation).toMatch(/NOT `devkit update`/);
    expect(r?.fixable).toBe(false);
  });

  // The repair depends on whether a newer tag exists, and naming the wrong one is worse than saying
  // nothing: `devkit update` on an already-newest pin prints "up to date" and changes nothing, so
  // the user walks away believing it is fixed.
  it('names `devkit update` when a newer tag exists — re-pinning is what re-resolves', () => {
    const pin = 'git+https://github.com/norvalbv/devkit.git#v0.46.0';
    const lock = lockText({
      requested: pin,
      resolutions: ['@norvalbv/devkit@github:norvalbv/devkit#590bae2'],
    });
    const r = checkLockPin(repo({ pin, lock }));
    expect(r?.status).toBe('DRIFT');
    expect(r?.remediation).toContain('devkit update');
    expect(r?.remediation).toContain('v0.47.1');
    expect(r?.remediation).not.toContain('bun update');
  });

  it('DRIFTs when the recorded object belongs to a different ref', () => {
    const lock = lockText({ resolutions: ['@norvalbv/devkit@github:norvalbv/devkit#3084b25'] });
    const r = checkLockPin(repo({ lock }));
    expect(r?.status).toBe('DRIFT');
    expect(r?.detail).toContain('refs/tags/v0.1.0');
  });

  it('DRIFTs when the pinned tag itself no longer exists on the remote', () => {
    const pin = 'git+https://github.com/norvalbv/devkit.git#v9.9.9';
    const lock = lockText({ requested: pin });
    const r = checkLockPin(repo({ pin, lock }));
    expect(r?.status).toBe('DRIFT');
    expect(r?.detail).toMatch(/v9\.9\.9, which no longer exists/);
    expect(r?.remediation).toContain('devkit update');
  });
});
