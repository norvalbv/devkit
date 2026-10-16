// sc-2759: the self-host skill-projection advisory judges the pending commit's index, not the
// working tree a ship refreshes from the running package.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resetCommitIndexCache } from '../../gate-engine/ratchets/commit-index.mts';
import { indexTreeRef } from '../../gate-engine/ratchets/git-index.mts';
import { treeBlobsAtRef } from '../../gate-engine/ratchets/tree-blobs.mts';
import {
  blamedFindings,
  inspectSkillProjectionIntegrity,
  printSkillProjectionWarning,
  runSkillProjectionGate,
} from '../lib/husky/skill-projection-integrity.mts';
import { agentAssetDir } from '../lib/install/agent-assets/agent-assets.mts';
import { rootRegistry } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();
const CARRIER_VARS = ['DEVKIT_COMMIT_INDEX_FILE', 'DEVKIT_COMMIT_GIT_DIR'] as const;
// A native bound on every spawn here: this file is in the parallel project, where nothing else
// bounds a wedged synchronous child (suite-hangs-bound-at-the-spawn-site).
const SPAWN_TIMEOUT_MS = 60_000;
const script = fileURLToPath(
  new URL('../lib/husky/skill-projection-integrity.mts', import.meta.url),
);

afterEach(() => {
  for (const name of CARRIER_VARS) delete process.env[name];
  resetCommitIndexCache();
  cleanup();
});

const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: SPAWN_TIMEOUT_MS,
  });

