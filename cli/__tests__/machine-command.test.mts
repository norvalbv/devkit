import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import machine, { meta } from '../commands/machine/machine.mts';
import { evidenceDir } from '../lib/machine/manifest.mts';

const temps: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'machine-command-'));
  temps.push(root);
  execFileSync('git', ['init', '-q', root]);
  return root;
}

function errors(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((line: string) => void lines.push(line));
  return lines;
}

describe('devkit machine', () => {
  it('prints its help and fails on an unknown or missing verb', async () => {
    const said = errors();
    expect(await machine([], repo())).toBe(1);
    expect(await machine(['start'], repo())).toBe(1);
    expect(said.join('\n')).toContain('devkit machine up');
    expect(meta.agentFacing).toBe(true);
  });

  it('tells the agent to run `up` first when this worktree has no machine', async () => {
    const said = errors();
    const root = repo();
    expect(await machine(['env'], root)).toBe(1);
    expect(await machine(['run', 'flow.mjs'], root)).toBe(1);
    expect(said.filter((line) => line.includes('run `devkit machine up` first'))).toHaveLength(2);
  });

  it('sends exec and screenshot to `up` first too, and asks exec for a command', async () => {
    const said = errors();
    const root = repo();
    expect(await machine(['exec', '--', 'xdotool', 'key', 'Return'], root)).toBe(1);
    expect(await machine(['screenshot'], root)).toBe(1);
    expect(await machine(['exec'], root)).toBe(1);
    expect(said.filter((line) => line.includes('run `devkit machine up` first'))).toHaveLength(2);
    expect(said.join('\n')).toContain('usage: devkit machine exec [-d] -- <command…>');
  });

  it('refuses full mode, before leasing a slot, when no container engine answers', async () => {
    const said = errors();
    const bin = mkdtempSync(join(tmpdir(), 'machine-no-docker-'));
    temps.push(bin);
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    const root = repo();
    expect(await machine(['up', '--full'], root)).toBe(1);
    writeFileSync(join(root, 'guard.config.json'), '{"machine": {"mode": "full"}}');
    expect(await machine(['up'], root)).toBe(1);
    expect(said.filter((line) => line.includes('full mode needs Docker Desktop'))).toHaveLength(2);
    expect(await machine(['env'], root)).toBe(1);
  });

  it('refuses both mode flags, or an unknown one, before leasing a slot', async () => {
    const said = errors();
    const root = repo();
    for (const args of [['--light', '--full'], ['--full=1'], ['--FULL'], ['-f']])
      expect(await machine(['up', ...args], root)).toBe(1);
    const usage = said.filter((line) => line.includes('usage: devkit machine up [--full|--light]'));
    expect(usage).toHaveLength(4);
    expect(await machine(['env'], root)).toBe(1);
  });

  it('asks for a flow file when run is given none', async () => {
    const said = errors();
    expect(await machine(['run'], repo())).toBe(1);
    expect(said.join('\n')).toContain('usage: devkit machine run <flow.mjs>');
  });

  it("deletes this worktree's captures on clear", async () => {
    errors();
    const root = repo();
    const dir = evidenceDir(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), '{"entries": []}');
    writeFileSync(join(dir, 'flow.webm'), 'x');
    expect(await machine(['clear'], root)).toBe(0);
    expect(existsSync(join(dir, 'manifest.json'))).toBe(false);
    expect(existsSync(join(dir, 'flow.webm'))).toBe(false);
  });
});
