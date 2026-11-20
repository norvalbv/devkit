import { execFileSync } from 'node:child_process';
import fs, {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codebaseRegisterCommand } from '../../gate-engine/judge/mcp/registration-remedy.mts';
import { DEFAULT_INDEX_COMMAND, installSearchCode } from '../lib/install/install-search-code.mts';
import { tmpRepos } from './_helpers.mts';

const { tmpRepo, devkit, cleanup } = tmpRepos('sc-');
afterEach(cleanup);

describe('installSearchCode .gitignore line', () => {
  it('keeps an edit another writer makes between its read and its write', () => {
    const root = tmpRepo();
    const gitignore = join(root, '.gitignore');
    writeFileSync(gitignore, 'node_modules\n');
    const realReadFileSync = fs.readFileSync;
    let interleaved = false;
    // SAFETY: the wrapper forwards every argument to the real readFileSync and returns its value.
    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      const stale = realReadFileSync(...args);
      if (!interleaved && String(args[0]) === gitignore) {
        interleaved = true; // an editor saves its own line just after devkit's read
        writeFileSync(gitignore, 'node_modules\nuser-line\n');
      }
      return stale;
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports(); // install-search-code.mts binds readFileSync by name
    try {
      installSearchCode(root, false);
    } finally {
      fs.readFileSync = realReadFileSync;
      syncBuiltinESMExports();
    }
    expect(interleaved).toBe(true);
    expect(readFileSync(gitignore, 'utf8')).toBe('node_modules\nuser-line\n.search-code/\n');
  });

  it('puts the line on its own line when the file lacks a trailing newline, once', () => {
    const root = tmpRepo();
    writeFileSync(join(root, '.gitignore'), 'node_modules');
    installSearchCode(root, false);
    installSearchCode(root, false);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules\n.search-code/\n');
  });

  it('appends under the shared .gitignore lock, and a re-run converges once it is free', () => {
    const root = tmpRepo();
    const lock = join(root, '.devkit', 'gitignore.lock');
    writeFileSync(join(root, '.gitignore'), 'node_modules\n');
    mkdirSync(join(root, '.devkit'));
    writeFileSync(lock, String(process.pid)); // a live devkit writer mid-rewrite
    expect(() => installSearchCode(root, false)).toThrow(/held by another devkit process/);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules\n');
    rmSync(lock);
    installSearchCode(root, false);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules\n.search-code/\n');
    expect(existsSync(lock)).toBe(false); // released
  });

  it('dry-run writes neither .gitignore nor .devkit/', () => {
    const root = tmpRepo();
    installSearchCode(root, true);
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
    expect(existsSync(join(root, '.devkit'))).toBe(false);
  });
});

