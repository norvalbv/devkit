#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { judgeComment } from '../judge.mts';
import type { CommentFinding, CommentRationale } from '../types.mts';

interface Row {
  id: string;
  expected: 'PASS' | 'FAIL';
  comment: string;
  code: string;
  rationale: string;
  ticket?: string;
}

const corpusPath = fileURLToPath(new URL('./corpus.json', import.meta.url));

export function loadCorpus(): Row[] {
  return JSON.parse(readFileSync(corpusPath, 'utf8')) as Row[];
}

function fixture(row: Row): { finding: CommentFinding; rationale: CommentRationale } {
  return {
    finding: {
      id: row.id.padEnd(12, '0').slice(0, 12),
      path: `src/eval/${row.id}.ts`,
      extension: 'ts',
      adapterVersion: 'typescript-scanner-v1',
      kind: row.comment.startsWith('/*') ? 'block' : 'line',
      startLine: 2,
      endLine: 2,
      comment: row.comment,
      context: `${row.code}\n${row.comment}`,
      relevantDiff: `@@ -1 +1,2 @@\n ${row.code}\n+${row.comment}`,
    },
    rationale: {
      rationale: row.rationale,
      at: 'benchmark',
      ...(row.ticket ? { ticket: row.ticket } : {}),
    },
  };
}

export function runCorpus(cwd = process.cwd()): number {
  const filter = process.env.COMMENT_EVAL_FILTER;
  const rows = loadCorpus().filter((row) => !filter || row.id === filter);
  if (rows.length === 0) throw new Error(`COMMENT_EVAL_FILTER matched no corpus row: ${filter}`);
  let correct = 0;
  let predictedPass = 0;
  let correctPass = 0;
  for (const row of rows) {
    const { finding, rationale } = fixture(row);
    const result = judgeComment(cwd, finding, rationale);
    const actual = result?.verdict ?? 'NO_VERDICT';
    if (actual === row.expected) correct += 1;
    if (actual === 'PASS') {
      predictedPass += 1;
      if (row.expected === 'PASS') correctPass += 1;
    }
    console.log(
      `${actual === row.expected ? 'PASS' : 'MISS'} ${row.id}: expected=${row.expected} actual=${actual}${result ? ` — ${result.reason}` : ''}`,
    );
  }
  const accuracy = correct / rows.length;
  const approvalPrecision = predictedPass === 0 ? 1 : correctPass / predictedPass;
  console.log(
    `comment-firewall eval: ${correct}/${rows.length} accuracy=${accuracy.toFixed(3)} approval_precision=${approvalPrecision.toFixed(3)}`,
  );
  return accuracy >= 0.9 && approvalPrecision === 1 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = runCorpus();
}
