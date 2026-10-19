/**
 * Early red: a job whose steps all run after a failure (`if: !cancelled()`) stays pending for the
 * whole suite, yet a failed step cannot turn green within the attempt. Read the steps, not the check.
 */
import { z } from 'zod';
const JOB_LINK = /\/actions\/runs\/(\d+)\/job\/(\d+)/;
/** The jobs-endpoint fields this reader uses; a malformed answer is REJECTED, not read. */
const jobsSchema = z.object({
    jobs: z.array(z.object({
        id: z.number(),
        // Optional in GitHub's job schema: a job queued behind `needs:` may not list any yet.
        steps: z.array(z.object({ name: z.string(), conclusion: z.string().nullable() })).default([]),
    })),
});
/** Failed step names per job id, from `repos/<repo>/actions/runs/<run>/jobs`; null when unusable. */
export function failedStepsByJob(raw) {
    let json;
    try {
        json = JSON.parse(raw);
    }
    catch {
        return null;
    }
    const parsed = jobsSchema.safeParse(json);
    if (!parsed.success)
        return null;
    return new Map(parsed.data.jobs.map((job) => [
        job.id,
        job.steps.filter((s) => s.conclusion === 'failure').map((s) => s.name),
    ]));
}
/** One run's failed steps, or an empty map when gh cannot say: this read only ever adds a red. */
function readRun(run, repo, cwd, exec) {
    try {
        // The default `filter=latest` is the current attempt; a job past page one simply stays pending.
        return (failedStepsByJob(exec(['api', `repos/${repo}/actions/runs/${run}/jobs?per_page=100`], cwd)) ??
            new Map());
    }
    catch {
        return new Map();
    }
}
/** Turn each pending Actions job with a failed step into a `fail` row naming `check › step`. */
export function withFailedSteps(rows, { repo, cwd, exec }) {
    const runs = new Map(); // one gh call per run, however many jobs
    return rows.map((row) => {
        const match = row.bucket === 'pending' ? JOB_LINK.exec(row.link) : null;
        if (!match)
            return row;
        const [, run, job] = match;
        if (!runs.has(run))
            runs.set(run, readRun(run, repo, cwd, exec));
        const steps = runs.get(run)?.get(Number(job));
        return steps?.length
            ? { ...row, bucket: 'fail', failedSteps: steps.map((s) => `${row.name} › ${s}`) }
            : row;
    });
}
