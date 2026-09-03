// The SHIPPED electron template's placement walls (project-structure/folder-structure), linted
// end-to-end: real template + real plugin + a domain registry, against a fixture tree. The
// compile/walk suites pin the config-driven engine's grammar; nothing else lints the template
// itself, and its socket-server/vercel branches — gated by guard.config.json `backends` — had no
// coverage at all (the import-wall fixture switches both off).
//
// The fixture owns its own node_modules symlink so the plugin, which derives its project root from
// its OWN resolved module path, roots HERE rather than in the devkit checkout that holds the real
// dependencies. That is why eslint is spawned through `--preserve-symlinks`, the same way
// gate-engine/structure/run.mts spawns it.
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';

const DEVKIT_ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '../..'));
const RULE = 'project-structure/folder-structure';

// A registry with a domain in EVERY tree, so "registered passes / unregistered fails" is asserted
// per tree. The shipped domains.mjs seeds only the renderer array, which cannot express that.
const DOMAINS = `export const RENDERER_LIB_DOMAINS = ['tasks'];
export const MAIN_ROOT_FOLDERS = ['lib', 'windows'];
export const MAIN_LIB_DOMAINS = ['queue'];
export const SOCKET_LIB_DOMAINS = ['flows'];
export const VERCEL_LIB_DOMAINS = ['parsers'];
`;

const BLOCKED = [
  'src/renderer/lib/flat-file.ts',
  'src/renderer/lib/junk-drawer/probe.ts',
  'src/renderer/utils/frozen-add.ts',
  'src/main/lib/flat-file.ts',
  'socket-server/src/lib/flat-file.ts',
  'vercel-serverless/lib/flat-file.ts',
];

const ALLOWED = [
  'src/renderer/lib/tasks/registered.ts',
  'src/main/lib/queue/index.ts',
  'socket-server/src/lib/flows/registered.ts',
  'socket-server/src/api/routes/health.ts',
  'vercel-serverless/api/cron/sweep.ts',
  'vercel-serverless/api/triggers/shortcut/[storyId].ts',
  'vercel-serverless/_shared/mirror.ts',
];

const PROBES = [...BLOCKED, ...ALLOWED];

function write(root: string, relativePath: string, content = 'export {};\n') {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeFixture(root: string) {
  symlinkSync(join(DEVKIT_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  write(root, 'package.json', '{"type":"module"}\n');
  write(
    root,
    'guard.config.json',
    JSON.stringify({ scanRoots: ['src'], backends: { socketServer: true, vercel: true } }),
  );
  copyFileSync(
    join(DEVKIT_ROOT, 'templates/electron/eslint.config.mjs'),
    join(root, 'eslint.config.mjs'),
  );
  write(root, 'eslint/domains.mjs', DOMAINS);
  write(root, 'src/main/index.ts'); // src/main declares enforceExistence: 'index.ts'
  for (const probe of PROBES) write(root, probe);
}

function collectStructureErrors(root: string) {
  const result = spawnSync(
    process.execPath,
    [
      '--preserve-symlinks',
      join(root, 'node_modules', 'eslint', 'bin', 'eslint.js'),
      '--format',
      'json',
      ...PROBES,
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  // 0 (clean) and 1 (lint errors) are the only statuses that mean eslint ran to completion; a
  // config fault exits 2 with the diagnosis on stderr, and a signal kill can flush partial JSON.
  if (![0, 1].includes(result.status) || !result.stdout) {
    throw new Error(`eslint did not run (status ${result.status}): ${result.stderr}`);
  }
  const errors = new Map<string, number>(
    JSON.parse(result.stdout).map((file) => [
      relative(root, file.filePath).replaceAll('\\', '/'),
      (file.messages ?? []).filter((message) => message.ruleId === RULE).length,
    ]),
  );
  const unreported = PROBES.filter((probe) => !errors.has(probe));
  if (unreported.length) {
    throw new Error(
      `ESLint never reported on ${unreported.length} probe(s), so their expectations prove ` +
        `nothing: ${unreported.join(', ')}`,
    );
  }
  if ([...errors.values()].every((count) => count === 0)) {
    throw new Error(
      `${RULE} reported nothing on ANY probe, so the placement walls never ran. The structure ` +
        'plugin resolved a project root outside this fixture — typically a symlinked node_modules ' +
        'realpath-escaping to the owning checkout. Spawn eslint the way ' +
        'gate-engine/structure/run.mts does (--preserve-symlinks, bin resolved from the fixture).',
    );
  }
  return errors;
}

describe('shipped Electron placement walls', () => {
  let root = '';
  let errors: Map<string, number>;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'electron-folder-structure-')));
    writeFixture(root);
    errors = collectStructureErrors(root);
  }, 120_000);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it.each(BLOCKED)('blocks %s', (probe) => {
    expect(errors.get(probe)).toBeGreaterThan(0);
  });

  it.each(ALLOWED)('allows %s', (probe) => {
    expect(errors.get(probe)).toBe(0);
  });
});
