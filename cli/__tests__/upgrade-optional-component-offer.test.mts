/**
 * `devkit upgrade` step 3c — the generic offer for optional components shipped since a repo's last
 * install (OPTIONAL_COMPONENTS / unofferedComponents). The component analog of the step-3 gate
 * reconcile, and the reason a new opt-in component no longer needs its own bespoke upgrade step.
 *
 * Two properties carry the design, and both are easy to break:
 *   1. never auto-add — an opt-in component must not arrive because someone ran upgrade in CI;
 *   2. never re-nag — but ONLY once the user actually answered. Step 4's broad refresh rewrites the
 *      whole components block, so a non-TTY run must NOT let the normalized `false` be recorded as
 *      a decision nobody made (that would suppress the offer forever, silently).
 *
 * Subprocess-style, so stdin/stdout are pipes → always the non-interactive branch. DEVKIT_REPO
 * points at a bogus URL so the version step's `git ls-remote` fails fast (no network).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OPTIONAL_COMPONENTS, type Selection, unofferedComponents } from '../lib/components.mts';
import { ADHD_SKILL_DIR } from '../lib/install/adhd-skill.mts';
import { CLI, tmpRepos } from './_helpers.mts';

const { tmpRepo, cleanup } = tmpRepos('upgrade-optional-');
afterEach(cleanup);

const run = (root: string, ...args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DEVKIT_REPO: 'file:///devkit-nonexistent-xyz' },
  });

const configPath = (root: string) => join(root, '.devkit', 'config.json');
const config = (root: string) => JSON.parse(readFileSync(configPath(root), 'utf8'));

/** An initialised repo whose recorded config PREDATES the optional components (keys stripped). */
function legacyFixture() {
  const root = tmpRepo();
  const r = run(root, 'init', '--stack', 'generic', '--yes', '--no-cursor');
  expect(r.status, r.stderr || r.stdout).toBe(0);
  const cfg = config(root);
  for (const c of OPTIONAL_COMPONENTS) delete cfg.components[c.id];
  writeFileSync(configPath(root), `${JSON.stringify(cfg, null, 2)}\n`);
  return root;
}

describe('unofferedComponents', () => {
  const id = OPTIONAL_COMPONENTS[0].id;

  it('offers a component whose key is ABSENT (a repo that predates it)', () => {
    expect(unofferedComponents({}).map((c) => c.id)).toContain(id);
    expect(unofferedComponents(undefined).map((c) => c.id)).toContain(id);
  });

  it('does not offer one that was answered — either way', () => {
    // The false case is the load-bearing one: a recorded decline must be as final as an accept.
    const declinedAll = Object.fromEntries(OPTIONAL_COMPONENTS.map((c) => [c.id, false]));
    const acceptedAll = Object.fromEntries(OPTIONAL_COMPONENTS.map((c) => [c.id, true]));
    expect(unofferedComponents(declinedAll as Partial<Selection>)).toEqual([]);
    expect(unofferedComponents(acceptedAll as Partial<Selection>)).toEqual([]);
    // Answering ONE component silences only that one — the rest stay offered.
    expect(unofferedComponents({ [id]: false } as Partial<Selection>).map((c) => c.id)).toEqual(
      OPTIONAL_COMPONENTS.slice(1).map((c) => c.id),
    );
  });

  it('lists only genuinely optional components', () => {
    // A recommended component arriving through this table would install itself on upgrade.
    expect(OPTIONAL_COMPONENTS.length).toBeGreaterThan(0);
    for (const c of OPTIONAL_COMPONENTS) expect(c.flag.startsWith('--')).toBe(true);
  });
});