function write(root: string, rel: string, content: string | Buffer): void {
  const file = join(root, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

function manifest(targets: string[]): string {
  return `${JSON.stringify({
    schemaVersion: 2,
    kind: 'skills',
    devkitRef: null,
    generatedAt: '2026-10-01T00:00:00.000Z',
    files: {},
    providers: Object.fromEntries(targets.map((target) => [target, { files: {} }])),
  })}\n`;
}

/** A committed devkit self-host repo whose projections all match their source. */
function devkitGitRepo(
  files: Record<string, string | Buffer> = { 'review/SKILL.md': '# Review\n' },
  targets = ['claude', 'cursor'],
): string {
  const root = realpathSync(mkTmp('skill-projection-index-'));
  write(root, 'package.json', `${JSON.stringify({ name: '@norvalbv/devkit' })}\n`);
  write(root, '.devkit/config.json', `${JSON.stringify({ components: { guards: [] } })}\n`);
  write(root, '.devkit/skills-manifest.json', manifest(targets));
  for (const [rel, content] of Object.entries(files)) {
    write(root, `skills/${rel}`, content);
    write(root, `dist/skills/${rel}`, content);
    for (const target of targets) write(root, `${agentAssetDir(target, 'skills')}/${rel}`, content);
  }
  git(root, ['init', '-q']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'seed']);
  return root;
}

describe('skill projection advisory reads the commit index (sc-2759)', () => {
  it('ignores a working-tree .claude refresh the commit does not carry (the ship repro)', () => {
    const root = devkitGitRepo();
    // What prepare-gate-worktree.sh does: overwrite .claude on disk from the running package.
    write(root, '.claude/skills/review/SKILL.md', '# packaged copy\n');
    write(root, '.claude/skills/i-have-adhd/SKILL.md', '# packaged-only skill\n');

    expect(inspectSkillProjectionIntegrity(root)).toEqual({
      active: true,
      checkedProjections: ['claude', 'cursor', 'dist'],
      findings: [],
      source: 'index',
    });
  });

  it('reports a staged stale projection even when the working tree was re-synced', () => {
    const root = devkitGitRepo();
    write(root, 'skills/review/SKILL.md', '# Review v2\n');
    write(root, 'dist/skills/review/SKILL.md', '# Review v2\n');
    git(root, ['add', 'skills', 'dist']);
    // Synced on disk but never staged: the commit still carries the old projections.
    write(root, '.claude/skills/review/SKILL.md', '# Review v2\n');
    write(root, '.cursor/skills/review/SKILL.md', '# Review v2\n');

    expect(inspectSkillProjectionIntegrity(root).findings.sort()).toEqual([
      'stale .claude/skills/review/SKILL.md',
      'stale .cursor/skills/review/SKILL.md',
    ]);
  });

  it('clears once the corrective projections are staged', () => {
    const root = devkitGitRepo();
    for (const rel of ['skills', 'dist/skills', '.claude/skills', '.cursor/skills'])
      write(root, `${rel}/review/SKILL.md`, '# Review v2\n');
    git(root, ['add', '-A']);
    write(root, '.claude/skills/review/SKILL.md', '# packaged copy\n');

    expect(inspectSkillProjectionIntegrity(root).findings).toEqual([]);
  });

  it('counts only tracked extras as orphans and reports staged missing files', () => {
    const root = devkitGitRepo();
    write(root, '.cursor/skills/review/untracked.md', 'never added\n');
    write(root, '.cursor/skills/review/extra.md', 'tracked\n');
    git(root, ['add', '.cursor/skills/review/extra.md']);
    git(root, ['rm', '-q', '--cached', '.claude/skills/review/SKILL.md']);

    expect(inspectSkillProjectionIntegrity(root).findings.sort()).toEqual([
      'missing .claude/skills/review/SKILL.md',
      'orphan .cursor/skills/review/extra.md',
    ]);
  });

  it('judges the carrier index of a partial commit (`git commit -- <path>`)', () => {
    const root = devkitGitRepo();
    write(root, '.claude/skills/review/SKILL.md', '# stale on disk and in the default index\n');
    git(root, ['add', '.claude']);
    // The partial commit's temporary index carries HEAD's (correct) projection.
    const gitDir = join(root, '.git');
    const partial = join(gitDir, 'next-index-4242.lock');
    copyFileSync(join(gitDir, 'index'), partial);
    git(root, ['read-tree', 'HEAD'], { ...process.env, GIT_INDEX_FILE: partial });

    expect(inspectSkillProjectionIntegrity(root).findings).toEqual([
      'stale .claude/skills/review/SKILL.md',
    ]);
    Object.assign(process.env, {
      DEVKIT_COMMIT_INDEX_FILE: partial,
      DEVKIT_COMMIT_GIT_DIR: gitDir,
    });
    resetCommitIndexCache();
    expect(inspectSkillProjectionIntegrity(root).findings).toEqual([]);
  });

  it('reads targets and selection from the staged manifest, not the disk copy', () => {
    const root = devkitGitRepo();
    rmSync(join(root, '.cursor'), { recursive: true });
    git(root, ['add', '-A']);
    write(root, '.devkit/skills-manifest.json', manifest(['claude']));
    // Disk says cursor is gone; the commit still records it as a provider.
    expect(inspectSkillProjectionIntegrity(root).findings).toEqual([
      'missing .cursor/skills/review/SKILL.md',
    ]);
    git(root, ['add', '.devkit/skills-manifest.json']);
    expect(inspectSkillProjectionIntegrity(root)).toMatchObject({
      checkedProjections: ['claude', 'dist'],
      findings: [],
    });
  });

  it('reads the codex provider directory from the index', () => {
    const root = devkitGitRepo({ 'review/SKILL.md': '# Review\n' }, ['codex']);
    write(root, '.agents/skills/review/SKILL.md', '# drifted on disk only\n');
    expect(inspectSkillProjectionIntegrity(root).findings).toEqual([]);
    git(root, ['add', '.agents']);
    expect(inspectSkillProjectionIntegrity(root).findings).toEqual([
      'stale .agents/skills/review/SKILL.md',
    ]);
  });

  it('compares non-UTF-8 bytes and awkward file names exactly', () => {
    const binary = Buffer.from([0x00, 0xff, 0xfe, 0x0a, 0x80, 0x0a]);
    const root = devkitGitRepo({
      'review/SKILL.md': '# Review\n',
      'review/assets/logo.bin': binary,
      'review/ref é with space.md': 'unicode\n',
    });
    expect(inspectSkillProjectionIntegrity(root).findings).toEqual([]);

    write(root, '.claude/skills/review/assets/logo.bin', Buffer.from([0x00, 0xff, 0xfe, 0x0a]));
    git(root, ['add', '.claude']);
    expect(inspectSkillProjectionIntegrity(root).findings).toEqual([
      'stale .claude/skills/review/assets/logo.bin',
    ]);
  });

  it('reports a staged symlink projection as stale instead of crashing', () => {
    const root = devkitGitRepo();
    rmSync(join(root, '.claude/skills/review/SKILL.md'));
    symlinkSync('../../../skills/review/SKILL.md', join(root, '.claude/skills/review/SKILL.md'));
    git(root, ['add', '.claude']);

    expect(inspectSkillProjectionIntegrity(root).findings).toEqual([
      'stale .claude/skills/review/SKILL.md',
    ]);
  });

  it('reports a staged symlink source once, without orphaning its projections', () => {
    const root = devkitGitRepo();
    write(root, 'elsewhere.md', '# Review\n');
    rmSync(join(root, 'skills/review/SKILL.md'));
    symlinkSync('../../elsewhere.md', join(root, 'skills/review/SKILL.md'));
    git(root, ['add', '-A']);

    expect(inspectSkillProjectionIntegrity(root).findings).toEqual([
      'unreadable skills/review/SKILL.md',
    ]);
  });

  it('stands down with one unchecked finding when the index has unmerged paths', () => {
    const root = devkitGitRepo();
    git(root, ['checkout', '-q', '-b', 'side']);
    write(root, 'skills/review/SKILL.md', '# side\n');
    git(root, ['commit', '-q', '-am', 'side']);
    git(root, ['checkout', '-q', '-']);
    write(root, 'skills/review/SKILL.md', '# main\n');
    git(root, ['commit', '-q', '-am', 'main']);
    expect(() => git(root, ['merge', '-q', 'side'])).toThrow();

    expect(inspectSkillProjectionIntegrity(root)).toEqual({
      active: true,
      checkedProjections: [],
      findings: ['unchecked skills/ — the commit index could not be read as one snapshot'],
      source: 'index',
    });
  });

  it('runs end to end through the hook entrypoint and stays silent on a ship refresh', () => {
    const root = devkitGitRepo();
    // The advisory writes to stderr; merge it so a regression cannot hide from the assertion.
    const run = () =>
      execFileSync('sh', ['-c', 'node "$0" --root "$1" 2>&1', script, root], {
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
      });
    write(root, '.claude/skills/review/SKILL.md', '# packaged copy\n');
    expect(run()).toBe('');

    git(root, ['add', '.claude']);
    const loud = run();
    expect(loud).toContain('stale .claude/skills/review/SKILL.md');
    expect(loud).toContain('Judged: the staged commit index');
    expect(loud).toContain('then `git add` the result');
  });

  it('never tells an agent to stage a rebuilt tracked dist file (release-only, sc-2467)', () => {
    const root = devkitGitRepo();
    write(root, 'dist/skills/review/SKILL.md', '# rebuilt\n');
    git(root, ['add', 'dist']);
    const stderr: string[] = [];
    const report = inspectSkillProjectionIntegrity(root);
    const spy = (line: string) => stderr.push(line);
    const original = console.error;
    console.error = spy;
    try {
      printSkillProjectionWarning(report);
    } finally {
      console.error = original;
    }

    const output = stderr.join('\n');
    expect(output).toContain('stale dist/skills/review/SKILL.md');
    expect(output).toContain('release-only');
    // Dist-only drift has no provider repair, so no sync line and no staging instruction at all.
    expect(output).not.toContain('sync-skills');
    expect(output).not.toContain('git add');
  });

  it('classifies dist findings by their path, not a substring of a provider path', () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (line: string) => lines.push(line);
    try {
      printSkillProjectionWarning({
        active: true,
        checkedProjections: ['claude', 'dist'],
        findings: ['stale .claude/skills/review/x dist/skills/y.md'],
        source: 'index',
      });
    } finally {
      console.error = original;
    }
    const output = lines.join('\n');
    expect(output).toContain('sync-skills');
    expect(output).not.toContain('release-only');
  });

  it('judges self-host identity from the staged package.json, not the working tree', () => {
    const root = devkitGitRepo();
    write(root, '.claude/skills/review/SKILL.md', '# stale\n');
    git(root, ['add', '.claude']);
    write(root, 'package.json', `${JSON.stringify({ name: 'renamed-on-disk' })}\n`);
    expect(inspectSkillProjectionIntegrity(root)).toMatchObject({
      active: true,
      findings: ['stale .claude/skills/review/SKILL.md'],
    });

    git(root, ['add', 'package.json']);
    write(root, 'package.json', `${JSON.stringify({ name: '@norvalbv/devkit' })}\n`);
    expect(inspectSkillProjectionIntegrity(root)).toEqual({
      active: false,
      checkedProjections: [],
      findings: [],
    });
  });

  it('stands down rather than judging the working tree when git itself fails', () => {
    const root = devkitGitRepo();
    write(root, '.claude/skills/review/SKILL.md', '# packaged copy\n');
    const path = process.env.PATH;
    // No git on PATH: every git call fails, but `.git` still marks this as a repository.
    process.env.PATH = mkTmp('no-git-bin-');
    resetCommitIndexCache();
    try {
      expect(inspectSkillProjectionIntegrity(root)).toEqual({
        active: true,
        checkedProjections: [],
        findings: ['unchecked skills/ — the commit index could not be read as one snapshot'],
        source: 'index',
      });
    } finally {
      process.env.PATH = path;
    }
  });

  it('stays inactive for a non-devkit repo even when its index is unmerged', () => {
    const root = devkitGitRepo();
    write(root, 'package.json', `${JSON.stringify({ name: 'consumer' })}\n`);
    git(root, ['commit', '-q', '-am', 'consumer']);
    git(root, ['checkout', '-q', '-b', 'side']);
    write(root, 'skills/review/SKILL.md', '# side\n');
    git(root, ['commit', '-q', '-am', 'side']);
    git(root, ['checkout', '-q', '-']);
    write(root, 'skills/review/SKILL.md', '# main\n');
    git(root, ['commit', '-q', '-am', 'main']);
    expect(() => git(root, ['merge', '-q', 'side'])).toThrow();

    expect(inspectSkillProjectionIntegrity(root).active).toBe(false);
  });
});