describe('search-code opt-in component', () => {
  it('--search-code writes the opt-in config + gitignores the index + wires indexPath', () => {
    const root = tmpRepo();
    const r = devkit(root, 'init', '--stack', 'generic', '--yes', '--search-code');
    expect(r.status).toBe(0);
    expect(existsSync(join(root, 'search-code.config.json')), 'opt-in config written').toBe(true);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.search-code/');
    // generic template ships no indexPath → installSearchCode must INSERT it.
    expect(readFileSync(join(root, 'guard.config.json'), 'utf8')).toContain(
      '"indexPath": ".search-code/index.db"',
    );
    // recorded so clean knows to reverse it.
    const cfg = JSON.parse(readFileSync(join(root, '.devkit/config.json'), 'utf8'));
    expect(cfg.components.searchCode).toBe(true);
  });

  it("keeps a consumer's existing search-code.config.json byte for byte", () => {
    const root = tmpRepo();
    writeFileSync(join(root, 'search-code.config.json'), '{"mine":true}\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    installSearchCode(root, false);
    expect(readFileSync(join(root, 'search-code.config.json'), 'utf8')).toBe('{"mine":true}\n');
    expect(log.mock.calls.flat().join('\n')).toContain('• kept search-code.config.json');
    log.mockRestore();
  });

  it('prints the command that registers the codebase MCP server for this repo', () => {
    const root = tmpRepo();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    installSearchCode(root, false);
    expect(log.mock.calls.flat()).toContain(`      ${codebaseRegisterCommand(realpathSync(root))}`);
    log.mockRestore();
  });

  it.each([
    ['not opted in: it says to opt the primary in, and prints no command', false],
    ['opted in: it registers the primary checkout, which outlives the worktree', true],
  ])('run from a linked worktree whose primary is %s', (_name, primaryOptedIn) => {
    const root = tmpRepo();
    const worktree = `${root}-wt`;
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root });
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
    git('worktree', 'add', '-q', '--detach', worktree);
    if (primaryOptedIn) writeFileSync(join(root, 'search-code.config.json'), '{}\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      installSearchCode(worktree, false);
      const out = log.mock.calls.flat().map(String);
      const primary = realpathSync(root);
      expect(out.find((l) => l.includes('claude mcp add'))).toBe(
        primaryOptedIn ? `      ${codebaseRegisterCommand(primary)}` : undefined,
      );
      if (!primaryOptedIn)
        expect(out).toContain(
          `  ℹ gate reviewers search the primary checkout: run this there too, in ${primary}`,
        );
    } finally {
      log.mockRestore();
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('is off by default (no --search-code → no config)', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes');
    expect(existsSync(join(root, 'search-code.config.json'))).toBe(false);
  });

  it('clean removes the opt-in config + prunes the gitignore line', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes', '--search-code');
    expect(devkit(root, 'clean', '--yes').status).toBe(0);
    expect(existsSync(join(root, 'search-code.config.json'))).toBe(false);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).not.toContain('.search-code/');
  });

  it('syncs the external search-code CLI fallback for commit-guard', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes').status).toBe(0);

    const surfaces = [
      {
        skill: ['.claude', 'skills/commit-guard/SKILL.md'],
        agent: ['.claude', 'agents/commit-guard.md'],
      },
      {
        skill: ['.agents', 'skills/commit-guard/SKILL.md'],
        agent: ['.codex', 'agents/commit-guard.toml'],
      },
      {
        skill: ['.cursor', 'skills/commit-guard/SKILL.md'],
        agent: ['.cursor', 'agents/commit-guard.md'],
      },
    ] as const;

    for (const surface of surfaces) {
      const skill = readFileSync(join(root, ...surface.skill), 'utf8');
      const agent = readFileSync(join(root, ...surface.agent), 'utf8');

      expect(skill).toContain('`search-code search "<text>"`');
      expect(skill).not.toContain('tools/search-code/bin/semantic-search.mjs');
      expect
        .soft(skill, `${surface.skill[0]} semantic boundary`)
        .toContain('Semantic matching is intentionally not run as an advisory pre-push net');
      expect
        .soft(skill, `${surface.skill[0]} stale semantic pre-push guidance`)
        .not.toContain('+ the advisory `.husky/pre-push` net');
      expect(agent).toContain('search-code search');
      expect(agent).toContain('--json');
      expect(agent).not.toContain('tools/search-code/bin/semantic-search.mjs');
    }
  });
});

