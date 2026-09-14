import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parentSessionId } from '../../gate-engine/judge/run-context.mts';
import { PARENT_SESSION_SH_FN } from '../lib/husky/commit-terminal.mts';

// The same predicate lives in node (run-context.mts), bash (ship telemetry) and POSIX sh (the
// commit hook). One fixture table through all three keeps a shell row from disagreeing with a node row.
const TELEMETRY_SH = resolve(import.meta.dirname, '../lib/ship/telemetry.sh');

const VALUES = [
  'd323ae68-c68f-4457-b340-e8a7a0a18e80',
  'ok.id_1-2',
  'ok-',
  'a'.repeat(128),
  'a'.repeat(129),
  '',
  'a b',
  'x"y',
  'id\nx',
  'é1',
  '-lead',
  '_lead',
  'a/b',
  'a*b',
  '[x',
  '$(x)',
];

function viaShell(shell: string, script: string, value: string, locale: string): string {
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: locale };
  const r = spawnSync(shell, ['-c', script], {
    env: { ...env, CLAUDE_CODE_SESSION_ID: value },
    encoding: 'utf8',
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

describe('parent_session_id predicate parity (node · bash · sh)', () => {
  for (const locale of ['C', 'en_US.UTF-8']) {
    it.each(VALUES)(`agrees on %j under LC_ALL=${locale}`, (value) => {
      const id = parentSessionId({ CLAUDE_CODE_SESSION_ID: value });
      const expected = id === undefined ? '' : `,"parent_session_id":"${id}"`;
      const bash = `. "${TELEMETRY_SH}"; devkit_parent_session_json`;
      expect(viaShell('/bin/bash', bash, value, locale)).toBe(expected);
      expect(viaShell('sh', `${PARENT_SESSION_SH_FN}\n__dk_parent_session`, value, locale)).toBe(
        expected,
      );
    });
  }
});
