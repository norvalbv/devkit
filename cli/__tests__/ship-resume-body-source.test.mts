/** sc-3411 — a --resume banner names the body that will ship; an override sized as the record
 *  looked exactly like the stale-body failure. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import {
  dropWorktree,
  installHook,
  reshipScript,
  scriptPath,
  seedReshipRepo,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

const run = (script, s, argv, { input = '' } = {}) =>
  spawnSync('/bin/bash', [script, ...argv], {
    cwd: s.dir,
    input,
    encoding: 'utf8',
    env: { ...s.env, SHIP_DRY_RUN: '1' },
  });

/** The single banner line, so an assertion cannot pass on text printed elsewhere in the run. */
const banner = (stderr) => {
  const line = stderr.split('\n').find((l) => l.startsWith('Resuming recorded invocation for '));
  if (!line) throw new Error(`no resume banner in:\n${stderr}`);
  return line;
};

/** Block a new-ship once on a failing hook so a record exists, then make the hook pass. The stdin
 *  read strips the trailing newline, so the recorded body is 'original body' — 13 bytes. */
function seedBlockedShip(branch) {
  const s = seedShipRepoLocalRemote({ hookBody: 'exit 1' });
  writeFileSync(join(s.dir, '.gitignore'), '.devkit/\n');
  writeFileSync(join(s.dir, 'note.txt'), 'hello\n');
  const blocked = run(scriptPath, s, [branch, 'x', '--', 'note.txt'], { input: 'original body\n' });
  expect(blocked.status).not.toBe(0);
  installHook(s.dir, 'exit 0');
  return s;
}

describe('ship --resume banner: body source (new-ship)', () => {
  it('names --body-file and its size, and says which recorded size it overrides', () => {
    const s = seedBlockedShip('feat/bf');
    writeFileSync(join(s.dir, 'fixed.md'), 'a corrected and longer body\n'); // 28 bytes
    const r = run(scriptPath, s, ['--resume', 'feat/bf', '--body-file', 'fixed.md']);
    try {
      expect(r.status, r.stderr).toBe(0);
      expect(banner(r.stderr)).toContain(
        'body 28 bytes (from --body-file fixed.md, overriding recorded 13)',
      );
      expect(s.git(['log', '-1', '--format=%b', 'feat/bf']).trim()).toBe(
        'a corrected and longer body',
      );
    } finally {
      dropWorktree(s.git, r.stderr);
    }
  });

  it('still names the override when the new body is the SAME size as the recorded one', () => {
    // A same-length typo fix is the case a bare byte count can never tell apart from a stale replay.
    const s = seedBlockedShip('feat/same');
    writeFileSync(join(s.dir, 'fixed.md'), 'original BODY'); // 13 bytes, no newline
    const r = run(scriptPath, s, ['--resume', 'feat/same', '--body-file', 'fixed.md']);
    try {
      expect(r.status, r.stderr).toBe(0);
      expect(banner(r.stderr)).toContain(
        'body 13 bytes (from --body-file fixed.md, overriding recorded 13)',
      );
    } finally {
      dropWorktree(s.git, r.stderr);
    }
  });

  it('counts BYTES, not characters, for a multibyte body', () => {
    const s = seedBlockedShip('feat/utf8');
    writeFileSync(join(s.dir, 'fixed.md'), 'ünïcode — fix\n'); // 14 chars, 18 bytes (ü ï 2 each, — 3)
    const r = run(scriptPath, s, ['--resume', 'feat/utf8', '--body-file', 'fixed.md']);
    try {
      expect(r.status, r.stderr).toBe(0);
      expect(Buffer.byteLength('ünïcode — fix\n')).toBe(18);
      expect(banner(r.stderr)).toContain('body 18 bytes (from --body-file fixed.md');
    } finally {
      dropWorktree(s.git, r.stderr);
    }
  });

  it('reports an EMPTY --body-file as 0 bytes, not as the recorded body', () => {
    const s = seedBlockedShip('feat/empty');
    writeFileSync(join(s.dir, 'empty.md'), '');
    const r = run(scriptPath, s, ['--resume', 'feat/empty', '--body-file', 'empty.md']);
    try {
      expect(banner(r.stderr)).toContain(
        'body 0 bytes (from --body-file empty.md, overriding recorded 13)',
      );
    } finally {
      dropWorktree(s.git, r.stderr);
    }
  });

  it('names --body text the same way', () => {
    const s = seedBlockedShip('feat/inline');
    const r = run(scriptPath, s, ['--resume', 'feat/inline', '--body', 'inline fix']);
    try {
      expect(r.status, r.stderr).toBe(0);
      expect(banner(r.stderr)).toContain('body 10 bytes (from --body, overriding recorded 13)');
    } finally {
      dropWorktree(s.git, r.stderr);
    }
  });

  it('without an override the banner is the recorded size and claims no override', () => {
    const s = seedBlockedShip('feat/plain');
    const r = run(scriptPath, s, ['--resume', 'feat/plain']);
    try {
      expect(r.status, r.stderr).toBe(0);
      const line = banner(r.stderr);
      expect(line).toContain('body 13 bytes, recorded ');
      expect(line).not.toContain('overriding');
      expect(line).not.toContain('from --');
    } finally {
      dropWorktree(s.git, r.stderr);
    }
  });

  it('a missing --body-file is named in the banner, never sized as the recorded body, and still exits 1', () => {
    const s = seedBlockedShip('feat/gone');
    const r = run(scriptPath, s, ['--resume', 'feat/gone', '--body-file', 'nope.md']);
    expect(r.status).toBe(1);
    const line = banner(r.stderr);
    expect(line).toContain('body from --body-file nope.md (missing');
    expect(line).not.toContain('body 13 bytes');
    expect(r.stderr).toContain('--body-file: no such file: nope.md');
  });
});

