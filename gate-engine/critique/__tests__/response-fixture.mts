import type { PlanCritiqueResponseV1 } from '../response-contract.mts';

export const REVIEWED_RESPONSE: PlanCritiqueResponseV1 = {
  schemaVersion: 1,
  kind: 'plan_critique',
  phase: 'plan',
  scope: { frontend: false, backend: false, shared: true },
  analysis: {
    title: 'Normalized critique transport',
    proposal: 'Keep the scoring pipeline and replace only its transport contract.',
    decisionLogAlignment: {
      present: true,
      targetsQueried: ['plan-critique-evidence-loop'],
      conflicts: [],
    },
    sourceToSinkTrace:
      'The model writes normalized JSON, the runner parses it, and the matcher consumes a projection.',
    implicitAssumptions: ['A non-null stdout value means the model completed successfully.'],
    layoutAlignment: 'The transport seam is independent of consumer repository layout.',
    configurationRows: [
      {
        configuration: 'legacy benchmark consumer',
        expected: 'Read a projection of the normalized response.',
        proposed: 'Read a report path the response no longer writes.',
        correct: false,
        evidence: 'The runner still reads the removed report file.',
      },
      {
        configuration: 'direct normalized consumer',
        expected: 'Parse the normalized response directly.',
        proposed: 'Parse the normalized response directly.',
        correct: true,
        evidence: 'The parser seam accepts the exact closed response contract.',
      },
    ],
    missingConsiderations: ['A parser failure needs a completed-failure state.'],
  },
  status: 'reviewed',
  verdict: 'RETHINK',
  feasibility: {
    status: 'PARTIALLY_FEASIBLE',
    evidence: ['The existing parser seam can be reused.'],
    blockers: [],
  },
  frameMeta: 'SOUND',
  uxImpact: { level: 'none', detail: 'The transport correction preserves the user workflow.' },
  summary: 'Keep the scoring pipeline and replace only its transport contract.',
  findings: [
    {
      severity: 'CRITICAL',
      lens: 'DATA_FLOW',
      claim: 'The file writer and reader disagree.',
      evidence: 'The runner reads a path the response no longer writes.',
      impact: 'Every valid critique appears empty to the matcher.',
      recommendation: 'Project the normalized response at the runner boundary.',
    },
    {
      severity: 'WARNING',
      lens: 'MISSING_CONSIDERATION',
      claim: 'Malformed model output needs a completed-failure state.',
      evidence: 'A non-null stdout is currently the completion signal.',
      impact: 'Parser failures can otherwise inflate outage counts.',
      recommendation: 'Track response validity separately from process availability.',
    },
  ],
  edgeCases: [
    {
      id: 'EC1',
      risk: {
        id: 'R1',
        layer: 'shared',
        category: 'Contract & Boundary Handling',
        triggers: ['stdout violates the normalized response contract'],
      },
      scenario: 'The critic returns a fenced JSON object.',
      expectedBehavior: 'Reject it without throwing and do not classify it as an outage.',
      testType: 'unit',
      coverageStatus: 'covered',
      coveredBy: ['response-contract.test.mts'],
      notes: '',
    },
    {
      id: 'EC2',
      risk: {
        id: 'R1',
        layer: 'shared',
        category: 'Contract & Boundary Handling',
        triggers: ['stdout violates the normalized response contract'],
      },
      scenario: 'The critic adds a future field without changing schemaVersion.',
      expectedBehavior: 'Reject the response as an unknown-field contract violation.',
      testType: 'unit',
      coverageStatus: 'covered',
      coveredBy: ['response-contract.test.mts'],
      notes: 'The parser is intentionally closed-world.',
    },
  ],
  actions: [
    { kind: 'recommendation', detail: 'Adopt the normalized response at the runner seam.' },
  ],
  strengths: ['The existing matcher and score functions remain unchanged.'],
  researchReferences: [
    { title: 'JSON data interchange syntax', url: 'https://www.rfc-editor.org/rfc/rfc8259' },
  ],
};
