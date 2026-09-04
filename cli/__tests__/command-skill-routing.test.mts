/** Every agent-facing CLI verb must be NAMED in skills/, since that is all an agent reads.
 *  sc-2361; the reasoning is the 2026-09-04 note on docs/decisions/review-gate-in-chain.md. */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CommandMeta } from '../lib/help/render.mts';
import { CLI } from './_helpers.mts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const COMMANDS_DIR = join(ROOT, 'cli', 'commands');
const SKILLS_DIR = join(ROOT, 'skills');

/**
 * Lower bound on the registry, so a parse that silently matches nothing cannot make this whole
 * suite pass vacuously. 22 commands exist today; this only has to be under that, not tracking it.
 */
const MIN_COMMANDS = 20;

/** The invocation form a skill must contain for `<verb>` to count as routed. */
function namedInSkills(verb: string): RegExp {
  return new RegExp(
    `(?<![\\w-])devkit[ \\t]+${verb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`,
  );
}

/** The verbs devkit dispatches. Read via subprocess because cli/index.mts calls main() at
 *  import, so COMMANDS cannot be imported — and --help renders from that same map. */
function registeredVerbs(): Set<string> {
  const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  expect(r.status, `devkit --help failed: ${r.stderr}`).toBe(0);
  // renderSummaryLine emits `  devkit <name padded> <summary>`; the usage block and the global
  // flags share that prefix, so keep only things shaped like a verb.
  return new Set(
    [...r.stdout.matchAll(/^ {2}devkit (\S+)/gm)]
      .map((m) => m[1])
      .filter((name) => /^[a-z][a-z0-9-]*$/.test(name)),
  );
}

/** A module loaded from cli/commands/. A helper module there simply has no `meta`. */
interface LoadedCommandModule {
  meta?: CommandMeta;
}

interface CommandRegistry {
  byVerb: Map<string, { meta: CommandMeta; file: string }>;
  /** Two modules claiming one `meta.name`. Keying by verb drops the loser's classification, and
   *  the dispatch check cannot see it — the surviving verb is still registered. */
  collisions: { verb: string; files: string[] }[];
}

interface RegistryDivergence {
  /** Declared by a module's `meta`, but `devkit <verb>` cannot reach it. */
  unreachable: string[];
  /** Dispatched by the CLI, but no module declares that `meta.name`. */
  unclaimed: string[];
}

/**
 * Which verbs each side knows about, compared. Pure so the comparison itself is testable: in a
 * healthy tree both arrays are empty on every run, so nothing else would exercise this logic.
 */
export function diffRegistry(
  declared: Iterable<string>,
  registered: ReadonlySet<string>,
): RegistryDivergence {
  const names = new Set(declared);
  return {
    unreachable: [...names].filter((verb) => !registered.has(verb)).sort(),
    unclaimed: [...registered].filter((verb) => !names.has(verb)).sort(),
  };
}

/** Every `meta` under cli/commands/, keyed by verb. No `meta` = library code, skipped; the
 *  dispatch cross-check is what proves that skip never hid a real command. */
async function commandMetas(): Promise<CommandRegistry> {
  const byVerb = new Map<string, { meta: CommandMeta; file: string }>();
  const claimedBy = new Map<string, string[]>();
  const files = readdirSync(COMMANDS_DIR, { recursive: true, encoding: 'utf8' })
    .filter((p) => p.endsWith('.mts') && !p.endsWith('.test.mts'))
    .sort();
  for (const rel of files) {
    let mod: LoadedCommandModule;
    try {
      mod = await import(pathToFileURL(join(COMMANDS_DIR, rel)).href);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`cli/commands/${rel} failed to import: ${reason}`);
    }
    if (!mod.meta) continue;
    byVerb.set(mod.meta.name, { meta: mod.meta, file: rel });
    claimedBy.set(mod.meta.name, [...(claimedBy.get(mod.meta.name) ?? []), rel]);
  }
  const collisions = [...claimedBy]
    .filter(([, claimants]) => claimants.length > 1)
    .map(([verb, claimants]) => ({ verb, files: claimants }));
  return { byVerb, collisions };
}

/** Every markdown file under skills/, as one searchable corpus. */
function skillFiles(): { rel: string; body: string }[] {
  return readdirSync(SKILLS_DIR, { recursive: true, encoding: 'utf8' })
    .filter((p) => p.endsWith('.md'))
    .sort()
    .map((rel) => ({ rel, body: readFileSync(join(SKILLS_DIR, rel), 'utf8') }));
}

