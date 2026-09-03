#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { runCommentFirewall } from './gate.mjs';
const USAGE = `Usage:
  guard-comments gate`;
/** Usage errors exit 4, never 2: the shared hook helper passes on 2, and this gate has no fail-open. */
export function runCommentCli(args, cwd = process.cwd()) {
    const [command] = args;
    if (command === 'gate')
        return runCommentFirewall(cwd);
    console.error(USAGE);
    return 4;
}
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(new URL(import.meta.url))) {
    process.exitCode = runCommentCli(process.argv.slice(2));
}
