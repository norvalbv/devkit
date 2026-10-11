#!/usr/bin/env node
import { categoryReport } from './category-report.mjs';
import { RECORDS } from './records.mjs';

if (process.argv[2] === 'categories') console.log(categoryReport(RECORDS));
else {
  console.error('usage: cli.mjs categories');
  process.exit(2);
}
