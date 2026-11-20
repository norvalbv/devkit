import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  codebaseRegisterCommand,
  codebaseRemedy,
  SEARCH_CODE_CONFIG,
} from '../mcp/registration-remedy.mts';

const base = mkdtempSync(path.join(tmpdir(), 'registration-remedy-'));
const home = path.join(base, 'home');
mkdirSync(home);
const claudeRegistry = path.join(realpathSync(home), '.claude.json');
writeFileSync(claudeRegistry, '{}');
afterAll(() => rmSync(base, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

function repoAt(name: string, optedIn: boolean): string {
  const dir = path.join(base, name);
  mkdirSync(dir);
  if (optedIn) writeFileSync(path.join(dir, SEARCH_CODE_CONFIG), '{}\n');
  return dir;
}

describe('codebaseRegisterCommand', () => {
  it('pastes as-is: a root with spaces and a quote cds, pins, and drops CLAUDE_CONFIG_DIR', () => {
    const dir = repoAt("Personal and learning's devkit", true);
    const bin = path.join(base, 'bin');
    mkdirSync(bin);
    const stub = 'pwd -P; printf "%s\\n" "${CLAUDE_CONFIG_DIR-unset}" "$@"';
    writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n${stub}\n`, { mode: 0o755 });
    const out = spawnSync('/bin/sh', ['-c', codebaseRegisterCommand(dir)], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: '/decoy' },
    }).stdout;
    expect(out.trimEnd().split('\n')).toEqual([
      realpathSync(dir),
      'unset',
      ...['mcp', 'add', '-s', 'local', 'codebase', '-e', `SEMANTIC_SEARCH_ROOT=${dir}`],
      ...['--', 'search-code', 'serve'],
    ]);
  });

  it('writes ~/.claude.json even under CLAUDE_CONFIG_DIR, with the name before -e', () => {
    expect(codebaseRegisterCommand('/repo')).toBe(
      'cd /repo && env -u CLAUDE_CONFIG_DIR claude mcp add -s local codebase -e SEMANTIC_SEARCH_ROOT=/repo -- search-code serve',
    );
  });
});

describe('codebaseRemedy', () => {
  it('a repo search-code never indexed opts in before it registers', () => {
    vi.stubEnv('HOME', home);
    const dir = repoAt('plain', false);
    expect(codebaseRemedy(dir, claudeRegistry)).toMatch(
      /^opt this repo into search-code first \(`devkit init --search-code`, then `search-code index`\), then run `cd /,
    );
  });

  it('an opted-in repo gets the command, plus the disabledMcpServers step it does not cover', () => {
    vi.stubEnv('HOME', home);
    const dir = repoAt('opted', true);
    expect(codebaseRemedy(dir, claudeRegistry)).toBe(
      `run \`${codebaseRegisterCommand(dir)}\`, and remove \`codebase\` from this project's \`disabledMcpServers\` in ${claudeRegistry} if it is listed there`,
    );
  });

  it('an explicit registry gets no claude mcp command, which would write ~/.claude.json instead', () => {
    vi.stubEnv('HOME', home);
    const dir = repoAt('explicit', true);
    expect(codebaseRemedy(dir, '/etc/judge-mcp.json')).toBe(
      "add the `codebase` MCP server for this project in /etc/judge-mcp.json, or remove it from that project's `disabledMcpServers`",
    );
  });
});
