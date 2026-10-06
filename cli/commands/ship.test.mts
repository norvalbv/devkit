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
    async enterQueue() {
      events.push('queue');
      return { env: {} };
    },
    showQueue: () => 'running: (none)',
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
    // --wait-ci-timeout takes a value, so `--pr` here is that value, not a mode flag. An unlisted
    // value-taking flag would route this new ship to reship.sh.
    [
      'new ship whose --wait-ci-timeout swallowed a mode-flag-shaped value',
      ['feat/runtime', 'ship it', '--wait-ci', '--wait-ci-timeout', '--pr', 'note.txt'],
      'ship-branch.sh',
    ],
    // A --body value spelled like a mode flag or `--` is opaque text: no rejection, same route.
    [
      'reship whose --body is --draft',
      ['--pr', 'feat/x', 't', '--body', '--draft', '--', 'note.txt'],
      'reship.sh',
    ],
    [
      'reship whose --body is --from-branch',
      ['--pr', 'feat/x', 't', '--body', '--from-branch', '--', 'note.txt'],
      'reship.sh',
    ],
    [
      'reship whose --body is --',
      ['feat/x', 't', '--body', '--', '--pr', '--', 'note.txt'],
      'reship.sh',
    ],
    // The record supplies the mode under --resume, so --ready without --pr is not rejected there.
    ['resume with --ready', ['--resume', 'feat/x', '--ready'], 'ship-branch.sh'],
  ])('reports once before dispatching a %s', async (_label, args, script) => {
    const test = harness();

    expect(await ship(args, '/consumer', test.dependencies)).toBe(0);
    expect(test.provenance).toEqual(['/consumer']);
    expect(test.scripts).toEqual([{ args, command: 'devkit ship', cwd: '/consumer', script }]);
    expect(test.events).toEqual(['provenance', 'queue', 'script']);
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

describe('devkit ship machine-wide queue wiring (sc-3785)', () => {
  it.each([
    ['new ship', ['feat/q', 'ship it', 'a.txt'], 'feat/q', 'ship-branch'],
    ['reship', ['feat/q', 'ship it', '--pr', 'a.txt'], 'feat/q', 'reship'],
    ['resume', ['--resume', 'feat/q'], 'feat/q', 'resume'],
    ['dry-gates rehearsal', ['feat/q', 'ship it', '--dry-gates', 'a.txt'], 'feat/q', 'dry-gates'],
  ])(
    'queues a %s before its script runs, naming the branch and mode',
    async (_l, args, branch, mode) => {
      const test = harness();
      const entered: Array<{ branch: string; mode: string }> = [];
      test.dependencies.enterQueue = async (options) => {
        test.events.push('queue');
        entered.push({ branch: options.branch, mode: options.mode });
        return { env: {} };
      };

      expect(await ship(args, '/consumer', test.dependencies)).toBe(0);
      expect(test.events).toEqual(['provenance', 'queue', 'script']);
      expect(entered).toEqual([{ branch, mode }]);
    },
  );

  it('hands the slot env to the script and releases after it exits', async () => {
    const test = harness();
    const calls: string[] = [];
    let seenEnv: NodeJS.ProcessEnv | undefined;
    test.dependencies.enterQueue = async () => ({
      env: { DEVKIT_SHIP_SLOT: 'tok', DEVKIT_SHIP_SLOT_RELEASE: '1' },
      handle: {
        token: 'tok',
        slotDir: '/q/slot',
        release: () => calls.push('release'),
      },
    });
    test.dependencies.runManagedScript = (_s, _a, options) => {
      seenEnv = options.env;
      calls.push('script');
      return 3;
    };

    expect(await ship(['feat/q', 'ship it', 'a.txt'], '/consumer', test.dependencies)).toBe(3);
    expect(seenEnv?.DEVKIT_SHIP_SLOT).toBe('tok');
    expect(seenEnv?.DEVKIT_SHIP_SLOT_RELEASE).toBe('1');
    expect(calls).toEqual(['script', 'release']);
  });

  it('releases the slot even when the script dispatch throws', async () => {
    const test = harness();
    const release = vi.fn();
    test.dependencies.enterQueue = async () => ({
      env: {},
      handle: { token: 't', slotDir: '/q/slot', release },
    });
    test.dependencies.runManagedScript = () => {
      throw new Error('spawn failed');
    };

    await expect(
      ship(['feat/q', 'ship it', 'a.txt'], '/consumer', test.dependencies),
    ).rejects.toThrow('spawn failed');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['--pr with --from-branch', ['feat/q', 't', '--pr', '--from-branch']],
    ['--pr with --draft', ['feat/q', 't', '--pr', '--draft']],
    ['--ready without --pr', ['feat/q', 't', '--ready', 'a.txt']],
  ])('rejects %s before ever joining the queue', async (_l, args) => {
    const test = harness();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await ship(args, '/consumer', test.dependencies)).toBe(1);
    expect(test.events).not.toContain('queue');
    error.mockRestore();
  });

  it('prints the queue for a leading --queue without queueing or running a script', () => {
    const test = harness();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(ship(['--queue'], '/consumer', test.dependencies)).toBe(0);
    expect(log).toHaveBeenCalledWith('running: (none)');
    expect(test.events).toEqual([]);
    log.mockRestore();
  });

  it('fails --queue with a message when the queue cannot be read', () => {
    const test = harness();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    test.dependencies.showQueue = () => {
      throw new Error('timed out acquiring queue lock');
    };

    expect(ship(['--queue'], '/consumer', test.dependencies)).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain('could not read the queue');
    error.mockRestore();
  });

  it('rejects --queue with other arguments', () => {
    const test = harness();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(ship(['--queue', 'extra'], '/consumer', test.dependencies)).toBe(1);
    expect(test.events).toEqual([]);
    error.mockRestore();
  });

  it('names the mode from the parsed flags, so --dry-gates as a --body value is not a rehearsal', async () => {
    const test = harness();
    const modes: string[] = [];
    test.dependencies.enterQueue = async (options) => {
      modes.push(options.mode);
      return { env: {} };
    };

    await ship(['feat/q', 't', '--body', '--dry-gates', 'a.txt'], '/consumer', test.dependencies);
    expect(modes).toEqual(['ship-branch']);
  });

  it('fails the ship without running a script when the queue cannot be joined', async () => {
    const test = harness();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    test.dependencies.enterQueue = async () => {
      throw new Error('timed out acquiring manifest lock');
    };

    expect(await ship(['feat/q', 't', 'a.txt'], '/consumer', test.dependencies)).toBe(1);
    expect(test.scripts).toEqual([]);
    expect(error.mock.calls.flat().join('\n')).toContain(
      'could not join the machine-wide ship queue',
    );
    error.mockRestore();
  });

  // The bash scripts' resolve-only test seam must not become an unqueued path for the dispatcher.
  it('still queues when SHIP_RESOLVE_ONLY is set', async () => {
    const test = harness();
    vi.stubEnv('SHIP_RESOLVE_ONLY', '1');
    try {
      expect(await ship(['--pr', 'feat/q', 't', 'a.txt'], '/consumer', test.dependencies)).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(test.events).toEqual(['provenance', 'queue', 'script']);
  });

  it('treats --queue as body text when it is the value of --body', async () => {
    const test = harness();

    expect(
      await ship(['feat/q', 't', '--body', '--queue', 'a.txt'], '/consumer', test.dependencies),
    ).toBe(0);
    expect(test.events).toEqual(['provenance', 'queue', 'script']);
  });
});