/** Run the gate with console captured; returns its exit code and everything it printed. */
function gate(root: string) {
  const lines: string[] = [];
  const capture = (line: string) => lines.push(line);
  const { log, error } = console;
  console.log = capture;
  console.error = capture;
  try {
    return { code: runSkillProjectionGate(root), output: lines.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe('skill projection gate blames only the drift this commit caused (sc-3950)', () => {
  const twoSkills = { 'review/SKILL.md': '# Review\n', 'other/SKILL.md': '# Other\n' };

  it('blocks a staged skill edit whose provider copies were not synced, naming only that skill', () => {
    const root = devkitGitRepo(twoSkills);
    write(root, '.claude/skills/other/SKILL.md', '# Other, already stale\n');
    git(root, ['commit', '-q', '-am', 'pre-existing drift']);
    write(root, 'skills/review/SKILL.md', '# Review v2\n');
    git(root, ['add', 'skills']);

    const { code, output } = gate(root);
    expect(code).toBe(1);
    expect(output).toContain('stale .claude/skills/review/SKILL.md');
    expect(output).toContain('stale .cursor/skills/review/SKILL.md');
    expect(output).toContain('sync-skills');
    expect(output).not.toContain('other');
    // dist lags until the next release by design: it is reported by the advisory, never blamed.
    expect(output).not.toContain('dist/skills');
  });

  it('passes a synced skill edit despite pre-existing drift elsewhere and a stale dist copy', () => {
    const root = devkitGitRepo(twoSkills);
    write(root, '.claude/skills/other/SKILL.md', '# Other, already stale\n');
    git(root, ['commit', '-q', '-am', 'pre-existing drift']);
    for (const dir of ['skills', '.claude/skills', '.cursor/skills'])
      write(root, `${dir}/review/SKILL.md`, '# Review v2\n');
    git(root, ['add', '-A']);

    expect(inspectSkillProjectionIntegrity(root).findings.sort()).toEqual([
      'stale .claude/skills/other/SKILL.md',
      'stale dist/skills/review/SKILL.md',
    ]);
    expect(gate(root)).toEqual({ code: 0, output: '' });
  });

  it('blocks a deleted skill file whose tracked provider copy is left behind', () => {
    const root = devkitGitRepo({ 'review/SKILL.md': '# Review\n', 'review/ref.md': 'ref\n' });
    git(root, ['rm', '-q', 'skills/review/ref.md', 'dist/skills/review/ref.md']);

    const { code, output } = gate(root);
    expect(code).toBe(1);
    expect(output).toContain('orphan .claude/skills/review/ref.md');
    expect(output).toContain('remove orphan files explicitly');
  });

  it('passes a staged symlink source whose provider copies match, since sync cannot repair it', () => {
    const root = devkitGitRepo();
    write(root, 'elsewhere.md', '# Review\n');
    rmSync(join(root, 'skills/review/SKILL.md'));
    symlinkSync('../../elsewhere.md', join(root, 'skills/review/SKILL.md'));
    git(root, ['add', '-A']);

    // The advisory still reports it; blocking would name a sync-skills remedy that changes nothing.
    expect(inspectSkillProjectionIntegrity(root).findings).toEqual([
      'unreadable skills/review/SKILL.md',
    ]);
    expect(gate(root).code).toBe(0);
  });

  it('blames a renamed skill for both its left-behind and its missing copies', () => {
    const root = devkitGitRepo();
    git(root, ['mv', 'skills/review', 'skills/reviewer']);

    const { code, output } = gate(root);
    expect(code).toBe(1);
    expect(output).toContain('orphan .claude/skills/review/SKILL.md');
    expect(output).toContain('missing .claude/skills/reviewer/SKILL.md');
  });

  it('blames from the carrier index of a partial commit, not the default index', () => {
    const root = devkitGitRepo();
    const gitDir = join(root, '.git');
    const partial = join(gitDir, 'next-index-4242.lock');
    copyFileSync(join(gitDir, 'index'), partial);
    write(root, 'skills/review/SKILL.md', '# Review v2\n');
    // Only the partial commit's index carries the unsynced edit; the default index matches HEAD.
    git(root, ['add', 'skills'], { ...process.env, GIT_INDEX_FILE: partial });
    expect(gate(root).code).toBe(0);

    Object.assign(process.env, {
      DEVKIT_COMMIT_INDEX_FILE: partial,
      DEVKIT_COMMIT_GIT_DIR: gitDir,
    });
    resetCommitIndexCache();
    expect(gate(root).code).toBe(1);
  });

  it('blocks a hand edit staged only in a provider copy', () => {
    const root = devkitGitRepo();
    write(root, '.cursor/skills/review/SKILL.md', '# edited in place\n');
    git(root, ['add', '.cursor']);

    expect(gate(root).code).toBe(1);
  });

  it('blames every provider finding when the staged manifest adds a provider', () => {
    const root = devkitGitRepo();
    write(root, '.devkit/skills-manifest.json', manifest(['claude', 'cursor', 'codex']));
    git(root, ['add', '.devkit']);

    const { code, output } = gate(root);
    expect(code).toBe(1);
    expect(output).toContain('missing .agents/skills/review/SKILL.md');
  });

  it('stands down on an unmerged index rather than blaming the tree', () => {
    const root = devkitGitRepo();
    git(root, ['checkout', '-q', '-b', 'side']);
    write(root, 'skills/review/SKILL.md', '# side\n');
    git(root, ['commit', '-q', '-am', 'side']);
    git(root, ['checkout', '-q', '-']);
    write(root, 'skills/review/SKILL.md', '# main\n');
    git(root, ['commit', '-q', '-am', 'main']);
    expect(() => git(root, ['merge', '-q', 'side'])).toThrow();

    const { code, output } = gate(root);
    expect(code).toBe(0);
    expect(output).toContain('nothing was judged');
  });

  it('is silent outside devkit', () => {
    const root = devkitGitRepo();
    write(root, 'package.json', `${JSON.stringify({ name: 'consumer' })}\n`);
    write(root, 'skills/review/SKILL.md', '# Review v2\n');
    git(root, ['add', '-A']);

    expect(gate(root)).toEqual({ code: 0, output: '' });
  });

  it('maps shared and vendored skill directories by their first path segment', () => {
    const staged = new Set(['skills/_devkit/review-roots.mjs']);
    expect(
      blamedFindings(
        [
          'stale .claude/skills/_devkit/review-roots.mjs',
          'orphan .claude/skills/i-have-adhd/SKILL.md',
          'stale dist/skills/_devkit/review-roots.mjs',
        ],
        staged,
      ),
    ).toEqual(['stale .claude/skills/_devkit/review-roots.mjs']);
    // A finding's path starts after the FIRST space only, so a spaced skill name still matches.
    expect(
      blamedFindings(
        ['stale .cursor/skills/my skill/SKILL.md'],
        new Set(['skills/my skill/SKILL.md']),
      ),
    ).toEqual(['stale .cursor/skills/my skill/SKILL.md']);
  });

  it('exits through the --gate entrypoint with the gate verdict', () => {
    const root = devkitGitRepo();
    const run = () =>
      spawnSync('node', [script, '--root', root, '--gate'], {
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
      });
    expect(run().status).toBe(0);

    write(root, 'skills/review/SKILL.md', '# Review v2\n');
    git(root, ['add', 'skills']);
    const blocked = run();
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain('caused by this commit');
  });

  it('passes rather than blocks when the gate itself cannot start', () => {
    const run = spawnSync('node', [script, '--gate'], {
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('did not run');
  });
});

describe('treeBlobsAtRef', () => {
  it('returns byte-exact blobs, maps symlinks to null, and skips gitlinks', () => {
    const root = devkitGitRepo({ 'review/SKILL.md': Buffer.from([0xc3, 0x28, 0x00]) });
    symlinkSync('SKILL.md', join(root, 'skills/review/link.md'));
    git(root, ['add', '-A']);
    git(root, [
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${git(root, ['rev-parse', 'HEAD']).trim()},skills/sub`,
    ]);
    const tree = indexTreeRef(root);
    expect(tree).toBeTruthy();

    const blobs = treeBlobsAtRef(root, tree ?? '', ['skills']);
    expect(blobs?.get('skills/review/SKILL.md')).toEqual(Buffer.from([0xc3, 0x28, 0x00]));
    expect(blobs?.get('skills/review/link.md')).toBeNull();
    expect(blobs?.has('skills/sub')).toBe(false);
    expect(blobs?.has('dist/skills/review/SKILL.md')).toBe(false);
  });

  it('returns null when git cannot read the tree', () => {
    const root = devkitGitRepo();
    expect(treeBlobsAtRef(root, '0'.repeat(40), ['skills'])).toBeNull();
  });

  it('stands down instead of colliding paths that are not valid UTF-8', () => {
    const root = devkitGitRepo();
    const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: root,
      input: 'x\n',
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
    }).trim();
    // Two distinct byte paths that a lossy decode would both map to `skills/review/\uFFFD`.
    const entry = (byte: number) =>
      Buffer.concat([
        Buffer.from(`100644 ${oid}\tskills/review/`),
        Buffer.from([byte]),
        Buffer.from('\n'),
      ]);
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: root,
      input: Buffer.concat([entry(0x80), entry(0x81)]),
      timeout: SPAWN_TIMEOUT_MS,
    });

    expect(treeBlobsAtRef(root, indexTreeRef(root) ?? '', ['skills'])).toBeNull();
    expect(inspectSkillProjectionIntegrity(root).findings).toEqual([
      'unchecked skills/ — the commit index could not be read as one snapshot',
    ]);
  });
});
