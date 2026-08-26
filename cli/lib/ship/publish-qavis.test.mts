import { spawnSync } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  QAVIS_HELP_TIMEOUT_MS,
  qavisSupportsPublish,
} from '../../../gate-engine/qavis-advisory/check.mts';

const helper = fileURLToPath(new URL('./publish-qavis.sh', import.meta.url));
let root: string;
let bin: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'publish-qavis-'));
  bin = join(root, 'bin');
  mkdirSync(bin);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function stubQavis(script: string): void {
  writeFileSync(join(bin, 'qavis'), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, 'qavis'), 0o755);
}

/**
 * A stub that answers `--help` the way commander really does, because the probe is a help PARSER and
 * a stub that models the wrong CLI would certify a probe that cannot work. Two behaviours are
 * load-bearing and were measured against the installed qavis: `<unknown> --help` exits 0 printing
 * TOP-LEVEL help (commander handles --help before rejecting the unknown operand — so exit status is
 * not a capability signal), while a bare unknown subcommand errors.
 *
 * `publish` marks $root/invoked when it runs, so "never invoked" is assertable rather than inferred
 * from the absence of a message.
 *
 * A `commands` entry may carry commander's alias rendering (`publish|pub`); the part before the pipe
 * is what the CLI actually dispatches on.
 */
function commandsHelp(commands: string[], blurb = ''): string {
  return [
    'Usage: qavis [options] [command]',
    '',
    `Computer-vision QA driver.${blurb ? ` ${blurb}` : ''}`,
    '',
    'Options:',
    '  -V, --version    output the version number',
    '',
    'Commands:',
    ...commands.map((c) => `  ${c} [options]     does a thing`),
    '  help [command]   display help for command',
  ].join('\n');
}

function stubCommanderQavis(commands: string[], onPublish = 'exit 0', blurb = ''): void {
  const help = commandsHelp(commands, blurb);
  stubQavis(
    [
      // commander answers --help wherever it appears, INCLUDING after an unknown subcommand.
      `for a in "$@"; do [ "$a" = "--help" ] && { cat <<'HELP'\n${help}\nHELP\n exit 0; }; done`,
      `case "$1" in`,
      ...commands.map((c) => {
        const dispatch = c.split('|')[0];
        return dispatch === 'publish'
          ? `  publish) touch ${JSON.stringify(join(root, 'invoked'))}; shift; ${onPublish} ;;`
          : `  ${dispatch}) exit 0 ;;`;
      }),
      `  *) echo "error: unknown command '$1'" >&2; exit 1 ;;`,
      'esac',
    ].join('\n'),
  );
}

/** Help text on stdout and nothing else — for exercising the parser without a dispatch table. */
function stubHelpOnly(help: string, preamble = ''): void {
  stubQavis(`${preamble}cat <<'HELP'\n${help}\nHELP`);
}

/** The shell probe's verdict on its own, decoupled from whether a receipt exists. */
function shellProbe(): boolean {
  const r = spawnSync(
    '/bin/bash',
    ['-c', 'set -euo pipefail; . "$QAVIS_HELPER"; qavis_supports_publish && echo yes || echo no'],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, QAVIS_HELPER: helper },
    },
  );
  return r.stdout.trim() === 'yes';
}

/** The same question as `devkit doctor` asks, against the same stub. */
function doctorProbe(): boolean | null {
  const prev = process.env.PATH;
  process.env.PATH = `${bin}:${prev}`;
  try {
    return qavisSupportsPublish();
  } finally {
    process.env.PATH = prev;
  }
}

function seedReceipt(): void {
  mkdirSync(join(root, '.qavis'));
  writeFileSync(join(root, '.qavis/receipt.json'), '{}');
}

/**
 * `errexit` mirrors the real callers, which source this helper into a `set -euo pipefail` shell
 * (ship-branch.sh, reship.sh). Without it a probe that aborts the ship after the push has landed —
 * and before the reconcile-manifest write — is structurally unobservable here.
 */
function run(opts: { errexit?: boolean; path?: string } = {}) {
  const prelude = opts.errexit === false ? '' : 'set -euo pipefail; ';
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      `${prelude}. "$QAVIS_HELPER"; publish_qavis_receipt "$@"`,
      'bash',
      root,
      '42',
      'base',
      'head',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: opts.path ?? `${bin}:${process.env.PATH}`,
        QAVIS_HELPER: helper,
      },
    },
  );
}

