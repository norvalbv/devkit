/**
 * The i-have-adhd SessionStart hook — the always-on half of the `adhd` component.
 *
 * The skill sets `disable-model-invocation: true`, so NOTHING but this hook can start it; if the
 * hook is silently a no-op, selecting the component gets you a file on disk and no behaviour, and
 * nothing else in the suite would notice. So this exercises the real script as Claude runs it:
 * spawn it, feed it CLAUDE_PROJECT_DIR, parse its stdout as the hook protocol.
 *
 * Every skip path is asserted too. A SessionStart hook that throws or emits garbage degrades every
 * session start in the repo, so "say nothing, exit 0" is the required behaviour whenever the skill
 * is not there to inject.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ADHD_SKILL_DIR } from '../lib/install/adhd-skill.mts';
import { HOOK_REGISTRATIONS } from '../lib/install/hook-registration-ledger/registrations.mts';
import {
  ADHD_SESSION_HOOK,
  hookScriptsFor,
} from '../lib/install/hook-registration-ledger/selection.mts';
import { rootRegistry } from './_helpers.mts';

const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'agents-hooks',
  ADHD_SESSION_HOOK,
);
const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

const SKILL_BODY = '# i-have-adhd\n\nLead with the next action. Number multi-step work.\n';

function repoWithSkill(body: string | null = SKILL_BODY) {
  const root = mkTmp('adhd-hook-');
  if (body !== null) {
    const dir = join(root, ADHD_SKILL_DIR);
    mkdirSync(dir, { recursive: true });
    // Frontmatter present, exactly as the vendored file ships it.
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: i-have-adhd\nlicense: MIT\n---\n${body}`);
  }
  return root;
}

const run = (root: string) =>
  spawnSync(process.execPath, [HOOK], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });

describe('adhd SessionStart hook', () => {
  it('emits the skill body as SessionStart additionalContext', () => {
    const r = run(repoWithSkill());
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain('Lead with the next action');
    expect(out.systemMessage).toMatch(/i-have-adhd/);
  });

  it('injects the BODY only — never the YAML frontmatter', () => {
    // Frontmatter is loader metadata, not instructions; shipping it as context is pure noise.
    const ctx = JSON.parse(run(repoWithSkill()).stdout).hookSpecificOutput.additionalContext;
    expect(ctx).not.toContain('license: MIT');
    expect(ctx.trimStart().startsWith('# i-have-adhd')).toBe(true);
  });

  it('strips CRLF frontmatter too — a Windows checkout must not leak YAML into context', () => {
    // The LF-only pattern silently fails to match under core.autocrlf, and the frontmatter then
    // rides into every session as noise. ponytail-frink's injector has the same shape, so this is
    // a class of bug rather than a one-off.
    const root = mkTmp('adhd-crlf-');
    const dir = join(root, ADHD_SKILL_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\r\nname: i-have-adhd\r\nlicense: MIT\r\n---\r\n# i-have-adhd\r\n\r\nLead with the next action.\r\n',
    );
    const ctx = JSON.parse(run(root).stdout).hookSpecificOutput.additionalContext;
    expect(ctx).not.toContain('license: MIT');
    expect(ctx.trimStart().startsWith('# i-have-adhd')).toBe(true);
  });

  it("appends devkit's footer without touching the vendored file", () => {
    // The vendored SKILL.md must stay byte-identical to its pinned upstream (vendored-skills.test),
    // so anything devkit adds has to be composed at inject time.
    const ctx = JSON.parse(run(repoWithSkill()).stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('.devkit/adhd-off');
    expect(ctx).toContain('stop adhd mode');
  });

  it('stays silent when .devkit/adhd-off exists — the durable off switch', () => {
    // Without this, "stop adhd mode" lasts only until the next compaction re-fires the hook.
    const root = repoWithSkill();
    mkdirSync(join(root, '.devkit'), { recursive: true });
    writeFileSync(join(root, '.devkit', 'adhd-off'), '');
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('stays silent when the skill is not installed (adhd deselected)', () => {
    const r = run(repoWithSkill(null));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('stays silent on an empty skill body rather than injecting nothing-shaped context', () => {
    const r = run(repoWithSkill(''));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});

describe('adhd hook wiring', () => {
  it('registers on SessionStart including compact', () => {
    // `compact` is the load-bearing matcher: the style's "rest of the session" persistence is
    // instruction text, so without re-firing after a compaction it silently decays.
    const [reg] = HOOK_REGISTRATIONS.adhd;
    expect(reg.event).toBe('SessionStart');
    expect(reg.matcher).toContain('compact');
    expect(reg.command).toContain(ADHD_SESSION_HOOK);
  });

  it('is owned by adhd alone — agentHooks neither installs nor prunes it', () => {
    const base = { agentHooks: true, decisions: false, fallow: false };
    expect(hookScriptsFor({ ...base, adhd: false })).not.toContain(ADHD_SESSION_HOOK);
    expect(hookScriptsFor({ ...base, adhd: true })).toContain(ADHD_SESSION_HOOK);
    // …and it arrives with agent hooks OFF, since the component owns it independently.
    expect(
      hookScriptsFor({ agentHooks: false, decisions: false, fallow: false, adhd: true }),
    ).toEqual([ADHD_SESSION_HOOK]);
  });
});
