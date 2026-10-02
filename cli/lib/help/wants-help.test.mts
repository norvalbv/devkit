import { describe, expect, it } from 'vitest';
import { meta as shipMeta } from '../../commands/ship.mts';
import { wantsCommandHelp } from './wants-help.mts';

const SHIP = shipMeta.valueFlags;

describe('wantsCommandHelp (sc-2485)', () => {
  it.each([
    // A value-taking flag consumes the next token as opaque text, however it is spelled.
    ['--body value spelled --help', ['b', 't', '--body', '--help', '--', 'f'], false],
    ['--body-file value spelled -h', ['b', 't', '--body-file', '-h', '--', 'f'], false],
    ['--base value spelled -h', ['b', 't', '--base', '-h', 'f'], false],
    [
      '--wait-ci-timeout value spelled --help',
      ['b', 't', '--wait-ci-timeout', '--help', 'f'],
      false,
    ],
    [
      'a repeated --link whose second value is -h',
      ['b', 't', '--link', 'a', '--link', '-h', 'f'],
      false,
    ],
    // A consumed `--` is body text, not the terminator — same rule as ship's route scan.
    ['--help after a consumed --', ['b', 't', '--body', '--', '--help'], true],
    ['--help after an unconsumed --', ['b', 't', '--', '--help'], false],
    ['-h after an unconsumed --', ['b', 't', '--', 'f', '-h'], false],
    // `=` forms are not parsed: the bash parsers have no such arms, so this is one opaque token.
    ['--body=--help as one token', ['b', 't', '--body=--help', 'f'], false],
    ['a trailing value flag with no value', ['b', 't', '--body'], false],
    ['plain --help', ['--help'], true],
    ['plain -h among positionals', ['b', 't', '-h', 'f'], true],
    ['--help after a fully consumed value', ['b', 't', '--body', 'x', '--help'], true],
    ['no args', [], false],
  ])('%s', (_label, args, expected) => {
    expect(wantsCommandHelp(args, SHIP)).toBe(expected);
  });

  // The bash parser binds the positional slots first; a flag sitting in one fails it before any
  // option is read, so nothing is consumed and a later help flag still asks for help.
  it.each([
    ['--body in the title slot', ['feat/x', '--body', '--help'], true],
    ['--body-file in the branch slot', ['--body-file', '-h'], true],
    ['--body in the title slot after --pr', ['--pr', 'feat/x', '--body', '--help'], true],
    ['--body in the branch slot after --resume', ['--resume', '--body', '--help'], true],
    ['--body-file after --resume <branch>', ['--resume', 'b', '--body-file', '-h'], false],
    ['--body after --pr <branch> <title>', ['--pr', 'b', 't', '--body', '--help'], false],
    // --resume replays WHAT ships, so bash refuses --base/--link there before reading a value.
    ['--base under --resume', ['--resume', 'b', '--base', '--help'], true],
    ['--link under --pr --resume', ['--pr', '--resume', 'b', '--link', '-h'], true],
    ['--body under --resume still takes a value', ['--resume', 'b', '--body', '--help'], false],
    // ship-branch.sh strips ONE --resume (the second is its branch); reship.sh strips the run.
    ['a repeated --resume on a new ship', ['--resume', '--resume', 'b', '--body', '--help'], true],
    [
      'a repeated --resume routed to reship',
      ['--resume', '--resume', 'b', '--pr', '--body', '--help'],
      false,
    ],
    ['a title-slot flag on a reship', ['--pr', 'b', '--draft', '--body', '--help'], true],
    // ship.mts rejects these argv shapes before either bash parser runs, so nothing is consumed.
    ['--ready on a new ship', ['b', 't', '--ready', '--body', '--help'], true],
    ['--draft with --pr', ['--pr', 'b', 't', '--draft', '--body-file', '-h'], true],
    ['--from-branch with --pr', ['b', 't', '--pr', '--from-branch', '--body', '--help'], true],
    ['--queue with other args', ['--queue', '--body', '--help'], true],
    ['--ready under --resume is accepted', ['--resume', 'b', '--ready', '--body', '--help'], false],
  ])('%s', (_label, args, expected) => {
    expect(wantsCommandHelp(args, shipMeta.valueFlagsFor(args))).toBe(expected);
  });

  it('keeps the pre-existing scan for a command that declares no value flags', () => {
    expect(wantsCommandHelp(['--body', '--help'])).toBe(true);
    expect(wantsCommandHelp(['x', '--', '--help'])).toBe(false);
  });
});
