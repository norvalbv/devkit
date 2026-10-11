import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { writeFileAtomic } from '../atomic-write.mjs';
import { superviseGateCommand } from '../ship/review/process/gate-supervisor.mjs';
import { concludeRegression, parseVitestRegressionReport, REGRESSION_EVIDENCE_SCHEMA, renderRegressionEvidence, sha256, } from './regression-evidence.mjs';
import { createRegressionClone, linkRegressionDependencies, prepareRegressionReportPath, prepareRegressionRepository, readRegressionReport, regressionCloneCwd, RegressionUsageError, snapshotRegressionCaller, } from './regression-repository.mjs';
import { regressionCaptureSignals, superviseWindowsRegressionHelper, } from './regression-windows-supervisor.mjs';
const NO_REPORT = {
    reportFile: null,
    reportSha256: null,
    reportError: null,
    testCounts: null,
    failures: [],
    fileErrors: [],
    tests: null,
};
class InterruptedError extends Error {
    status;
    constructor(status) {
        super(`regression evidence capture interrupted (exit ${status})`);
        this.status = status;
    }
}
class CaptureSignalGuard {
    status = null;
    handlers;
    constructor() {
        this.handlers = regressionCaptureSignals().map(([signal, status]) => {
            const handler = () => {
                this.status ??= status;
            };
            process.on(signal, handler);
            return [signal, handler];
        });
    }
    throwIfInterrupted() {
        if (this.status)
            throw new InterruptedError(this.status);
    }
    async checkpoint() {
        await new Promise((resolveCheckpoint) => setImmediate(resolveCheckpoint));
        this.throwIfInterrupted();
    }
    dispose() {
        for (const [signal, handler] of this.handlers)
            process.off(signal, handler);
    }
}
const MAX_SUPERVISION_MS = 2_147_483_647;
function helperPath() {
    const extension = import.meta.url.endsWith('.mts') ? '.mts' : '.mjs';
    return join(import.meta.dirname, `regression-exec${extension}`);
}
function invalidCommandResult() {
    throw new Error('execution helper wrote an invalid command result');
}
function isSupportedNodeSignal(value) {
    return Object.hasOwn(constants.signals, value);
}
function parseCommandResultCandidate(path) {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (Object.prototype.toString.call(value) !== '[object Object]')
        invalidCommandResult();
    return {
        exitCode: Object.getOwnPropertyDescriptor(value, 'exitCode')?.value,
        signal: Object.getOwnPropertyDescriptor(value, 'signal')?.value,
        spawnError: Object.getOwnPropertyDescriptor(value, 'spawnError')?.value,
    };
}
function readCommandResult(path) {
    const value = parseCommandResultCandidate(path);
    let exitCode = null;
    if (value.exitCode !== null) {
        const parsedExitCode = Number(value.exitCode);
        if (Object.prototype.toString.call(value.exitCode) !== '[object Number]' ||
            !Number.isInteger(parsedExitCode) ||
            parsedExitCode < 0) {
            return invalidCommandResult();
        }
        exitCode = parsedExitCode;
    }
    let signal = null;
    if (value.signal !== null) {
        const parsedSignal = String(value.signal);
        if (Object.prototype.toString.call(value.signal) !== '[object String]' ||
            !isSupportedNodeSignal(parsedSignal)) {
            return invalidCommandResult();
        }
        signal = parsedSignal;
    }
    const spawnError = value.spawnError === true ? true : value.spawnError === false ? false : invalidCommandResult();
    if ((exitCode === null) === (signal === null))
        return invalidCommandResult();
    return {
        exitCode,
        signal,
        spawnError,
    };
}
function statusFor(result) {
    if (result.exitCode !== null)
        return result.exitCode;
    return result.signal ? 128 + (constants.signals[result.signal] ?? 0) : 1;
}
async function runManaged(command, cwd, stdoutPath, stderrPath, commandResultPath, ownershipToken, signalGuard) {
    const helperCommand = [
        process.execPath,
        helperPath(),
        cwd,
        stdoutPath,
        stderrPath,
        commandResultPath,
        '--',
        ...command,
    ];
    const supervisionStatus = process.platform === 'win32'
        ? await superviseWindowsRegressionHelper(helperCommand)
        : await superviseGateCommand(MAX_SUPERVISION_MS, helperCommand, undefined, ownershipToken, false);
    signalGuard.throwIfInterrupted();
    const result = readCommandResult(commandResultPath);
    const commandStatus = statusFor(result);
    if (supervisionStatus !== commandStatus) {
        throw new Error(`test process tree did not drain cleanly (command ${commandStatus}, supervisor ${supervisionStatus})`);
    }
    return { ...result, commandResultPath };
}
function captureVitestReport(name, clone, prefix, reportPath, evidenceDir, dependencySource, exitCode) {
    let outputName = null;
    let reportSha256 = null;
    try {
        const report = readRegressionReport(clone, prefix, reportPath);
        outputName = `${name}.vitest.json`;
        reportSha256 = sha256(report.bytes);
        writeFileSync(join(evidenceDir, outputName), report.bytes, { mode: 0o600 });
        const parsed = parseVitestRegressionReport(report.bytes.toString('utf8'), clone, dependencySource);
        if (exitCode === 0 && !parsed.success)
            throw new Error('Vitest report success is false despite command exiting 0');
        return {
            reportFile: outputName,
            reportSha256,
            reportError: null,
            testCounts: parsed.counts,
            failures: parsed.failures,
            fileErrors: parsed.fileErrors,
            tests: parsed.tests,
        };
    }
    catch (error) {
        return {
            ...NO_REPORT,
            reportFile: outputName,
            reportSha256,
            reportError: error instanceof Error ? error.message : String(error),
        };
    }
}
async function runOperand(name, clone, prefix, command, vitestReport, dependencySource, evidenceDir, ownershipToken, signalGuard) {
    const cwd = regressionCloneCwd(clone, prefix);
    if (vitestReport)
        prepareRegressionReportPath(clone, prefix, vitestReport);
    const stdoutPath = join(evidenceDir, `${name}.stdout.log`);
    const stderrPath = join(evidenceDir, `${name}.stderr.log`);
    const commandResultPath = join(evidenceDir, `${name}.command.json`);
    const result = await runManaged(command, cwd, stdoutPath, stderrPath, commandResultPath, ownershipToken, signalGuard);
    const report = vitestReport
        ? captureVitestReport(name, clone, prefix, vitestReport, evidenceDir, dependencySource, result.exitCode)
        : NO_REPORT;
    return { ...result, stdoutPath, stderrPath, ...report };
}
function operandEvidence(name, requestedRef, sha, run) {
    const stdout = readFileSync(run.stdoutPath);
    const stderr = readFileSync(run.stderrPath);
    const commandResult = readFileSync(run.commandResultPath);
    return {
        requestedRef,
        sha,
        exitCode: run.exitCode,
        signal: run.signal,
        spawnError: run.spawnError,
        stdoutFile: `${name}.stdout.log`,
        stderrFile: `${name}.stderr.log`,
        commandResultFile: `${name}.command.json`,
        stdoutSha256: sha256(stdout),
        stderrSha256: sha256(stderr),
        commandResultSha256: sha256(commandResult),
        reportFile: run.reportFile,
        reportSha256: run.reportSha256,
        reportError: run.reportError,
        testCounts: run.testCounts,
        failures: run.failures,
        fileErrors: run.fileErrors,
    };
}
function removeClone(path) {
    try {
        rmSync(path, { recursive: true, force: true });
    }
    catch {
        return false;
    }
    return !existsSync(path);
}
function regressionTempBase(callerRoot) {
    const base = realpathSync(tmpdir());
    const fromCaller = relative(callerRoot, base);
    if (fromCaller === '' ||
        (fromCaller !== '..' && !fromCaller.startsWith(`..${sep}`) && !isAbsolute(fromCaller))) {
        throw new RegressionUsageError('temporary directory must be outside the caller repository');
    }
    return base;
}
/** Throws on interruption or a clone/setup failure, after removing every clone. */
export async function captureRegressionEvidence(prepared) {
    const signalGuard = new CaptureSignalGuard();
    let root = null;
    let redClone = '';
    let greenClone = '';
    let completed = false;
    try {
        root = mkdtempSync(join(regressionTempBase(prepared.root), 'devkit-regression-evidence-'));
        redClone = join(root, 'red');
        greenClone = join(root, 'green');
        const evidenceDir = join(root, 'evidence');
        const ownershipToken = randomBytes(32).toString('hex');
        mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
        signalGuard.throwIfInterrupted();
        createRegressionClone(prepared.root, redClone, prepared.redSha);
        await signalGuard.checkpoint();
        createRegressionClone(prepared.root, greenClone, prepared.greenSha);
        await signalGuard.checkpoint();
        const dependencySnapshot = linkRegressionDependencies(redClone, prepared.prefix, prepared.dependencySource);
        linkRegressionDependencies(greenClone, prepared.prefix, dependencySnapshot);
        await signalGuard.checkpoint();
        const redRun = await runOperand('red', redClone, prepared.prefix, prepared.args.command, prepared.args.vitestReport, prepared.dependencySource, evidenceDir, ownershipToken, signalGuard);
        signalGuard.throwIfInterrupted();
        const greenRun = await runOperand('green', greenClone, prepared.prefix, prepared.args.command, prepared.args.vitestReport, prepared.dependencySource, evidenceDir, ownershipToken, signalGuard);
        signalGuard.throwIfInterrupted();
        const red = operandEvidence('red', prepared.args.red, prepared.redSha, redRun);
        const green = operandEvidence('green', prepared.args.green, prepared.greenSha, greenRun);
        const cleanup = {
            redCloneRemoved: removeClone(redClone),
            greenCloneRemoved: removeClone(greenClone),
        };
        const callerAfter = snapshotRegressionCaller(prepared.root);
        const matched = callerAfter === prepared.callerBefore;
        const callerBoundarySamples = {
            beforeSha256: prepared.callerBefore,
            afterSha256: callerAfter,
            matched,
        };
        const tests = redRun.tests && greenRun.tests ? { red: redRun.tests, green: greenRun.tests } : null;
        const conclusion = concludeRegression(red, green, tests, matched, cleanup);
        const evidence = {
            schema: REGRESSION_EVIDENCE_SCHEMA,
            ...conclusion,
            createdAt: new Date().toISOString(),
            command: {
                argv: prepared.args.command,
                callerPrefix: prepared.prefix,
                vitestReport: prepared.args.vitestReport,
            },
            red,
            green,
            dependency: {
                source: prepared.dependencySource,
                mutableStoreException: false,
            },
            cleanup,
            callerBoundarySamples,
        };
        writeFileAtomic(join(evidenceDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
        writeFileAtomic(join(evidenceDir, 'evidence.md'), renderRegressionEvidence(evidence));
        await signalGuard.checkpoint();
        completed = true;
        return { evidence, evidenceDir };
    }
    catch (error) {
        if (redClone)
            removeClone(redClone);
        if (greenClone)
            removeClone(greenClone);
        throw error;
    }
    finally {
        if (!completed && root)
            removeClone(root);
        signalGuard.dispose();
    }
}
export async function proveRegression(rawArgs, cwd = process.cwd()) {
    let prepared;
    try {
        prepared = prepareRegressionRepository(rawArgs, cwd);
    }
    catch (error) {
        const prefix = error instanceof RegressionUsageError ? 'usage' : 'setup';
        console.error(`🚫 prove-regression ${prefix}: ${error instanceof Error ? error.message : error}`);
        return 1;
    }
    let captured;
    try {
        captured = await captureRegressionEvidence(prepared);
    }
    catch (error) {
        if (error instanceof InterruptedError)
            return error.status;
        const phase = error instanceof RegressionUsageError ? 'setup' : 'failed';
        console.error(`🚫 prove-regression ${phase}: ${error instanceof Error ? error.message : error}`);
        return 1;
    }
    const { red, green, status } = captured.evidence;
    console.log(`red: ${red.sha} → ${red.signal ?? red.exitCode}`);
    console.log(`green: ${green.sha} → ${green.signal ?? green.exitCode}`);
    if (red.reportError)
        console.warn(`⚠️  red Vitest report: ${red.reportError}`);
    if (green.reportError)
        console.warn(`⚠️  green Vitest report: ${green.reportError}`);
    console.log(`evidence: ${captured.evidenceDir}`);
    return status === 'captured' ? 0 : 1;
}
