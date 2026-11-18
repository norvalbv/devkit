import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PREPARATION, ROOT, sourceSnapshot } from '../manifest.mts';

export function comparisonFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'comparison-frozen-'));
  const snapshot = sourceSnapshot(path.join(ROOT, PREPARATION));
  symlinkSync(path.join(ROOT, '.git'), path.join(root, '.git'));
  for (const [file, text] of Object.entries(snapshot)) {
    const destination = path.join(root, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    const bytes = file.endsWith('cases-correctness.jsonl')
      ? readFileSync(path.join(ROOT, file))
      : text;
    writeFileSync(destination, bytes);
  }
  mkdirSync(path.dirname(path.join(root, PREPARATION)), { recursive: true });
  cpSync(path.join(ROOT, PREPARATION), path.join(root, PREPARATION), { recursive: true });
  return { root, snapshot, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