describe('installSearchCode indexCommand', () => {
  function wired(config: string, dryRun = false, overlay?: { configTracked: boolean }) {
    const root = tmpRepo();
    writeFileSync(join(root, 'guard.config.json'), config);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    installSearchCode(root, dryRun, overlay);
    const out = log.mock.calls.flat().join('\n');
    log.mockRestore();
    return { text: readFileSync(join(root, 'guard.config.json'), 'utf8'), out };
  }

  it('writes the bounded default next to indexPath', () => {
    const { text } = wired('{\n  "guards": ["dup"]\n}\n');
    const cfg = JSON.parse(text);
    expect(cfg.indexPath).toBe('.search-code/index.db');
    expect(cfg.indexCommand).toBe(DEFAULT_INDEX_COMMAND);
  });

  it.each([
    ['a set value', '"search-code index"'],
    ['an explicit null', 'null'],
  ])("keeps %s, the consumer's call", (_, value) => {
    const { text, out } = wired(
      `{\n  "indexPath": ".search-code/index.db",\n  "indexCommand": ${value}\n}\n`,
    );
    expect(text).toBe(
      `{\n  "indexPath": ".search-code/index.db",\n  "indexCommand": ${value}\n}\n`,
    );
    expect(out).toContain('• kept indexCommand');
  });

  it('adds it on a re-run where indexPath already holds the default', () => {
    const { text } = wired('{\n  "indexPath": ".search-code/index.db"\n}\n');
    expect(JSON.parse(text).indexCommand).toBe(DEFAULT_INDEX_COMMAND);
  });

  // A monorepo or custom indexPath is the consumer's: a re-run (doctor --fix included) keeps it.
  it('keeps a configured indexPath and still adds indexCommand', () => {
    const { text, out } = wired('{\n  "indexPath": "idx/index.db"\n}\n');
    expect(JSON.parse(text)).toMatchObject({
      indexPath: 'idx/index.db',
      indexCommand: DEFAULT_INDEX_COMMAND,
    });
    expect(out).toContain('• kept indexPath');
  });

  // An empty path is no path: the matcher would resolve it to the checkout directory.
  it.each(['""', '" "', '"\\t"', '"\\u0020"'])(
    'replaces a blank indexPath (%s) like a null',
    (value) => {
      expect(JSON.parse(wired(`{\n  "indexPath": ${value}\n}\n`).text).indexPath).toBe(
        '.search-code/index.db',
      );
    },
  );

  // The path is judged by its decoded value; an escaped quote is content, kept byte for byte.
  it('keeps a configured indexPath that contains an escaped quote', () => {
    const before = '{\n  "indexPath": "idx/a\\"b.db"\n}\n';
    const { text } = wired(before);
    expect(JSON.parse(text).indexPath).toBe('idx/a"b.db');
  });

  // The insert anchors on a newline after `{`, so a one-line config cannot take it; never claim it did.
  it('says so instead of claiming the key on a one-line config it cannot insert into', () => {
    const { text, out } = wired('{"indexPath": null}\n');
    expect(JSON.parse(text)).toEqual({ indexPath: '.search-code/index.db' });
    expect(out).not.toContain('set indexCommand');
    expect(out).toContain('could not wire indexCommand');
  });

  it('inserts the real key beside a "//indexCommand" guidance key, which stays', () => {
    const cfg = JSON.parse(wired('{\n  "//indexCommand": "why"\n}\n').text);
    expect(cfg['//indexCommand']).toBe('why');
    expect(cfg.indexCommand).toBe(DEFAULT_INDEX_COMMAND);
  });

  // An atomic rename over a link would replace it with a copy and drop the file's mode.
  it('writes through a symlinked guard.config.json and keeps its mode', () => {
    const root = tmpRepo();
    const real = join(root, 'shared-guard.json');
    writeFileSync(real, '{\n  "guards": []\n}\n');
    fs.chmodSync(real, 0o600);
    fs.symlinkSync(real, join(root, 'guard.config.json'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    installSearchCode(root, false);
    expect(fs.lstatSync(join(root, 'guard.config.json')).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, 'utf8')).indexCommand).toBe(DEFAULT_INDEX_COMMAND);
    expect(fs.statSync(real).mode & 0o777).toBe(0o600);
  });

  it('dry-run leaves guard.config.json as it was', () => {
    expect(wired('{\n  "guards": []\n}\n', true).text).toBe('{\n  "guards": []\n}\n');
  });

  it('overlay with a tracked config keeps its bytes and names both env vars', () => {
    const { text, out } = wired('{\n  "guards": []\n}\n', false, { configTracked: true });
    expect(text).toBe('{\n  "guards": []\n}\n');
    expect(out).toContain('GUARD_INDEX_PATH=');
    expect(out).toContain(`GUARD_INDEX_COMMAND='${DEFAULT_INDEX_COMMAND}'`);
  });
});

// The repair end to end: doctor's refresh row is fixable for a search-code selection, and --fix
// re-runs init --search-code, which puts the key back.
describe('doctor --fix and the indexCommand refresh row', () => {
  it('restores a removed indexCommand over a populated index', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes', '--search-code').status).toBe(0);
    const path = join(root, 'guard.config.json');
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    delete cfg.indexCommand;
    writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
    mkdirSync(join(root, '.search-code'), { recursive: true });
    const db = new DatabaseSync(join(root, '.search-code', 'index.db'));
    db.exec('CREATE TABLE chunks (symbol_name TEXT, embedding BLOB, code_embedding BLOB)');
    db.prepare('INSERT INTO chunks VALUES (?, ?, ?)').run(
      'fn',
      new Uint8Array(4),
      new Uint8Array(4),
    );
    db.close();
    expect(devkit(root, 'doctor').stdout).toContain('search-code refresh');
    devkit(root, 'doctor', '--fix');
    expect(JSON.parse(readFileSync(path, 'utf8')).indexCommand).toBe(DEFAULT_INDEX_COMMAND);
  });
});
