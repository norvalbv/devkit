import { describe, expect, it, vi } from 'vitest';
import ship, { type ShipDependencies } from './ship.mts';

interface ScriptCall {
  args: string[];
  command: string;
  cwd: string;
  script: string;
}

function harness() {
  const events: string[] = [];
  const provenance: string[] = [];
  const scripts: ScriptCall[] = [];
  const dependencies = {
    reportRuntimeProvenance(cwd: string): void {
      events.push('provenance');
      provenance.push(cwd);
    },
    runManagedScript(
      script: string,
      args: string[],
      options: Parameters<ShipDependencies['runManagedScript']>[2],
    ): number {
      events.push('script');
      scripts.push({ args, command: options.command, cwd: options.cwd, script });
      return 0;
    },
  } satisfies ShipDependencies;
  return {
    dependencies,
    events,
    provenance,
    scripts,
  };
}

describe('devkit ship dispatcher provenance', () => {
  it.each([
    ['new ship', ['feat/runtime', 'ship it', 'note.txt'], 'ship-branch.sh'],
    ['reship', ['feat/runtime', 'ship it', '--pr', 'note.txt'], 'reship.sh'],
  ])('reports once before dispatching a %s', async (_label, args, script) => {
    const test = harness();

    expect(await ship(args, '/consumer', test.dependencies)).toBe(0);
    expect(test.provenance).toEqual(['/consumer']);
    expect(test.scripts).toEqual([{ args, command: 'devkit ship', cwd: '/consumer', script }]);
    expect(test.events).toEqual(['provenance', 'script']);
  });

  it('keeps the no-argument help path free of runtime diagnostics', () => {
    const test = harness();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(ship([], '/consumer', test.dependencies)).toBe(1);
    expect(test.provenance).toEqual([]);
    expect(test.scripts).toEqual([]);
    log.mockRestore();
  });
});
