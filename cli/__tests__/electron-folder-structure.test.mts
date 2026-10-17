// The SHIPPED electron template's placement walls (project-structure/folder-structure), linted
// end-to-end: real template + real plugin + a domain registry, against a fixture tree. The
// compile/walk suites pin the config-driven engine's grammar; nothing else lints the template
// itself, and its socket-server/vercel branches — gated by guard.config.json `backends` — had no
// coverage at all (the import-wall fixture switches both off).
//
// The fixture links node_modules and eslint runs WITHOUT --preserve-symlinks, so the plugin roots
// in the devkit checkout: the template itself must re-root folder-structure at the fixture.
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

const GUARD_CONFIG = JSON.stringify({
  scanRoots: ['src'],
  backends: { socketServer: true, vercel: true },
});

function write(root: string, relativePath: string, content = 'export {};\n') {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// Everything ESLint needs to load the template from `dir`.
function writeConfig(dir: string) {
  symlinkSync(join(DEVKIT_ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  write(dir, 'package.json', '{"type":"module"}\n');
  write(dir, 'guard.config.json', GUARD_CONFIG);
  copyFileSync(
    join(DEVKIT_ROOT, 'templates/electron/eslint.config.mjs'),
    join(dir, 'eslint.config.mjs'),
  );
  write(dir, 'eslint/domains.mjs', DOMAINS);
}

function writeFixture(root: string) {
  writeConfig(root);
  write(root, 'src/main/index.ts'); // src/main declares enforceExistence: 'index.ts'
  for (const probe of PROBES) write(root, probe);
}

function collectStructureErrors(root: string, invocation: Invocation) {
  const { cwd, args } = invocation.spawn(root);
  const result = spawnSync(
    process.execPath,
    [
      ...invocation.nodeFlags,
      join(root, 'node_modules', 'eslint', 'bin', 'eslint.js'),
      ...args,
      '--format',
      'json',
      ...PROBES.map((probe) => join(root, probe)),
    ],
    { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
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
        "plugin roots at the directory above its own node_modules: check each rule's projectRoot " +
        'in templates/electron/eslint.config.mjs.',
    );
  }
  return errors;
}

type Invocation = {
  name: string;
  nodeFlags: string[];
  fixturePrefix?: string;
  spawn: (root: string) => { cwd: string; args: string[] };
};

// A config holding only the template, so its directory is unrelated to the tree under lint.
function writeDetachedConfig() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'electron-folder-structure-config-')));
  writeConfig(dir);
  return dir;
}

const detachedConfigs: string[] = [];

// Each row is a distinct way ESLint meets the template; every row must judge the fixture itself.
const INVOCATIONS: Invocation[] = [
  { name: 'from the package root', nodeFlags: [], spawn: (root) => ({ cwd: root, args: [] }) },
  {
    // The fixture's own linked node_modules becomes the plugin root, so the offset is '.'.
    name: 'under --preserve-symlinks',
    nodeFlags: ['--preserve-symlinks'],
    spawn: (root) => ({ cwd: root, args: [] }),
  },
  {
    name: 'from a subdirectory of the package',
    nodeFlags: [],
    spawn: (root) => ({ cwd: join(root, 'src'), args: [] }),
  },
  {
    name: 'from an ancestor of the package (an editor opened at a monorepo root)',
    nodeFlags: [],
    // A package dir named '..x' must still read as INSIDE cwd, not as a path climbing out of it.
    fixturePrefix: '..electron-folder-structure-',
    spawn: (root) => ({ cwd: dirname(root), args: [] }),
  },
  {
    name: "with a config from an unrelated checkout (review's merge-base run)",
    nodeFlags: [],
    spawn: (root) => {
      const dir = writeDetachedConfig();
      detachedConfigs.push(dir);
      return { cwd: root, args: ['--config', join(dir, 'eslint.config.mjs')] };
    },
  },
];

describe.each(INVOCATIONS)('shipped Electron placement walls, eslint run $name', (invocation) => {
  let root = '';
  let errors: Map<string, number>;

  beforeAll(() => {
    const prefix = invocation.fixturePrefix ?? 'electron-folder-structure-';
    root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    writeFixture(root);
    errors = collectStructureErrors(root, invocation);
  }, 120_000);

  afterAll(() => {
    for (const dir of [root, ...detachedConfigs.splice(0)]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(BLOCKED)('blocks %s', (probe) => {
    expect(errors.get(probe)).toBeGreaterThan(0);
  });

  it.each(ALLOWED)('allows %s', (probe) => {
    expect(errors.get(probe)).toBe(0);
  });
});
