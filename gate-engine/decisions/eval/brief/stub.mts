#!/usr/bin/env node
/** Stands in for guard-decisions in a decisions-brief scratch repo: answers from the task's frozen
 * brief.json and logs each call, with its caller, to $BENCH_STAMP_DIR/stub.jsonl. */
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

interface Axis {
  slug: string;
  ruling: string;
}

const taskDir = process.env.BENCH_TASK_DIR ?? '';
const argv = process.argv.slice(2);
const [command, ...rest] = argv;
const stampDir = process.env.BENCH_STAMP_DIR;
if (stampDir) {
  const caller = process.env.BENCH_CALLER === 'hook' ? 'hook' : 'agent';
  appendFileSync(path.join(stampDir, 'stub.jsonl'), `${JSON.stringify({ caller, argv })}\n`);
}

const readJson = (name: string) => JSON.parse(readFileSync(path.join(taskDir, name), 'utf8'));
const axes: Axis[] = readJson('brief.json');
const record = (axis: Axis) =>
  `# ${axis.slug}\n\n## Target · current\n\n**Ruling:** ${axis.ruling.trim()}\n`;

if (command === 'scoped-targets') {
  if (!rest.includes('--brief-again')) {
    const task = readJson('task.json');
    const file = rest[rest.indexOf('--files') + 1];
    const governed = [task.file, ...(task.alsoBrief ?? [])].includes(file);
    console.log(JSON.stringify(governed ? axes : []));
  }
} else if (command === 'show') {
  const hit = axes.find((axis) => rest.includes(axis.slug));
  if (!hit) {
    console.error(`guard-decisions: no decision named ${rest.join(' ')}`);
    process.exit(1);
  }
  console.log(record(hit));
} else if (command === 'query') {
  console.log(axes.map(record).join('\n'));
} else {
  console.error(
    'usage: guard-decisions show <slug> | query "<topic>" | scoped-targets --files <p>',
  );
  process.exit(1);
}