describe('publish_qavis_receipt', () => {
  it('passes the exact repository, PR, and shipped range to a Qavis that supports publishing', () => {
    seedReceipt();
    const capture = join(root, 'args');
    stubCommanderQavis(
      ['qa', 'publish'],
      `printf '%s\\n' "$@" > ${JSON.stringify(capture)}; echo '{"status":"published"}'; exit 0`,
    );

    const result = run();

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(capture, 'utf8').trim().split('\n')).toEqual([
      '--pr',
      '42',
      '--repo',
      root,
      '--base',
      'base',
      '--head',
      'head',
    ]);
  });

  it('does nothing when there is no receipt', () => {
    const called = join(root, 'called');
    stubQavis(`touch ${JSON.stringify(called)}`);
    expect(run().status).toBe(0);
    expect(existsSync(called)).toBe(false); // not even the capability probe may spawn qavis
  });

  it('keeps a completed ship successful and prints the retry when publication fails', () => {
    seedReceipt();
    stubCommanderQavis(['qa', 'publish'], `echo '{"status":"failed"}'; exit 2`);
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('PR opened/pushed, but evidence publication failed');
    // Reached only because `publish` EXISTS here, so this retry line is one the operator can run.
    expect(result.stderr).toContain('qavis publish --pr');
  });

  // sc-2028: devkit shipped this caller against a `qavis publish` that never landed, so every ship
  // with a pass receipt printed `unknown command 'publish'` plus a retry naming that same command.
  it('never invokes publish on a Qavis that does not expose it, and prints a runnable remedy', () => {
    seedReceipt();
    stubCommanderQavis(['qa', 'waive', 'route']);

    const result = run();

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(root, 'invoked'))).toBe(false);
    expect(result.stderr).not.toContain("unknown command 'publish'");
    expect(result.stderr).not.toContain('qavis publish --pr'); // an impossible remedy is worse than none
    expect(result.stderr).toContain('no publication subcommand');
    expect(result.stderr).toContain(`qavis qa --pr 42 --repo ${root} --annotate description`);
  });

  // The word occurs in qavis's own descriptive prose, so a bare `grep publish` over the help text
  // would report a capability that isn't registered — and put us straight back in the bug.
  it('reads the Commands block, not the help prose, when deciding publish exists', () => {
    seedReceipt();
    stubCommanderQavis(['qa', 'route'], 'exit 0', 'It publishes nothing on its own.');

    const result = run();

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(root, 'invoked'))).toBe(false);
    expect(result.stderr).toContain('no publication subcommand');
  });

  // `qavis publish --help` exits 0 on a qavis WITHOUT publish, so the probe must not read an exit
  // status. Asserted head-on: the stub errors on a bare `publish` and would fail the run if invoked.
  it('is not fooled by commander answering --help for an unregistered subcommand', () => {
    seedReceipt();
    stubCommanderQavis(['qa', 'route']);
    const probe = spawnSync('/bin/sh', [join(bin, 'qavis'), 'publish', '--help'], {
      encoding: 'utf8',
    });
    expect(probe.status).toBe(0); // the trap this fix exists to avoid

    expect(run().status).toBe(0);
    expect(existsSync(join(root, 'invoked'))).toBe(false);
  });

  // The call site runs AFTER `gh pr create` and BEFORE the reconcile-manifest write, so a probe that
  // can propagate a failure under errexit orphans an already-pushed branch from `devkit reconcile`.
  it('survives a probe that fails outright under the callers set -euo pipefail', () => {
    seedReceipt();
    stubQavis('echo "boom" >&2; exit 3'); // every invocation fails, --help included

    const result = run({ errexit: true });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('no publication subcommand');
  });

  it('names a runnable remedy when qavis is not on PATH at all', () => {
    seedReceipt();
    const result = run({ path: join(root, 'empty-bin') });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('qavis is not on PATH');
    expect(result.stderr).not.toContain('qavis publish --pr');
    expect(result.stderr).toContain(`qavis qa --pr 42 --repo ${root} --annotate description`);
  });

  // commander renders an aliased subcommand as `name|alias` in its Commands block (its help.js
  // builds the term that way), so the day sc-2161 lands `publish` with ANY alias, a probe that
  // matches the rendered term literally reports absent — and devkit silently never publishes again,
  // with doctor agreeing. A false negative is safe but invisible, which is the worst kind of dead.
  it('recognises publish when commander renders it with an alias', () => {
    seedReceipt();
    stubCommanderQavis(['qa', 'publish|pub']);

    const result = run();

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(root, 'invoked'))).toBe(true);
    expect(result.stderr).not.toContain('no publication subcommand');
  });

  // The probe spawns a second process on a path that already ran `gh pr create`. Inheriting the
  // ship's stdin lets a qavis that reads it swallow piped input — or block forever, after the push
  // has landed and before the reconcile-manifest write.
  it('never reads the ship stdin while probing', () => {
    seedReceipt();
    const seen = join(root, 'stdin-seen');
    stubHelpOnly(commandsHelp(['qa', 'route']), `cat > ${JSON.stringify(seen)}\n`);

    const result = spawnSync(
      '/bin/bash',
      [
        '-c',
        'set -euo pipefail; . "$QAVIS_HELPER"; publish_qavis_receipt "$@"',
        'bash',
        root,
        '42',
        'base',
        'head',
      ],
      {
        encoding: 'utf8',
        input: 'PR body from the operator\n',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, QAVIS_HELPER: helper },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(seen, 'utf8')).toBe('');
  });
});