describe('every agent-facing command is routed from skills/', async () => {
  const { byVerb: metas, collisions } = await commandMetas();
  const registered = registeredVerbs();
  const skills = skillFiles();

  it('the help output parses to verbs, not flags or placeholders', () => {
    // The parse is what makes the cross-check meaningful; if it silently yielded flags or nothing,
    // every assertion downstream of it would be measuring the wrong set.
    expect(registered.size).toBeGreaterThanOrEqual(MIN_COMMANDS);
    expect([...registered].filter((verb) => !/^[a-z][a-z0-9-]*$/.test(verb))).toEqual([]);
    expect(registered.has('ship')).toBe(true);
  });

  it('the command modules and the dispatch table agree', () => {
    // Guards the enumeration itself: a module with a `meta` that nobody registered is dead help
    // text, and a registered verb no module claims means a `meta.name` drifted from its key.
    expect(
      diffRegistry(metas.keys(), registered),
      'The command modules under cli/commands/ and the verbs `devkit --help` lists have diverged.\n' +
        '  unreachable — exports a meta, but `devkit <verb>` cannot reach it\n' +
        '  unclaimed   — registered in COMMANDS, but no module declares that meta.name\n\n' +
        'Register it in COMMANDS (cli/index.mts), fix the meta.name to match its key, or — if the ' +
        'module is a helper rather than a command — remove its `meta` export.',
    ).toEqual({ unreachable: [], unclaimed: [] });
  });

  it('no two modules claim the same verb', () => {
    expect(
      collisions,
      'Two modules under cli/commands/ export the same `meta.name`. Only one can be dispatched, ' +
        "and the other's agentFacing classification is silently ignored — the dispatch-table " +
        'check above cannot see it, because the surviving verb is still registered.',
    ).toEqual([]);
  });

  it('no command claims to be agent-facing AND gives a reason it is not routed', () => {
    // A half-finished reclassification: agentFacing flipped to true, old justification left
    // behind. Nothing else fails, so the stale sentence reads as current policy.
    const contradictory = [...metas]
      .filter(([, { meta }]) => meta.agentFacing && meta.notRoutedBecause !== undefined)
      .map(([verb, { file }]) => `${verb} (cli/commands/${file})`);
    expect(
      contradictory,
      'notRoutedBecause explains why a verb is NOT routed, so it is meaningless on an ' +
        'agent-facing one. Delete it, or set agentFacing: false if the reason still holds.',
    ).toEqual([]);
  });

  it.each([...metas].filter(([, { meta }]) => meta.agentFacing).map(([verb, m]) => [verb, m.file]))(
    'skills/ names `devkit %s`',
    (verb, file) => {
      const matcher = namedInSkills(verb);
      const hits = skills.filter(({ body }) => matcher.test(body)).map(({ rel }) => rel);
      expect(
        hits,
        `devkit ${verb} is declared agent-facing but no file under skills/ names it.\n\n` +
          `  declared at: cli/commands/${file}  (meta.agentFacing: true)\n` +
          `  searched:    skills/**/*.md  (${skills.length} files)\n` +
          `  matcher:     ${matcher}\n\n` +
          'An agent only learns a verb exists by reading skills/. A command no skill names is\n' +
          'unreachable in practice, however good its --help is. Satisfy this ONE OF TWO ways:\n\n' +
          '  1. ROUTE IT. Add a row to the situation -> command table in skills/using-devkit/SKILL.md,\n' +
          '     or to the topic skill that owns the situation (e.g. skills/testing/SKILL.md), whose\n' +
          `     command cell literally contains "devkit ${verb}". Lead with the OBSERVABLE TRIGGER\n` +
          '     ("you see X"), not with the command — an agent matches on the symptom, not the verb.\n\n' +
          `  2. RECLASSIFY IT. If no agent should ever type it, set in cli/commands/${file}:\n` +
          '       agentFacing: false,\n' +
          '       notRoutedBecause: <one sentence: who or what invokes it instead, and why an\n' +
          '                          agent reaching for it directly would be wrong>',
      ).not.toEqual([]);
    },
  );

  it.each(
    [...metas].filter(([, { meta }]) => !meta.agentFacing).map(([verb, m]) => [verb, m.file]),
  )('`devkit %s` says why it is not routed', (verb, file) => {
    const why = metas.get(verb)?.meta.notRoutedBecause;
    expect(
      why?.trim() ?? '',
      `devkit ${verb} is declared agentFacing: false but gives no notRoutedBecause.\n\n` +
        `  declared at: cli/commands/${file}\n\n` +
        '"Not agent-facing" is a claim, not a default. Write one sentence naming the real caller\n' +
        '(a hook shim, a package script, another devkit command, CI) so the next person can tell\n' +
        'an INTENTIONAL omission from a FORGOTTEN one — which is the entire point of this test.',
    ).not.toBe('');
  });
});

