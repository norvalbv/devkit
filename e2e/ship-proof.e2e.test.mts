import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MARKERS, out, REPO_ROOT } from './lib/harness.mts';
import { type ShipProof, prepareShipProof } from './lib/ship-proof.mts';

// A dry-gates ship from the installed build, in the consumer `bun run playground --change` uses.
// The playground runs the queued `devkit ship`; this spawns the packaged ship-branch.sh directly, as
// the unit ship tests do, so a real ship holding the machine queue cannot stall the suite.

const changeDirs: string[] = [];
afterAll(() => {
  for (const dir of changeDirs) rmSync(dir, { recursive: true, force: true });
});

function changeDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'devkit-ship-proof-change-'));
  changeDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

function dryGates(proof: ShipProof) {
  const script = join(
    proof.fx.repoDir,
    'node_modules/@norvalbv/devkit/dist/cli/lib/ship/ship-branch.sh',
  );
  return spawnSync('bash', [script, 'proof', 'proof', '--dry-gates', '--', ...proof.paths], {
    cwd: proof.fx.repoDir,
    env: proof.env,
    input: '',
    encoding: 'utf8',
    // A sync spawn blocks vitest's own timeout, so bound it here or a hung ship hangs the suite.
    timeout: 110_000,
  });
}

/** The generic template config with one extra gate that always fails, naming itself. */
function seedWithFailingGate(): string {
  const config = JSON.parse(
    readFileSync(join(REPO_ROOT, 'templates/generic/guard.config.json'), 'utf8'),
  );
  config.extraGates = { 'seed-gate': 'node seed-gate.mjs' };
  return changeDir({
    'guard.config.json': `${JSON.stringify(config, null, 2)}\n`,
    'seed-gate.mjs': 'process.exit(1);\n',
    'README.md': '# seed\n',
  });
}

function sinkHas(file: string, needle: string): boolean {
  return spawnSync('grep', ['-qF', '--', needle, file]).status === 0;
}

describe('e2e: ship proof consumer', () => {
  it('prints the blocked dry-gates ship and leaves nothing behind', async () => {
    // generic caps a folder at 12 files with no exemption, so 13 under src/ trips fan-out.
    const files = Object.fromEntries(
      Array.from({ length: 13 }, (_, i) => [`src/f${i}.ts`, `export const f${i} = ${i};\n`]),
    );
    const proof = await prepareShipProof({ change: changeDir(files) });
    try {
      const ship = dryGates(proof);
      expect(ship.status, out(ship)).toBe(1);
      expect(out(ship)).toContain(MARKERS.fanoutExceeded);
      expect(out(ship)).toContain(MARKERS.shipDetBlocked);
      const shipId = /devkit-ship-hook-start:(\S+)/.exec(out(ship))?.[1];
      expect(shipId, out(ship)).toBeTruthy();
      expect(sinkHas(String(proof.env.DEVKIT_GATE_EVENTS), String(shipId))).toBe(true);
      const machineSink = join(homedir(), '.devkit', 'telemetry', 'gate-events.jsonl');
      if (existsSync(machineSink)) expect(sinkHas(machineSink, String(shipId))).toBe(false);
    } finally {
      proof.cleanup();
    }
    expect(existsSync(proof.fx.repoDir)).toBe(false);
    expect(existsSync(proof.root)).toBe(false);
  });

  it('passes a clean change', async () => {
    const proof = await prepareShipProof({
      change: changeDir({ 'src/util.ts': 'export const util = 1;\n' }),
    });
    try {
      const ship = dryGates(proof);
      expect(ship.status, out(ship)).toBe(0);
    } finally {
      proof.cleanup();
    }
  });

  it('keeps a seeded guard.config.json instead of the one init would write', async () => {
    const proof = await prepareShipProof({
      seed: seedWithFailingGate(),
      change: changeDir({ 'src/util.ts': 'export const util = 1;\n' }),
    });
    try {
      const ship = dryGates(proof);
      expect(ship.status, out(ship)).toBe(1);
      expect(out(ship)).toContain(`${MARKERS.shipDetBlocked}: seed-gate`);
    } finally {
      proof.cleanup();
    }
  });

  it('never copies node_modules or .git from a seed or change into the fixture', async () => {
    const poison = { 'node_modules/poison-pkg/package.json': '{}\n', '.git/poison': 'x\n' };
    const proof = await prepareShipProof({
      seed: changeDir({ ...poison, 'README.md': '# seed\n' }),
      change: changeDir({ ...poison, 'src/util.ts': 'export const util = 1;\n' }),
    });
    try {
      // node_modules is a symlink to the shared cached prefix: a copy into it would poison every run.
      expect(existsSync(join(proof.fx.repoDir, 'node_modules', 'poison-pkg'))).toBe(false);
      expect(existsSync(join(proof.fx.repoDir, '.git', 'poison'))).toBe(false);
      expect(proof.paths).toEqual(['src/util.ts']);
    } finally {
      proof.cleanup();
    }
  });
});
