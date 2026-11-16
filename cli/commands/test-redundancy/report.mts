/** fallow's `mutation --kill-matrix-for` report, reduced to the tests a person should look at. The
 * verdicts are fallow's own lists; devkit never works redundancy out from raw kill counts. */
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
  kill_matrix: z
    .object({
      candidates: strings,
      coverage_without_kills: strings,
      targets: z
        .array(
          z.object({ target: z.string(), test_ids: strings, status: z.string(), reasons: strings }),
        )
        .nullish(),
    })
    .nullish(),
});
export type KillMatrixReport = z.infer<typeof killMatrixReport>;

export interface FlaggedTest {
  testId: string;
  verdict: 'redundant' | 'kills nothing';
}

export interface UnjudgedTarget {
  target: string;
  tests: number;
  reasons: string[];
}

export interface Redundancy {
  flagged: FlaggedTest[];
  unjudged: UnjudgedTarget[];
  judged: number;
}

export function redundancy(report: KillMatrixReport): Redundancy {
  const matrix = report.kill_matrix ?? {};
  const targets = matrix.targets ?? [];
  const complete = new Set(
    targets.filter((t) => t.status === 'complete').flatMap((t) => t.test_ids ?? []),
  );
  const flag = (verdict: FlaggedTest['verdict']) => (testId: string) => ({ testId, verdict });
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