/** Unreachable through the real tree: renaming a `meta.name` moves both sides together, since
 *  --help renders from the same modules. Its detection only runs on healthy input unless pinned. */
describe('diffRegistry', () => {
  it('reports a declared verb the dispatch table cannot reach', () => {
    expect(diffRegistry(['ship', 'ghost'], new Set(['ship']))).toEqual({
      unreachable: ['ghost'],
      unclaimed: [],
    });
  });

  it('reports a dispatched verb no module declares', () => {
    expect(diffRegistry(['ship'], new Set(['ship', 'orphan']))).toEqual({
      unreachable: [],
      unclaimed: ['orphan'],
    });
  });

  it('reports both sides at once, sorted, and is silent when they agree', () => {
    expect(diffRegistry(['b', 'a'], new Set(['a', 'b']))).toEqual({
      unreachable: [],
      unclaimed: [],
    });
    expect(diffRegistry(['z', 'x'], new Set(['y']))).toEqual({
      unreachable: ['x', 'z'],
      unclaimed: ['y'],
    });
  });

  it('does not report a verb twice when a module declares it twice', () => {
    // Guards the Set() normalisation: a duplicated input must not inflate `unreachable`, or the
    // collision check's message would be buried under a second, misleading failure.
    expect(diffRegistry(['ghost', 'ghost'], new Set())).toEqual({
      unreachable: ['ghost'],
      unclaimed: [],
    });
  });
});

/** The gate reduces to one regex whose edges a healthy tree never hits: loosening it to a bare
 *  `\bverb\b` leaves every assertion above green while the gate stops meaning anything. */
describe('the routing predicate', () => {
  const matches = (corpus: string, verb: string): boolean => namedInSkills(verb).test(corpus);

  it.each([
    ['a table cell', '| `devkit review [--base <ref>]` | it runs …', 'review'],
    ['prose', 'run `devkit reconcile` (preview) before applying', 'reconcile'],
    // Documenting a command in a fenced block is the most canonical form there is; a code-span-only
    // matcher would miss it, which is why the predicate ignores markdown structure entirely.
    ['a fenced block', '```sh\ndevkit sync-skills --dry-run\n```', 'sync-skills'],
    ['a tab separator', 'devkit\tship <branch>', 'ship'],
    ['repeated spaces', 'devkit   move src dest', 'move'],
    ['a hyphenated verb', 'then `devkit base-status --json`', 'base-status'],
  ])('counts %s as routing', (_case, corpus, verb) => {
    expect(matches(corpus, verb)).toBe(true);
  });

  it.each([
    // The reason `review` needed a row at all: skills/ was already full of the bare word.
    ['the bare word in prose', 'the reviewer gate blocks on review findings', 'review'],
    // The reason guard-branch is classified internal rather than routed — a skill DOCUMENTS it as a
    // term without ever telling an agent to type it, and that must not read as routing.
    ['a backticked bare verb', 'devkit **provides** a `guard-branch` command', 'guard-branch'],
    ['a longer verb starting with it', 'see `devkit review-all` for the sweep', 'review'],
    ['a longer verb ending with it', 'run `devkit pre-ship` first', 'ship'],
    ['a suffixed hyphenated verb', 'try `devkit base-status-json`', 'base-status'],
    ['another tool of the same name', 'run `notdevkit ship` instead', 'ship'],
    ['a hyphen before devkit', 'the my-devkit ship wrapper', 'ship'],
    // A wrapped sentence must not fabricate an invocation that was never written.
    ['a line wrap between the two words', 'just run devkit\nreview the output', 'review'],
  ])('does not count %s', (_case, corpus, verb) => {
    expect(matches(corpus, verb)).toBe(false);
  });

  it('is strictly stricter than a bare-word match on the real skills/ corpus', () => {
    // If this stops holding, the predicate has been loosened to the one thing it was chosen
    // over, and `review` would pass on prose that routes nobody.
    const bareWord = /(?<![\w-])review(?![\w-])/;
    const prosePassers = skillFiles().filter(
      ({ body }) => bareWord.test(body) && !namedInSkills('review').test(body),
    );
    expect(prosePassers.length).toBeGreaterThan(0);
  });
});
