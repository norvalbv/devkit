/** Package and standalone consumers format with devkit's pinned Oxfmt under the starter devkit writes,
 *  so a staged file comes out in the starter's style and a Biome-era `{}` starter is refreshed. */
import { execFileSync, spawnSync } from 'node:child_process';
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeSelection } from '../lib/components.mts';
import { digest } from '../lib/fs-helpers.mts';
import { buildGuardBlock } from '../lib/husky/husky-block.mts';
import { syncOxcCapability } from '../lib/install/oxc/lifecycle.mts';
import {
  OXFMT_STARTER,
  OXLINT_STARTER,
  retiredBiomeNotice,
} from '../lib/install/oxc/root-configs.mts';
import { resolveOxcRuntime } from '../lib/install/oxc/runtime.mts';

const REPO = join(import.meta.dirname, '..', '..');
const CLI = join(REPO, 'cli', 'index.mts');
const dirs: string[] = [];
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const oxfmtStep = (binDir: 'package' | 'global-optional') =>
  buildGuardBlock({ guards: [] }, '', { binDir }).match(
    /# devkit:format[\s\S]*?# \/devkit:format/,
  )?.[0] ?? '';

/** A git repo with the starter, staged `files`, and a bin dir whose `devkit` is this checkout. */
function consumerRepo(files: Record<string, string>) {
  const repo = tempDir('dk-consumer-oxfmt-');
  const bin = tempDir('dk-consumer-bin-');
  writeFileSync(join(bin, 'devkit'), `#!/bin/sh\nexec node "${CLI}" "$@"\n`);
  chmodSync(join(bin, 'devkit'), 0o755);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  writeFileSync(join(repo, '.oxfmtrc.json'), OXFMT_STARTER);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(repo, name, '..'), { recursive: true });
    writeFileSync(join(repo, name), body);
    git('add', name);
  }
  return { repo, bin, git };
}

