/** fallow's `mutation --kill-matrix-for` report, reduced to what a person should look at: changed
 * lines no test catches, and tests fallow lists as redundant. The verdicts are fallow's own. */
import { z } from 'zod';
const strings = z.array(z.string()).nullish();
/** Only the fields this command reads; fallow's JSON carries many more, and may send null for any. */
export const killMatrixReport = z.object({
    error: z.boolean().nullish(),
    message: z.string().nullish(),
    elapsed_ms: z.number().nullish(),
    summary: z
        .object({
        counts: z.object({ total: z.number().nullish(), pending: z.number().nullish() }).nullish(),
    })
        .nullish(),
    mutants: z
        .array(z.object({
        file: z.string().nullish(),
        line: z.number().nullish(),
        status: z.string().nullish(),
        operator: z.string().nullish(),
        change: z.object({ from: z.string().nullish(), to: z.string().nullish() }).nullish(),
    }))
        .nullish(),
    kill_matrix: z
        .object({
        candidates: strings,
        coverage_without_kills: strings,
        targets: z
            .array(z.object({ target: z.string(), test_ids: strings, status: z.string(), reasons: strings }))
            .nullish(),
    })
        .nullish(),
});
export function redundancy(report) {
    const matrix = report.kill_matrix ?? {};
    const targets = matrix.targets ?? [];
    const complete = new Set(targets.filter((t) => t.status === 'complete').flatMap((t) => t.test_ids ?? []));
    const flag = (verdict) => (testId) => ({ testId, verdict });
    const flagged = [
        ...(matrix.candidates ?? []).filter((id) => complete.has(id)).map(flag('redundant')),
        ...(matrix.coverage_without_kills ?? [])
            .filter((id) => complete.has(id))
            .map(flag('kills nothing')),
    ];
    const unjudged = targets
        .filter((t) => t.status !== 'complete')
        .map((t) => ({ target: t.target, tests: t.test_ids?.length ?? 0, reasons: t.reasons ?? [] }));
    return { flagged, unjudged, judged: complete.size };
}
/** The planted bugs on lines the change touched. `no_coverage` counts as run: no test reaches it. */
export function changedLines(report, isChanged) {
    const uncaught = [];
    let planned = 0;
    let ran = 0;
    for (const { file, line, status, operator, change } of report.mutants ?? []) {
        if (!file || !line || !isChanged(file, line))
            continue;
        planned += 1;
        if (status === 'pending')
            continue;
        ran += 1;
        if (status === 'survived') {
            uncaught.push({
                file,
                line,
                what: `${operator ?? 'change'}: ${change?.from} → ${change?.to}`,
            });
        }
        else if (status === 'no_coverage') {
            uncaught.push({ file, line, what: 'no test runs this line' });
        }
    }
    return { uncaught, planned, ran };
}