/** Block a reship once on the base-aware size preflight, then fix the cause. */
function seedBlockedReship(argv, input) {
  const s = seedReshipRepo();
  writeFileSync(join(s.dir, 'guard.config.json'), '{"maxLines":5}\n');
  s.git(['add', 'guard.config.json'], { stdio: 'ignore' });
  s.git(['commit', '-qm', 'cap'], { stdio: 'ignore' });
  s.git(['push', '-qf', 'origin', 'work:pr-open'], { stdio: 'ignore' });
  mkdirSync(join(s.dir, 'src'), { recursive: true });
  writeFileSync(join(s.dir, 'src/big.ts'), 'export const a = 1;\n'.repeat(20));
  const first = run(
    reshipScript,
    s,
    ['pr-open', 'the title', '--pr', ...argv, '--', 'src/big.ts'],
    {
      input,
    },
  );
  expect(first.status, first.stderr).toBe(1);
  writeFileSync(join(s.dir, 'src/big.ts'), 'export const a = 1;\n');
  return s;
}

describe('ship --resume banner: body source + PR effect (reship --pr)', () => {
  it('--body-file on the resume is named and refreshes the PR body', () => {
    const s = seedBlockedReship([], 'pr body\n'); // stdin: recorded 7 bytes, commit-only
    writeFileSync(join(s.dir, 'fixed.md'), 'better pr body\n'); // 15 bytes
    const r = run(scriptPath, s, ['--resume', 'pr-open', '--body-file', 'fixed.md']);
    try {
      expect(r.status, r.stderr).toBe(0);
      const line = banner(r.stderr);
      expect(line).toContain('(--pr)');
      expect(line).toContain('body 15 bytes (from --body-file fixed.md, overriding recorded 7)');
      expect(line).toContain('commit + PR body');
    } finally {
      dropWorktree(s.git, r.stderr);
    }
  });

  it('a stdin-recorded body replayed with no flag is commit-only and says the PR body is kept', () => {
    const s = seedBlockedReship([], 'pr body\n');
    const r = run(scriptPath, s, ['--resume', 'pr-open']);
    try {
      expect(r.status, r.stderr).toBe(0);
      const line = banner(r.stderr);
      expect(line).toContain('body 7 bytes (commit only, PR body kept), recorded ');
    } finally {
      dropWorktree(s.git, r.stderr);
    }
  });

  it('a body recorded from --body-file keeps its PR-refresh bit across a flagless resume', () => {
    const s = seedReshipRepo();
    const seeded = seedBlockedReshipWithFile(s);
    const r = run(scriptPath, seeded, ['--resume', 'pr-open']);
    try {
      expect(r.status, r.stderr).toBe(0);
      const line = banner(r.stderr);
      expect(line).not.toContain('overriding');
      expect(line).toContain('commit + PR body');
    } finally {
      dropWorktree(seeded.git, r.stderr);
    }
  });
});