function runStep(repo: string, bin: string, binDir: 'package' | 'global-optional') {
  const hook = join(tempDir('dk-consumer-hook-'), 'pre-commit');
  writeFileSync(hook, `__dk_package_bin_dir="${bin}"\n${oxfmtStep(binDir)}\nexit 0\n`);
  const r = spawnSync('sh', ['-e', hook], { cwd: repo, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("the consumer format step runs devkit's pinned Oxfmt", () => {
  for (const binDir of ['package', 'global-optional'] as const) {
    it(`${binDir}: formats staged TS to single quotes and keeps CSS strings double`, () => {
      const { repo, bin, git } = consumerRepo({
        'src/a.ts': 'const a  =  {b:"x"}\n',
        'src/a.css': 'a { font-family: "Inter"; }\n',
      });
      const r = runStep(repo, bin, binDir);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('🎨 oxfmt formatted and re-staged 2 staged file(s).');
      expect(git('show', ':src/a.ts')).toBe("const a = { b: 'x' };\n");
      expect(git('show', ':src/a.css')).toBe('a {\n  font-family: "Inter";\n}\n');
    });
  }

  // Explicit paths bypass discovery, so only the starter's ignorePatterns keep devkit-managed bytes
  // (digested manifests, the baseline) from being rewritten under their recorded digests.
  it("leaves staged devkit-managed files byte-identical: the starter's ignores hold for explicit paths", () => {
    const managed = '{"a":[1,\n2]}\n';
    const { repo, bin, git } = consumerRepo({
      '.devkit/oxc/manifest.json': managed,
      '.anti-slop-baseline.json': managed,
    });
    const r = runStep(repo, bin, 'package');
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toContain('failed');
    expect(git('show', ':.devkit/oxc/manifest.json')).toBe(managed);
    expect(git('show', ':.anti-slop-baseline.json')).toBe(managed);
  });

  it('stands down without an Oxfmt config, which is how a consumer opts out', () => {
    const { repo, bin, git } = consumerRepo({ 'a.ts': 'const a  =  1\n' });
    rmSync(join(repo, '.oxfmtrc.json'));
    const r = runStep(repo, bin, 'package');
    expect(r.out).toContain('🎨 No formatter config here');
    expect(git('show', ':a.ts')).toBe('const a  =  1\n');
  });
});

describe('the starters devkit writes', () => {
  it('are byte-stable under the Oxfmt that formats them, so a staged starter keeps its digest', () => {
    const dir = tempDir('dk-starter-stable-');
    writeFileSync(join(dir, '.oxfmtrc.json'), OXFMT_STARTER);
    writeFileSync(join(dir, '.oxlintrc.json'), OXLINT_STARTER);
    const oxfmt = resolveOxcRuntime('fmt').binPath;
    const r = spawnSync(process.execPath, [oxfmt, '--check', '.oxfmtrc.json', '.oxlintrc.json'], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  });
});

describe('refreshing a Biome-era `{}` Oxfmt starter', () => {
  /** A consumer synced by an older devkit: its unedited `.oxfmtrc.json` is the old `{}` starter. */
  function legacyConsumer() {
    const root = tempDir('dk-oxfmt-refresh-');
    syncOxcCapability(root);
    writeFileSync(join(root, '.oxfmtrc.json'), '{}\n');
    const manifestPath = join(root, '.devkit/oxc/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.configs.oxfmt.createdDigest = digest('{}\n');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return root;
  }
  const oxfmtrc = (root: string) => readFileSync(join(root, '.oxfmtrc.json'), 'utf8');

  it('install paths rewrite the unedited starter and record its new digest', () => {
    const root = legacyConsumer();
    syncOxcCapability(root, { refreshStarters: true });
    expect(oxfmtrc(root)).toBe(OXFMT_STARTER);
    const manifest = JSON.parse(readFileSync(join(root, '.devkit/oxc/manifest.json'), 'utf8'));
    expect(manifest.configs.oxfmt.createdDigest).toBe(digest(OXFMT_STARTER));
  });

  it("ship's managed refresh (no refreshStarters) leaves the committed config byte-identical", () => {
    const root = legacyConsumer();
    syncOxcCapability(root);
    expect(oxfmtrc(root)).toBe('{}\n');
  });

  it('a starter the consumer edited is preserved', () => {
    const root = legacyConsumer();
    writeFileSync(join(root, '.oxfmtrc.json'), '{ "ignorePatterns": ["**"] }\n');
    syncOxcCapability(root, { refreshStarters: true });
    expect(oxfmtrc(root)).toBe('{ "ignorePatterns": ["**"] }\n');
  });

  it('a config the consumer brought (adopted, never created by devkit) is never refreshed', () => {
    const root = tempDir('dk-oxfmt-adopted-');
    writeFileSync(join(root, '.oxfmtrc.json'), '{}\n');
    syncOxcCapability(root);
    syncOxcCapability(root, { refreshStarters: true });
    expect(oxfmtrc(root)).toBe('{}\n');
  });

  it('waits while a biome config remains, so an opted-out formatter is never switched on early', () => {
    const root = legacyConsumer();
    writeFileSync(join(root, 'biome.jsonc'), '{ "formatter": { "enabled": false } }\n');
    syncOxcCapability(root, { refreshStarters: true });
    expect(oxfmtrc(root)).toBe('{}\n');
  });
});

describe('retired Biome state', () => {
  it('a recorded components.biome key is dropped from the selection', () => {
    const sel = normalizeSelection(JSON.parse('{ "biome": true }'));
    expect(Object.hasOwn(sel, 'biome')).toBe(false);
  });

  it('upgrade names every leftover and the hand step, and stays silent on a clean repo', () => {
    const root = tempDir('dk-biome-notice-');
    expect(retiredBiomeNotice(root, false)).toBeNull();
    writeFileSync(join(root, 'biome.jsonc'), '{}\n');
    mkdirSync(join(root, '.devkit', 'biome'), { recursive: true });
    const notice = retiredBiomeNotice(root, true) ?? '';
    expect(notice).toContain('found components.biome, biome.jsonc, .devkit/biome');
    expect(notice).toContain('{"ignorePatterns":["**"]} opts out');
    // add-if-absent keeps a Biome-era `lint: biome check .`, which breaks once the dependency goes.
    expect(notice).toContain('@biomejs/biome and its lint/format scripts');
  });

  it("overlay names only devkit's own leftovers, never the team's Biome config", () => {
    const root = tempDir('dk-biome-notice-overlay-');
    writeFileSync(join(root, 'biome.jsonc'), '{}\n');
    expect(retiredBiomeNotice(root, true, true)).toBeNull();
    writeFileSync(join(root, 'biome.devkit.jsonc'), '{}\n');
    const notice = retiredBiomeNotice(root, true, true) ?? '';
    expect(notice).toContain('found biome.devkit.jsonc');
    expect(notice).not.toMatch(/biome\.jsonc|\.oxfmtrc/);
  });

  it('devkit no longer ships the Biome presets', () => {
    expect(existsSync(join(REPO, 'biome'))).toBe(false);
    expect(existsSync(join(REPO, 'dist', 'biome'))).toBe(false);
  });
});

describe('the consumer lint base', () => {
  it('fails `devkit oxc lint` on an unused import, as `biome check` did', () => {
    const root = tempDir('dk-consumer-lint-');
    syncOxcCapability(root);
    writeFileSync(join(root, 'a.ts'), "import { x } from './b';\nexport const y = 1;\n");
    writeFileSync(join(root, 'b.ts'), 'export const x = 1;\n');
    const r = spawnSync(process.execPath, [CLI, 'oxc', 'lint', 'a.ts'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(/no-unused-vars/);
  });
});
