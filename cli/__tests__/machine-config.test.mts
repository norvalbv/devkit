import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { expand, readMachineConfig, slotEnv } from '../lib/machine/config.mts';

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repoWith(config: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'machine-config-'));
  temps.push(dir);
  if (config !== null) writeFileSync(join(dir, 'guard.config.json'), config);
  return dir;
}

const vars = { port: 40010, data: '/m/slot-1/data', profile: '/m/slot-1/profile', slot: 1 };

describe('machine recipe', () => {
  it('is an empty light recipe when guard.config.json or its machine key is absent', () => {
    expect(readMachineConfig(repoWith(null))).toEqual({ mode: 'light' });
    expect(readMachineConfig(repoWith('{"maxLines": 500}'))).toEqual({ mode: 'light' });
  });

  it('reads a mode, command and seed', () => {
    const recipe = {
      machine: {
        mode: 'full',
        command: ['bunx', 'next', 'dev', '-p', '{port}'],
        seed: ['node', 'seed.mjs'],
      },
    };
    expect(readMachineConfig(repoWith(JSON.stringify(recipe)))).toEqual(recipe.machine);
  });

  it('refuses a malformed recipe instead of guessing', () => {
    expect(() => readMachineConfig(repoWith('{"machine": {"command": "next dev"}}'))).toThrow();
    expect(() => readMachineConfig(repoWith('{"machine": {"comand": ["x"]}}'))).toThrow();
    expect(() => readMachineConfig(repoWith('{"machine": {"electron": {"main": "x"}}}'))).toThrow();
    expect(() => readMachineConfig(repoWith('{"machine": {"mode": "vm"}}'))).toThrow();
  });

  it('holds no env, because guard.config.json may be committed with any secret in it', () => {
    const recipe = '{"machine": {"command": ["next", "dev"], "env": {"API_KEY": "x"}}}';
    expect(() => readMachineConfig(repoWith(recipe))).toThrow(
      'may be committed, so it holds no env',
    );
  });

  it("expands the slot's own port, data, profile and slot number", () => {
    expect(expand('-p {port} --db {data}/x.db --profile {profile} #{slot}', vars)).toBe(
      '-p 40010 --db /m/slot-1/data/x.db --profile /m/slot-1/profile #1',
    );
  });

  it('gives the app PORT and the DEVKIT_MACHINE_* names, and nothing from the recipe', () => {
    expect(slotEnv(vars)).toEqual({
      PORT: '40010',
      DEVKIT_MACHINE_SLOT: '1',
      DEVKIT_MACHINE_URL: 'http://127.0.0.1:40010',
      DEVKIT_MACHINE_DATA: '/m/slot-1/data',
      DEVKIT_MACHINE_PROFILE: '/m/slot-1/profile',
    });
  });
});
