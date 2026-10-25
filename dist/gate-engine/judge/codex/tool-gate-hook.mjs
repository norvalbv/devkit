// The codex judge PreToolUse hook: exit 2 + stderr reason blocks, silent exit 0 allows. Codex runs the
// call on any other outcome, so the code is 2 before any module loads and only a completed allow clears it.
import { appendFileSync, readFileSync } from 'node:fs';
process.exitCode = 2;
const LEDGER_LINE_CHARS = 500;
async function main() {
    const [{ z }, gate, { judgeToolCall }] = await Promise.all([
        import('zod'),
        import('./tool-gate.mjs'),
        import('./tool-gate-policy.mjs'),
    ]);
    const callSchema = z.object({
        session_id: z.string(),
        tool_name: z.string(),
        tool_input: z.looseObject({ command: z.string().optional() }).catch({}),
    });
    const token = gate.decodeToolGateToken(process.argv[2]);
    const call = callSchema.parse(JSON.parse(readFileSync(0, 'utf8')));
    const command = call.tool_input.command;
    const decision = judgeToolCall(call.tool_name, command, token);
    const line = `${call.tool_name}: ${command ?? JSON.stringify(call.tool_input)}`.replace(/\s+/g, ' ');
    const file = gate.ledgerFile(token.ledgerDir, call.session_id);
    try {
        if (file && gate.ensureLedgerDir(token.ledgerDir)) {
            const entry = {
                decision: decision.allow ? 'allow' : 'deny',
                line: line.slice(0, LEDGER_LINE_CHARS),
            };
            appendFileSync(file, `${JSON.stringify(entry)}\n`);
        }
    }
    catch {
        // The ledger only feeds the after-run audit; the decision stands without it.
    }
    if (decision.allow)
        process.exitCode = 0;
    else
        process.stderr.write(`devkit tool gate: ${decision.reason}\n`);
}
try {
    await main();
}
catch (error) {
    process.exitCode = 2;
    process.stderr.write(`devkit tool gate: refused (${error instanceof Error ? error.message : String(error)})\n`);
}
