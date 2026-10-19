/** `devkit coverage-run` warns about uninstalled root dependencies before anything else. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import coverageRun from './run.mts';

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('prints the root dependency warning before it does anything else', async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'coverage-run-')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { helmet: '1' } }));
  const printed: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((line) => void printed.push(line));
  try {
    expect(await coverageRun([], root)).toBe(1);
  } finally {
    spy.mockRestore();
  }
  expect(printed[0]).toBe('⚠️  1 declared dependency is not installed: helmet');
  expect(printed.some((line) => line.includes('needs vitest'))).toBe(true);
});
