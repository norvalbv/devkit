/** The check this replaced resolved through packageDir() — already inside dist/ — so it reported OK
 * for all of sc-2563. These drive the MISSING branch directly, on the layout that shipped the bug. */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkRegisteredHookTargets } from '../lib/doctor/asset-checks.mts';
import { PKG, registrationsFor } from '../lib/install/hook-registration-ledger/registrations.mts';
import { rootRegistry } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

/** Every registration in `componentIds` that names a script inside the installed package. */
const packageScripts = (componentIds: string[]) =>
  registrationsFor(componentIds).flatMap((r) => (r.scriptRel ? [r.scriptRel] : []));

/** A repo with devkit "installed": every registered engine bin present under node_modules. */
function withInstalledPackage(componentIds: string[], stripDist = false): string {
  const root = mkTmp('doctor-hook-targets-');
  for (const scriptRel of packageScripts(componentIds)) {
    const path = join(root, PKG, stripDist ? scriptRel.replace(/^dist\//, '') : scriptRel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '// engine bin\n');
  }
  return root;
}

describe('checkRegisteredHookTargets', () => {
  it('passes when every registered hook script resolves', () => {
    const result = checkRegisteredHookTargets(withInstalledPackage(['searchSteering']), [
      'searchSteering',
    ]);
    expect(result.status).toBe('OK');
  });

  it('flags a registered hook path that does not exist', () => {
    const root = withInstalledPackage(['searchSteering']);
    const guard = packageScripts(['searchSteering'])[0];
    rmSync(join(root, PKG, guard));

    const result = checkRegisteredHookTargets(root, ['searchSteering']);
    expect(result.status).toBe('MISSING');
    expect(result.detail).toContain(guard);
    expect(result.detail).toContain('search-steering:pre-bash');
  });

  it('reports the pre-dist layout that shipped the bug, rather than passing on it', () => {
    // The whole package present at the package ROOT but nothing under dist/ — what a consumer had
    // while doctor said OK. packageDir() would resolve; the REGISTERED path must not.
    const root = withInstalledPackage(['searchSteering'], true);
    expect(checkRegisteredHookTargets(root, ['searchSteering']).status).toBe('MISSING');
  });

  it('ignores consumer-anchored hook scripts, which the agent-hooks manifest already covers', () => {
    // decisions registers .claude/hooks scripts and carries no scriptRel; nothing to resolve here.
    expect(checkRegisteredHookTargets(mkTmp('doctor-hook-targets-'), ['decisions']).status).toBe(
      'OK',
    );
  });
});
