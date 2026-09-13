import { execFileSync } from 'node:child_process';
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
import { z } from 'zod';
import { PREPARATION, ROOT } from '../manifest.mts';

export function comparisonFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'comparison-frozen-'));
  const protocol = z
    .object({
      sourceRevision: z.string(),
      sourceFilesSha256: z.record(z.string(), z.string()),
    })
    .parse(JSON.parse(readFileSync(path.join(ROOT, PREPARATION, 'protocol.json'), 'utf8')));
  symlinkSync(path.join(ROOT, '.git'), path.join(root, '.git'));
  for (const file of Object.keys(protocol.sourceFilesSha256)) {
    const destination = path.join(root, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    const bytes = file.endsWith('cases-correctness.jsonl')
      ? readFileSync(path.join(ROOT, file))
      : execFileSync('git', ['show', `${protocol.sourceRevision}:${file}`], {
          cwd: ROOT,
          maxBuffer: 10 * 1024 * 1024,
        });
    writeFileSync(destination, bytes);
  }
  mkdirSync(path.dirname(path.join(root, PREPARATION)), { recursive: true });
  cpSync(path.join(ROOT, PREPARATION), path.join(root, PREPARATION), { recursive: true });
  return { root, protocol, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
