import { emitGateEvent, emitGateInfraFailure, finishGateTiming } from '../judge/gate-events.mjs';
/** Records the gate decision; SILENT can mean irrelevant or receipt-covered, never a new QA pass. */
export function finishQavis(startedAt, outcome, code, qaExitCode, detail) {
    const event = {
        gate: 'qavis-advisory',
        qavis_outcome: outcome,
        exit_code: code,
    };
    if (qaExitCode !== undefined)
        event.qa_exit_code = qaExitCode;
    if (outcome === 'unavailable') {
        emitGateInfraFailure({ ...event, cause: 'route_unavailable', detail });
    }
    else {
        const outcomes = {
            silent: { type: 'gate_result', status: 'pass' },
            self_run_cleared: { type: 'gate_result', status: 'pass' },
            required: code === 3
                ? { type: 'gate_result', status: 'fail' }
                : { type: 'advisory_result', status: 'finding' },
        };
        emitGateEvent({
            ...event,
            ...outcomes[outcome],
            detail: `qavis-advisory(${outcome})`,
        });
    }
    if (outcome === 'required' && code === 3)
        console.error('qavis-advisory: strict gate blocked');
    return finishGateTiming('qavis-advisory', startedAt, code);
}
