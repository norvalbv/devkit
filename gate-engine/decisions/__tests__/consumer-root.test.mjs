import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// W-3 proof: when the engine runs with cwd set to a CONSUMER fixture dir, it must resolve every
// path (the decision log, the INDEX, the vec cache) against THAT cwd via the consumer's
// guard.config.json — NEVER against the package dir. This is the load-bearing portability invariant:
// shipped inside a consumer's node_modules, the engine scans the consumer's repo, not the package.

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const PACKAGE_DIR = dirname(fileURLToPath(new URL('../decisions.mjs', import.meta.url)));

let consumer;
beforeEach(() => {
  consumer = mkdtempSync(join(tmpdir(), 'consumer-repo-'));
});
afterEach(() => rmSync(consumer, { recursive: true, force: true }));

// Run the guard-decisions CLI as a consumer would: from the consumer repo root, with NO env
// override of the decisions dir — the config must come from <cwd>/guard.config.json alone.
const inConsumer = (args, env = {}) =>
  spawnSync('node', [CLI, ...args], {
    cwd: consumer,
    encoding: 'utf8',
    env: {
      ...process.env,
      // Strip any GUARD_*/FRINK_*/DECISIONS_* leakage so resolution is driven purely by cwd + the
      // consumer's guard.config.json — the whole point of the W-3 proof.
      GUARD_DECISIONS_DIR: undefined,
      FRINK_DECISIONS_DIR: undefined,
      DECISIONS_TODAY: '2026-05-29',
      DECISIONS_NO_EMBED: '1',
      ...env,
    },
  });

describe('consumer-root resolution (W-3)', () => {
  it('writes the decision log under the CONSUMER cwd (from its guard.config.json), not the package dir', () => {
    // The consumer relocates its decision log to a non-default path purely via guard.config.json.
    writeFileSync(
      join(consumer, 'guard.config.json'),
      JSON.stringify({ decisionsDir: 'governance/adr' }),
    );

    const r = inConsumer([
      'add',
      'transport',
      '--target',
      '--context',
      'transport scaling broke under load',
      '--ruling',
      'http-proxy',
      '--consequences',
      'reliable transport',
      '--tradeoff',
      'one extra network hop',
      '--vision-fit',
      'n/a — internal tooling',
      '--new',
    ]);
    expect(r.status).toBe(0);

    // Resolved against the CONSUMER cwd, at the config-declared path.
    const logFile = join(consumer, 'governance', 'adr', 'transport.md');
    const indexFile = join(consumer, 'governance', 'adr', 'INDEX.md');
    expect(existsSync(logFile)).toBe(true);
    expect(existsSync(indexFile)).toBe(true);
    expect(readFileSync(logFile, 'utf8')).toContain('**Ruling:** http-proxy');
    expect(readFileSync(indexFile, 'utf8')).toContain('http-proxy');

    // It must NOT have written into the package dir (the negative half of the invariant).
    expect(existsSync(join(PACKAGE_DIR, 'governance'))).toBe(false);
    expect(existsSync(join(PACKAGE_DIR, 'docs'))).toBe(false);
    expect(readdirSync(PACKAGE_DIR)).not.toContain('transport.md');
    expect(readdirSync(PACKAGE_DIR)).not.toContain('INDEX.md');
  });

  it('query reads back the decision log from the consumer cwd (round-trips through config)', () => {
    writeFileSync(
      join(consumer, 'guard.config.json'),
      JSON.stringify({ decisionsDir: 'governance/adr' }),
    );
    inConsumer([
      'add',
      'transport',
      '--target',
      '--context',
      'transport scaling broke under load',
      '--ruling',
      'http-proxy lifecycle',
      '--consequences',
      'reliable transport',
      '--tradeoff',
      'one extra network hop',
      '--vision-fit',
      'n/a',
      '--new',
    ]);
    const q = inConsumer(['query', 'transport proxy lifecycle'], {
      DECISIONS_INDEX: join(consumer, '.decisions', 'index.json'),
    });
    expect(q.status).toBe(0);
    expect(q.stdout).toContain('transport');
  });
});
