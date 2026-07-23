import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PLAN_CRITIQUE_ACTION_KINDS,
  PLAN_CRITIQUE_EDGE_CASE_CATEGORIES,
  PLAN_CRITIQUE_FEASIBILITY_STATUSES,
  PLAN_CRITIQUE_FRAME_METAS,
  PLAN_CRITIQUE_LENSES,
  PLAN_CRITIQUE_STATUSES,
  PLAN_CRITIQUE_VERDICTS,
} from '../response-status.mts';
import { REVIEWED_RESPONSE } from './response-fixture.mts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const agent = readFileSync(join(ROOT, 'agents', 'feature-critique.md'), 'utf8');
const skill = readFileSync(join(ROOT, 'skills', 'feature-critique', 'SKILL.md'), 'utf8');
const brainstorming = readFileSync(join(ROOT, 'skills', 'brainstorming', 'SKILL.md'), 'utf8');

describe('feature-critique guidance', () => {
  it('preserves the substantive critique lenses and evidence rules', () => {
    const preservedGuidance = [
      '<architecture_context>',
      '<discovery_workflow>',
      '<sources severity="HIGH">',
      'Phase 0: Read repo context + load governing Targets',
      'Decision alignment — MANDATORY',
      'Validate critical claims with real evidence',
      'Frame check — symptom vs root cause',
      'Decompose-then-verify',
      '**Feasibility**',
      '**UX / DX Impact**',
      '**Security**',
      '**Codebase Conflicts**',
      '**Scope & Complexity**',
      '**Data Flow and State Correctness**',
      '**Runtime Behavior Across Configurations**',
      'Frame Second-Opinion + Deterministic Gate',
      'Burden of proof for blockers',
      'FABRICATED BLOCKER',
    ];
    for (const marker of preservedGuidance) expect(agent).toContain(marker);
  });

  it('documents every closed-contract root field and enum value', () => {
    for (const field of Object.keys(REVIEWED_RESPONSE)) expect(agent).toContain(field);
    for (const value of [
      ...PLAN_CRITIQUE_STATUSES,
      ...PLAN_CRITIQUE_VERDICTS,
      ...PLAN_CRITIQUE_FEASIBILITY_STATUSES,
      ...PLAN_CRITIQUE_FRAME_METAS,
      ...PLAN_CRITIQUE_LENSES,
      ...PLAN_CRITIQUE_EDGE_CASE_CATEGORIES,
      ...PLAN_CRITIQUE_ACTION_KINDS,
    ])
      expect(agent).toContain(value);
  });

  it('documents the parser cross-field invariants that commonly invalidate model output', () => {
    const invariants = [
      'analysis.title',
      'analysis.proposal',
      'analysis.sourceToSinkTrace',
      'analysis.layoutAlignment',
      'at least one recommendation',
      'require feasible,',
      'unblocked execution',
      '`BANDAID` and `NOTABUG` require `RETHINK` or `REJECT`',
      'include a `UX_DX` finding',
      '`UXHARM` always uses `degrades`',
      'unique `id`',
      'at least one risk trigger',
      'same layer and category',
      'at least one `coveredBy` reference',
      'routing action appears',
      'only on `wrong_phase`',
    ];
    for (const invariant of invariants) expect(agent).toContain(invariant);
  });

  it('returns evidence in the final response without runtime repository artifacts', () => {
    const forbidden = [
      '.cursor/.feature-critique.md',
      '.cursor/.edge-cases',
      'EDGE_CASES_ID',
      'flowId',
      'FRAME_META',
      'Recommended Path Forward',
      'PROCEED WITH CHANGES',
    ];
    for (const text of [agent, skill])
      for (const marker of forbidden) expect(text).not.toContain(marker);
    expect(agent).toContain('Return **exactly one JSON object**');
    expect(agent).toContain('Do not write a separate artifact');
  });

  it('runs once on the final plan, permits one blocker recheck, and stops looping', () => {
    for (const text of [skill, brainstorming]) {
      expect(text).toContain('decision-complete');
      expect(text).toContain('one fresh recheck');
      expect(text).toMatch(/instead\s+of looping/u);
      expect(text).toContain('first response is `aborted`, `wrong_phase`, or invalid JSON');
      expect(text).toMatch(/Do not (?:schedule|run) periodic critique/u);
      expect(text).toContain('wrong_phase');
    }
  });
});
