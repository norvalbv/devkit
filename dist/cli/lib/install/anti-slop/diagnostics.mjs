/** Normalize Oxlint JSON diagnostics into checkout-independent anti-slop findings. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
const RULE_CODE = /^anti-slop\(([^)]+)\)$/u;
const normalizeText = (value) => value.trim().replace(/\s+/gu, ' ');
function ruleId(code) {
    if (typeof code !== 'string')
        return null;
    const match = RULE_CODE.exec(code);
    return match?.[1] ? `anti-slop/${match[1]}` : null;
}
function repositoryFile(cwd, filename) {
    if (typeof filename !== 'string' || !filename)
        throw new Error('diagnostic has no filename');
    const absolute = resolve(cwd, filename);
    const rel = relative(cwd, absolute);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`diagnostic path escapes repository: ${filename}`);
    }
    return { absolute, relative: rel.split(sep).join('/') };
}
function lineContext(source, line) {
    const lines = source.toString('utf8').replace(/\r\n?/gu, '\n').split('\n');
    return normalizeText(lines[Math.max(0, line - 1)] ?? '');
}
/** The first line of the reported span, so a formatter reflowing the line around it keeps the
 * identity. Oxlint offsets count UTF-8 bytes, so the slice is taken from the raw bytes. */
function spanContext(source, span, line) {
    const offset = span?.offset ?? -1;
    const length = span?.length ?? 0;
    if (offset < 0 || length < 1)
        return lineContext(source, line);
    const text = source.subarray(offset, offset + length).toString('utf8');
    return normalizeText(text.split(/\r\n?|\n/u)[0] ?? '');
}
function fingerprintFor(parts) {
    return createHash('sha256')
        .update(JSON.stringify([parts.ruleId, parts.file, parts.diagnostic, parts.context]))
        .digest('hex');
}
/** Parse only namespaced anti-slop diagnostics; other Oxlint rules remain outside this gate. */
export function parseAntiSlopFindings(cwd, json) {
    let payload;
    try {
        payload = JSON.parse(json);
    }
    catch (error) {
        throw new Error(`Oxlint did not return JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!Array.isArray(payload.diagnostics))
        throw new Error('Oxlint JSON has no diagnostics array');
    const findings = [];
    const sources = new Map();
    for (const diagnostic of payload.diagnostics) {
        const id = ruleId(diagnostic.code);
        if (!id)
            continue;
        const location = repositoryFile(cwd, diagnostic.filename);
        const span = diagnostic.labels?.[0]?.span;
        const line = typeof span?.line === 'number' && span.line > 0 ? span.line : 1;
        const column = typeof span?.column === 'number' && span.column > 0 ? span.column : 1;
        const message = typeof diagnostic.message === 'string' ? normalizeText(diagnostic.message) : 'diagnostic';
        let source = sources.get(location.absolute);
        if (!source)
            sources.set(location.absolute, (source = readFileSync(location.absolute)));
        const stable = {
            ruleId: id,
            file: location.relative,
            diagnostic: message,
            context: spanContext(source, span, line),
        };
        findings.push({
            ...stable,
            fingerprint: fingerprintFor(stable),
            legacyFingerprint: fingerprintFor({ ...stable, context: lineContext(source, line) }),
            severity: diagnostic.severity === 'warning' ? 'warning' : 'error',
            line,
            column,
        });
    }
    return findings.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint) || a.line - b.line || a.column - b.column);
}
/** Group indistinguishable repeated diagnostics so an added copy still exceeds baseline debt. */
export function groupFindings(findings) {
    const groups = new Map();
    for (const finding of findings) {
        const current = groups.get(finding.fingerprint);
        if (!current) {
            const { legacyFingerprint: _legacy, ...group } = finding;
            const locations = [{ line: finding.line, column: finding.column }];
            groups.set(finding.fingerprint, { ...group, count: 1, locations });
            continue;
        }
        current.count += 1;
        current.locations.push({ line: finding.line, column: finding.column });
        if (finding.severity === 'error')
            current.severity = 'error';
    }
    return [...groups.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}
/** Every site of a group, labelled with how many of its identical findings the caller counts. */
export function formatGroupSites(group, counted, label) {
    const sites = group.locations.map(({ line, column }) => `${group.file}:${line}:${column}`);
    const of = group.count > 1 ? ` of ${group.count} identical` : '';
    return `${sites.join(', ')} (${counted} ${label}${of})`;
}
