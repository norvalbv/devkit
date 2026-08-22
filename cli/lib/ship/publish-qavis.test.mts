import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const helper = fileURLToPath(new URL('./publish-qavis.sh', import.meta.url));
let root: string;
let bin: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'publish-qavis-'));
  bin = join(root, 'bin');
  mkdirSync(bin);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function stubQavis(script: string): void {
  writeFileSync(join(bin, 'qavis'), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, 'qavis'), 0o755);
}

function run() {
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      'source "$QAVIS_HELPER"; publish_qavis_receipt "$@"',
      'bash',
      root,
      '42',
      'base',
      'head',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, QAVIS_HELPER: helper },
    },
  );
}

describe('publish_qavis_receipt', () => {
  it('passes the exact repository, PR, and shipped range to Qavis', () => {
    mkdirSync(join(root, '.qavis'));
    writeFileSync(join(root, '.qavis/receipt.json'), '{}');
    const capture = join(root, 'args');
    stubQavis(`printf '%s\\n' "$@" > ${JSON.stringify(capture)}\necho '{"status":"published"}'`);

    const result = run();

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(capture, 'utf8').trim().split('\n')).toEqual([
      'publish',
      '--pr',
      '42',
      '--repo',
      root,
      '--base',
      'base',
      '--head',
      'head',
    ]);
  });

  it('does nothing when there is no receipt', () => {
    const called = join(root, 'called');
    stubQavis(`touch ${JSON.stringify(called)}`);
    expect(run().status).toBe(0);
    expect(existsSync(called)).toBe(false);
  });

  it('keeps a completed ship successful and prints the retry when publication fails', () => {
    mkdirSync(join(root, '.qavis'));
    writeFileSync(join(root, '.qavis/receipt.json'), '{}');
    stubQavis(`echo '{"status":"failed"}'\nexit 2`);
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('PR opened/pushed, but evidence publication failed');
    expect(result.stderr).toContain('qavis publish --pr');
  });
});