describe('devkit upgrade — optional component offer', () => {
  it('REPORTS an unoffered component without installing it', () => {
    const root = legacyFixture();
    const up = run(root, 'upgrade');
    expect(up.status, up.stderr || up.stdout).toBe(0);

    expect(up.stdout).toContain('3c. newly bundled optional skills / hooks / tools');
    expect(up.stdout).toMatch(/devkit bundles the i-have-adhd skill/i);
    expect(up.stdout).toContain('--adhd');
    // Reported, not applied.
    expect(existsSync(join(root, '.claude', 'skills', 'i-have-adhd'))).toBe(false);
    // Core Oxc is reconciled independently of optional-component offers.
    expect(existsSync(join(root, '.devkit', 'oxc'))).toBe(true);
  });

  it('names WHAT is on offer, never devkit\'s internal word "component"', () => {
    // `component` is the Selection-toggle mechanism; a user told they can install a "component"
    // learns nothing. The copy is rendered from OptionalComponent.kind for exactly this reason.
    const root = legacyFixture();
    const out = run(root, 'upgrade').stdout;
    expect(out).toMatch(/i-have-adhd skill/);
    const offerSection = out.slice(out.indexOf('3c.'), out.indexOf('4.'));
    // Bans describing the OFFERED thing as a component. "the Agent skills component" is fine and
    // deliberate — that names a real prerequisite by the label the wizard shows.
    expect(offerSection).not.toMatch(/optional components/i);
    expect(offerSection).not.toMatch(/adhd component/i);
    expect(offerSection).not.toMatch(/component selection/i);
  });

  it('leaves the key ABSENT on a non-TTY run, so a real offer still happens later', () => {
    // The trap: step 4 rewrites the whole components block from the normalized selection, where
    // the component defaults to false. Recording that would be indistinguishable from a decline
    // and would kill the offer permanently — for every repo whose upgrades run unattended.
    const root = legacyFixture();
    expect(run(root, 'upgrade').status).toBe(0);
    expect(config(root).components.adhd).toBeUndefined();
    expect(config(root).components.oxc).toBeUndefined();

    // Still offered on the next run — the notice is not a one-shot.
    expect(run(root, 'upgrade').stdout).toMatch(/devkit bundles the i-have-adhd skill/i);
  });

  it('does NOT re-nag once the component was answered', () => {
    const root = tmpRepo();
    // A plain --yes init records adhd:false — an explicit init IS a decision.
    expect(run(root, 'init', '--stack', 'generic', '--yes', '--no-cursor').status).toBe(0);
    expect(config(root).components.adhd).toBe(false);
    expect(config(root).components.oxc).toBeUndefined();

    const up = run(root, 'upgrade');
    expect(up.status, up.stderr || up.stdout).toBe(0);
    expect(up.stdout).toContain('none — selection unchanged');
    expect(up.stdout).not.toMatch(/devkit bundles the i-have-adhd skill/i);
  });

  it('preserves an accepted component across upgrade', () => {
    const root = tmpRepo();
    expect(run(root, 'init', '--stack', 'generic', '--yes', '--no-cursor', '--adhd').status).toBe(
      0,
    );
    expect(run(root, 'upgrade').status).toBe(0);
    expect(config(root).components.adhd).toBe(true);
    expect(existsSync(join(root, ADHD_SKILL_DIR, 'SKILL.md'))).toBe(true);
  });

  it('leaves the key absent for an OVERLAY repo too', () => {
    // Overlay upgrade runs a self-contained branch with its OWN config writer (applyOverlay), so
    // the package branch's `undecided` handling does not cover it. Missing that, an overlay repo
    // recorded adhd:false on its first upgrade — a decline nobody made, killing the offer forever.
    // Overlay needs a REAL git repo — it writes .git/info/exclude and repoints core.hooksPath.
    const root = tmpRepo();
    execFileSync('git', ['init', '-q'], { cwd: root });
    const init = run(root, 'init', '--overlay', '--stack', 'generic', '--yes');
    expect(init.status, init.stderr || init.stdout).toBe(0);
    const cfg = config(root);
    expect(cfg.overlay).toBe(true);
    for (const c of OPTIONAL_COMPONENTS) delete cfg.components[c.id];
    writeFileSync(configPath(root), `${JSON.stringify(cfg, null, 2)}\n`);

    const up = run(root, 'upgrade');
    expect(up.status, up.stderr || up.stdout).toBe(0);
    expect(up.stdout).toMatch(/devkit bundles the i-have-adhd skill/i);
    expect(config(root).components.adhd).toBeUndefined();
    expect(up.stdout).not.toMatch(/devkit bundles the Oxc tool/i);
    expect(config(root).components.oxc).toBeUndefined();
  });

  it('--dry-run announces the offer and writes nothing', () => {
    const root = legacyFixture();
    const up = run(root, 'upgrade', '--dry-run');
    expect(up.status, up.stderr || up.stdout).toBe(0);
    expect(up.stdout).toMatch(/\[dry-run\] would offer the i-have-adhd skill/);
    expect(up.stdout).toContain('[dry-run] sync .devkit/oxc/oxlint.base.json');
    expect(config(root).components.adhd).toBeUndefined();
    expect(config(root).components.oxc).toBeUndefined();
  });
});