// Two probes, one contract: publish-qavis.sh decides whether ship invokes, check.mts decides what
// doctor reports. They are separate implementations in separate languages, so they can drift into
// telling an operator two different things about the same binary. Pin them to the same answers.
describe('publish-capability probes agree (ship shell vs doctor TypeScript)', () => {
  const FIXTURES: Array<{ name: string; help: string; expected: boolean | null }> = [
    {
      name: 'no publish registered',
      help: commandsHelp(['qa', 'waive', 'route']),
      expected: false,
    },
    { name: 'publish registered', help: commandsHelp(['qa', 'publish']), expected: true },
    {
      name: 'publish registered under an alias',
      help: commandsHelp(['qa', 'publish|pub']),
      expected: true,
    },
    // The mirror image: commander renders `name|alias`, so a command declared as `pub` with
    // `publish` as its alias puts publish SECOND. Both probes must still find it — commander
    // dispatches on either name, so `qavis publish` really would run.
    {
      name: 'publish registered as the non-primary alias',
      help: commandsHelp(['qa', 'pub|publish']),
      expected: true,
    },
    // Command names are lowercase in both probes; neither may match a capitalised look-alike.
    { name: 'a capitalised look-alike', help: commandsHelp(['qa', 'Publish']), expected: false },
    // Guards against a bare substring match in either implementation.
    {
      name: 'a longer command that starts with publish',
      help: commandsHelp(['qa', 'publishing']),
      expected: false,
    },
    {
      name: 'a hyphenated neighbour',
      help: commandsHelp(['qa', 'publish-evidence']),
      expected: false,
    },
    {
      name: 'the word publish only in prose',
      help: commandsHelp(['qa', 'route'], 'It publishes nothing on its own.'),
      expected: false,
    },
    {
      name: 'CRLF line endings',
      help: commandsHelp(['qa', 'publish']).replace(/\n/g, '\r\n'),
      expected: true,
    },
    {
      name: 'help with no Commands block at all',
      help: 'Usage: qavis\n\nSee the docs.',
      // Unreadable, so doctor must say "could not ask" rather than assert absence; ship declines
      // either way, which is why the shell probe has only the two outcomes.
      expected: null,
    },
    // The dangerous direction: a false POSITIVE puts ship back to invoking a subcommand that does
    // not exist. Anything appended after the Commands block is prose, not a registered command.
    {
      name: 'the word publish in a later help section',
      help: `${commandsHelp(['qa', 'route'])}\n\nExamples:\n  publish --pr 1 --repo .\n`,
      expected: false,
    },
  ];

  for (const { name, help, expected } of FIXTURES) {
    it(`both report ${String(expected)} for ${name}`, () => {
      stubHelpOnly(help);
      // Ship's only question is "may I invoke?", so it collapses absent and unknown into false.
      expect(shellProbe(), 'ship (shell)').toBe(expected === true);
      expect(doctorProbe(), 'doctor (TypeScript)').toBe(expected);
    });
  }

  // `devkit doctor` is a health report, so it may not become the outage it describes: a qavis whose
  // --help never returns must degrade to "absent", not wedge the command. execFileSync waits forever
  // by default, so the bound is the whole guarantee.
  it('gives up on a qavis whose --help never returns, instead of hanging doctor', () => {
    stubQavis('sleep 60');
    const started = Date.now();

    expect(doctorProbe()).toBeNull(); // could not ask — never reported as a known absence

    expect(Date.now() - started).toBeLessThan(QAVIS_HELP_TIMEOUT_MS * 3);
  }, 30_000);

  // The shell probe always resolves qavis against the live PATH; the doctor probe only does so
  // because it hands `execFileSync` an explicit `env`. Bun resolves the executable against the PATH
  // its process STARTED with and ignores a later `process.env.PATH` write, so dropping that `env`
  // makes doctor answer for a different binary than ship found — and devkit's own tooling runs under
  // both runtimes. Asserting the two runs DIFFER proves the live PATH is honoured no matter what an
  // ambient qavis exposes, so this cannot go vacuous once sc-2161 ships a real publish.
  it('resolves against the live PATH under Bun, not the PATH the process started with', () => {
    if (spawnSync('bun', ['--version'], { encoding: 'utf8' }).status !== 0) return;
    const checkModule = fileURLToPath(
      new URL('../../../gate-engine/qavis-advisory/check.mts', import.meta.url),
    );
    const script = join(root, 'probe.mts');
    writeFileSync(
      script,
      // PREPEND rather than replace: the stub shells out to `cat`, and it is the prepend case Bun
      // actually mishandles — it keeps resolving against the PATH the process started with.
      `import { qavisSupportsPublish } from ${JSON.stringify(checkModule)};\n` +
        `process.env.PATH = ${JSON.stringify(bin)} + ':' + process.env.PATH;\n` +
        `console.log(qavisSupportsPublish() ? 'yes' : 'no');\n`,
    );
    const underBun = () => spawnSync('bun', [script], { encoding: 'utf8' });

    stubHelpOnly(commandsHelp(['qa', 'publish']));
    const withPublish = underBun();
    stubHelpOnly(commandsHelp(['qa', 'route']));
    const withoutPublish = underBun();

    expect(withPublish.stdout.trim(), withPublish.stderr).toBe('yes');
    expect(withoutPublish.stdout.trim(), withoutPublish.stderr).toBe('no');
  });
});
