#!/usr/bin/env node
/** Runs one registered hook command unchanged (same stdin, stdout, stderr and exit code) and appends
 * what it delivered to $BENCH_STAMP_DIR/tap.jsonl, outside the scratch repo. */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SLUG_RE = /^- \*\*([^*]+)\*\*/gm;
const OUTAGE_NOTICE = 'DID NOT RUN';

const [registration = '', command = ''] = process.argv.slice(2);
const stdin = readFileSync(0, 'utf8');
const run = spawnSync(command, {
  shell: true,
  input: stdin,
  encoding: 'utf8',
  env: { ...process.env, BENCH_CALLER: 'hook' },
});
process.stdout.write(run.stdout ?? '');
process.stderr.write(run.stderr ?? '');

const parse = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const stampDir = process.env.BENCH_STAMP_DIR;
if (stampDir) {
  const input = parse(stdin);
  const text = String(parse(run.stdout ?? '')?.hookSpecificOutput?.additionalContext ?? '');
  const task = parse(
    readFileSync(path.join(process.env.BENCH_TASK_DIR ?? '', 'task.json'), 'utf8'),
  );
  const file = String(input?.tool_input?.file_path ?? '');
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const row = {
    registration,
    tool: input?.tool_name,
    rel: path.isAbsolute(file) ? path.relative(root, file) : file,
    briefChars: text.length,
    slugs: [...text.matchAll(SLUG_RE)].map((match) => match[1]),
    outage: text.includes(OUTAGE_NOTICE),
    clauseShown: Boolean(task?.bindingText) && text.includes(task.bindingText),
  };
  appendFileSync(path.join(stampDir, 'tap.jsonl'), `${JSON.stringify(row)}\n`);
}
process.exit(run.status ?? 1);