function seedBlockedReshipWithFile(s) {
  writeFileSync(join(s.dir, 'guard.config.json'), '{"maxLines":5}\n');
  s.git(['add', 'guard.config.json'], { stdio: 'ignore' });
  s.git(['commit', '-qm', 'cap'], { stdio: 'ignore' });
  s.git(['push', '-qf', 'origin', 'work:pr-open'], { stdio: 'ignore' });
  mkdirSync(join(s.dir, 'src'), { recursive: true });
  writeFileSync(join(s.dir, 'src/big.ts'), 'export const a = 1;\n'.repeat(20));
  writeFileSync(join(s.dir, 'body.md'), 'file body\n');
  const first = run(reshipScript, s, [
    'pr-open',
    'the title',
    '--pr',
    '--body-file',
    'body.md',
    '--',
    'src/big.ts',
  ]);
  expect(first.status, first.stderr).toBe(1);
  writeFileSync(join(s.dir, 'src/big.ts'), 'export const a = 1;\n');
  return s;
}

describe('ship_resume_body_note: one read of --body-file serves banner and body', () => {
  const helper = fileURLToPath(new URL('../lib/ship/read-stdin-body.sh', import.meta.url));
  const note = (dir, script) =>
    spawnSync('/bin/bash', ['-c', `. "${helper}"; RESUME_BODY=rec; BODY_SET=0; ${script}`], {
      cwd: dir,
      encoding: 'utf8',
    });

  it('a rewrite after the banner cannot change the bytes it sized (trailing newline kept)', () => {
    const { dir } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, 'b.md'), 'first\n\n');
    const r = note(
      dir,
      `BODY_FILE_SET=1; BODY_FILE_FLAG=b.md; ship_resume_body_note; printf 'rewritten' > b.md
       printf '%s|%s|%s' "$BODY_FILE_PREREAD_SET" "$SHIP_BODY_NOTE" "$BODY_FILE_PREREAD"`,
    );
    expect(r.stdout).toBe(
      '1|body 7 bytes (from --body-file b.md, overriding recorded 3)|first\n\n',
    );
  });

  it('an unreadable file is named and latched (2), so the resolution refuses instead of re-reading', () => {
    const { dir } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, 'locked.md'), 'secret\n', { mode: 0o000 });
    const r = note(
      dir,
      `BODY_FILE_PREREAD_SET=0; BODY_FILE_SET=1; BODY_FILE_FLAG=locked.md; ship_resume_body_note
       printf '%s|%s|%s' "$BODY_FILE_PREREAD_SET" "$BODY_FILE_PREREAD_ERR" "$SHIP_BODY_NOTE"`,
    );
    // root reads mode-000 files; the contract under test is only meaningful for a normal user.
    if (process.getuid?.() === 0) return;
    expect(r.stdout).toBe(
      '2|unreadable|body from --body-file locked.md (missing or unreadable — recorded 3 bytes not used)',
    );
  });
});
