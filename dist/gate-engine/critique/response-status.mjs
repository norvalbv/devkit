export const PLAN_CRITIQUE_STATUSES = ['reviewed', 'wrong_phase', 'aborted'];
export const PLAN_CRITIQUE_VERDICTS = [
    'PROCEED',
    'PROCEED_WITH_CHANGES',
    'RETHINK',
    'REJECT',
];
export const PLAN_CRITIQUE_FEASIBILITY_STATUSES = [
    'CONFIRMED_FEASIBLE',
    'PARTIALLY_FEASIBLE',
    'NOT_FEASIBLE',
];
export const PLAN_CRITIQUE_FRAME_METAS = ['SOUND', 'NOTABUG', 'BANDAID', 'UXHARM', 'SKIP'];
export const PLAN_CRITIQUE_LENSES = [
    'ALIGNMENT',
    'FEASIBILITY',
    'UX_DX',
    'SECURITY',
    'CODEBASE_CONFLICT',
    'SCOPE_COMPLEXITY',
    'DATA_FLOW',
    'RUNTIME_CONFIGURATION',
    'REGISTRATION_DISCOVERY',
    'MISSING_CONSIDERATION',
];
export const PLAN_CRITIQUE_EDGE_CASE_CATEGORIES = [
    'State & Data Integrity',
    'Temporal & Concurrency',
    'Contract & Boundary Handling',
    'Permission & Security Boundaries',
    'Recovery & Failure Modes',
    'UX Behavioral Correctness',
];
export const PLAN_CRITIQUE_ACTION_KINDS = [
    'recommendation',
    'route_implementation_reviewer',
];
/** Validate invariants that span multiple fields of an otherwise structurally valid response. */
export function validatePlanCritiqueStatus(response, invalid) {
    const routeActionIndex = response.actions.findIndex((action) => action.kind === 'route_implementation_reviewer');
    if (response.status !== 'wrong_phase' && routeActionIndex !== -1)
        invalid(`$.actions[${routeActionIndex}].kind`, 'implementation-reviewer routing is only valid for wrong_phase responses');
    if (response.status === 'reviewed') {
        const verdict = response.verdict ?? invalid('$.verdict', 'reviewed responses require a verdict');
        const feasibility = response.feasibility ?? invalid('$.feasibility', 'reviewed responses require feasibility');
        if (feasibility.evidence.length === 0)
            invalid('$.feasibility.evidence', 'reviewed responses require feasibility evidence');
        if (response.edgeCases.length === 0)
            invalid('$.edgeCases', 'reviewed responses require at least one edge case');
        if (response.actions.length === 0)
            invalid('$.actions', 'reviewed responses require at least one recommendation action');
        if (response.strengths.length === 0)
            invalid('$.strengths', 'reviewed responses require at least one strength');
        const criticalCount = response.findings.filter((finding) => finding.severity === 'CRITICAL').length;
        if (verdict === 'PROCEED' && criticalCount > 0)
            invalid('$.findings', 'PROCEED cannot carry CRITICAL findings');
        if (verdict === 'PROCEED_WITH_CHANGES' && response.findings.length === 0)
            invalid('$.findings', 'PROCEED_WITH_CHANGES requires at least one finding');
        if ((verdict === 'RETHINK' || verdict === 'REJECT') && criticalCount === 0)
            invalid('$.findings', `${verdict} requires at least one CRITICAL finding`);
        if ((response.frameMeta === 'BANDAID' || response.frameMeta === 'NOTABUG') &&
            verdict !== 'RETHINK' &&
            verdict !== 'REJECT')
            invalid('$.verdict', `${response.frameMeta} requires RETHINK or REJECT`);
        if (feasibility.status === 'CONFIRMED_FEASIBLE' && feasibility.blockers.length > 0)
            invalid('$.feasibility.blockers', 'confirmed feasibility cannot carry blockers');
        if (feasibility.status === 'NOT_FEASIBLE' && feasibility.blockers.length === 0)
            invalid('$.feasibility.blockers', 'not-feasible responses require a blocker');
        if ((verdict === 'PROCEED' || verdict === 'PROCEED_WITH_CHANGES') &&
            (feasibility.status === 'NOT_FEASIBLE' || feasibility.blockers.length > 0))
            invalid('$.feasibility', `${verdict} requires feasible, unblocked execution`);
        if (response.frameMeta === 'UXHARM' && response.uxImpact.level !== 'degrades')
            invalid('$.uxImpact.level', 'frameMeta UXHARM requires a degrading UX impact');
        if (response.uxImpact.level === 'degrades' &&
            response.frameMeta !== 'UXHARM' &&
            response.frameMeta !== 'BANDAID' &&
            response.frameMeta !== 'NOTABUG')
            invalid('$.frameMeta', 'degrading UX requires UXHARM or a higher-priority frame');
        if (response.uxImpact.level === 'degrades' &&
            !response.findings.some((finding) => finding.lens === 'UX_DX'))
            invalid('$.findings', 'degrading UX impact requires a UX_DX finding');
        const risks = new Map();
        const edgeCaseIds = new Set();
        response.edgeCases.forEach((edgeCase, index) => {
            if (edgeCase.risk.triggers.length === 0)
                invalid(`$.edgeCases[${index}].risk.triggers`, 'risk requires at least one trigger');
            if (edgeCaseIds.has(edgeCase.id))
                invalid(`$.edgeCases[${index}].id`, 'edge-case ids must be unique');
            edgeCaseIds.add(edgeCase.id);
            const metadata = `${edgeCase.risk.layer}\0${edgeCase.risk.category}`;
            const prior = risks.get(edgeCase.risk.id);
            if (prior !== undefined && prior !== metadata)
                invalid(`$.edgeCases[${index}].risk`, 'one risk id must keep one layer and category');
            risks.set(edgeCase.risk.id, metadata);
            if (edgeCase.coverageStatus === 'covered' && edgeCase.coveredBy.length === 0)
                invalid(`$.edgeCases[${index}].coveredBy`, 'covered edge cases require coverage references');
        });
        return;
    }
    if (response.verdict !== null)
        invalid('$.verdict', `${response.status} responses require a null verdict`);
    if (response.feasibility !== null)
        invalid('$.feasibility', `${response.status} responses require null feasibility`);
    if (response.frameMeta !== 'SKIP')
        invalid('$.frameMeta', `${response.status} responses require frameMeta SKIP`);
    if (response.findings.length !== 0)
        invalid('$.findings', `${response.status} responses require zero findings`);
    if (response.edgeCases.length !== 0)
        invalid('$.edgeCases', `${response.status} responses require zero edge cases`);
    if (response.actions.length === 0)
        invalid('$.actions', `${response.status} responses require at least one action`);
    if (response.status === 'wrong_phase' &&
        !response.actions.some((action) => action.kind === 'route_implementation_reviewer'))
        invalid('$.actions', 'wrong_phase responses must route the caller to a future implementation reviewer');
    if (response.uxImpact.level !== 'none')
        invalid('$.uxImpact.level', `${response.status} responses do not critique UX impact`);
    if (response.strengths.length !== 0)
        invalid('$.strengths', `${response.status} responses require zero strengths`);
    if (response.researchReferences.length !== 0)
        invalid('$.researchReferences', `${response.status} responses require zero research references`);
    if (response.scope.frontend || response.scope.backend || response.scope.shared)
        invalid('$.scope', `${response.status} responses require an all-false scope`);
    const analysis = response.analysis;
    if (analysis.title !== '' ||
        analysis.proposal !== '' ||
        analysis.decisionLogAlignment.present ||
        analysis.decisionLogAlignment.targetsQueried.length > 0 ||
        analysis.decisionLogAlignment.conflicts.length > 0 ||
        analysis.sourceToSinkTrace !== '' ||
        analysis.implicitAssumptions.length > 0 ||
        analysis.layoutAlignment !== '' ||
        analysis.configurationRows.length > 0 ||
        analysis.missingConsiderations.length > 0)
        invalid('$.analysis', `${response.status} responses require neutral analysis`);
}
