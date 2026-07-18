import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { captureFixture, cleanupCaptureFixtures } from './capture-fixtures.mts';

const hook = fileURLToPath(
  new URL('../../../agents-hooks/plan-critique-evidence.mjs', import.meta.url),
);
const captureModuleParts = [
  'node_modules',
  '@norvalbv',
  'devkit',
  'dist',
  'gate-engine',
  'critique',
  'capture.mjs',
];

function validRuntime(path: string, marker: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    [
      "import { writeFileSync } from 'node:fs';",
      `const marker = ${JSON.stringify(marker)};`,
      'export function captureSubagentStop(provider, input, cwd) {',
      '  writeFileSync(marker, JSON.stringify({ provider, inputCwd: input.cwd, cwd }));',
      '}',
    ].join('\n'),
  );
}

afterEach(() => {
  cleanupCaptureFixtures();
});

describe('plan critique hook runtime discovery', () => {
  it.each([
    'directory',
    'missing-export',
  ] as const)('skips a nearer %s candidate and loads a valid farther ancestor through paths with spaces', (nearerKind) => {
    const { repo } = captureFixture('plan critique hook ');
    const child = join(repo, 'packages', 'app with spaces');
    const marker = join(repo, 'capture marker.json');
    const nearerModule = join(child, ...captureModuleParts);
    const fartherModule = join(repo, ...captureModuleParts);
    mkdirSync(child, { recursive: true });
    validRuntime(fartherModule, marker);
    if (nearerKind === 'directory') mkdirSync(nearerModule, { recursive: true });
    else {
      mkdirSync(dirname(nearerModule), { recursive: true });
      writeFileSync(nearerModule, 'export const unrelated = true;\n');
    }

    execFileSync(process.execPath, [hook, 'codex', 'subagent-stop'], {
      cwd: child,
      input: JSON.stringify({
        cwd: child,
        turn_id: 'turn-child',
        agent_type: 'feature-critique',
        last_assistant_message: '{"kind":"plan_critique"}',
      }),
    });

    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({
      provider: 'codex',
      inputCwd: child,
      cwd: child,
    });
  });
});
