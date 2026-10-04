import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { moveContext } from './rewrite-plan.mts';
import { rewriteFile } from './write.mts';

const BOM = '﻿';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'move-write-'));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

describe('rewriteFile', () => {
  it('rewrites what the file holds now, keeping an edit nobody planned for', () => {
    // disk is post-move: util is already at lib/, and use.ts gained a line after the move began
    const root = tree({
      'lib/util.ts': 'export const u = 1;\n',
      'src/use.ts': "import { u } from './util';\nexport const added = u + 1;\n",
    });
    const moves = [{ oldAbs: join(root, 'src/util.ts'), newAbs: join(root, 'lib/util.ts') }];
    const ctx = moveContext({}, [], moves, [join(root, 'src/util.ts'), join(root, 'src/use.ts')]);

    const out = rewriteFile(join(root, 'src/use.ts'), join(root, 'src/use.ts'), ctx);
    expect(out.rewrites).toBe(1);
    expect(readFileSync(join(root, 'src/use.ts'), 'utf8')).toBe(
      "import { u } from '../lib/util';\nexport const added = u + 1;\n",
    );
  });

  it('keeps a BOM, and does not touch a file that needs nothing', () => {
    const root = tree({
      'lib/util.ts': '',
      'src/use.ts': `${BOM}import './util';\n`,
      'src/other.ts': "import './use';\n",
    });
    const moves = [{ oldAbs: join(root, 'src/util.ts'), newAbs: join(root, 'lib/util.ts') }];
    const files = ['src/util.ts', 'src/use.ts', 'src/other.ts'].map((f) => join(root, f));
    const ctx = moveContext({}, [], moves, files);

    rewriteFile(join(root, 'src/use.ts'), join(root, 'src/use.ts'), ctx);
    expect(readFileSync(join(root, 'src/use.ts'), 'utf8')).toBe(`${BOM}import '../lib/util';\n`);

    const other = join(root, 'src/other.ts');
    const before = statSync(other).mtimeMs;
    expect(rewriteFile(other, other, ctx).text).toBeNull();
    expect(statSync(other).mtimeMs).toBe(before);
  });
});
