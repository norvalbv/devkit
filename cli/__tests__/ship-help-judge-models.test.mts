import { describe, expect, it } from 'vitest';
import {
  claudeFamilyEnvLine,
  JUDGE_MODEL_ENVS,
  judgeEnvUnsetLine,
} from '../../gate-engine/judge/outage/family-override.mts';
import { isCodexModel } from '../../gate-engine/judge/codex/result.mts';
import { meta } from '../commands/ship.mts';

// sc-3497: GUARD_REVIEW_MODEL alone left completeness on codex. The help names every judge knob,
// rendered from the table the outage remedy uses, so a new knob cannot ship without appearing here.
describe('devkit ship --help — judge models', () => {
  it('lists every env that selects a judging model', () => {
    for (const env of JUDGE_MODEL_ENVS) expect(meta.help).toContain(env);
  });

  it('prints the complete family move and the way back verbatim', () => {
    expect(meta.help).toContain(claudeFamilyEnvLine());
    expect(meta.help).toContain(judgeEnvUnsetLine());
  });

  it('states the routing rule the engine actually applies', () => {
    expect(meta.help).toContain('`gpt-` runs on the codex CLI');
    expect(isCodexModel('gpt-5.6-sol')).toBe(true);
    expect(isCodexModel('opus')).toBe(false);
  });

  it('names the knob the completeness judge reads', () => {
    expect(meta.help).toMatch(
      /completeness reads GUARD_REVIEW_ESCALATION_MODEL,\s+not GUARD_REVIEW_MODEL/,
    );
  });
});
