import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writesToRepo } from '../shell-writes.mts';

// Under os.tmpdir() on purpose: a repo inside temp space must still count its own writes.
const root = mkdtempSync(join(tmpdir(), 'shell-writes-root-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const writes = (command: string) => writesToRepo(command, root, root);

describe('writesToRepo — commands that write files', () => {
  it.each([
    'echo hi > src/a.ts',
    'printf x >> notes.md',
    'cat <<EOF > notes.md\nbody\nEOF',
    '{ echo a; } > grouped.txt',
    "sed -i '' 's/a/b/' src/a.ts",
    'perl -pi -e "s/a/b/" src/a.ts',
    "rg -l foo src | xargs sed -i '' 's/foo/bar/g'",
    "find src -name '*.ts' -exec sed -i '' 's/a/b/' {} +",
    'bun run build | tee build.log',
    'touch src/new.ts',
    'mv src/a.ts src/b.ts',
    'patch -p1 < fix.patch',
    'git -C ../wt apply fix.patch',
    "python3 - <<'PY'\nopen('a', 'w').write('b')\nPY",
    'python3 <<<"print(1)"',
    'node --input-type=module -e "1"',
    'bash -c "echo x > d.txt"',
    'cd sub && echo x > y.ts',
  ])('%s', (command) => {
    expect(writes(command)).toBe(true);
  });
});

it('expands ~ to the home directory instead of a path under cwd', () => {
  // The suite's HOME is a temp dir, so an unexpanded `~` would land inside root and flip this.
  expect(writes('echo x > ~/notes.md')).toBe(writes(`echo x > ${join(homedir(), 'notes.md')}`));
});

describe('writesToRepo — commands that do not', () => {
  it.each([
    'git status',
    'sed -n 1,5p src/a.ts',
    'ls 2>/dev/null',
    'bun test 2>&1',
    'bun run build 2>&1 | tee /tmp/build.log',
    "sed -i '' 's/a/b/' /tmp/scratch.txt",
    'cp src/a.ts /tmp/',
    'echo x > "$OUT"',
    'node scripts/gen.mjs',
    'gh pr view 1 --json body | python3 -c "import json"',
    'V=$(node -p 1); echo "$V"',
    'echo "unterminated > e.txt',
  ])('%s', (command) => {
    expect(writes(command)).toBe(false);
  });
});
