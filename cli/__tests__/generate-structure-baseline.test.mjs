import { afterEach, describe, expect, it } from 'vitest';
import {
  generateStructureBaselines,
  generateTreeBaseline,
} from '../lib/generate/generate-structure-baseline.mjs';
import { structFixtures } from './_helpers.mjs';

const { tmpRepo, write, cleanup } = structFixtures('struct-');
afterEach(cleanup);

describe('generateTreeBaseline — renderer', () => {
  it('grandfathers exactly the violators of a tiny fixture (manual-walk, no scan dedup)', () => {
    const root = tmpRepo();
    // Valid (NOT grandfathered):
    write(root, 'src/renderer/App.tsx');
    write(root, 'src/renderer/components/Button/index.tsx');
    write(root, 'src/renderer/lib/utils/format.ts');
    // Violators (grandfathered):
    write(root, 'src/renderer/loose-file.ts'); // loose at root
    write(root, 'src/renderer/components/NoIndex/helper.tsx'); // component folder missing index.tsx
    write(root, 'src/renderer/lib/junk-drawer/thing.ts'); // unregistered lib domain

    const baseline = generateTreeBaseline('renderer', root, {
      domains: { RENDERER_LIB_DOMAINS: ['utils'] },
    });

    expect(baseline).toEqual([
      'components/NoIndex/helper.tsx',
      'lib/junk-drawer/thing.ts',
      'loose-file.ts',
    ]);
  });

  it('captures EVERY file in a broken (missing-index) component folder, not just one', () => {
    // The dedup hazard: a scan-mode generator would collapse these to ONE message.
    const root = tmpRepo();
    write(root, 'src/renderer/components/Broken/a.tsx');
    write(root, 'src/renderer/components/Broken/b.tsx');
    write(root, 'src/renderer/components/Broken/c.tsx');
    const baseline = generateTreeBaseline('renderer', root, { domains: {} });
    expect(baseline).toEqual([
      'components/Broken/a.tsx',
      'components/Broken/b.tsx',
      'components/Broken/c.tsx',
    ]);
  });

  it('an empty domain registry grandfathers existing lib folders (pre-baseline safe)', () => {
    const root = tmpRepo();
    write(root, 'src/renderer/lib/audio/player.ts');
    // No domains registered → audio is "unregistered" → all its files grandfathered.
    const baseline = generateTreeBaseline('renderer', root, { domains: {} });
    expect(baseline).toContain('lib/audio/player.ts');
  });
});

describe('generateTreeBaseline — main', () => {
  it('grandfathers an unregistered main lib domain + flags missing index.ts', () => {
    const root = tmpRepo();
    write(root, 'src/main/index.ts');
    write(root, 'src/main/lib/db/index.ts'); // registered domain w/ index → OK
    write(root, 'src/main/lib/db/query.ts');
    write(root, 'src/main/lib/unregistered/thing.ts'); // not in MAIN_LIB_DOMAINS → grandfathered
    const baseline = generateTreeBaseline('main', root, {
      domains: { MAIN_LIB_DOMAINS: ['db'], MAIN_ROOT_FOLDERS: ['lib', 'windows'] },
    });
    expect(baseline).toContain('lib/unregistered/thing.ts');
    expect(baseline).not.toContain('lib/db/query.ts');
  });
});

describe('generateStructureBaselines — multi-tree', () => {
  it('only writes baselines for trees that exist on disk', async () => {
    const root = tmpRepo();
    write(root, 'src/renderer/oops.ts');
    write(root, 'src/shared/types.ts');
    // No src/main, src/preload, socket-server, vercel-serverless.
    const summary = await generateStructureBaselines(root, {});
    const byTree = Object.fromEntries(summary.map((s) => [s.tree, s]));
    expect(byTree.renderer.written).toBe(true);
    expect(byTree.shared.written).toBe(true);
    expect(byTree.main.written).toBe(false);
    expect(byTree.preload.written).toBe(false);
    expect(byTree.socket.written).toBe(false);
    expect(byTree.vercel.written).toBe(false);
    expect(byTree.renderer.count).toBe(1);
  });

  it('reads the consumer eslint/domains.mjs to decide registered lib domains', async () => {
    const root = tmpRepo();
    write(root, 'src/renderer/lib/charts/bar.ts');
    write(
      root,
      'eslint/domains.mjs',
      'export const RENDERER_LIB_DOMAINS = ["charts"];\n' +
        'export const MAIN_ROOT_FOLDERS = ["lib","windows"];\n' +
        'export const MAIN_LIB_DOMAINS = [];\n' +
        'export const SOCKET_LIB_DOMAINS = [];\n' +
        'export const VERCEL_LIB_DOMAINS = [];\n',
    );
    const summary = await generateStructureBaselines(root, {});
    // 'charts' is registered → bar.ts is valid → renderer baseline empty.
    expect(summary.find((s) => s.tree === 'renderer').count).toBe(0);
  });
});
