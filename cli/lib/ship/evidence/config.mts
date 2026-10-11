// guard.config.json `evidence`: the consumer's own test command and support globs, so ship never
// assumes devkit's layout. An absent key means ship writes no evidence block at all.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { parseJsonObject } from '../../../../gate-engine/config-json.mts';
import { hasUnsupportedGlobSyntax } from '../../../../skills/_devkit/review-roots.mjs';

export const FILES_PLACEHOLDER = '{files}';
export const REPORT_PLACEHOLDER = '{report}';

const evidenceSchema = z.strictObject({
  command: z
    .array(z.string().min(1))
    .refine(
      (argv) => argv.filter((arg) => arg === FILES_PLACEHOLDER).length === 1,
      'must contain exactly one "{files}" element',
    )
    .refine(
      (argv) => argv.some((arg) => arg.includes(REPORT_PLACEHOLDER)),
      'must write its Vitest JSON report to "{report}"',
    ),
  supportPaths: z
    .array(
      z
        .string()
        .min(1)
        .refine((glob) => !hasUnsupportedGlobSyntax(glob), 'must use only *, ** and ?'),
    )
    .default([]),
  timeoutSeconds: z.number().int().positive().max(3600).default(120),
});

export type EvidenceConfig = z.infer<typeof evidenceSchema>;

const configSchema = z.looseObject({ evidence: evidenceSchema.optional() });

/** The validated `evidence` entry, or null when the repository has not configured one. */
export function readEvidenceConfig(root: string): EvidenceConfig | null {
  const file = join(root, 'guard.config.json');
  if (!existsSync(file)) return null;
  const parsed = configSchema.safeParse(
    parseJsonObject<object>(readFileSync(file, 'utf8'), 'guard.config.json'),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `.${issue.path.join('.')}` : '';
    throw new Error(`guard.config.json${where}: ${issue?.message ?? 'invalid evidence entry'}`);
  }
  return parsed.data.evidence ?? null;
}

/** The argv with `{files}` spread into the test paths and `{report}` naming the report file. */
export function expandCommand(
  command: readonly string[],
  files: readonly string[],
  report: string,
): string[] {
  return command.flatMap((arg) =>
    arg === FILES_PLACEHOLDER ? [...files] : [arg.replaceAll(REPORT_PLACEHOLDER, report)],
  );
}
